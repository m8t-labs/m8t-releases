---
name: m8t-cli
description: Use when the user wants to manage their m8t deployment's team or channel bindings via the `m8t` CLI — adding/listing/showing/removing team members and their channel identities (Telegram/Slack/Teams), or wiring/listing/inspecting/removing bot-to-worker bindings, or deploying/tearing down the hosted coding agent (`coder` group), or operating the deployment itself — checking local status/health (`m8t status`, `m8t doctor`), re-pointing the CLI at another tenant/subscription (`m8t switch`, `m8t config set`), opening the deployed webapp / Foundry portal / resource group in a browser (`m8t open`), or deploying/updating the gateway stack (`m8t deploy`). Shells out to `m8t` through Bash. Triggers on requests like "add Ilan to the team", "show me everyone on the team", "bind the CMO to a Telegram bot with this token", "list the bindings", "remove the cmo-tg binding", "deploy the coding agent", "spin up a coder", "check my m8t setup", "is my deployment healthy", "what tenant am I on", "switch to my startup subscription", "open the webapp", "deploy/update the gateway". NOT for talking to a worker (that's the per-worker /<name> commands and @<name> routing) — this is admin management.
---

# m8t-cli — manage teams, bindings & the hosted coding agent via the `m8t` CLI

The `m8t` CLI manages an m8t deployment: **team members** (who is allowed to talk to the workers, and their per-channel identities), **bindings** (which bot, on which channel, routes to which Foundry worker), **the hosted coding agent** (deploy/teardown the curated Python coding-agent image as a hosted Foundry worker), the **local CLI context** (`status` / `doctor` / `switch` / `config` — your identity, the `~/.m8t/config.yaml`, and which deployment the CLI points at), **opening the deployment in a browser** (`open`), and **the gateway stack itself** (`deploy` — provision/update the infrastructure). When the user asks to manage any of these, shell out to `m8t` via Bash.

**This is admin/management — not how you talk to a worker.** Talking to a worker is the per-worker `/<name>` slash commands and the `@<name>` mention routing (the `m8t-routing` skill). If the user wants a worker to *do* something, this is the wrong skill.

## How to run

- Invoke `m8t <group> <verb> …` through Bash.
- Add `--output json` when you need to parse the result, then render it back as a short, clean summary or table — **never dump raw JSON at the user**.
- The CLI authenticates with the user's existing `az login`. There is nothing to wire up.

## Prerequisites — stay lazy, let the CLI tell you

Don't pre-flight every check. Run the command the user asked for, and react only when the CLI reports a problem:

- **`m8t: command not found`** → the CLI isn't installed. See [Installing the `m8t` CLI](#installing-the-m8t-cli) and offer to install it.
- **An auth error** (not signed in / login expired / wrong tenant) → the CLI's error already names the fix (`az login`, or `az login --tenant <id>`). Surface it and offer to run it. `az login` is interactive and opens a browser — say so before running it.

Optionally, at the **first** m8t task in a session, run `m8t whoami` once as a health check — it prints your identity, the gateway it will talk to, and whether your `az` tenant matches the gateway's. If it errors or reports a tenant mismatch, relay its hint verbatim.

## Confirm before you change anything

**Read-only — run immediately, no confirmation:**
`m8t whoami`, `m8t version`, `m8t status`, `m8t doctor`, `m8t config show`, `m8t switch --list`, `m8t open` (opens a browser tab — harmless), `m8t team list`, `m8t team show`, `m8t bind list`, `m8t bind show`.

**Mutating — show the exact command and get an explicit "yes" first:**
`m8t config set`, `m8t switch`, `m8t team add`, `m8t team add-identity`, `m8t team remove-identity`, `m8t team remove`, `m8t bind add`, `m8t bind remove`, `m8t bind cleanup`, `m8t coder deploy`, `m8t coder teardown`, `m8t azure-exec deploy`, `m8t agent remove`.

**`m8t deploy` is the heaviest mutation — it provisions/updates Azure infrastructure.** Confirm carefully, and prefer previewing with `az deployment group create --what-if` first (the deploy is *declarative* — re-running it can revert hand-modifications made to a live stack). For an operator who can't create Entra app registrations (a directory guest), it **must** be run with `--client-id <existing-appId>` (which skips all Microsoft Graph writes).

**The bot token is a secret.** When you confirm a `bind add`, show the command with the token redacted — e.g. `m8t bind add telegram --worker cmo --bot-token <the token you gave me> --slug cmo-tg`. Never echo the real token, never put it in a summary, never log it. Pass it to the CLI exactly once.

## Reading CLI output

Exit codes: `0` success · `1` failure · `2` user-cancelled.

On failure, the CLI writes a structured error to stderr (`{ code, message, details }`), often with a `hint:` line. **Surface the `message` — and the `hint` if present — verbatim. Do not paraphrase.** The hints contain the exact remediation command; relaying them accurately beats your rewording.

| What you see | What to tell the user |
|---|---|
| not signed in / login expired / wrong tenant | Relay the CLI's `az login [--tenant <id>]` instruction; offer to run it (interactive, opens a browser). |
| `m8t: command not found` | Offer to install the CLI (below). |
| `no_adapter_registered` for `telegram` | This gateway doesn't have the Telegram adapter deployed yet. |
| `webhook_registration_rejected` | Telegram rejected the bot token — ask the user to re-check it from BotFather (wrong or revoked). |
| `webhook_registration_failed` | Telegram was unreachable — try again in a moment. |
| `binding_exists` / `handle_exists` | The hint names the exact next command (`bind show`/`bind remove`, or `team add-identity`) — relay it. |
| multiple / no deployments found | Relay the hint; you can pass `--subscription <id>`, or the user runs `az account set --subscription <other>` then `m8t config reset`. |

## Command cheat sheet

Worker names are **case-sensitive and lowercase** — the Foundry agent name exactly as deployed (e.g. `cmo`). A wrong name is **not** caught at bind time; it surfaces later as an orphaned binding on the first message. Use the real name.

```bash
# Identity / local context / health
m8t whoami                       # who am I, which gateway, does my az tenant match?
m8t status                       # full local snapshot: az identity, config.yaml, gateway cache, azd mode
m8t doctor                       # health checks (az · config · tenant align · gateway · Foundry data-plane · model-quota) + fixes
m8t doctor --agent <name>        # + delivery-grant check: agent MI has Key Vault Secrets User?
m8t config show                  # config.yaml (tenant/client/project) + the cached gateway
m8t config set <key> <value>     # set tenantId | clientId | projectEndpoint in config.yaml
m8t switch --subscription <id>   # re-point local config at another deployment (snapshots the old one first)
m8t switch <profile>             # restore a saved profile;  m8t switch --list
m8t open [webapp|foundry|portal] # open the deployed app / Foundry portal / resource group  (--print for the URL)

# Team
m8t team list                                  # everyone on the team
m8t team show <handle>                         # one member + their channel identities
m8t team add <handle> --display "<name>" [--telegram <id>] [--slack <id>] [--teams <upn>]
m8t team add-identity <handle> [--telegram <id>] [--slack <id>] [--teams <upn>]
m8t team remove-identity <handle> --telegram | --slack | --teams   # exactly one channel
m8t team remove <handle>                       # remove the member entirely

# Bindings (bot → worker)
m8t bind list [--channel telegram] [--status active|orphaned]
m8t bind show <slug>                           # token never shown, only the Key Vault URI
m8t bind add telegram --worker <agent-name> --bot-token <token> --slug <slug> [--bot-username "@<name>"]
m8t bind remove <slug> [--yes]                 # cascade delete; works on ANY status
m8t bind cleanup --all-orphaned                # orphaned bindings ONLY; refuses active ones

# Hosted coding agent
m8t coder deploy <name> [--image <repo>] [--image-tag <tag>] [--size small|medium|large]
                         [--model-deployment <name>] [--endpoint <url>] [--subscription <id>]
                         [--env KEY=VALUE] …     # repeatable; injects M8T_CODER_* tuning vars
                         [--brain-kv <name|uri>] # KV for delivery grant; inferred from AZURE_KEYVAULT_URI
                         [--skip-quota-check]    # bypass pre-deploy MODEL_NO_QUOTA check
                         [--allow-non-reasoning] # suppress reasoning-model warning
m8t coder teardown <name> [--yes] [--endpoint <url>] [--subscription <id>]

# Hosted Azure executor (az CLI + tiered ops: Tier 0/1 auto, Tier 2 refused)
m8t azure-exec deploy <name> --resource-group <rg> | --scope <arm-id>   # Contributor scope REQUIRED (no default)
                         --brain <owner/repo>     # proof-delivery brain (resolves App install + KV)
                         [--image-tag <tag>] [--size small|medium|large] [--model-deployment <name>]
                         [--gateway-url <url>]    # a2a-enables the worker as a target
                         [--endpoint <url>] [--subscription <id>] [--skip-quota-check]

# Agent cascade removal (any kind — prompt or hosted)
m8t agent remove <name> --yes                          # full cascade: bindings + a2a + brain + agent + yaml
m8t agent remove <name> --yes --delete-brain-repo      # also delete the brain GitHub repo
m8t agent remove <name> --yes --keep-bindings          # skip binding teardown
m8t agent remove <name> --yes --keep-a2a               # skip a2a teardown
m8t agent remove <name> --yes --output json            # machine-readable step results

# Create Foundry from scratch (account + project + model), idempotent + region/quota-aware
m8t foundry create --resource-group <rg> --location <region>
                   [--account <name>] [--project <name>] [--model <deployment>]
                   [--model-version <ver>] [--capacity <n>] [--subscription <id>] [--skip-quota-check]
                   [--output <mode>]

# Deploy / update the gateway stack (replaces the old deploy/setup.mjs)
m8t deploy [--client-id <appId>] [--image-ref <ref>] [--location <region>] [--resource-group <name>]
           [--suffix <s>] [--foundry-endpoint <url>] [--foundry-resource-id <id>]
```

`bind remove <slug>` deletes a specific binding whatever its state. `bind cleanup --all-orphaned` is the janitor for dead (orphaned) bindings and refuses to touch active ones — reach for it when the user says "clean up dead/leftover bindings."

### `m8t foundry create` — create an AI Foundry account, project, and model from zero

Non-interactive and idempotent. Creates the AIServices account (custom subdomain + `--allow-project-management`), a project, and a model deployment (default `gpt-4.1-mini` @ capacity 50), then emits the project endpoint (`--output json` → `.endpoint`) for `m8t deploy --foundry-endpoint`. Re-run is a clean no-op: account/project are skipped if present, and the deployment capacity converges **up** only (never scaled down).

- `--location` — must be hosted-agent-eligible (e.g. `eastus2`, not `eastus`); fails fast with `FOUNDRY_REGION_NOT_ELIGIBLE` otherwise.
- `--account` — globally-unique account name (also the endpoint subdomain). Defaults to a deterministic per-subscription slug.
- `--capacity` — model deployment capacity (default 50). Reasoning models (`gpt-5*`/`o*`) warn below 250.
- `--skip-quota-check` — bypass the pre-create quota check (normally fails fast with `FOUNDRY_MODEL_NO_QUOTA`).
- `--output json` — emits `{ endpoint, accountName, accountResourceId, projectName, region, model, capacity, created }` for scripting (e.g. piping `.endpoint` into `m8t deploy --foundry-endpoint`).

### `m8t coder deploy <name>` — deploy the hosted coding agent

Deploys the curated Python coding-agent image as a hosted Foundry worker, tags it (`kind: hosted` + persona), grants its identity the Foundry User role, and polls to active. The image must already be pushed to the ACR (see `deploy.md §2b`). Re-running creates a new version (idempotent).

- `--image` — ACR image name (default: `m8t-coding-agent`). Can be a bare repo name or a full `host/repo` ref.
- `--image-tag` — image tag (default: a pinned release tag baked into the CLI).
- `--size` — `small` (0.5 vCPU / 1 Gi) · `medium` (1 / 2 Gi, default) · `large` (2 / 4 Gi).
- `--model-deployment` — Foundry model the coder calls (default: `gpt-4.1-mini`).
- `--endpoint` / `--subscription` — target project / subscription overrides (skip gateway auto-discovery).
- `--env KEY=VALUE` — repeatable; passes environment variables (e.g. `M8T_CODER_EXEC_TIMEOUT_SECONDS=300`) directly to the container.
- `--brain-kv <name|uri>` — Key Vault to use for the `Key Vault Secrets User` grant when delivery env is set. Accepts a bare vault name or full URI. Inferred from `AZURE_KEYVAULT_URI` in the injected env when omitted.
- `--skip-quota-check` — bypass the pre-deploy quota check (normally fails fast with `MODEL_NO_QUOTA` if the chosen model has 0 TPM quota in the region).
- `--allow-non-reasoning` — suppress the reasoning-model warning when brain-linking on a model outside the known-good `gpt-5*`/`o*` family.

**Auto-grant on delivery creds.** When `GITHUB_APP_INSTALLATION_ID` + `AZURE_KEYVAULT_URI` are injected via `--env` (without `--brain`), the CLI automatically grants `Key Vault Secrets User` to the agent's managed identity on the target vault. No manual `az role assignment create` is needed.

### `m8t coder teardown <name>` — remove a hosted coder (agent only)

Tears down the hosted worker: removes its container, identity, and cascades the role assignment. Idempotent — tearing down a missing coder reports "already gone." Interactive by default (prompts for confirmation); pass `--yes` to skip the prompt in scripts or non-interactive contexts.

For a full cleanup that also removes bindings, a2a connections, and brain connections, use `m8t agent remove` instead.

### `m8t azure-exec deploy <name>` — deploy the hosted Azure executor

Deploys the Azure-executor image (Azure CLI + SDK) as a hosted Foundry worker, grants its identity Foundry User (model calls) + **Contributor at the required `--scope`** + Key Vault Secrets User (brain KV, for proof delivery), polls to active, and a2a-enables it as a discoverable target. The worker classifies every requested operation by tier: Tier 0 (read) and Tier 1 (provision) run automatically; Tier 2 (role assignments, deletes, privilege-granting) is **refused** with `needs_approval` — it holds a Contributor-only identity by design. It returns a proof artifact (resource ids + portal links) to the caller's brain.

- `--scope <arm-id>` / `--resource-group <rg>` — **required**; the scope the Contributor grant is made at. No default (least-privilege): use a dedicated RG for testing, your existing RG for production.
- `--brain <owner/repo>` — **required**; the brain the executor delivers proof to (resolves the GitHub App installation + KV for the in-container self-mint).
- `--kv-uri <name|uri>` — the App Key Vault holding the GitHub App secrets (bare name or full URI). Defaults to the `AZURE_KEYVAULT_URI` / `KEYVAULT_URI` env var.
- `--image` / `--image-tag` — ACR image (default `m8t-azure-executor`) and tag (bump to force a new revision).
- `--size` — `small` (0.5/1Gi) · `medium` (1/2Gi, default) · `large` (2/4Gi).
- `--model-deployment` — Foundry model the executor reasons with (default: `gpt-5-mini`).
- `--gateway-url` — the a2a bridge URL used to register the worker as a target.
- `--endpoint` / `--subscription` / `--skip-quota-check` — as for `coder deploy`.

### `m8t agent remove <name>` — cascade-remove any worker

Removes ALL traces of a Foundry agent in order: channel bindings (Table row + KV secret + conversation rows via the gateway cascade), a2a connection, brain connection (GitHub repo kept by default), the agent itself, and its local yaml. Works for any worker kind (prompt or hosted). Idempotent and partial-failure resilient — one failing step does not abort the rest. Re-run the same command to retry failed steps.

- `--yes` — required for non-interactive use. Without it, the command prints a summary of what will be removed and exits (prompts interactively if running in a TTY).
- `--keep-bindings` — skip binding teardown (when bindings were already cleaned up separately).
- `--keep-a2a` — skip disabling a2a.
- `--delete-brain-repo` — also delete the brain GitHub repo via `gh repo delete --yes`. Default: keep repo.
- `--kv-uri <uri>` — Key Vault URI (inferred from `AZURE_KEYVAULT_URI` / `KEYVAULT_URI` when omitted).
- `--endpoint <url>` — override the Foundry project endpoint.
- `--subscription <id>` — override the target subscription.
- `--output json|pretty` — `json` emits `{ agentName, steps[] }` suitable for scripting.

Exit codes: `0` all steps ok or skipped · `1` one or more steps failed.

### `m8t doctor [--agent <name>]` — health checks

`m8t doctor` runs the standard health checks (az login · config.yaml · tenant alignment · gateway · Foundry data-plane · **model-quota**) and streams each result as it resolves.

`--agent <name>` adds a targeted **delivery-grant check**: reads the deployed agent's env vars and verifies that the agent's managed identity holds `Key Vault Secrets User` on the configured vault. Reports PASS / FAIL / skipped (agent has no delivery env). Use after `m8t coder deploy` with delivery creds to confirm the auto-grant landed:

```bash
m8t doctor --agent my-coder
```

### `m8t brain link --persona <path>` — override or synthesize persona

`--persona <path>` overrides the persona file path recorded in `~/.m8t/foundry/<agent>.yaml` when re-rendering the agent's instructions for the brain-enabled version. Useful when the persona has moved or when you want to force a specific file.

When no local agent yaml exists at all (e.g. the agent was created via the REST API or SDK, not through the Architect), `m8t brain link` now falls back to the deployed agent's instructions and synthesizes a minimal local yaml automatically — no `AGENT_YAML_NOT_FOUND` error.

```bash
m8t brain link cmo --repo owner/cmo-brain --persona personas/cmo/persona.md
m8t brain link cmo --repo owner/cmo-brain   # falls back to deployed instructions if no local yaml
```

`--allow-non-reasoning` silences the warning that fires when the agent's model is not in the known-good `gpt-5*`/`o*` whitelist. The brain link still proceeds.

Most commands also accept `--subscription <id>` (pin gateway discovery to a subscription) and `--output json|pretty`.

## Natural language → command

| The user says… | You run… |
|---|---|
| "show me everyone on the team" | `m8t team list` |
| "what are Ilan's channel IDs?" | `m8t team show ilan` |
| "add Ilan to the team, his Telegram ID is 88112233" | confirm → `m8t team add ilan --display "Ilan" --telegram 88112233` |
| "add Ilan's Slack handle U01ILA too" | `m8t team add-identity ilan --slack U01ILA` |
| "remove Ilan's Telegram identity" | confirm → `m8t team remove-identity ilan --telegram` |
| "remove Ilan from the team" | confirm → `m8t team remove ilan` |
| "bind the cmo worker to a Telegram bot — token bot123:ABC, slug cmo-tg" | confirm (token redacted) → `m8t bind add telegram --worker cmo --bot-token bot123:ABC --slug cmo-tg` |
| "…and the bot is @startup_cmo_bot" | add `--bot-username "@startup_cmo_bot"` |
| "what bindings are set up?" | `m8t bind list` |
| "show me the cmo-tg binding" | `m8t bind show cmo-tg` |
| "remove the cmo-tg binding" | confirm → `m8t bind remove cmo-tg` |
| "clean up the dead bindings" | `m8t bind cleanup --all-orphaned` |
| "deploy the coding agent" / "spin up a coder called data-coder" | confirm → `m8t coder deploy data-coder` |
| "tear down the data-coder" / "remove the hosted coder" | confirm → `m8t coder teardown data-coder` |
| "remove the cmo agent" / "fully clean up cmo" | confirm → `m8t agent remove cmo --yes` |
| "remove cmo and delete the brain repo too" | confirm → `m8t agent remove cmo --yes --delete-brain-repo` |
| "is my setup ok?" / "check my m8t deployment / health" | `m8t doctor` |
| "what tenant / subscription am I on?" / "show my local config" | `m8t status` (or `m8t config show`) |
| "switch to my startup subscription" / "point m8t at the <other> deployment" | confirm → `m8t switch --subscription <id-or-name>` (snapshots the current config first) |
| "go back to my personal setup" | `m8t switch <profile>` (run `m8t switch --list` to see saved profiles) |
| "open the webapp" / "open the Foundry portal" / "open the resource group" | `m8t open` / `m8t open foundry` / `m8t open portal` |
| "deploy / update the gateway" | confirm carefully → `m8t deploy [--client-id <appId>] [--image-ref <ref>]` (heavy — prefer a `--what-if` preview first) |

Handles and slugs are lowercase letters, digits, and hyphens (e.g. `ilan`, `cmo-tg`). If the user gives a display name like "Ilan Best", derive a sensible handle (`ilan` or `ilan-best`) and confirm it with them as part of the add.

## Installing the `m8t` CLI

If `m8t` isn't on the PATH, offer to install it (a global install is a system change — confirm first), in this order:

1. **From npm (any OS with Node 20+) — the default:**

   ```bash
   npm install -g @m8t-stack/cli      # or: brew install m8t-labs/tap/m8t  ·  scoop install m8t
   m8t version
   ```

2. **From the cloned repo (contributors / unreleased changes):** if `~/.m8t/repo-root` exists, build and install the bundled tarball:

   ```bash
   cd "$(cat ~/.m8t/repo-root)/apps/cli"
   pnpm build && pnpm pack && npm install -g ./m8t-stack-cli-*.tgz
   m8t version
   ```

3. **Neither available:** ask the user to install Node 20+ (then option 1), or clone the m8t repo and run its top-level `install.md`.
