import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { z } from "zod";
import { WORKDIR } from "..";
import type OpenAI from "openai";
import { runSubAgent, RunSubAgentArgsSchema } from "./run-sub-agent";

const BashArgsSchema = z
  .object({
    command: z.string().describe("Command to execute in the workspace"),
  })
  .strict();

const ReadFileArgsSchema = z
  .object({
    path: z.string().describe("File path to read"),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const WriteFileArgsSchema = z
  .object({
    path: z.string().describe("File path to write"),
    content: z.string().describe("File content"),
  })
  .strict();

const EditFileArgsSchema = z
  .object({
    path: z.string().describe("File path to edit"),
    old_text: z.string().describe("Text to replace"),
    new_text: z.string().describe("Replacement text"),
  })
  .strict();

const TOOL_SCHEMAS = {
  runBash: BashArgsSchema,
  runRead: ReadFileArgsSchema,
  runWrite: WriteFileArgsSchema,
  runEdit: EditFileArgsSchema,
} as const;

function safePath(pathStr: string): string {
  const resolvedPath = path.resolve(WORKDIR, pathStr);
  if (!resolvedPath.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${pathStr}`);
  }
  return resolvedPath;
}

const toolHandler = {
  runBash(command: string): Promise<string> {
    return new Promise((resolve) => {
      const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
      if (dangerous.some((item) => command.includes(item))) {
        resolve("Error: Dangerous command blocked");
        return;
      }

      const child = spawn(command, {
        shell: true,
        cwd: WORKDIR,
        timeout: 120000,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        const output = (stdout + stderr).trim() || "(no output)";
        resolve(output);
      });

      child.on("error", (err) => {
        resolve(`Error: ${err.message}`);
      });
    });
  },

  runRead(filePath: string, toolUseId: string, limit?: number): string {
    try {
      const content = fs.readFileSync(safePath(filePath), "utf-8");
      let lines = content.split("\n");

      if (limit && limit < lines.length) {
        lines = lines
          .slice(0, limit)
          .concat([`... (${lines.length - limit} more lines)`]);
      }

      const output = lines.join("\n");
      return output;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  runWrite(filePath: string, content: string): string {
    try {
      const fullPath = safePath(filePath);
      const dir = path.dirname(fullPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, content);
      return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  runEdit(filePath: string, oldText: string, newText: string): string {
    try {
      const fullPath = safePath(filePath);
      const content = fs.readFileSync(fullPath, "utf-8");

      if (!content.includes(oldText)) {
        return `Error: Text not found in ${filePath}`;
      }

      const newContent = content.replace(oldText, newText);
      fs.writeFileSync(fullPath, newContent);
      return `Edited ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
} as const;

export function genTool<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: z.toJSONSchema(schema) as Record<string, unknown>,
    },
  };
}

export const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  genTool("runBash", "Run a shell command.", TOOL_SCHEMAS.runBash),
  genTool("runRead", "Read file contents.", TOOL_SCHEMAS.runRead),
  genTool("runWrite", "Run a shell command.", TOOL_SCHEMAS.runWrite),
  genTool("runEdit", "Run a shell command.", TOOL_SCHEMAS.runEdit),
];

function genInvalidArgsError(name: string, message: string) {
  return `Error: Invalid arguments for ${name}: ${message}`;
}

export async function executeTool(
  name: string,
  args: unknown,
  toolCallId: string,
): Promise<string> {
  switch (name) {
    case "runBash": {
      const parsed = TOOL_SCHEMAS.runBash.safeParse(args);
      if (!parsed.success)
        return genInvalidArgsError(name, parsed.error.message);
      return await toolHandler.runBash(parsed.data.command);
    }
    case "runRead": {
      const parsed = TOOL_SCHEMAS.runRead.safeParse(args);
      if (!parsed.success)
        return genInvalidArgsError(name, parsed.error.message);
      return toolHandler.runRead(
        parsed.data.path,
        toolCallId,
        parsed.data.limit,
      );
    }
    case "runWrite": {
      const parsed = TOOL_SCHEMAS.runWrite.safeParse(args);
      if (!parsed.success)
        return genInvalidArgsError(name, parsed.error.message);
      return toolHandler.runWrite(parsed.data.path, parsed.data.content);
    }
    case "runEdit": {
      const parsed = TOOL_SCHEMAS.runEdit.safeParse(args);
      if (!parsed.success)
        return genInvalidArgsError(name, parsed.error.message);

      return toolHandler.runEdit(
        parsed.data.path,
        parsed.data.old_text,
        parsed.data.new_text,
      );
    }
    case "runSubAgent": {
      const parsed = RunSubAgentArgsSchema.safeParse(args);
      if (!parsed.success)
        return genInvalidArgsError(name, parsed.error.message);

      console.log(`> subAgent (${parsed.data.description})`);
      return runSubAgent(parsed.data.prompt);
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
