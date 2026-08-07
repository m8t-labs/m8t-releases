import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveProjectEndpoint } from "./project-endpoint.js";
import type { DiscoveryResult } from "./auto-discover.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("resolveProjectEndpoint", () => {
  const originalEnv = process.env.PROJECT_ENDPOINT;
  let tmpDir: string;

  beforeEach(async () => {
    delete process.env.PROJECT_ENDPOINT;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-test-"));
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.PROJECT_ENDPOINT;
    } else {
      process.env.PROJECT_ENDPOINT = originalEnv;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns PROJECT_ENDPOINT env var when set", async () => {
    process.env.PROJECT_ENDPOINT = "https://example.services.ai.azure.com/api/projects/test";
    const result = await resolveProjectEndpoint({ foundryYamlDir: tmpDir, autoDiscoverFn: false });
    expect(result).toBe("https://example.services.ai.azure.com/api/projects/test");
  });

  it("reads from ~/.m8t/foundry/*.yaml when env var is not set", async () => {
    const yamlPath = path.join(tmpDir, "cmo.yaml");
    await fs.writeFile(
      yamlPath,
      `projectEndpoint: https://from-yaml.services.ai.azure.com/api/projects/test\n`,
    );
    const result = await resolveProjectEndpoint({ foundryYamlDir: tmpDir, autoDiscoverFn: false });
    expect(result).toBe("https://from-yaml.services.ai.azure.com/api/projects/test");
  });

  it("prefers user-written seed.yaml over auto-written _auto.yaml", async () => {
    // Filesystem-order bug: `_auto.yaml` sorts before `seed.yaml` in lexicographic
    // order, so naive iteration would let the stale auto-cache shadow the override
    // path documented in install/m8t-plugin.md.
    await fs.writeFile(
      path.join(tmpDir, "_auto.yaml"),
      `projectEndpoint: https://stale-auto.services.ai.azure.com/api/projects/old\n`,
    );
    await fs.writeFile(
      path.join(tmpDir, "seed.yaml"),
      `projectEndpoint: https://user-override.services.ai.azure.com/api/projects/new\n`,
    );
    const result = await resolveProjectEndpoint({ foundryYamlDir: tmpDir, autoDiscoverFn: false });
    expect(result).toBe("https://user-override.services.ai.azure.com/api/projects/new");
  });

  it("falls back to auto-discovery and writes _auto.yaml on found", async () => {
    const endpoint = "https://discovered.services.ai.azure.com/api/projects/x";
    const discover = vi.fn(async (): Promise<DiscoveryResult> => ({
      kind: "found",
      endpoint,
    }));
    const result = await resolveProjectEndpoint({
      foundryYamlDir: tmpDir,
      autoDiscoverFn: discover,
    });
    expect(result).toBe(endpoint);
    expect(discover).toHaveBeenCalledTimes(1);

    const persisted = await fs.readFile(path.join(tmpDir, "_auto.yaml"), "utf-8");
    expect(persisted).toContain(endpoint);
    expect(persisted).toContain("Auto-discovered by the m8t plugin");
  });

  it("throws an ambiguity error when discovery returns multiple candidates", async () => {
    const discover = async (): Promise<DiscoveryResult> => ({
      kind: "ambiguous",
      candidates: [
        { endpoint: "https://a.services.ai.azure.com/api/projects/a", resourceName: "fa", projectName: "a" },
        { endpoint: "https://b.services.ai.azure.com/api/projects/b", resourceName: "fb", projectName: "b" },
      ],
    });
    await expect(
      resolveProjectEndpoint({ foundryYamlDir: tmpDir, autoDiscoverFn: discover }),
    ).rejects.toThrow(/multiple foundry projects/i);
  });

  it("throws a no-projects error when discovery finds nothing", async () => {
    const discover = async (): Promise<DiscoveryResult> => ({ kind: "no-accounts" });
    await expect(
      resolveProjectEndpoint({ foundryYamlDir: tmpDir, autoDiscoverFn: discover }),
    ).rejects.toThrow(/no foundry projects found/i);
  });

  it("throws an az-login error when discovery cannot authenticate", async () => {
    const discover = async (): Promise<DiscoveryResult> => ({ kind: "no-login" });
    await expect(
      resolveProjectEndpoint({ foundryYamlDir: tmpDir, autoDiscoverFn: discover }),
    ).rejects.toThrow(/az login/i);
  });

  it("respects autoDiscoverFn: false (uses the original final-fallback error)", async () => {
    await expect(
      resolveProjectEndpoint({ foundryYamlDir: tmpDir, autoDiscoverFn: false }),
    ).rejects.toThrow(/could not resolve PROJECT_ENDPOINT/i);
  });
});
