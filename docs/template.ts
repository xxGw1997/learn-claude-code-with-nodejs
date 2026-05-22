#!/usr/bin/env bun
// Harness: safety -- the pipeline between intent and execution.
/*
 * s07_permission_system.ts - Permission System
 *
 * Every tool call passes through a permission pipeline before execution.
 *
 * Teaching pipeline:
 *   1. deny rules
 *   2. mode check
 *   3. allow rules
 *   4. ask user
 *
 * This version intentionally teaches three modes first:
 *   - default
 *   - plan
 *   - auto
 *
 * Key insight: "Safety is a pipeline, not a boolean."
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

const WORKDIR = process.cwd();

const client = new OpenAI({
  apiKey: Bun.env.OPENAI_API_KEY ?? Bun.env.API_KEY ?? Bun.env.ANTHROPIC_API_KEY,
  baseURL: Bun.env.OPENAI_BASE_URL ?? Bun.env.BASE_URL,
});

const MODEL = Bun.env.MODEL_ID ?? "gpt-4.1-mini";

// -- Permission modes --

const MODES = ["default", "plan", "auto"] as const;
type PermissionMode = (typeof MODES)[number];
type PermissionBehavior = "allow" | "deny" | "ask";

const READ_ONLY_TOOLS = new Set(["read_file", "bash_readonly"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "bash"]);

type ToolInput = Record<string, unknown>;

type PermissionRule = {
  tool: string;
  path?: string;
  content?: string;
  behavior: PermissionBehavior;
};

// -- Bash security validation --

class BashSecurityValidator {
  private readonly validators: Array<[string, RegExp]> = [
    ["shell_metachar", /[;&|`$]/],
    ["sudo", /\bsudo\b/],
    ["rm_rf", /\brm\s+(-[a-zA-Z]*)?r/],
    ["cmd_substitution", /\$\(/],
    ["ifs_injection", /\bIFS\s*=/],
  ];

  validate(command: string): Array<[string, string]> {
    const failures: Array<[string, string]> = [];

    for (const [name, pattern] of this.validators) {
      if (pattern.test(command)) {
        failures.push([name, pattern.source]);
      }
    }

    return failures;
  }

  isSafe(command: string): boolean {
    return this.validate(command).length === 0;
  }

  describeFailures(command: string): string {
    const failures = this.validate(command);

    if (failures.length === 0) {
      return "No issues detected";
    }

    return `Security flags: ${failures
      .map(([name, pattern]) => `${name} (pattern: ${pattern})`)
      .join(", ")}`;
  }
}

// -- Workspace trust --

function isWorkspaceTrusted(workspace = WORKDIR): boolean {
  const trustMarker = path.join(workspace, ".claude", ".claude_trusted");
  return fs.existsSync(trustMarker);
}

const bashValidator = new BashSecurityValidator();

// -- Permission rules --

const DEFAULT_RULES: PermissionRule[] = [
  { tool: "bash", content: "rm -rf /", behavior: "deny" },
  { tool: "bash", content: "sudo *", behavior: "deny" },
  { tool: "read_file", path: "*", behavior: "allow" },
];

class PermissionManager {
  mode: PermissionMode;
  rules: PermissionRule[];
  consecutiveDenials = 0;
  maxConsecutiveDenials = 3;

  constructor(mode: PermissionMode = "default", rules: PermissionRule[] = DEFAULT_RULES) {
    if (!MODES.includes(mode)) {
      throw new Error(`Unknown mode: ${mode}. Choose from ${MODES.join(", ")}`);
    }

    this.mode = mode;
    this.rules = [...rules];
  }

  check(toolName: string, toolInput: ToolInput): { behavior: PermissionBehavior; reason: string } {
    if (toolName === "bash") {
      const command = String(toolInput.command ?? "");
      const failures = bashValidator.validate(command);

      if (failures.length > 0) {
        const severe = new Set(["sudo", "rm_rf"]);
        const severeHits = failures.filter(([name]) => severe.has(name));
        const desc = bashValidator.describeFailures(command);

        if (severeHits.length > 0) {
          return { behavior: "deny", reason: `Bash validator: ${desc}` };
        }

        return { behavior: "ask", reason: `Bash validator flagged: ${desc}` };
      }
    }

    for (const rule of this.rules) {
      if (rule.behavior === "deny" && this.matches(rule, toolName, toolInput)) {
        return { behavior: "deny", reason: `Blocked by deny rule: ${JSON.stringify(rule)}` };
      }
    }

    if (this.mode === "plan") {
      if (WRITE_TOOLS.has(toolName)) {
        return { behavior: "deny", reason: "Plan mode: write operations are blocked" };
      }

      return { behavior: "allow", reason: "Plan mode: read-only allowed" };
    }

    if (this.mode === "auto" && READ_ONLY_TOOLS.has(toolName)) {
      return { behavior: "allow", reason: "Auto mode: read-only tool auto-approved" };
    }

    for (const rule of this.rules) {
      if (rule.behavior === "allow" && this.matches(rule, toolName, toolInput)) {
        this.consecutiveDenials = 0;
        return { behavior: "allow", reason: `Matched allow rule: ${JSON.stringify(rule)}` };
      }
    }

    return { behavior: "ask", reason: `No rule matched for ${toolName}, asking user` };
  }

  async askUser(rl: readline.Interface, toolName: string, toolInput: ToolInput): Promise<boolean> {
    const preview = JSON.stringify(toolInput).slice(0, 200);
    console.log(`\n  [Permission] ${toolName}: ${preview}`);

    let answer = "";
    try {
      answer = (await rl.question("  Allow? (y/n/always): ")).trim().toLowerCase();
    } catch {
      return false;
    }

    if (answer === "always") {
      this.rules.push({ tool: toolName, path: "*", behavior: "allow" });
      this.consecutiveDenials = 0;
      return true;
    }

    if (answer === "y" || answer === "yes") {
      this.consecutiveDenials = 0;
      return true;
    }

    this.consecutiveDenials += 1;
    if (this.consecutiveDenials >= this.maxConsecutiveDenials) {
      console.log(`  [${this.consecutiveDenials} consecutive denials -- consider switching to plan mode]`);
    }

    return false;
  }

  private matches(rule: PermissionRule, toolName: string, toolInput: ToolInput): boolean {
    if (rule.tool !== "*" && rule.tool !== toolName) {
      return false;
    }

    if (rule.path && rule.path !== "*") {
      const inputPath = String(toolInput.path ?? "");
      if (!globMatch(inputPath, rule.path)) {
        return false;
      }
    }

    if (rule.content) {
      const command = String(toolInput.command ?? "");
      if (!globMatch(command, rule.content)) {
        return false;
      }
    }

    return true;
  }
}

// -- Tool implementations --

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

function safePath(pathStr: string): string {
  const resolvedPath = path.resolve(WORKDIR, pathStr);
  const relative = path.relative(WORKDIR, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${pathStr}`);
  }

  return resolvedPath;
}

async function runBash(command: string): Promise<string> {
  return await new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: WORKDIR,
      timeout: 120_000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", () => {
      const result = (stdout + stderr).trim();
      resolve(result ? result.slice(0, 50_000) : "(no output)");
    });

    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

function runRead(filePath: string, limit?: number): string {
  try {
    const lines = fs.readFileSync(safePath(filePath), "utf-8").split(/\r?\n/);

    if (limit && limit < lines.length) {
      const remaining = lines.length - limit;
      return [...lines.slice(0, limit), `... (${remaining} more)`].join("\n").slice(0, 50_000);
    }

    return lines.join("\n").slice(0, 50_000);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    return `Wrote ${content.length} bytes`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
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
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeTool(name: string, inputData: ToolInput): Promise<string> {
  switch (name) {
    case "bash":
      return await runBash(String(inputData.command ?? ""));
    case "read_file":
      return runRead(String(inputData.path ?? ""), asOptionalNumber(inputData.limit));
    case "write_file":
      return runWrite(String(inputData.path ?? ""), String(inputData.content ?? ""));
    case "edit_file":
      return runEdit(
        String(inputData.path ?? ""),
        String(inputData.old_text ?? ""),
        String(inputData.new_text ?? ""),
      );
    default:
      return `Unknown: ${name}`;
  }
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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
      description: "Write content to file.",
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
      description: "Replace exact text in file.",
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
];

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
The user controls permissions. Some tool calls may be denied.`;

async function agentLoop(
  messages: ChatCompletionMessageParam[],
  perms: PermissionManager,
  rl: readline.Interface,
): Promise<void> {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: TOOLS,
      max_tokens: 8000,
    });

    const message = response.choices[0]?.message;
    if (!message) {
      return;
    }

    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.tool_calls,
    });

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return;
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") {
        continue;
      }

      const toolName = toolCall.function.name;
      const toolInput = parseToolArguments(toolCall.function.arguments);
      const decision = perms.check(toolName, toolInput);
      let toolOutput: string;

      if (decision.behavior === "deny") {
        toolOutput = `Permission denied: ${decision.reason}`;
        console.log(`  [DENIED] ${toolName}: ${decision.reason}`);
      } else if (decision.behavior === "ask") {
        if (await perms.askUser(rl, toolName, toolInput)) {
          toolOutput = await executeTool(toolName, toolInput);
          console.log(`> ${toolName}: ${toolOutput.slice(0, 200)}`);
        } else {
          toolOutput = `Permission denied by user for ${toolName}`;
          console.log(`  [USER DENIED] ${toolName}`);
        }
      } else {
        toolOutput = await executeTool(toolName, toolInput);
        console.log(`> ${toolName}: ${toolOutput.slice(0, 200)}`);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolOutput,
      });
    }
  }
}

function parseToolArguments(rawArguments: string): ToolInput {
  try {
    const parsed = JSON.parse(rawArguments);
    return typeof parsed === "object" && parsed !== null ? parsed as ToolInput : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  console.log("Permission modes: default, plan, auto");
  const modeInput = (await rl.question("Mode (default): ")).trim().toLowerCase();
  const mode = MODES.includes(modeInput as PermissionMode) ? modeInput as PermissionMode : "default";
  const perms = new PermissionManager(mode);
  const history: ChatCompletionMessageParam[] = [];

  console.log(`[Permission mode: ${mode}]`);
  console.log(`[Workspace trusted: ${isWorkspaceTrusted() ? "yes" : "no"}]`);

  while (true) {
    const query = await rl.question("\x1b[36ms07 >> \x1b[0m");
    const trimmed = query.trim();

    if (["q", "exit", ""].includes(trimmed.toLowerCase())) {
      break;
    }

    if (trimmed.startsWith("/mode")) {
      const [, nextMode] = trimmed.split(/\s+/);

      if (MODES.includes(nextMode as PermissionMode)) {
        perms.mode = nextMode as PermissionMode;
        console.log(`[Switched to ${nextMode} mode]`);
      } else {
        console.log(`Usage: /mode <${MODES.join("|")}>`);
      }

      continue;
    }

    if (trimmed === "/rules") {
      perms.rules.forEach((rule, index) => {
        console.log(`  ${index}: ${JSON.stringify(rule)}`);
      });
      continue;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history, perms, rl);

    const lastMessage = history[history.length - 1];
    if (lastMessage && lastMessage.role === "assistant" && typeof lastMessage.content === "string") {
      console.log(lastMessage.content);
    }

    console.log();
  }

  rl.close();
}

await main();
