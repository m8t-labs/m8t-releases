import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleListWorkers } from "./list-workers.js";
import type { AgentRecord, FoundryClient } from "../foundry-client.js";

describe("handleListWorkers", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-lw-test-"));
    await fs.mkdir(path.join(repoRoot, "personas", "cmo"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "personas", "cmo", "persona.md"),
      "---\nname: cmo\nrole: CMO\ndescription: CMO.\nversion: 0.1\n---\n",
    );
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("filters out non-m8t agents", async () => {
    const client: FoundryClient = {
      listAgents: async (): Promise<AgentRecord[]> => [
        {
          id: "1",
          name: "Carolyn",
          model: "gpt-4.1-mini",
          metadata: { source: "m8t", persona: "cmo" },
          kind: "prompt",
        },
        {
          id: "2",
          name: "OtherAgent",
          model: "gpt-4.1-mini",
          metadata: { source: "portal" },
          kind: "prompt",
        },
      ],
      createConversation: async () => ({ id: "x" }),
      getConversation: async () => ({ kind: "not_found" }),
      getConversationMessages: async () => [],
      appendConversationItems: async () => {},
      createResponse: async () => ({ id: "y", output: "" }),
      downloadArtifact: async () => Buffer.alloc(0),
    };
    const workers = await handleListWorkers({
      client,
      repoRoot,
      projectEndpoint: "https://test.services.ai.azure.com/api/projects/p",
    });
    expect(workers).toHaveLength(1);
    expect(workers[0].name).toBe("carolyn");
    expect(workers[0].role).toBe("CMO");
  });
});
