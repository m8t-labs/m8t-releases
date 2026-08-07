import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleSendToWorker } from "./send-to-worker.js";
import { createConversationStore } from "../conversation-store.js";
import { createInFlightRegistry } from "../in-flight-tasks.js";
import { artifactRoot } from "../artifact-store.js";
import type { WorkerRecord } from "../worker-builder.js";
import type { ChatTurn, FoundryClient } from "../foundry-client.js";

// Mock the rotation modules so tests never touch Azure / GitHub.
vi.mock("@m8t-stack/github-app-auth", () => ({
  rotateConnectionAuth: vi.fn().mockResolvedValue({ rotatedAt: new Date(), expiresAt: new Date() }),
}));
vi.mock("@azure/identity", () => ({
  // Must be a class (constructor) because send-to-worker uses `new DefaultAzureCredential()`.
  DefaultAzureCredential: vi.fn().mockImplementation(function () { return {}; }),
}));

// Import the mocked rotateConnectionAuth reference for spy assertions.
import { rotateConnectionAuth } from "@m8t-stack/github-app-auth";

beforeEach(() => {
  process.env.M8T_CONVERSATION_REGISTRY_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), "mcp3-")), "registry.json");
});
afterEach(() => {
  delete process.env.M8T_CONVERSATION_REGISTRY_PATH;
});

const carolyn: WorkerRecord = {
  name: "carolyn",
  displayName: "Carolyn",
  role: "CMO",
  description: "CMO",
  persona: "cmo",
  personaVersion: "0.2",
  agentId: "asst_x",
  projectEndpoint: "https://x",
  model: "gpt-4.1-mini",
  deployedAt: null,
  kind: "prompt",
};

function fakeClient(overrides: Partial<FoundryClient> = {}): FoundryClient {
  let createdMetadata: Record<string, string> = {};
  return {
    listAgents: vi.fn(),
    createConversation: vi.fn(async (metadata: Record<string, string>) => { createdMetadata = metadata; return { id: "conv_new" }; }),
    getConversation: vi.fn(async () => ({ id: "conv_new", metadata: createdMetadata })),
    getConversationMessages: vi.fn(async () => []),
    appendConversationItems: vi.fn(async () => undefined),
    createResponse: vi.fn(async () => ({ id: "resp_x", output: "Hello back", model: "gpt-5.1" })),
    ...overrides,
  } as unknown as FoundryClient;
}

type CreateResponseArgs = Parameters<FoundryClient["createResponse"]>[0];
type CreateResponseResult = Awaited<ReturnType<FoundryClient["createResponse"]>>;

/** Shared emitLedger mock — passed into every handleSendToWorker call. */
function fakeEmitLedger() {
  return vi.fn().mockResolvedValue(undefined);
}

describe("handleSendToWorker (sync path)", () => {
  it("resolves a durable conversation by normalized endpoint, local user, and persona", async () => {
    vi.spyOn(os, "userInfo").mockReturnValue({ username: " Alice ", uid: 1, gid: 1, shell: "/bin/zsh", homedir: "/tmp" });
    const store = createConversationStore({ filePath: path.join(mkdtempSync(path.join(os.tmpdir(), "mcp3-")), "registry.json") });
    const client = fakeClient({ getConversation: vi.fn(async () => ({ id: "conv_new", metadata: { app: "m8t", platform: "mcp", ownerKey: expect.any(String), persona: "cmo", agent: "carolyn" } })) });
    await handleSendToWorker({ workers: [{ ...carolyn, projectEndpoint: "HTTPS://X/" }], name: "carolyn", message: "hi", client, store, waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    expect(client.createConversation).toHaveBeenCalledWith(expect.objectContaining({ app: "m8t", platform: "mcp", persona: "cmo", agent: "carolyn", ownerKey: expect.stringMatching(/^[a-f0-9]{64}$/), provisioningToken: expect.stringMatching(/^[a-f0-9-]{20,}$/) }));
  });

  it("rejects workers without a persona before provisioning", async () => {
    const client = fakeClient();
    await expect(handleSendToWorker({ workers: [{ ...carolyn, persona: null }], name: "carolyn", message: "hi", client, store: createConversationStore({ filePath: path.join(mkdtempSync(path.join(os.tmpdir(), "mcp3-")), "registry.json") }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() })).rejects.toThrow(/persona/i);
    expect(client.createConversation).not.toHaveBeenCalled();
    expect(client.createResponse).not.toHaveBeenCalled();
  });

  it("converges same-persona workers and reuses the registry after restart", async () => {
    const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "mcp3-")), "registry.json");
    const client = fakeClient();
    const worker = { ...carolyn, displayName: "Carolyn v2" };
    await handleSendToWorker({ workers: [carolyn], name: "carolyn", message: "one", client, store: createConversationStore({ filePath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    await handleSendToWorker({ workers: [worker], name: "carolyn", message: "two", client, store: createConversationStore({ filePath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    expect(client.createConversation).toHaveBeenCalledOnce();
    expect(client.createResponse).toHaveBeenNthCalledWith(2, expect.objectContaining({ conversationId: "conv_new" }));
  });

  it("fails without creating when the persisted backing agent is renamed", async () => {
    const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "mcp3-")), "registry.json");
    const first = fakeClient();
    await handleSendToWorker({ workers: [carolyn], name: "carolyn", message: "one", client: first, store: createConversationStore({ filePath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    const second = fakeClient();
    await expect(handleSendToWorker({ workers: [{ ...carolyn, name: "renamed" }], name: "renamed", message: "two", client: second, store: createConversationStore({ filePath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() })).rejects.toThrow(/agent|mismatch/i);
    expect(second.createConversation).not.toHaveBeenCalled();
  });

  it("marks not-found validation broken but leaves transient failures retryable", async () => {
    const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "mcp3-")), "registry.json");
    const first = fakeClient();
    await handleSendToWorker({ workers: [carolyn], name: "carolyn", message: "one", client: first, store: createConversationStore({ filePath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    const gone = fakeClient({ getConversation: vi.fn(async () => ({ kind: "not_found" as const })) });
    await expect(handleSendToWorker({ workers: [carolyn], name: "carolyn", message: "two", client: gone, store: createConversationStore({ filePath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() })).rejects.toThrow(/validation|not_found|mismatch/i);
    const transientPath = path.join(mkdtempSync(path.join(os.tmpdir(), "mcp3-")), "registry.json");
    await handleSendToWorker({ workers: [carolyn], name: "carolyn", message: "one", client: fakeClient(), store: createConversationStore({ filePath: transientPath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    const transient = fakeClient({ getConversation: vi.fn(async () => { throw new Error("timeout"); }) });
    await expect(handleSendToWorker({ workers: [carolyn], name: "carolyn", message: "three", client: transient, store: createConversationStore({ filePath: transientPath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() })).rejects.toThrow("timeout");
  });

  it("does not classify unrelated kind-shaped conversations as not found", async () => {
    const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "mcp3-")), "registry.json");
    const first = fakeClient();
    await handleSendToWorker({ workers: [carolyn], name: "carolyn", message: "one", client: first, store: createConversationStore({ filePath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    const malformed = fakeClient({ getConversation: vi.fn(async () => ({ kind: "unexpected" } as never)) });
    await expect(handleSendToWorker({ workers: [carolyn], name: "carolyn", message: "two", client: malformed, store: createConversationStore({ filePath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() })).rejects.toThrow(/cannot read|metadata|mismatch/i);
  });

  it("creates a conversation on first call, reuses it on second", async () => {
    const store = createConversationStore();
    const registry = createInFlightRegistry();
    const client = fakeClient();
    const emitLedger = fakeEmitLedger();

    const r1 = await handleSendToWorker({
      workers: [carolyn],
      name: "carolyn",
      message: "hi",
      client,
      store,
      waitBudgetSeconds: 30,
      registry,
      emitLedger,
    });
    expect(r1.kind).toBe("completed");
    if (r1.kind === "completed") {
      expect(r1.conversationId).toBe("conv_new");
      expect(r1.reply).toBe("Hello back");
    }
    expect(client.createConversation).toHaveBeenCalledTimes(1);
    // The MCP surface stamps the canonical worker attribution key.
    expect(client.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ app: "m8t", platform: "mcp", agent: "carolyn" }),
    );

    await handleSendToWorker({
      workers: [carolyn],
      name: "carolyn",
      message: "again",
      client,
      store,
      waitBudgetSeconds: 30,
      registry,
      emitLedger,
    });
    expect(client.createConversation).toHaveBeenCalledTimes(1);
    expect(client.createResponse).toHaveBeenCalledTimes(2);
  });

  it("emits a completed ledger row on successful response", async () => {
    const store = createConversationStore();
    const registry = createInFlightRegistry();
    const emitLedger = fakeEmitLedger();

    const result = await handleSendToWorker({
      workers: [carolyn],
      name: "carolyn",
      message: "ping",
      client: fakeClient(),
      store,
      waitBudgetSeconds: 30,
      registry,
      emitLedger,
    });

    expect(result.kind).toBe("completed");
    expect(emitLedger).toHaveBeenCalledOnce();
    expect(emitLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "carolyn",
        source: "mcp",
        outcome: "ok",
        responseId: expect.any(String),
        foundryConversationId: expect.any(String),
      }),
    );
  });

  it("throws a clear error for an unknown worker", async () => {
    await expect(
      handleSendToWorker({
        workers: [carolyn],
        name: "ghost",
        message: "hi",
        client: fakeClient(),
        store: createConversationStore(),
        waitBudgetSeconds: 30,
        registry: createInFlightRegistry(),
        emitLedger: fakeEmitLedger(),
      }),
    ).rejects.toThrow(/worker 'ghost' not found/i);
  });

  it("emits an error ledger row and rethrows when createResponse rejects", async () => {
    const emitLedger = fakeEmitLedger();
    const errorClient = fakeClient({
      createResponse: vi.fn().mockRejectedValue(new Error("foundry boom")),
    });

    await expect(
      handleSendToWorker({
        workers: [carolyn],
        name: "carolyn",
        message: "boom",
        client: errorClient,
        store: createConversationStore(),
        waitBudgetSeconds: 30,
        registry: createInFlightRegistry(),
        emitLedger,
      }),
    ).rejects.toThrow("foundry boom");

    expect(emitLedger).toHaveBeenCalledOnce();
    expect(emitLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "carolyn",
        source: "mcp",
        outcome: "error",
        errorCode: expect.any(String),
      }),
    );
  });
});

describe("handleSendToWorker (kind forwarding)", () => {
  it("forwards kind to createResponse and emits agentKind in the ledger", async () => {
    const hostedWorker: WorkerRecord = {
      ...carolyn,
      name: "coder",
      displayName: "Coder",
      kind: "hosted",
    };
    const createResponseSpy = vi.fn(async () => ({ id: "resp_h", output: "Done", model: "gpt-4.1" }));
    const emitLedgerSpy = fakeEmitLedger();
    const client = fakeClient({ createResponse: createResponseSpy });

    await handleSendToWorker({
      workers: [hostedWorker],
      name: "coder",
      message: "hello",
      client,
      store: createConversationStore(),
      waitBudgetSeconds: 30,
      registry: createInFlightRegistry(),
      emitLedger: emitLedgerSpy,
    });

    expect(createResponseSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: "hosted" }));
    expect(emitLedgerSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ agentKind: "hosted" }));
  });
});

describe("handleSendToWorker (hosted transcript persistence)", () => {
  const hosted: WorkerRecord = { ...carolyn, name: "coder", displayName: "Coder", kind: "hosted" };

  it("loads server history, sends the current user turn once, then waits for the ordered append before completing", async () => {
    const calls: string[] = [];
    let resolveResponse!: (value: { id: string; output: string; model?: string }) => void;
    let resolveAppend!: () => void;
    const appendDone = new Promise<void>(resolve => { resolveAppend = resolve; });
    const client = fakeClient({
      getConversationMessages: vi.fn(async (): Promise<ChatTurn[]> => { calls.push("history"); return [{ role: "user", content: "old" }, { role: "assistant", content: "reply" }]; }),
      createResponse: vi.fn((args: CreateResponseArgs): Promise<CreateResponseResult> => {
        const { history } = args;
        calls.push("response");
        expect(history).toEqual([
          { role: "user", content: "old" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "now" },
        ]);
        return new Promise<CreateResponseResult>(resolve => { resolveResponse = resolve; });
      }),
      appendConversationItems: vi.fn(async (_id, turns) => {
        calls.push("append");
        expect(turns).toEqual([{ role: "user", content: "now" }, { role: "assistant", content: "answer" }]);
        await appendDone;
      }),
    });
    const pending = handleSendToWorker({ workers: [hosted], name: "coder", message: "now", client, store: createConversationStore(), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    await vi.waitFor(() => { expect(calls).toEqual(["history", "response"]); });
    resolveResponse({ id: "r", output: "answer" });
    await vi.waitFor(() => { expect(calls).toEqual(["history", "response", "append"]); });
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    resolveAppend();
    await expect(pending).resolves.toMatchObject({ kind: "completed", reply: "answer" });
  });

  it("detached tasks remain pending until hosted response persistence finishes", async () => {
    let resolveResponse!: (value: { id: string; output: string }) => void;
    let resolveAppend!: () => void;
    const appendDone = new Promise<void>(resolve => { resolveAppend = resolve; });
    const client = fakeClient({
      getConversationMessages: vi.fn(async (): Promise<ChatTurn[]> => []),
      createResponse: vi.fn((args: CreateResponseArgs): Promise<CreateResponseResult> => {
        expect(args.history).toEqual([{ role: "user", content: "slow" }]);
        return new Promise<CreateResponseResult>(resolve => { resolveResponse = resolve; });
      }),
      appendConversationItems: vi.fn(async () => appendDone),
    });
    const registry = createInFlightRegistry();
    const result = await handleSendToWorker({ workers: [hosted], name: "coder", message: "slow", client, store: createConversationStore(), waitBudgetSeconds: 0, registry, emitLedger: fakeEmitLedger() });
    expect(result.kind).toBe("detached");
    if (result.kind !== "detached") return;
    resolveResponse({ id: "r", output: "late" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(registry.peek(result.taskId).kind).toBe("still_running");
    resolveAppend();
    await vi.waitFor(() => { expect(registry.peek(result.taskId)).toMatchObject({ kind: "completed", reply: "late" }); });
  });

  it("serializes hosted history replay and append across concurrent turns", async () => {
    const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "mcp-turn-lease-")), "registry.json");
    const calls: string[] = [];
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>(resolve => { releaseAppend = resolve; });
    let responseCount = 0;
    const client = fakeClient({
      getConversationMessages: vi.fn(async () => { calls.push("history"); return []; }),
      createResponse: vi.fn(async ({ message }: CreateResponseArgs): Promise<CreateResponseResult> => { calls.push(`response:${message}`); responseCount++; return { id: `r${String(responseCount)}`, output: `a${message}` }; }),
      appendConversationItems: vi.fn(async (_id, turns) => { const content = String(turns[0]?.content ?? ""); calls.push(`append:${content}`); if (content === "one") await appendGate; }),
    });
    const store = createConversationStore({ filePath });
    const args = (message: string) => ({ workers: [hosted], name: "coder", message, client, store, waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    const first = handleSendToWorker(args("one"));
    await vi.waitFor(() => { expect(calls).toEqual(["history", "response:one", "append:one"]); });
    const second = handleSendToWorker(args("two"));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toEqual(["history", "response:one", "append:one"]);
    releaseAppend();
    await expect(first).resolves.toMatchObject({ kind: "completed" });
    await expect(second).resolves.toMatchObject({ kind: "completed" });
    expect(calls).toEqual(["history", "response:one", "append:one", "history", "response:two", "append:two"]);
  });

  it("records an error and returns no success when hosted transcript append fails", async () => {
    const emitLedger = fakeEmitLedger();
    const client = fakeClient({
      getConversationMessages: vi.fn(async () => []),
      appendConversationItems: vi.fn(async () => { throw new Error("append failed"); }),
    });
    await expect(handleSendToWorker({ workers: [hosted], name: "coder", message: "persist me", client, store: createConversationStore(), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger })).rejects.toThrow("append failed");
    expect(client.appendConversationItems).toHaveBeenCalledOnce();
    expect(emitLedger).toHaveBeenCalledOnce();
    expect(emitLedger).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error" }));
  });

  it("does not load or append conversation history for prompt workers", async () => {
    const client = fakeClient({ getConversationMessages: vi.fn(), appendConversationItems: vi.fn() });
    await handleSendToWorker({ workers: [carolyn], name: "carolyn", message: "prompt", client, store: createConversationStore(), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    expect(client.getConversationMessages).not.toHaveBeenCalled();
    expect(client.appendConversationItems).not.toHaveBeenCalled();
    expect(client.createResponse).toHaveBeenCalledWith(expect.objectContaining({ history: undefined }));
  });

  it("replays persisted hosted turns after a new process/store is created", async () => {
    const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "mcp4-restart-")), "registry.json");
    const serverTurns: { role: "user" | "assistant"; content: string }[] = [];
    const client = fakeClient({
      getConversationMessages: vi.fn(async () => [...serverTurns]),
      appendConversationItems: vi.fn(async (_id, turns) => { serverTurns.push(...turns); }),
      createResponse: vi.fn(async (): Promise<CreateResponseResult> => ({ id: `r${String(serverTurns.length)}`, output: `a${String(serverTurns.length)}`, model: "gpt" })),
    });
    await handleSendToWorker({ workers: [hosted], name: "coder", message: "first", client, store: createConversationStore({ filePath }), waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    const restarted = createConversationStore({ filePath });
    await handleSendToWorker({ workers: [hosted], name: "coder", message: "second", client, store: restarted, waitBudgetSeconds: 30, registry: createInFlightRegistry(), emitLedger: fakeEmitLedger() });
    expect(client.createResponse).toHaveBeenLastCalledWith(expect.objectContaining({ history: [
      { role: "user", content: "first" }, { role: "assistant", content: "a0" }, { role: "user", content: "second" },
    ] }));
  });
});

describe("handleSendToWorker (detach path)", () => {
  it("returns detached when the response takes longer than the budget", async () => {
    const store = createConversationStore();
    const registry = createInFlightRegistry();
    const emitLedger = fakeEmitLedger();
    const slowClient: FoundryClient = {
      listAgents: vi.fn(),
      createConversation: async () => ({ id: "conv_slow" }),
      createResponse: () =>
        new Promise((res) => setTimeout(() => { res({ id: "r", output: "late" }); }, 500)),
    } as unknown as FoundryClient;

    const result = await handleSendToWorker({
      workers: [carolyn],
      name: "carolyn",
      message: "hi",
      client: slowClient,
      store,
      waitBudgetSeconds: 0.1,
      registry,
      emitLedger,
    });
    expect(result.kind).toBe("detached");
    if (result.kind === "detached") {
      expect(result.taskId).toBeTruthy();
      expect(result.conversationId).toBe("conv_slow");
    }
  });

  it("emits outcome:empty on sync path when output is blank and no artifacts", async () => {
    const emitLedger = fakeEmitLedger();
    const client = fakeClient({ createResponse: vi.fn(async () => ({ id: "resp_e", output: "   ", model: "gpt-5.1" })) });
    await handleSendToWorker({
      workers: [carolyn], name: "carolyn", message: "ping",
      client, store: createConversationStore(), waitBudgetSeconds: 30,
      registry: createInFlightRegistry(), emitLedger,
    });
    expect(emitLedger).toHaveBeenCalledWith(expect.objectContaining({ outcome: "empty" }));
  });

  it("emits outcome:ok on sync path when output is non-empty", async () => {
    const emitLedger = fakeEmitLedger();
    const client = fakeClient({ createResponse: vi.fn(async () => ({ id: "resp_ok", output: "Hello back", model: "gpt-5.1" })) });
    await handleSendToWorker({
      workers: [carolyn], name: "carolyn", message: "ping",
      client, store: createConversationStore(), waitBudgetSeconds: 30,
      registry: createInFlightRegistry(), emitLedger,
    });
    expect(emitLedger).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ok" }));
  });

  it("emits outcome:ok on sync path when output is blank but artifacts array is non-empty", async () => {
    const emitLedger = fakeEmitLedger();
    const client = fakeClient({
      createResponse: vi.fn(async () => ({
        id: "resp_art",
        output: "   ",
        model: "gpt-5.1",
        artifacts: [{ name: "report.csv", path: "report.csv", mime: "text/csv", size_bytes: 42, session_id: "sess_art" }],
        agentSessionId: "sess_art",
      })),
    });
    await handleSendToWorker({
      workers: [carolyn], name: "carolyn", message: "ping",
      client, store: createConversationStore(), waitBudgetSeconds: 30,
      registry: createInFlightRegistry(), emitLedger,
    });
    expect(emitLedger).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ok" }));
  });

  it("emits outcome:empty on detached path when late-resolved output is blank", async () => {
    const emitLedger = fakeEmitLedger();
    let resolveResponse!: (v: { id: string; output: string; model?: string }) => void;
    const responsePromise = new Promise<{ id: string; output: string; model?: string }>(
      (res) => (resolveResponse = res),
    );
    const slowClient: FoundryClient = {
      listAgents: vi.fn(),
      createConversation: async () => ({ id: "conv_empty_det" }),
      createResponse: () => responsePromise,
    } as unknown as FoundryClient;

    const result = await handleSendToWorker({
      workers: [carolyn], name: "carolyn", message: "ping",
      client: slowClient, store: createConversationStore(), waitBudgetSeconds: 0,
      registry: createInFlightRegistry(), emitLedger,
    });
    expect(result.kind).toBe("detached");
    expect(emitLedger).not.toHaveBeenCalled();

    resolveResponse({ id: "resp_empty_det", output: "", model: "gpt-5.1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(emitLedger).toHaveBeenCalledOnce();
    expect(emitLedger).toHaveBeenCalledWith(expect.objectContaining({ outcome: "empty" }));
  });

  it("emits a detached ok row after the response finally resolves (independent of registry)", async () => {
    const store = createConversationStore();
    const registry = createInFlightRegistry();
    const emitLedger = fakeEmitLedger();

    let resolveResponse!: (v: { id: string; output: string; model?: string }) => void;
    const responsePromise = new Promise<{ id: string; output: string; model?: string }>(
      (res) => (resolveResponse = res),
    );
    const slowClient: FoundryClient = {
      listAgents: vi.fn(),
      createConversation: async () => ({ id: "conv_det" }),
      createResponse: () => responsePromise,
    } as unknown as FoundryClient;

    // budget=0 → immediately detaches
    const result = await handleSendToWorker({
      workers: [carolyn],
      name: "carolyn",
      message: "slow",
      client: slowClient,
      store,
      waitBudgetSeconds: 0,
      registry,
      emitLedger,
    });
    expect(result.kind).toBe("detached");
    // Emit should not have fired yet
    expect(emitLedger).not.toHaveBeenCalled();

    // Now the underlying response resolves
    resolveResponse({ id: "resp_det", output: "done", model: "gpt-5.1" });
    // Give the microtask queue a tick to process the chained .then
    await new Promise((r) => setTimeout(r, 0));

    expect(emitLedger).toHaveBeenCalledOnce();
    expect(emitLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "carolyn",
        source: "mcp",
        outcome: "ok",
        responseId: "resp_det",
        foundryConversationId: "conv_det",
      }),
    );
  });
});

describe("handleSendToWorker (brain rotation)", () => {
  const appModeBrainWorker: WorkerRecord = {
    ...carolyn,
    name: "cmo-brain",
    displayName: "CMO Brain",
    brain: {
      repo: "orkeren21/cmo-brain-f02",
      credentialRef: "cmo-brain-f02-github-token",
      installationId: "999",
      branch: "main",
      topology: "per-worker",
      schemaVersion: "1",
    },
  };
  const patModeBrainWorker: WorkerRecord = {
    ...carolyn,
    name: "cmo-brain-pat",
    displayName: "CMO Brain (PAT)",
    brain: {
      repo: "orkeren21/cmo-brain-f01",
      credentialRef: "cmo-brain-f01-github-token",
      // no installationId → PAT mode
      branch: "main",
      topology: "per-worker",
      schemaVersion: "1",
    },
  };

  beforeEach(() => {
    process.env.AZURE_FOUNDRY_PROJECT_ARM_ID = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/proj";
    process.env.AZURE_KEYVAULT_URI = "https://kv-test.vault.azure.net";
    vi.mocked(rotateConnectionAuth).mockClear();
  });
  afterEach(() => {
    delete process.env.AZURE_FOUNDRY_PROJECT_ARM_ID;
    delete process.env.AZURE_KEYVAULT_URI;
  });

  it("App-mode brain worker: calls rotateConnectionAuth before createResponse", async () => {
    const createResponseSpy = vi.fn(async () => ({ id: "resp_brain", output: "done", model: "gpt-4.1" }));
    const client = fakeClient({ createResponse: createResponseSpy });
    const callOrder: string[] = [];
    vi.mocked(rotateConnectionAuth).mockImplementationOnce(async () => {
      callOrder.push("rotate");
      return { rotatedAt: new Date(), expiresAt: new Date() };
    });
    createResponseSpy.mockImplementationOnce(async () => {
      callOrder.push("createResponse");
      return { id: "resp_brain", output: "done", model: "gpt-4.1" };
    });

    await handleSendToWorker({
      workers: [appModeBrainWorker],
      name: "cmo-brain",
      message: "hello",
      client,
      store: createConversationStore(),
      waitBudgetSeconds: 30,
      registry: createInFlightRegistry(),
      emitLedger: fakeEmitLedger(),
    });

    expect(rotateConnectionAuth).toHaveBeenCalledOnce();
    expect(rotateConnectionAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        kvUri: "https://kv-test.vault.azure.net",
        projectArmId: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/proj",
        connectionName: "cmo-brain-f02-github-token",
        installationId: "999",
        repository: "orkeren21/cmo-brain-f02",
      }),
    );
    // rotate MUST precede createResponse
    expect(callOrder).toEqual(["rotate", "createResponse"]);
  });

  it("PAT-mode brain worker (no installationId): does NOT call rotateConnectionAuth", async () => {
    const client = fakeClient();

    await handleSendToWorker({
      workers: [patModeBrainWorker],
      name: "cmo-brain-pat",
      message: "hello",
      client,
      store: createConversationStore(),
      waitBudgetSeconds: 30,
      registry: createInFlightRegistry(),
      emitLedger: fakeEmitLedger(),
    });

    expect(rotateConnectionAuth).not.toHaveBeenCalled();
  });

  it("non-brain worker: does NOT call rotateConnectionAuth", async () => {
    const client = fakeClient();

    await handleSendToWorker({
      workers: [carolyn],
      name: "carolyn",
      message: "hi",
      client,
      store: createConversationStore(),
      waitBudgetSeconds: 30,
      registry: createInFlightRegistry(),
      emitLedger: fakeEmitLedger(),
    });

    expect(rotateConnectionAuth).not.toHaveBeenCalled();
  });

  it("throws a clear error when AZURE_FOUNDRY_PROJECT_ARM_ID is missing", async () => {
    delete process.env.AZURE_FOUNDRY_PROJECT_ARM_ID;
    const registryPath = process.env.M8T_CONVERSATION_REGISTRY_PATH!;
    const hostedBrainWorker = { ...appModeBrainWorker, kind: "hosted" as const };

    await expect(
      handleSendToWorker({
        workers: [hostedBrainWorker],
        name: "cmo-brain",
        message: "hello",
        client: fakeClient(),
        store: createConversationStore(),
        waitBudgetSeconds: 30,
        registry: createInFlightRegistry(),
        emitLedger: fakeEmitLedger(),
      }),
    ).rejects.toThrow(/AZURE_FOUNDRY_PROJECT_ARM_ID/);
    expect((await readdir(path.dirname(registryPath))).some(name => name.endsWith(".turn.lock"))).toBe(false);
  });

  it("throws a clear error when AZURE_KEYVAULT_URI is missing", async () => {
    delete process.env.AZURE_KEYVAULT_URI;

    await expect(
      handleSendToWorker({
        workers: [appModeBrainWorker],
        name: "cmo-brain",
        message: "hello",
        client: fakeClient(),
        store: createConversationStore(),
        waitBudgetSeconds: 30,
        registry: createInFlightRegistry(),
        emitLedger: fakeEmitLedger(),
      }),
    ).rejects.toThrow(/AZURE_KEYVAULT_URI/);
  });

  it("hosted in-container brain worker: does NOT call rotateConnectionAuth", async () => {
    // kind:hosted + brain.credentialRef="in-container" + installationId set
    const hostedBrainWorker: WorkerRecord = {
      ...carolyn,
      name: "coder-brain",
      displayName: "Coder Brain",
      kind: "hosted",
      brain: {
        repo: "m8t-labs/coder-x-brain",
        branch: "main",
        topology: "per-worker",
        schemaVersion: "1",
        credentialRef: "in-container",
        installationId: "42",
      },
    };
    const client = fakeClient();

    await handleSendToWorker({
      workers: [hostedBrainWorker],
      name: "coder-brain",
      message: "hello",
      client,
      store: createConversationStore(),
      waitBudgetSeconds: 30,
      registry: createInFlightRegistry(),
      emitLedger: fakeEmitLedger(),
    });

    expect(rotateConnectionAuth).not.toHaveBeenCalled();
  });
});

describe("handleSendToWorker (hosted artifact download)", () => {
  const coder: WorkerRecord = {
    name: "coder",
    displayName: "Coder",
    role: "Dev",
    description: "Dev",
    persona: "coder",
    personaVersion: "0.1",
    agentId: "asst_c",
    projectEndpoint: "https://x",
    model: "gpt-4.1-mini",
    deployedAt: null,
    kind: "hosted",
  };

  // Redirect the artifact root to a tmpdir — never wipe a real ~/.m8t.
  beforeAll(() => { process.env.M8T_ARTIFACT_ROOT = mkdtempSync(path.join(os.tmpdir(), "m8t-art-")); });
  afterAll(() => { rmSync(artifactRoot(), { recursive: true, force: true }); delete process.env.M8T_ARTIFACT_ROOT; });
  afterEach(() => { rmSync(artifactRoot(), { recursive: true, force: true }); });

  it("downloads artifact bytes and includes localPath in the completed result", async () => {
    const artifactData = Buffer.from("CHARTDATA");
    const createResponseSpy = vi.fn(async () => ({
      id: "caresp_a",
      output: "Here is your chart",
      model: "gpt-4.1",
      artifacts: [{ name: "chart.png", path: "chart.png", mime: "image/png", size_bytes: 9, session_id: "sess1", description: "chart" }],
      agentSessionId: "sess1",
    }));
    const downloadArtifactSpy = vi.fn(async () => artifactData);

    const client: FoundryClient = {
      listAgents: vi.fn(),
      createConversation: vi.fn(async () => ({ id: "conv_a" })),
      getConversation: vi.fn(async () => ({ kind: "not_found" as const })),
      getConversationMessages: vi.fn(async () => []),
      appendConversationItems: vi.fn(async () => {}),
      createResponse: createResponseSpy,
      downloadArtifact: downloadArtifactSpy,
    };

    const result = await handleSendToWorker({
      workers: [coder],
      name: "coder",
      message: "make me a chart",
      client,
      store: createConversationStore(),
      waitBudgetSeconds: 30,
      registry: createInFlightRegistry(),
      emitLedger: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.files).toHaveLength(1);
      expect(result.files![0].name).toBe("chart.png");
      expect(result.files![0].mime).toBe("image/png");
      expect(result.files![0].size).toBe(9);
      expect(result.files![0].localPath).toMatch(/[/\\]sess1[/\\]chart\.png$/); // under artifactRoot() (tmpdir in tests)
      expect(existsSync(result.files![0].localPath)).toBe(true);
    }
    expect(downloadArtifactSpy).toHaveBeenCalledWith("coder", "sess1", "chart.png");
  });

  it("returns empty files for a prompt worker even with artifact-shaped output", async () => {
    const promptWorker: WorkerRecord = { ...coder, kind: "prompt", name: "carolyn", displayName: "Carolyn" };
    const createResponseSpy = vi.fn(async () => ({
      id: "resp_p",
      output: "Hi there",
      model: "gpt-4.1",
    }));
    const downloadArtifactSpy = vi.fn();

    const client: FoundryClient = {
      listAgents: vi.fn(),
      createConversation: vi.fn(async () => ({ id: "conv_p" })),
      getConversation: vi.fn(async () => ({ kind: "not_found" as const })),
      getConversationMessages: vi.fn(async () => []),
      appendConversationItems: vi.fn(async () => {}),
      createResponse: createResponseSpy,
      downloadArtifact: downloadArtifactSpy,
    };

    const result = await handleSendToWorker({
      workers: [promptWorker],
      name: "carolyn",
      message: "hi",
      client,
      store: createConversationStore(),
      waitBudgetSeconds: 30,
      registry: createInFlightRegistry(),
      emitLedger: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.files ?? []).toHaveLength(0);
    }
    expect(downloadArtifactSpy).not.toHaveBeenCalled();
  });

  it("detached path downloads hosted artifacts into the registry result", async () => {
    const store = createConversationStore();
    const registry = createInFlightRegistry();

    let resolveResponse!: (v: {
      id: string;
      output: string;
      model: string;
      artifacts: { name: string; path: string; mime: string; size_bytes: number; session_id: string }[];
      agentSessionId: string;
    }) => void;
    const responsePromise = new Promise<{
      id: string;
      output: string;
      model: string;
      artifacts: { name: string; path: string; mime: string; size_bytes: number; session_id: string }[];
      agentSessionId: string;
    }>((res) => (resolveResponse = res));

    const downloadArtifactSpy = vi.fn(async () => Buffer.from("PNGOK"));

    const client: FoundryClient = {
      listAgents: vi.fn(),
      createConversation: vi.fn(async () => ({ id: "conv_det_hosted" })),
      getConversation: vi.fn(async () => ({ kind: "not_found" as const })),
      getConversationMessages: vi.fn(async () => []),
      appendConversationItems: vi.fn(async () => {}),
      createResponse: () => responsePromise,
      downloadArtifact: downloadArtifactSpy,
    };

    // budget=0 → immediately detaches
    const result = await handleSendToWorker({
      workers: [coder],
      name: "coder",
      message: "make me a chart",
      client,
      store,
      waitBudgetSeconds: 0,
      registry,
      emitLedger: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.kind).toBe("detached");
    const taskId = result.kind === "detached" ? result.taskId : "";
    expect(taskId).toBeTruthy();

    // Registry should still be running — response hasn't resolved yet
    expect(registry.peek(taskId).kind).toBe("still_running");

    // Now resolve the response with an artifact
    resolveResponse({
      id: "resp_det_hosted",
      output: "done",
      model: "",
      artifacts: [{ name: "chart.png", path: "chart.png", mime: "image/png", size_bytes: 5, session_id: "sessX" }],
      agentSessionId: "sessX",
    });

    // Wait until the registry observes persistence, lease release, and artifact download.
    await vi.waitFor(() => { expect(registry.peek(taskId).kind).toBe("completed"); });

    const peeked = registry.peek(taskId);
    expect(peeked.kind).toBe("completed");
    if (peeked.kind === "completed") {
      expect(peeked.files).toHaveLength(1);
      expect(peeked.files![0].name).toBe("chart.png");
    }
    expect(downloadArtifactSpy).toHaveBeenCalledWith("coder", "sessX", "chart.png");
  });
});
