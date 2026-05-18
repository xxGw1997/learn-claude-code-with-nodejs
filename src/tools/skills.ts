import * as fs from "fs";
import * as path from "node:path";
import { WORKDIR } from "../config";

interface SkillManifest {
  name: string;
  description: string;
  path: string;
}

interface SkillDocument {
  manifest: SkillManifest;
  body: string;
}

const SKILLS_DIR = path.join(WORKDIR, "skills");
const SKILL_NAME = "SKILL.md";

class SkillRegistry {
  private readonly documents = new Map<string, SkillDocument>();

  constructor(private readonly skillsDir: string) {
    if (!fs.existsSync(this.skillsDir)) return;

    for (const skillPath of this.listSkillsFiles(this.skillsDir).sort()) {
      const text = fs.readFileSync(skillPath, "utf8");
      const { meta, body } = this.parseFrontmatter(text);

      const name = meta.name?.trim() ?? path.basename(path.dirname(skillPath));
      const description = meta.description ?? "No description";
      this.documents.set(name, {
        manifest: { name, description, path: skillPath },
        body,
      });
    }
  }

  listAvailableSkills(): string {
    if (this.documents.size === 0) return "(no skills available)";

    return [...this.documents.keys()]
      .sort()
      .map((name) => {
        const manifest = this.documents.get(name)!.manifest;
        return `- ${manifest.name}: ${manifest.description}`;
      })
      .join("\n");
  }

  listSkillsFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.listSkillsFiles(fullPath));
      } else if (entry.isFile() && entry.name === SKILL_NAME) {
        files.push(fullPath);
      }
    }
    return files;
  }

  loadSkillFullText(name: string): string {
    const document = this.documents.get(name);
    if (!document) {
      const known = [...this.documents.keys()].sort().join(", ") || "(none)";
      return `Error: Unknown skill '${name}'. Available skills: ${known}`;
    }
    return `<skill name="${document.manifest.name}">\n${document.body}\n</skill>`;
  }

  parseFrontmatter(text: string): {
    meta: Record<string, string>;
    body: string;
  } {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { meta: {}, body: text };
    const meta: Record<string, string> = {};
    const [_, metaLines, body] = match;

    if (!metaLines) return { meta: {}, body: text };
    for (const line of metaLines.trim().split(/\r?\n/)) {
      const [key, value] = line.split(":");
      if (!key || !value) continue;
      meta[key] = value;
    }
    return { meta, body: body?.trim() ?? "" };
  }
}

export const SKILL_REGISTRY = new SkillRegistry(SKILLS_DIR);
