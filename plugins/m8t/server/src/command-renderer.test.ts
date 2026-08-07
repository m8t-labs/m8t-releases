import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { renderCommandFile, parseExistingMagicKey } from "./command-renderer.js";
import type { WorkerRecord } from "./worker-builder.js";

const sample: WorkerRecord = {
  name: "carolyn",
  displayName: "Carolyn",
  role: "CMO",
  description: "owns brand, growth, and demand-gen",
  persona: "cmo",
  personaVersion: "0.2",
  agentId: "asst_x",
  projectEndpoint: "x",
  model: "gpt-4.1-mini",
  deployedAt: null,
  kind: "prompt",
};

describe("renderCommandFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-cr-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a slash command file with the magic key and a CMO — description line", async () => {
    const target = path.join(tmpDir, "carolyn.md");
    await renderCommandFile(sample, target);
    const content = await fs.readFile(target, "utf-8");
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/m8t-generated: true/);
    expect(content).toMatch(/description: "CMO — owns brand, growth, and demand-gen"/);
    expect(content).toMatch(/send_to_worker/);
    expect(content).toMatch(/name="carolyn"/);
  });

  it("handles workers with null role by omitting the role tag", async () => {
    const target = path.join(tmpDir, "noname.md");
    await renderCommandFile({ ...sample, role: null }, target);
    const content = await fs.readFile(target, "utf-8");
    expect(content).toMatch(/description: "owns brand, growth, and demand-gen"/);
  });

  it("escapes YAML-special characters in the description (round-trip via parser)", async () => {
    const target = path.join(tmpDir, "weird.md");
    // A future persona with `:` and `"` in the description would corrupt the
    // frontmatter without explicit quoting + escaping.
    const tricky = "needs colon: yes, quote \"x\" and leading-dash issues";
    await renderCommandFile({ ...sample, role: null, description: tricky }, target);
    const content = await fs.readFile(target, "utf-8");
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
    expect(fmMatch).not.toBeNull();
    const fm = parseYaml(fmMatch![1]) as { description: string };
    expect(fm.description).toBe(tricky);
  });
});

describe("parseExistingMagicKey", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-pk-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns true for files we wrote", async () => {
    const fp = path.join(tmpDir, "x.md");
    await fs.writeFile(fp, "---\nm8t-generated: true\n---\nbody");
    expect(await parseExistingMagicKey(fp)).toBe(true);
  });

  it("returns false for files we did not write", async () => {
    const fp = path.join(tmpDir, "x.md");
    await fs.writeFile(fp, "---\ndescription: a user command\n---\n");
    expect(await parseExistingMagicKey(fp)).toBe(false);
  });

  it("returns false for non-existent files", async () => {
    expect(await parseExistingMagicKey(path.join(tmpDir, "ghost.md"))).toBe(false);
  });
});
