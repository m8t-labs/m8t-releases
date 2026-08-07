import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWorkerRecord } from "./worker-builder.js";
import type { AgentRecord } from "./foundry-client.js";

describe("buildWorkerRecord", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-wb-test-"));
    await fs.mkdir(path.join(repoRoot, "personas", "cmo"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "personas", "cmo", "persona.md"),
      [
        "---",
        "name: cmo",
        "role: CMO",
        "description: Chief Marketing Officer virtual worker — owns brand, growth, demand-gen.",
        "version: 0.2",
        "---",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("renders an m8t agent into a worker record with role and short description", async () => {
    const agent: AgentRecord = {
      id: "asst_abc123",
      name: "Carolyn",
      model: "gpt-4.1-mini",
      metadata: { source: "m8t", persona: "cmo", personaVersion: "0.2" },
      kind: "prompt",
    };
    const worker = await buildWorkerRecord(agent, {
      repoRoot,
      projectEndpoint: "https://x",
    });
    expect(worker.name).toBe("carolyn");
    expect(worker.displayName).toBe("Carolyn");
    expect(worker.role).toBe("CMO");
    expect(worker.description).toBe(
      "Chief Marketing Officer virtual worker — owns brand, growth, demand-gen",
    );
    expect(worker.persona).toBe("cmo");
    expect(worker.personaVersion).toBe("0.2");
    expect(worker.agentId).toBe("asst_abc123");
    expect(worker.model).toBe("gpt-4.1-mini");
    expect(worker.projectEndpoint).toBe("https://x");
  });

  it("falls back when persona file is missing the role", async () => {
    await fs.writeFile(
      path.join(repoRoot, "personas", "cmo", "persona.md"),
      [
        "---",
        "name: cmo",
        "description: A description.",
        "version: 0.2",
        "---",
      ].join("\n"),
    );
    const agent: AgentRecord = {
      id: "x",
      name: "carolyn",
      model: "gpt-4.1-mini",
      metadata: { source: "m8t", persona: "cmo" },
      kind: "prompt",
    };
    const worker = await buildWorkerRecord(agent, {
      repoRoot,
      projectEndpoint: "https://x",
    });
    expect(worker.role).toBe("Cmo");
  });

  it("surfaces the brain link parsed from metadata.brain", async () => {
    const agent: AgentRecord = {
      id: "cmo-brain",
      name: "cmo-brain",
      model: "gpt-4.1-mini",
      metadata: {
        source: "m8t",
        persona: "cmo",
        personaVersion: "0.2",
        brain: JSON.stringify({
          repo: "orkeren21/cmo-brain-f01",
          branch: "main",
          topology: "per-worker",
          schemaVersion: "1",
          credentialRef: "brain-cmo-brain",
        }),
      },
      kind: "prompt",
    };
    const worker = await buildWorkerRecord(agent, { repoRoot, projectEndpoint: "https://x" });
    expect(worker.brain?.repo).toBe("orkeren21/cmo-brain-f01");
    expect(worker.brain?.credentialRef).toBe("brain-cmo-brain");
  });

  it("leaves brain undefined when the agent has no brain link", async () => {
    const agent: AgentRecord = {
      id: "cmo",
      name: "cmo",
      model: "gpt-4.1-mini",
      metadata: { source: "m8t", persona: "cmo", personaVersion: "0.2" },
      kind: "prompt",
    };
    const worker = await buildWorkerRecord(agent, { repoRoot, projectEndpoint: "https://x" });
    expect(worker.brain).toBeUndefined();
  });
});

const baseAgent: AgentRecord = {
  id: "a1", name: "Coder", model: "gpt-4.1", metadata: {}, kind: "prompt",
};

describe("buildWorkerRecord — kind", () => {
  it("defaults kind to 'prompt' and omits hosted block", async () => {
    const w = await buildWorkerRecord(baseAgent, { repoRoot: process.cwd(), projectEndpoint: "https://x" });
    expect(w.kind).toBe("prompt");
    expect(w.hosted).toBeUndefined();
  });
  it("carries kind 'hosted' + the hosted block through", async () => {
    const hosted: AgentRecord = {
      ...baseAgent, kind: "hosted",
      hosted: { protocols: ["responses"], sandbox: { cpu: "1", memory: "2Gi" }, versionStatus: "active" },
    };
    const w = await buildWorkerRecord(hosted, { repoRoot: process.cwd(), projectEndpoint: "https://x" });
    expect(w.kind).toBe("hosted");
    expect(w.hosted).toEqual({ protocols: ["responses"], sandbox: { cpu: "1", memory: "2Gi" }, versionStatus: "active" });
  });
});
