#!/usr/bin/env bun
// Harness: context isolation -- protecting the model's clarity of thought.
/**
 * s04_subagent.ts - Subagents
 * Spawn a child agent with fresh messages=[]. The child works in its own
 * context, sharing the filesystem, then returns only a summary to the parent.
 *
 *     Parent agent                     Subagent
 *     +------------------+             +------------------+
 *     | messages=[...]   |             | messages=[]      |  <-- fresh
 *     |                  |  dispatch   |                  |
 *     | tool: task       | ---------->| while tool_call: |
 *     |   prompt="..."   |            |   call tools     |
 *     |   description="" |            |   append results |
 *     |                  |  summary   |                  |
 *     |   result = "..." | <--------- | return last text |
 *     +------------------+             +------------------+
 *               |
 *     Parent context stays clean.
 *     Subagent context is discarded.
 *
 * Key insight: "Fresh messages=[] gives context isolation. The parent stays clean."
 *
 * Note: Real Claude Code also uses in-process isolation (not OS-level process
 * forking). The child runs in the same process with a fresh message array and
 * isolated tool context -- same pattern as this teaching implementation.
 *
 *     Comparison with real Claude Code:
 *     +-------------------+------------------+----------------------------------+
 *     | Aspect            | This demo        | Real Claude Code                 |
 *     +-------------------+------------------+----------------------------------+
 *     | Backend           | in-process only  | 5 backends: in-process, tmux,    |
 *     |                   |                  | iTerm2, fork, remote             |
 *     | Context isolation | fresh messages=[]| createSubagentContext() isolates  |
 *     |                   |                  | ~20 fields (tools, permissions,  |
 *     |                   |                  | cwd, env, hooks, etc.)           |
 *     | Tool filtering    | manually curated | resolveAgentTools() filters from |
 *     |                   |                  | parent pool; allowedTools         |
 *     |                   |                  | replaces all allow rules         |
 *     | Agent definition  | hardcoded system | .claude/agents/*.md with YAML    |
 *     |                   | prompt           | frontmatter (AgentTemplate)      |
 *     +-------------------+------------------+----------------------------------+
 */

import OpenAI from "openai";
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;

if (!MODEL) {
  throw new Error("MODEL_ID is required");
}

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "dummy-key",
});

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => Promise<string> | string;

class AgentTemplate {
  path: string;
  name: string;
  config: Record<string, string> = {};
  systemPrompt = "";

  constructor(path: string) {
    this.path = path;
    this.name = path.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? "agent";
    this.parse();
  }

  private parse() {
    const text = readFileSync(this.path, "utf8");
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/);

    if (!match) {
      this.systemPrompt = text;
      return;
    }

    for (const line of match[1].split("\n")) {
      if (!line.includes(":")) continue;
      const index = line.indexOf(":");
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      this.config[key] = value;
    }

    this.systemPrompt = match[2].trim();
    this.name = this.config.name ?? this.name;
  }
}

function safePath(path: string): string {
  const fullPath = resolve(WORKDIR, path);
  const relativePrefix = WORKDIR.endsWith("/") ? WORKDIR : `${WORKDIR}/`;

  if (fullPath !== WORKDIR && !fullPath.startsWith(relativePrefix)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }

  return fullPath;
}

async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

  if (dangerous.some((item) => command.includes(item))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const result = await $`bash -lc ${command}`.cwd(WORKDIR).timeout(120_000).quiet();
    const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
    return output ? output.slice(0, 50_000) : "(no output)";
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("timeout")) {
      return "Error: Timeout (120s)";
    }

    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runRead(path: string, limit?: number): string {
  try {
    let lines = readFileSync(safePath(path), "utf8").split("\n");

    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }

    return lines.join("\n").slice(0, 50_000);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runWrite(path: string, content: string): string {
  try {
    const filePath = safePath(path);
    const parent = dirname(filePath);

    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }

    writeFileSync(filePath, content);
    return `Wrote ${Buffer.byteLength(content)} bytes`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runEdit(path: string, oldText: string, newText: string): string {
  try {
    const filePath = safePath(path);
    const content = readFileSync(filePath, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }

    writeFileSync(filePath, content.replace(oldText, newText));
    return `Edited ${path}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(String(input.command)),
  read_file: (input) => runRead(String(input.path), input.limit == null ? undefined : Number(input.limit)),
  write_file: (input) => runWrite(String(input.path), String(input.content)),
  edit_file: (input) => runEdit(String(input.path), String(input.old_text), String(input.new_text)),
};

const CHILD_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
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
        properties: { path: { type: "string" }, limit: { type: "integer" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
];

const PARENT_TOOLS: ChatCompletionTool[] = [
  ...CHILD_TOOLS,
  {
    type: "function",
    function: {
      name: "task",
      description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          description: { type: "string", description: "Short description of the task" },
        },
        required: ["prompt"],
      },
    },
  },
];

function parseToolArguments(toolCall: ChatCompletionMessageToolCall): ToolInput {
  try {
    return JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    return {};
  }
}

async function runSubagent(prompt: string): Promise<string> {
  const subMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: SUBAGENT_SYSTEM },
    { role: "user", content: prompt },
  ];

  let finalContent = "";

  for (let i = 0; i < 30; i++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: subMessages,
      tools: CHILD_TOOLS,
      max_tokens: 8000,
    });

    const message = response.choices[0].message;
    subMessages.push(message);

    if (!message.tool_calls?.length) {
      finalContent = message.content ?? "";
      break;
    }

    for (const toolCall of message.tool_calls) {
      const handler = TOOL_HANDLERS[toolCall.function.name];
      const output = handler
        ? await handler(parseToolArguments(toolCall))
        : `Unknown tool: ${toolCall.function.name}`;

      subMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: String(output).slice(0, 50_000),
      });
    }
  }

  return finalContent || "(no summary)";
}

async function agentLoop(messages: ChatCompletionMessageParam[]) {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: PARENT_TOOLS,
      max_tokens: 8000,
    });

    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      return;
    }

    for (const toolCall of message.tool_calls) {
      const input = parseToolArguments(toolCall);
      let output: string;

      if (toolCall.function.name === "task") {
        const description = String(input.description ?? "subtask");
        const prompt = String(input.prompt ?? "");
        console.log(`> task (${description}): ${prompt.slice(0, 80)}`);
        output = await runSubagent(prompt);
      } else {
        const handler = TOOL_HANDLERS[toolCall.function.name];
        output = handler ? await handler(input) : `Unknown tool: ${toolCall.function.name}`;
      }

      console.log(`  ${String(output).slice(0, 200)}`);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: String(output) });
    }
  }
}

async function main() {
  const history: ChatCompletionMessageParam[] = [];

  while (true) {
    const query = prompt("\x1b[36ms04 >> \x1b[0m");

    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
      break;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history);

    const responseContent = history.at(-1);
    if (responseContent?.role === "assistant" && typeof responseContent.content === "string") {
      console.log(responseContent.content);
    }

    console.log();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

export { AgentTemplate, agentLoop, runSubagent };
