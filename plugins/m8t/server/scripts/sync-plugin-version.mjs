// Sync the plugin manifest version from the server package version (the single
// source of truth). Runs as the first step of `pnpm build`. Idempotent.
//
// Why: `claude plugin update` keys off `.claude-plugin/plugin.json`'s `version`.
// Keeping it derived from `server/package.json` means you bump the version in
// ONE place and the rebuild propagates it. (See plugins/m8t/README.md.)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const pluginPath = fileURLToPath(
  new URL("../../.claude-plugin/plugin.json", import.meta.url),
);

const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
const previous = plugin.version;

if (previous === version) {
  console.log(`[sync-plugin-version] plugin.json already at ${version}`);
} else {
  plugin.version = version;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
  console.log(`[sync-plugin-version] plugin.json ${previous} → ${version}`);
}
