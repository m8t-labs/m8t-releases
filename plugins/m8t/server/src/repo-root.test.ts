import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readRepoRoot } from "./repo-root.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("readRepoRoot", () => {
  let tmpDir: string;
  let pointerPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-rr-test-"));
    pointerPath = path.join(tmpDir, "repo-root");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the trimmed contents of the pointer file", async () => {
    await fs.writeFile(pointerPath, "/Users/test/m8t\n", "utf-8");
    expect(await readRepoRoot(pointerPath)).toBe("/Users/test/m8t");
  });

  it("throws with a clear remediation when the file is missing", async () => {
    await expect(readRepoRoot(pointerPath)).rejects.toThrow(/m8t isn't installed/);
  });

  it("references the installer, not the in-repo install.md, in the remediation", async () => {
    // The pointer file (~/.m8t/repo-root) is written by install/m8t.md
    // which is invoked by the installer. A plugin user installing via Claude
    // Code's plugin marketplace likely does not have the repo cloned, so
    // pointing them at "install.md from the repo" is wrong.
    await expect(readRepoRoot(pointerPath)).rejects.toThrow(/installer/i);
    await expect(readRepoRoot(pointerPath)).rejects.toThrow(/m8t-labs\/m8t/i);
  });
});
