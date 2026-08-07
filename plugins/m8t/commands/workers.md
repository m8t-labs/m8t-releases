---
description: List m8t virtual workers (or `/m8t:workers refresh` to force re-discovery)
---
# `/m8t:workers` — virtual worker inventory

If `$ARGUMENTS` contains the word "refresh", call the `m8t` MCP server's `refresh_workers` tool first; otherwise call `list_workers`.

Format the response as:

```
<N> workers deployed and available in <project-name>:

NAME           ROLE   DESCRIPTION                                          DEPLOYED
carolyn        CMO    owns brand, growth, and demand-gen                   2026-05-12
carry          PA     calendar, inbox, scheduling for the founder          2026-05-15

All are reachable via `/<name>` (slash commands) or `@<name>` (free-text mentions). Example: `/carolyn` or `@carry please review this`.
```

The `<project-name>` is the last URL segment of any worker's `projectEndpoint` (e.g. `https://x.services.ai.azure.com/api/projects/acme-project` → `acme-project`). Use it once in the headline.

**Don't narrate plumbing.** Don't mention the seed.yaml, the project endpoint, the MCP server, the foundry resource, or any other implementation detail unless the user explicitly asks. Focus on what workers exist and how to reach them.

If any worker's role shows "(persona file not found)", briefly note that their persona file is missing from `<repo-root>/personas/` — the user may need to `git pull`.

If `list_workers` returns an empty array, surface:

> No m8t workers deployed in your Foundry project yet. Use the `m8t-architect` skill to deploy one (e.g. "spin up the CMO").

If the call fails with an error message, surface that message verbatim — the structured errors already include the right remediation (e.g. "Multiple Foundry projects accessible…", "Could not authenticate to Azure. Run `az login`…").
