import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface PersonaFrontmatter {
  name: string;
  role: string | null;
  description: string;
}

interface Args {
  repoRoot: string;
  persona: string;
}

export async function readPersonaFrontmatter(args: Args): Promise<PersonaFrontmatter | null> {
  const filePath = path.join(args.repoRoot, "personas", args.persona, "persona.md");
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!match) return null;

  const fm = parseYaml(match[1]) as {
    name?: string;
    role?: string;
    description?: string;
  } | null;
  if (!fm?.name || !fm.description) return null;

  return {
    name: fm.name,
    role: fm.role ?? null,
    description: fm.description,
  };
}
