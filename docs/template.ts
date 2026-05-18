#!/usr/bin/env bun
// Harness: on-demand knowledge -- discover skills cheaply, load them only when needed.
/*
 * s05_skill_loading.ts - Skills
 *
 * This chapter teaches a two-layer skill model:
 * 1. Put a cheap skill catalog in the system prompt.
 * 2. Load the full skill body only when the model asks for it.
 *
 * This TypeScript version uses OpenAI's Chat Completions tool-calling shape:
 * - Anthropic "input_schema" becomes OpenAI "function.parameters".
 * - Anthropic "tool_use" content blocks become OpenAI "tool_calls".
 * - Anthropic "tool_result" user content becomes OpenAI role="tool" messages.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import OpenAI from "openai";

const WORKDIR = process.cwd();
const SKILLS_DIR = path.join(WORKDIR, "skills");
const MODEL = Bun.env.MODEL_ID;

if (!MODEL) {
  throw new Error("MODEL_ID is required");
}

const client = new OpenAI({
  baseURL: Bun.env.OPENAI_BASE_URL ?? Bun.env.BASE_URL,
  apiKey: Bun.env.OPENAI_API_KEY ?? Bun.env.ANTHROPIC_API_KEY,
});

type JsonSchema = Record<string, unknown>;
type ToolArgs = Record<string, unknown>;
type ToolHandler = (args: ToolArgs) => string | Promise<string>;

interface SkillManifest {
  name: string;
  description: string;
  path: string;
}

interface SkillDocument {
  manifest: SkillManifest;
  body: string;
}

class SkillRegistry {
  private readonly documents = new Map<string, SkillDocument>();

  constructor(private readonly skillsDir: string) {
    this.loadAll();
  }

  describeAvailable(): string {
    if (this.documents.size === 0) return "(no skills available)";

    return [...this.documents.keys()]
      .sort()
      .map((name) => {
        const manifest = this.documents.get(name)!.manifest;
        return `- ${manifest.name}: ${manifest.description}`;
      })
      .join("\n");
  }

  loadFullText(name: string): string {
    const document = this.documents.get(name);
    if (!document) {
      const known = [...this.documents.keys()].sort().join(", ") || "(none)";
      return `Error: Unknown skill '${name}'. Available skills: ${known}`;
    }

    return `<skill name="${document.manifest.name}">\n${document.body}\n</skill>`;
  }

  private loadAll(): void {
    if (!fs.existsSync(this.skillsDir)) return;

    for (const skillPath of this.findSkillFiles(this.skillsDir).sort()) {
      const text = fs.readFileSync(skillPath, "utf8");
      const { meta, body } = this.parseFrontmatter(text);
      const name = meta.name ?? path.basename(path.dirname(skillPath));
      const description = meta.description ?? "No description";

      this.documents.set(name, {
        manifest: { name, description, path: skillPath },
        body: body.trim(),
      });
    }
  }

  private findSkillFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.findSkillFiles(fullPath));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(fullPath);
      }
    }

    return files;
  }

  private parseFrontmatter(text: string): {
    meta: Record<string, string>;
    body: string;
  } {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { meta: {}, body: text };

    const meta: Record<string, string> = {};
    for (const line of match[1].trim().split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;

      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key) meta[key] = value;
    }

    return { meta, body: match[2] };
  }
}

const SKILL_REGISTRY = new SkillRegistry(SKILLS_DIR);

const SYSTEM_PROMPT = `You are a coding agent at ${WORKDIR}.
Use load_skill when a task needs specialized instructions before you act.
Skills available:
${SKILL_REGISTRY.describeAvailable()}
`;

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

  return await new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: WORKDIR,
      timeout: 120_000,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;

      const output = (stdout + stderr).trim() || "(no output)";
      resolve(output.slice(0, 50_000));
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve(`Error: ${error.message}`);
    });
  });
}

function runRead(filePath: string, limit?: number): string {
  try {
    let lines = fs.readFileSync(safePath(filePath), "utf8").split(/\r?\n/);

    if (limit && limit < lines.length) {
      lines = lines
        .slice(0, limit)
        .concat([`... (${lines.length - limit} more lines)`]);
    }

    return lines.join("\n").slice(0, 50_000);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const resolved = safePath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const resolved = safePath(filePath);
    const content = fs.readFileSync(resolved, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }

    fs.writeFileSync(resolved, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function getStringArg(args: ToolArgs, name: string): string {
  const value = args[name];
  if (typeof value !== "string") {
    throw new Error(`Missing or invalid string argument: ${name}`);
  }
  return value;
}

function getOptionalNumberArg(args: ToolArgs, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Error(`Invalid number argument: ${name}`);
  }
  return value;
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => runBash(getStringArg(args, "command")),
  read_file: (args) =>
    runRead(getStringArg(args, "path"), getOptionalNumberArg(args, "limit")),
  write_file: (args) =>
    runWrite(getStringArg(args, "path"), getStringArg(args, "content")),
  edit_file: (args) =>
    runEdit(
      getStringArg(args, "path"),
      getStringArg(args, "old_text"),
      getStringArg(args, "new_text"),
    ),
  load_skill: (args) => SKILL_REGISTRY.loadFullText(getStringArg(args, "name")),
};

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function tool(
  name: string,
  description: string,
  parameters: JsonSchema,
): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters,
    },
  };
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  tool(
    "bash",
    "Run a shell command.",
    objectSchema(
      {
        command: { type: "string" },
      },
      ["command"],
    ),
  ),
  tool(
    "read_file",
    "Read file contents.",
    objectSchema(
      {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      ["path"],
    ),
  ),
  tool(
    "write_file",
    "Write content to a file.",
    objectSchema(
      {
        path: { type: "string" },
        content: { type: "string" },
      },
      ["path", "content"],
    ),
  ),
  tool(
    "edit_file",
    "Replace exact text in a file once.",
    objectSchema(
      {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      ["path", "old_text", "new_text"],
    ),
  ),
  tool(
    "load_skill",
    "Load the full body of a named skill into the current context.",
    objectSchema(
      {
        name: { type: "string" },
      },
      ["name"],
    ),
  ),
];

function parseToolArguments(rawArguments: string): ToolArgs {
  try {
    const parsed = JSON.parse(rawArguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as ToolArgs;
  } catch {
    return {};
  }
}

function extractText(
  content: OpenAI.Chat.ChatCompletionMessageParam["content"],
): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function agentLoop(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<void> {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools: TOOLS,
      max_tokens: 8000,
    });

    const assistantMessage = response.choices[0]?.message;
    if (!assistantMessage) return;

    messages.push({
      role: "assistant",
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (response.choices[0]?.finish_reason !== "tool_calls" || toolCalls.length === 0) {
      return;
    }

    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") continue;

      const name = toolCall.function.name;
      const handler = TOOL_HANDLERS[name];
      let output: string;

      try {
        const args = parseToolArguments(toolCall.function.arguments);
        output = handler ? await handler(args) : `Unknown tool: ${name}`;
      } catch (error) {
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }

      console.log(`> ${name}: ${output.slice(0, 200)}`);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: output,
      });
    }
  }
}

async function main(): Promise<void> {
  const history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms05 >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (query) => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "exit" || trimmed === "") {
      rl.close();
      return;
    }

    history.push({ role: "user", content: query });

    try {
      await agentLoop(history);
      const finalText = extractText(history[history.length - 1]?.content);
      if (finalText) console.log(finalText);
      console.log();
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }

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
