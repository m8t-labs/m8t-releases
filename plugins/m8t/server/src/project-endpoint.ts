import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { autoDiscoverProjectEndpoint, type DiscoveryResult } from "./auto-discover.js";

interface ResolveOptions {
  foundryYamlDir?: string;
  // Inject for tests. Pass `false` to disable auto-discovery entirely.
  autoDiscoverFn?: (() => Promise<DiscoveryResult>) | false;
}

export async function resolveProjectEndpoint(opts: ResolveOptions = {}): Promise<string> {
  if (process.env.PROJECT_ENDPOINT) {
    return process.env.PROJECT_ENDPOINT;
  }

  const foundryDir = opts.foundryYamlDir ?? path.join(os.homedir(), ".m8t", "foundry");
  try {
    const entries = await fs.readdir(foundryDir);
    // Prefer user-written files (e.g. seed.yaml) over auto-written ones
    // (`_auto.yaml`). `fs.readdir` returns filesystem-dependent order, so we
    // sort deterministically here.
    entries.sort((a, b) => {
      const aUnderscore = a.startsWith("_");
      const bUnderscore = b.startsWith("_");
      if (aUnderscore && !bUnderscore) return 1;
      if (!aUnderscore && bUnderscore) return -1;
      return a.localeCompare(b);
    });
    for (const entry of entries) {
      if (!entry.endsWith(".yaml")) continue;
      const content = await fs.readFile(path.join(foundryDir, entry), "utf-8");
      const parsed = parseYaml(content) as { projectEndpoint?: string } | null;
      if (parsed?.projectEndpoint) {
        return parsed.projectEndpoint;
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  if (opts.autoDiscoverFn !== false) {
    const discover =
      opts.autoDiscoverFn ??
      (() =>
        autoDiscoverProjectEndpoint({
          // `resolveProjectEndpoint` runs before the MCP logger is wired up,
          // so route partial-failure warnings (e.g. one good account + one
          // 403'd account) through stderr — the MCP host captures it.
          onWarn: (msg) => { console.warn(`[m8t] ${msg}`); },
        }));
    const result = await discover();

    if (result.kind === "found") {
      await persistAutoEndpoint(foundryDir, result.endpoint);
      return result.endpoint;
    }
    if (result.kind === "ambiguous") {
      const list = result.candidates
        .map(
          (c, i) =>
            `  ${(i + 1).toString()}. ${c.endpoint}  (resource: ${c.resourceName}, project: ${c.projectName})`,
        )
        .join("\n");
      throw new Error(
        `Multiple Foundry projects accessible to this account. Pick one by either:\n` +
          `  • setting PROJECT_ENDPOINT to the chosen URL, or\n` +
          `  • writing it to ~/.m8t/foundry/seed.yaml as \`projectEndpoint: <url>\`.\n\n` +
          `Candidates:\n${list}`,
      );
    }
    if (result.kind === "no-accounts") {
      throw new Error(
        "No Foundry projects found in your accessible Azure subscriptions. " +
          "Deploy one via the m8t-architect skill (e.g. `spin up the CMO`), " +
          "or set PROJECT_ENDPOINT to point at an existing project.",
      );
    }
    if (result.kind === "no-login") {
      throw new Error("Could not authenticate to Azure. Run `az login` first, then retry.");
    }
    // Only the "error" variant remains after the exhaustive checks above.
    throw new Error(`Auto-discovery failed: ${result.message}`);
  }

  throw new Error(
    "Could not resolve PROJECT_ENDPOINT. Set the PROJECT_ENDPOINT env var, or " +
      "run the m8t-architect skill to deploy a worker (which writes " +
      "~/.m8t/foundry/<name>.yaml with the endpoint).",
  );
}

async function persistAutoEndpoint(foundryDir: string, endpoint: string): Promise<void> {
  try {
    await fs.mkdir(foundryDir, { recursive: true });
    const content = [
      "# Auto-discovered by the m8t plugin on first run.",
      "# Safe to delete; the plugin will re-discover on the next session.",
      `# If you have multiple Foundry projects and want a different one, edit this file or`,
      "# set PROJECT_ENDPOINT — the env var wins over any yaml.",
      `projectEndpoint: ${endpoint}`,
      "",
    ].join("\n");
    await fs.writeFile(path.join(foundryDir, "_auto.yaml"), content, "utf-8");
  } catch {
    // Best-effort cache; we still have the endpoint in memory for this session.
  }
}
