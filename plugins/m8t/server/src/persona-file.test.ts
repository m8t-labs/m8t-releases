import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readPersonaFrontmatter } from "./persona-file.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("readPersonaFrontmatter", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-pf-test-"));
    await fs.mkdir(path.join(repoRoot, "personas", "cmo"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("parses role + description from a persona with role field", async () => {
    const personaPath = path.join(repoRoot, "personas", "cmo", "persona.md");
    await fs.writeFile(
      personaPath,
      [
        "---",
        "name: cmo",
        "role: CMO",
        "description: Chief Marketing Officer — brand, growth, demand-gen",
        "version: 0.2",
        "---",
        "body content here",
      ].join("\n"),
    );
    const result = await readPersonaFrontmatter({ repoRoot, persona: "cmo" });
    expect(result?.role).toBe("CMO");
    expect(result?.description).toBe("Chief Marketing Officer — brand, growth, demand-gen");
  });

  it("returns role: null when the persona file omits the role field", async () => {
    const personaPath = path.join(repoRoot, "personas", "cmo", "persona.md");
    await fs.writeFile(
      personaPath,
      [
        "---",
        "name: cmo",
        "description: Just description, no role.",
        "version: 0.1",
        "---",
      ].join("\n"),
    );
    const result = await readPersonaFrontmatter({ repoRoot, persona: "cmo" });
    expect(result?.role).toBeNull();
    expect(result?.description).toBe("Just description, no role.");
  });

  it("returns null for a persona that doesn't exist", async () => {
    const result = await readPersonaFrontmatter({ repoRoot, persona: "ghost" });
    expect(result).toBeNull();
  });
});
