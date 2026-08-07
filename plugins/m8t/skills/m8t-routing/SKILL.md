---
name: m8t-routing
description: Use whenever the user's message contains an @<worker-name> mention in free text — this skill routes the request to the corresponding m8t virtual worker via the m8t MCP server. Triggers on patterns like `@carolyn please research X`, `also ping @dan about this`, or `tell @carry to schedule a follow-up`. Case-insensitive on the worker name.
---
# m8t-routing — `@<name>` free-text mention routing

When the user's message contains `@<worker-name>` (capitalisation-insensitive) followed by an instruction or request, treat it as a virtual-worker mention and route through the `m8t` MCP server.

## Procedure

1. **Detect.** Scan the user's message for any `@<name>` token. Normalise the name to lowercase. Multiple mentions in a single message: handle them in order, one tool call per mention.

2. **Resolve.** Call the MCP tool `list_workers` (cheap, in-memory cached). Find a worker whose `name` matches the lowercased `<name>`. If no exact match, find the closest match and ask the user to disambiguate (don't guess).

3. **Compose the message.** The user's intent is in the rest of their message — and any relevant prior context from this session. **Be selective.** Don't paste the entire transcript. Include only what the worker genuinely needs:
   - The specific list / data / snippet they're being asked to operate on.
   - One-sentence framing of what came before, if it's not obvious from the request alone.
   - The user's actual request, verbatim or close to it.

4. **Invoke.** Call `send_to_worker(name=<lowercased-name>, message=<composed message>)`.

5. **Handle the response.**
   - `kind: "completed"` → surface `reply` to the user verbatim. Mention the worker by their display name ("Here's Carolyn's reply: …").
   - `kind: "detached"` → tell the user `<displayName>` is still working and offer to check back: "I'll check back shortly." Then call `check_worker(taskId)` once after ~30 seconds (use a `Bash sleep 30` between calls). If still running, surface the `taskId` so the user can ask you to `check_worker(taskId)` later, or just wait. **Do not poll in a tight loop** — that's expensive.

## When NOT to route

- The `@` is part of an email address (`@gmail.com`, `@example.org`). Don't route — these are addresses, not mentions.
- The `@` is part of a code snippet (`@decorator`, `@param`). Use context to disambiguate.
- The user is talking ABOUT a worker without addressing them ("I sent something to @carolyn yesterday"). Route only when the user is asking YOU to send something now.

## Casing convention

- File-on-disk: lowercase. (`~/.claude/commands/carolyn.md`)
- Slash command (per-worker, bare): lowercase. (`/carolyn`)
- Slash command (static plugin entry): namespaced. (`/m8t:workers`)
- Foundry agent display name: as-spelled at deploy time. ("Carolyn")
- Matching: case-insensitive. `@Carolyn`, `@carolyn`, `@CAROLYN` all resolve to the same worker.

## The `/<name>` per-worker slash command vs `@<name>` mention

- **`/<name>`** is the primary discovery path — autocomplete in Claude Code's `/`-completer shows all available workers with role hints. These commands live at `~/.claude/commands/<name>.md` and appear as bare `/carolyn` etc.
- **`@<name>`** is the inline mention path — for when the user wants to address a worker mid-paragraph and slash form doesn't fit naturally.
- **`/m8t:workers`** is the inventory / control-plane command (always namespaced — it's the plugin's static command).

All three routes eventually invoke the same `send_to_worker` MCP tool. This skill exists to handle the `@<name>` path; the slash commands handle themselves via their generated bodies.
