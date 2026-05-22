import * as readline from "node:readline/promises";
import * as path from "path";
import * as fs from "fs";
import { WORKDIR } from "..";

/*================  PERMISSION MODELS  ===================*/

const MODES = ["DEFAULT", "PLAN", "AUTO"] as const;
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

function isWorkspaceTrusted(workspace = WORKDIR): boolean {
  const trustMarker = path.join(workspace, ".claude", ".claude_trusted");
  return fs.existsSync(trustMarker);
}

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

const DEFAULT_RULES: PermissionRule[] = [
  { tool: "bash", content: "rm -f /", behavior: "deny" },
  { tool: "bash", content: "sudo *", behavior: "deny" },
  { tool: "read_file", content: "*", behavior: "allow" },
];

export class BashSecurityValidator {
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
      return "No issue detected";
    }

    return `Security flags: ${failures.map(([name, pattern]) => `${name} (pattern: ${pattern})`).join(", ")}`;
  }
}

const bashValidator = new BashSecurityValidator();

export class PermissionManager {
  mode: PermissionMode;
  rules: PermissionRule[];
  consecutiveDenials = 0;
  maxConsecutiveDenials = 3;

  constructor(
    mode: PermissionMode = "DEFAULT",
    rules: PermissionRule[] = DEFAULT_RULES,
  ) {
    if (!MODES.includes(mode)) {
      throw new Error(`Unknown mode: ${mode}. Choose from ${MODES.join(", ")}`);
    }

    this.mode = mode;
    this.rules = [...rules];
  }

  check(
    toolName: string,
    toolInput: ToolInput,
  ): { behavior: PermissionBehavior; reason: string } {
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
        return {
          behavior: "deny",
          reason: `Blocked by deny rule: ${JSON.stringify(rule)}`,
        };
      }
    }

    if (this.mode === "PLAN") {
      if (WRITE_TOOLS.has(toolName)) {
        return {
          behavior: "deny",
          reason: "Plan mode: write operations are blocked",
        };
      }

      return { behavior: "allow", reason: "Plan mode: read-only allowed" };
    }

    if (this.mode === "AUTO" && READ_ONLY_TOOLS.has(toolName)) {
      return {
        behavior: "allow",
        reason: "Auto mode: read-only tool auto-approved",
      };
    }

    for (const rule of this.rules) {
      if (
        rule.behavior === "allow" &&
        this.matches(rule, toolName, toolInput)
      ) {
        this.consecutiveDenials = 0;
        return {
          behavior: "allow",
          reason: `Matched allow rule: ${JSON.stringify(rule)}`,
        };
      }
    }

    return {
      behavior: "ask",
      reason: `No rule matched for ${toolName}, asking user`,
    };
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


  private matches(
    rule: PermissionRule,
    toolName: string,
    toolInput: ToolInput,
  ): boolean {
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
