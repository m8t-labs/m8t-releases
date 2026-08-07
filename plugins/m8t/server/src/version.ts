import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for the MCP server version: `server/package.json`.
 *
 * Read at runtime (from the package.json that ships alongside the bundle) so the
 * server's self-reported MCP-handshake version can never drift from the package
 * manifest. The plugin manifest (`.claude-plugin/plugin.json`) is kept in sync
 * from this same source by `scripts/sync-plugin-version.mjs` (runs first in
 * `pnpm build`), and `version.test.ts` asserts the two match.
 *
 * To release: bump the version in ONE place — `server/package.json` — then
 * `pnpm build` (which syncs `plugin.json` and rebuilds the committed `dist/`).
 */
export const SERVER_VERSION: string = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { version: string }
).version;
