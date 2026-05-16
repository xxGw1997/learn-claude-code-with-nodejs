#!/usr/bin/env bun
/**
 * s03_todo_write.ts - Session Planning with TodoWrite
 * This chapter is about a lightweight session plan, not a durable task graph.
 * The model can rewrite its current plan, keep one active step in focus, and get
 * nudged if it stops refreshing the plan for too many rounds.
 */
import OpenAI from "openai";
import * as path from "node:path";
import { mkdir } from "node:fs/promises";
import * as readline from "node:readline/promises";

const WORKDIR = process.cwd();
const client = new OpenAI({
  baseURL: Bun.env.BASE_URL ?? Bun.env.OPENAI_BASE_URL ?? Bun.env.ANTHROPIC_BASE_URL,
  apiKey:
    Bun.env.OPENAI_API_KEY ??
    Bun.env.ANTHROPIC_API_KEY ??
    Bun.env.ANTHROPIC_AUTH_TOKEN ??
    "not-needed",
});
const MODEL = Bun.env.MODEL_ID!;
const PLAN_REMINDER_INTERVAL = 3;
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool for multi-step work.
Keep exactly one step in_progress when a task has multiple steps.
Refresh the plan as work advances. Prefer tools over prose.`;

type PlanStatus = "pending" | "in_progress" | "completed";

type PlanItem = {
  content: string;
  status: PlanStatus;
  activeForm: string;
};

type PlanningState = {
  items: PlanItem[];
  roundsSinceUpdate: number;
};

class TodoManager {
  state: PlanningState = { items: [], roundsSinceUpdate: 0 };

  update(items: unknown): string {
    if (!Array.isArray(items)) {
      throw new Error("items must be an array");
    }
    if (items.length > 12) {
      throw new Error("Keep the session plan short (max 12 items)");
    }

    const normalized: PlanItem[] = [];
    let inProgressCount = 0;

    items.forEach((rawItem, index) => {
      if (!isRecord(rawItem)) {
        throw new Error(`Item ${index}: object required`);
      }

      const content = String(rawItem.content ?? "").trim();
      const status = String(rawItem.status ?? "pending").toLowerCase();
      const activeForm = String(rawItem.activeForm ?? "").trim();

      if (!content) {
        throw new Error(`Item ${index}: content required`);
      }
      if (!isPlanStatus(status)) {
        throw new Error(`Item ${index}: invalid status '${status}'`);
      }
      if (status === "in_progress") {
        inProgressCount += 1;
      }

      normalized.push({ content, status, activeForm });
    });

    if (inProgressCount > 1) {
      throw new Error("Only one plan item can be in_progress");
    }

    this.state.items = normalized;
    this.state.roundsSinceUpdate = 0;
    return this.render();
  }

  noteRoundWithoutUpdate(): void {
    this.state.roundsSinceUpdate += 1;
  }

  reminder(): string | null {
    if (this.state.items.length === 0) return null;
    if (this.state.roundsSinceUpdate < PLAN_REMINDER_INTERVAL) return null;
    return "<reminder>Refresh your current plan before continuing.</reminder>";
  }

  render(): string {
    if (this.state.items.length === 0) {
      return "No session plan yet.";
    }

    const lines = this.state.items.map((item) => {
      const marker = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      }[item.status];
      let line = `${marker} ${item.content}`;
      if (item.status === "in_progress" && item.activeForm) {
        line += ` (${item.activeForm})`;
      }
      return line;
    });

    const completed = this.state.items.filter(
      (item) => item.status === "completed",
    ).length;
    lines.push(`\n(${completed}/${this.state.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanStatus(value: string): value is PlanStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function safePath(pathStr: string): string {
  const resolved = path.resolve(WORKDIR, pathStr);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${pathStr}`);
  }
  return resolved;
}

async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: WORKDIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();

    let timeout: Timer | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        proc.kill();
        resolve("timeout");
      }, 120_000);
    });

    const exit = await Promise.race([proc.exited, timedOut]);
    if (timeout) clearTimeout(timeout);
    if (exit === "timeout") {
      await Promise.allSettled([stdout, stderr]);
      return "Error: Timeout (120s)";
    }

    const output = ((await stdout) + (await stderr)).trim();
    return output ? output.slice(0, 50_000) : "(no output)";
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runRead(filePath: string, limit?: number): Promise<string> {
  try {
    const content = await Bun.file(safePath(filePath)).text();
    let lines = content.length === 0 ? [] : content.split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more lines)`);
    }
    return lines.join("\n").slice(0, 50_000);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runWrite(filePath: string, content: string): Promise<string> {
  try {
    const resolved = safePath(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await Bun.write(resolved, content);
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runEdit(
  filePath: string,
  oldText: string,
  newText: string,
): Promise<string> {
  try {
    const resolved = safePath(filePath);
    const content = await Bun.file(resolved).text();
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    await Bun.write(resolved, content.replace(oldText, newText));
    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "bash": {
      if (typeof args.command !== "string") return "Error: command required";
      return await runBash(args.command);
    }
    case "read_file": {
      if (typeof args.path !== "string") return "Error: path required";
      if (args.limit !== undefined && typeof args.limit !== "number") {
        return "Error: limit must be a number";
      }
      return await runRead(args.path, args.limit);
    }
    case "write_file": {
      if (typeof args.path !== "string") return "Error: path required";
      if (typeof args.content !== "string") return "Error: content required";
      return await runWrite(args.path, args.content);
    }
    case "edit_file": {
      if (typeof args.path !== "string") return "Error: path required";
      if (typeof args.old_text !== "string") return "Error: old_text required";
      if (typeof args.new_text !== "string") return "Error: new_text required";
      return await runEdit(args.path, args.old_text, args.new_text);
    }
    case "todo":
      return TODO.update(args.items);
    default:
      return `Unknown tool: ${name}`;
  }
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
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
        properties: {
          path: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["path"],
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
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo",
      description: "Rewrite the current session plan for multi-step work.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
                activeForm: {
                  type: "string",
                  description: "Optional present-continuous label.",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
];

function extractText(message: OpenAI.Chat.ChatCompletionMessageParam | undefined): string {
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  const parsed = JSON.parse(argumentsText || "{}");
  if (!isRecord(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed;
}

async function agentLoop(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<void> {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: TOOLS,
      max_completion_tokens: 8000,
    });

    const assistantMessage = response.choices[0]?.message;
    if (!assistantMessage) return;

    messages.push({
      role: "assistant",
      content: assistantMessage.content ?? null,
      tool_calls: assistantMessage.tool_calls,
    });

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (response.choices[0]?.finish_reason !== "tool_calls" || toolCalls.length === 0) {
      return;
    }

    let usedTodo = false;
    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") continue;

      let output: string;
      try {
        output = await executeTool(
          toolCall.function.name,
          parseToolArguments(toolCall.function.arguments),
        );
      } catch (error) {
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }

      console.log(`> ${toolCall.function.name}: ${output.slice(0, 200)}`);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: output,
      });

      if (toolCall.function.name === "todo") {
        usedTodo = true;
      }
    }

    if (usedTodo) {
      TODO.state.roundsSinceUpdate = 0;
    } else {
      TODO.noteRoundWithoutUpdate();
      const reminder = TODO.reminder();
      if (reminder) {
        messages.push({ role: "user", content: reminder });
      }
    }
  }
}

async function main(): Promise<void> {
  const history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms03 >> \x1b[0m");
    } catch {
      break;
    }

    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history);

    const finalText = extractText(history.at(-1));
    if (finalText) {
      console.log(finalText);
    }
    console.log();
  }

  rl.close();
}

await main();
