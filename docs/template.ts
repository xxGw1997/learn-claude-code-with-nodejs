#!/usr/bin/env bun
// Harness: compression -- keep the active context small enough to keep working.
//
// s06_context_compact.ts - Context Compact
// This teaching version keeps the compact model intentionally small:
// 1. Large tool output is persisted to disk and replaced with a preview marker.
// 2. Older tool results are micro-compacted into short placeholders.
// 3. When the whole conversation gets too large, the agent summarizes it and
//    continues from that summary.
//
// The important OpenAI-specific shape is:
// - assistant tool requests live on assistant messages as `tool_calls`
// - tool outputs are separate messages with `role: "tool"` and `tool_call_id`

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

type CompactState = {
  hasCompacted: boolean;
  lastSummary: string;
  recentFiles: string[];
};

type JsonObject = Record<string, unknown>;

const WORKDIR = process.cwd();
const client = new OpenAI({
  baseURL: Bun.env.OPENAI_BASE_URL ?? Bun.env.BASE_URL,
  apiKey: Bun.env.OPENAI_API_KEY ?? Bun.env.ANTHROPIC_API_KEY ?? "dummy-key",
});

const MODEL = Bun.env.MODEL_ID;
if (!MODEL) {
  throw new Error("MODEL_ID is required");
}

const SYSTEM_PROMPT =
  `You are a coding agent at ${WORKDIR}. ` +
  "Keep working step by step, and use compact if the conversation gets too long.";

const CONTEXT_LIMIT = 50_000;
const KEEP_RECENT_TOOL_RESULTS = 3;
const PERSIST_THRESHOLD = 30_000;
const PREVIEW_CHARS = 2_000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

const COMPACTED_TOOL_RESULT =
  "[Earlier tool result compacted. Re-run the tool if you need full detail.]";

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in a file once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compact",
      description:
        "Summarize earlier conversation so work can continue in a smaller context.",
      parameters: {
        type: "object",
        properties: {
          focus: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
];

function estimateContextSize(messages: ChatCompletionMessageParam[]): number {
  return JSON.stringify(messages).length;
}

function trackRecentFile(state: CompactState, filePath: string): void {
  const existingIndex = state.recentFiles.indexOf(filePath);
  if (existingIndex >= 0) {
    state.recentFiles.splice(existingIndex, 1);
  }

  state.recentFiles.push(filePath);
  if (state.recentFiles.length > 5) {
    state.recentFiles.splice(0, state.recentFiles.length - 5);
  }
}

function safePath(pathStr: string): string {
  const resolvedPath = path.resolve(WORKDIR, pathStr);
  const relativePath = path.relative(WORKDIR, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path escapes workspace: ${pathStr}`);
  }

  return resolvedPath;
}

function persistLargeOutput(toolCallId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) {
    return output;
  }

  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const storedPath = path.join(TOOL_RESULTS_DIR, `${toolCallId}.txt`);
  if (!fs.existsSync(storedPath)) {
    fs.writeFileSync(storedPath, output);
  }

  const preview = output.slice(0, PREVIEW_CHARS);
  const relPath = path.relative(WORKDIR, storedPath);

  return [
    "<persisted-output>",
    `Full output saved to: ${relPath}`,
    "Preview:",
    preview,
    "</persisted-output>",
  ].join("\n");
}

function getMessageStringContent(message: ChatCompletionMessageParam): string {
  const content = "content" in message ? message.content : undefined;
  return typeof content === "string" ? content : "";
}

function microCompact(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  const toolMessages = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "tool");

  if (toolMessages.length <= KEEP_RECENT_TOOL_RESULTS) {
    return messages;
  }

  for (const { message, index } of toolMessages.slice(
    0,
    -KEEP_RECENT_TOOL_RESULTS,
  )) {
    const content = getMessageStringContent(message);
    if (content.length <= 120) continue;

    messages[index] = {
      ...message,
      role: "tool",
      content: COMPACTED_TOOL_RESULT,
    };
  }

  return messages;
}

function writeTranscript(messages: ChatCompletionMessageParam[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(
    TRANSCRIPT_DIR,
    `transcript_${Math.floor(Date.now() / 1000)}.jsonl`,
  );

  const lines = messages.map((message) => JSON.stringify(message)).join("\n");
  fs.writeFileSync(transcriptPath, `${lines}\n`);

  return transcriptPath;
}

async function summarizeHistory(
  messages: ChatCompletionMessageParam[],
): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const prompt = [
    "Summarize this coding-agent conversation so work can continue.",
    "Preserve:",
    "1. The current goal",
    "2. Important findings and decisions",
    "3. Files read or changed",
    "4. Remaining work",
    "5. User constraints and preferences",
    "Be compact but concrete.",
    "",
    conversation,
  ].join("\n");

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2_000,
  });

  return response.choices[0]?.message.content?.trim() ?? "";
}

async function compactHistory(
  messages: ChatCompletionMessageParam[],
  state: CompactState,
  focus?: string,
): Promise<ChatCompletionMessageParam[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);

  let summary = await summarizeHistory(messages);

  if (focus) {
    summary += `\n\nFocus to preserve next: ${focus}`;
  }

  if (state.recentFiles.length > 0) {
    const recentLines = state.recentFiles.map((filePath) => `- ${filePath}`);
    summary += `\n\nRecent files to reopen if needed:\n${recentLines.join("\n")}`;
  }

  state.hasCompacted = true;
  state.lastSummary = summary;

  return [
    {
      role: "user",
      content:
        "This conversation was compacted so the agent can continue working.\n\n" +
        summary,
    },
  ];
}

function runBash(command: string, toolCallId: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
    return Promise.resolve("Error: Dangerous command blocked");
  }

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: WORKDIR,
      timeout: 120_000,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120_000);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", () => {
      clearTimeout(timeout);
      if (timedOut) {
        resolve("Error: Timeout (120s)");
        return;
      }

      const output = (stdout + stderr).trim() || "(no output)";
      resolve(persistLargeOutput(toolCallId, output));
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve(`Error: ${error.message}`);
    });
  });
}

function runRead(
  filePath: string,
  toolCallId: string,
  state: CompactState,
  limit?: number,
): string {
  try {
    trackRecentFile(state, filePath);
    const lines = fs.readFileSync(safePath(filePath), "utf-8").split(/\r?\n/);
    const limitedLines =
      limit && limit < lines.length
        ? lines
            .slice(0, limit)
            .concat([`... (${lines.length - limit} more lines)`])
        : lines;

    return persistLargeOutput(toolCallId, limitedLines.join("\n"));
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fullPath = safePath(filePath);
    const content = fs.readFileSync(fullPath, "utf-8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }

    fs.writeFileSync(fullPath, content.replace(oldText, newText));
    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function parseToolArgs(rawArgs: string): JsonObject {
  if (!rawArgs.trim()) {
    return {};
  }

  const parsed = JSON.parse(rawArgs);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }

  return parsed as JsonObject;
}

function getStringArg(args: JsonObject, name: string): string {
  const value = args[name];
  if (typeof value !== "string") {
    throw new Error(`Missing or invalid string argument: ${name}`);
  }
  return value;
}

function getOptionalIntegerArg(args: JsonObject, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`Invalid positive integer argument: ${name}`);
  }
  return Number(value);
}

async function executeTool(
  name: string,
  args: JsonObject,
  toolCallId: string,
  state: CompactState,
): Promise<string> {
  try {
    if (name === "bash") {
      return await runBash(getStringArg(args, "command"), toolCallId);
    }

    if (name === "read_file") {
      return runRead(
        getStringArg(args, "path"),
        toolCallId,
        state,
        getOptionalIntegerArg(args, "limit"),
      );
    }

    if (name === "write_file") {
      return runWrite(getStringArg(args, "path"), getStringArg(args, "content"));
    }

    if (name === "edit_file") {
      return runEdit(
        getStringArg(args, "path"),
        getStringArg(args, "old_text"),
        getStringArg(args, "new_text"),
      );
    }

    if (name === "compact") {
      return "Compacting conversation...";
    }

    return `Unknown tool: ${name}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function extractText(message: ChatCompletionMessageParam | undefined): string {
  if (!message || !("content" in message)) {
    return "";
  }

  return typeof message.content === "string" ? message.content.trim() : "";
}

async function agentLoop(
  messages: ChatCompletionMessageParam[],
  state: CompactState,
): Promise<void> {
  while (true) {
    microCompact(messages);

    if (estimateContextSize(messages) > CONTEXT_LIMIT) {
      console.log("[auto compact]");
      messages.splice(0, messages.length, ...(await compactHistory(messages, state)));
    }

    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools: TOOLS,
      max_tokens: 8_000,
    });

    const choice = response.choices[0];
    const assistantMessage = choice?.message;
    if (!assistantMessage) return;

    messages.push({
      role: "assistant",
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    if (
      choice.finish_reason !== "tool_calls" ||
      !assistantMessage.tool_calls ||
      assistantMessage.tool_calls.length === 0
    ) {
      return;
    }

    let manualCompact = false;
    let compactFocus: string | undefined;

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

      const functionName = toolCall.function.name;
      const functionArgs = parseToolArgs(toolCall.function.arguments);
      const output = await executeTool(
        functionName,
        functionArgs,
        toolCall.id,
        state,
      );

      if (functionName === "compact") {
        manualCompact = true;
        const focus = functionArgs.focus;
        compactFocus = typeof focus === "string" ? focus : undefined;
      }

      console.log(`> ${functionName}: ${output.slice(0, 200)}`);
      messages.push({
        role: "tool",
        content: output,
        tool_call_id: toolCall.id,
      });
    }

    if (manualCompact) {
      console.log("[manual compact]");
      messages.splice(
        0,
        messages.length,
        ...(await compactHistory(messages, state, compactFocus)),
      );
    }
  }
}

async function main(): Promise<void> {
  const history: ChatCompletionMessageParam[] = [];
  const compactState: CompactState = {
    hasCompacted: false,
    lastSummary: "",
    recentFiles: [],
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms06 >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (query: string) => {
    const trimmedQuery = query.trim();

    if (["q", "exit", ""].includes(trimmedQuery.toLowerCase())) {
      rl.close();
      return;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history, compactState);

    const finalText = extractText(history.at(-1));
    if (finalText) {
      console.log(finalText);
    }
    console.log();
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
