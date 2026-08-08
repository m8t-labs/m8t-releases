# m8t — Claude Code plugin

> 📖 Reference for the Claude Code plugin and its MCP **server** that let a session call deployed virtual workers.

## What it is

A local-first Claude Code **plugin** (slash commands + a routing skill) backed by an **MCP server** (`server/`) that lists, sends-to, and checks-on virtual workers deployed in Microsoft Agent Foundry. The plugin is the install artifact; the MCP server is the engine it ships.

## What's in this plugin

- **MCP server** (`server/`) — TypeScript stdio server that lists, sends-to, and checks-on virtual workers.
- **Static slash command** (`commands/workers.md`) — `/m8t:workers` for inventory + manual refresh.
- **Routing skill** (`skills/m8t-routing/SKILL.md`) — teaches the LLM the free-text `@<name>` mention convention.
- **Dynamic per-worker commands** — written at runtime by the MCP server into the user's `~/.claude/commands/` directory. These appear as bare `/carolyn` etc., not namespaced.

## Install

```bash
claude plugin marketplace add m8t-labs/m8t-releases
claude plugin install m8t@m8t
```

## Uninstall

See [`guides/uninstall/m8t-plugin.md`](https://github.com/m8t-labs/ezra/blob/main/guides/uninstall/m8t-plugin.md).

## Develop

**Bump the version on every change — in ONE place.** `claude plugin update` keys
off the `version` in `.claude-plugin/plugin.json`; an unchanged version makes the
update **silently no-op** (`already at the latest version`), leaving the installed
copy stale even though the marketplace's directory source points at the live repo.
The version now has a **single source of truth: `server/package.json`**. Bump it
there, then `pnpm build` — which runs `scripts/sync-plugin-version.mjs` to
propagate it into `.claude-plugin/plugin.json`, and the server reads it at runtime
via `src/version.ts` (`SERVER_VERSION`). **Never hand-edit `plugin.json`'s
`version`** — it is derived, and a manual bump drifts ahead of the source until
the next rebuild silently *regresses* it (a backwards version breaks
`claude plugin update`). The `plugin-version-check` CI gate
(`scripts/maybe-bump-plugin-version.mjs --check`) asserts on **every PR** that
`.claude-plugin/plugin.json` equals `server/package.json`, so a manual manifest
edit — or a `package.json` bump that wasn't rebuilt — fails the PR.
(`src/version.test.ts` mirrors the same assertion; the `server/` suite is a
workspace package, so it runs under `turbo run test` alongside everything else.)
To force a refresh of an installed copy regardless of
version: `claude plugin uninstall m8t@m8t && claude plugin install m8t@m8t`.

The MCP server (`server/`) **is** a workspace package (`pnpm-workspace.yaml`
lists `plugins/m8t/server`), so a plain `pnpm install` at the repository root
installs its dev dependencies along with everything else. There is nothing to
install inside `server/` and no separate lockfile — an earlier note here
described a `pnpm install --ignore-workspace` workflow that had stopped being
either true or necessary.

The server bundles via **tsup** (`pnpm build` → a single `dist/index.js`), and
that one file is the **whole program**: every non-builtin is inlined, including
the seven npm runtime dependencies. It has to be. The plugin is distributed as
committed files with no install step, `server/node_modules` is gitignored, and
nothing ever created one on a consumer's machine — so while the dependencies
were left external the shipped server died on its first import with
`ERR_MODULE_NOT_FOUND`, on every clean profile, in silence. It only ever ran on
a machine that happened to have run a workspace install.

Consequences worth knowing before changing the build:

- **A dependency bump changes what ships.** `dist/index.js` moves when the
  lockfile does, with no source edit — which is why the version guard treats the
  shipped file, and every file the mirror publishes, as a trigger.
- **No sourcemap.** Bundling vendor code takes it to ~11 MB, Node reads it only
  under `--enable-source-maps`, and it would be republished in full into the
  public repository founders clone. The bundle stays unminified instead, so a
  stack frame still names a readable location.
- **`scripts/check-plugin-boot.mjs` is the check that matters.** It lays out the
  mirrored file set somewhere with no `node_modules` reachable and speaks MCP to
  the server. Nothing else in CI runs the artifact.

`pnpm typecheck` resolves `@m8t-stack/agent-ledger` via `tsconfig.json` `paths`
to that package's **built** declarations (`packages/agent-ledger/dist/esm/index.d.ts`)
— pointing at the source instead trips TS's `rootDir` check — so
`packages/agent-ledger` must be built first. The root `pnpm install` handles this
via the package's `prepare` script (same pattern as `@m8t-stack/api-contract`).
(`pnpm test` uses the source directly via the vitest/esbuild alias, which is
extension-agnostic and needs no prior build.)
