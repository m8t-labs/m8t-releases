import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { rmSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveArtifact, artifactRoot } from "./artifact-store.js";

// Redirect the artifact root to a tmpdir — the suite must never wipe a real
// developer's ~/.m8t/artifacts (the live MCP writes there).
beforeAll(() => { process.env.M8T_ARTIFACT_ROOT = mkdtempSync(path.join(os.tmpdir(), "m8t-art-")); });
afterAll(() => { rmSync(artifactRoot(), { recursive: true, force: true }); delete process.env.M8T_ARTIFACT_ROOT; });
afterEach(() => { rmSync(artifactRoot(), { recursive: true, force: true }); });

describe("saveArtifact", () => {
  it("writes bytes under <root>/<session>/ and returns the abs path", () => {
    const p = saveArtifact("sessABC", "chart.png", Buffer.from("PNGDATA"));
    expect(p.startsWith(path.join(artifactRoot(), "sessABC"))).toBe(true);
    expect(readFileSync(p).toString()).toBe("PNGDATA");
  });
  it("sanitizes a name with path separators (no traversal)", () => {
    const p = saveArtifact("s", "../../etc/passwd", Buffer.from("x"));
    expect(p.includes("..")).toBe(false);
    expect(existsSync(p)).toBe(true);
  });
});
