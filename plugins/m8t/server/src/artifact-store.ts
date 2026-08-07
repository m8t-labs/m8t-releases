import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LocalArtifact { name: string; localPath: string; mime: string; size: number; }

export function artifactRoot(): string {
  // M8T_ARTIFACT_ROOT lets tests redirect to a tmpdir so the suite never
  // touches a developer's real downloaded artifacts under ~/.m8t.
  return process.env.M8T_ARTIFACT_ROOT ?? path.join(os.homedir(), ".m8t", "artifacts");
}

/** Persist artifact bytes locally so Claude Code can open them. Returns the
 *  absolute path. `name` is basename-sanitized (no traversal). Same-named
 *  files in one session are last-write-wins (intentional — no dedup). */
export function saveArtifact(sessionId: string, name: string, bytes: Buffer): string {
  const safeName = path.basename(name) || "artifact";
  const dir = path.join(artifactRoot(), path.basename(sessionId) || "session");
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName);
  writeFileSync(dest, bytes);
  return dest;
}
