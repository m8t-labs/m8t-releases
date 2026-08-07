import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncCommandsToFs } from "./sync-commands.js";
import type { WorkerRecord } from "./worker-builder.js";

const w = (name: string, role: string | null = "X"): WorkerRecord => ({
  name,
  displayName: name,
  role,
  description: "d",
  persona: null,
  personaVersion: null,
  agentId: name,
  projectEndpoint: "x",
  model: "m",
  deployedAt: null,
  kind: "prompt",
});

describe("syncCommandsToFs", () => {
  let cmdDir: string;

  beforeEach(async () => {
    cmdDir = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-sync-"));
  });

  afterEach(async () => {
    await fs.rm(cmdDir, { recursive: true, force: true });
  });

  it("writes new files for added workers", async () => {
    const report = await syncCommandsToFs({
      commandsDir: cmdDir,
      previous: [],
      current: [w("alice"), w("bob")],
    });
    const files = (await fs.readdir(cmdDir)).sort();
    expect(files).toEqual(["alice.md", "bob.md"]);
    expect(report.added).toEqual(["alice", "bob"]);
  });

  it("removes files for removed workers (only those we wrote)", async () => {
    await syncCommandsToFs({ commandsDir: cmdDir, previous: [], current: [w("alice")] });
    const report = await syncCommandsToFs({
      commandsDir: cmdDir,
      previous: [w("alice")],
      current: [],
    });
    const files = await fs.readdir(cmdDir);
    expect(files).toEqual([]);
    expect(report.removed).toEqual(["alice"]);
  });

  it("does NOT overwrite an existing file lacking the magic key (collision)", async () => {
    const userFile = path.join(cmdDir, "carolyn.md");
    await fs.writeFile(userFile, "---\ndescription: user's own command\n---\nuser content");
    const report = await syncCommandsToFs({
      commandsDir: cmdDir,
      previous: [],
      current: [w("carolyn", "CMO")],
    });
    const content = await fs.readFile(userFile, "utf-8");
    expect(content).toMatch(/user content/);
    expect(report.collisions).toEqual(["carolyn"]);
  });
});
