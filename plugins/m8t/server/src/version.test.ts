import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "./version.js";

function readJson(rel: string): { version: string } {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
  );
}

describe("MCP version single source of truth", () => {
  it("SERVER_VERSION is read from server/package.json", () => {
    expect(SERVER_VERSION).toBe(readJson("../package.json").version);
  });

  // Guards against drift: the plugin manifest version must equal the package
  // version. `scripts/sync-plugin-version.mjs` (in `pnpm build`) keeps them
  // equal — if this fails, you bumped package.json but didn't rebuild.
  it("plugin.json version is synced to package.json (run `pnpm build` if this fails)", () => {
    expect(readJson("../../.claude-plugin/plugin.json").version).toBe(
      readJson("../package.json").version,
    );
  });
});
