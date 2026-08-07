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
(`src/version.test.ts` mirrors the same assertion, but the `server/` suite is
outside the pnpm workspace and so does **not** run in the workspace CI — the gate
is the enforcing check.) To force a refresh of an installed copy regardless of
version: `claude plugin uninstall m8t@m8t && claude plugin install m8t@m8t`.

The MCP server (`server/`) is a standalone plugin — it is **not** part of the
pnpm workspace. Installing its deps requires `pnpm install --ignore-workspace`
from `plugins/m8t/server/` (a plain `pnpm install` there runs in workspace
scope and misbehaves).

The server bundles via **tsup** (`pnpm build` → a single `dist/index.js`). It
inlines the pure `@m8t-stack/agent-ledger` core from source via a build-time
esbuild alias — nothing about the ledger appears in the server's
`package.json`/lockfile/consumer install. The runtime dep `@azure/data-tables`
is explicit in `package.json` and covers the agent-ledger writes.

`pnpm typecheck` resolves `@m8t-stack/agent-ledger` via `tsconfig.json` `paths`
to that package's **built** declarations (`packages/agent-ledger/dist/esm/index.d.ts`)
— pointing at the source instead trips TS's `rootDir` check — so
`packages/agent-ledger` must be built first. The root `pnpm install` handles this
via the package's `prepare` script (same pattern as `@m8t-stack/api-contract`).
(`pnpm test` uses the source directly via the vitest/esbuild alias, which is
extension-agnostic and needs no prior build.)
