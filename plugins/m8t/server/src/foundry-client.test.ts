import { describe, it, expect, vi } from "vitest";
import { createFoundryClient, isM8tStackAgent, isNotFound, validateMcpConversation, type FoundryClient } from "./foundry-client.js";

// Use vi.hoisted so mock functions are available both inside the vi.mock factory
// (hoisted to top of file by Vitest) and in test bodies.
const { responsesCreate, conversationsCreate, conversationsRetrieve, conversationsItemsList, conversationsItemsCreate } = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  conversationsCreate: vi.fn(),
  conversationsRetrieve: vi.fn(),
  conversationsItemsList: vi.fn(),
  conversationsItemsCreate: vi.fn(),
}));

vi.mock("@azure/ai-projects", () => {
  class AIProjectClient {
    getOpenAIClient() {
      return {
        responses: { create: responsesCreate },
        // The installed OpenAI Conversations SDK intentionally has no list().
        conversations: { create: conversationsCreate, retrieve: conversationsRetrieve, items: { list: conversationsItemsList, create: conversationsItemsCreate } },
      };
    }
    get agents() {
      return { list: async function* () {} };
    }
  }
  return { AIProjectClient };
});

describe("createFoundryClient", () => {
  it("returns an object exposing listAgents, createConversation, createResponse", () => {
    const client = createFoundryClient({
      projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
      credentialFactory: () => ({} as never),
    });
    expect(typeof client.listAgents).toBe("function");
    expect(typeof client.createConversation).toBe("function");
    expect(typeof client.listConversations).toBe("function");
    expect(typeof client.createResponse).toBe("function");
    expect(typeof client.getConversation).toBe("function");
    expect(typeof client.getConversationMessages).toBe("function");
    expect(typeof client.appendConversationItems).toBe("function");
  });
});

describe("isNotFound", () => {
  it("fails closed for nullish and primitive thrown values", () => {
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
    expect(isNotFound("404")).toBe(false);
  });
});

describe("conversation history", () => {
  const client = () => createFoundryClient({ projectEndpoint: "https://example.services.ai.azure.com/api/projects/test", credentialFactory: () => ({} as never) }) as Required<FoundryClient>;

  it("retrieves conversation id and metadata", async () => {
    conversationsRetrieve.mockResolvedValueOnce({ id: "conv_1", metadata: { app: "m8t", ownerKey: "abc" } });
    await expect(client().getConversation("conv_1")).resolves.toEqual({ id: "conv_1", metadata: { app: "m8t", ownerKey: "abc" } });
  });

  it("lists every conversation page with metadata and Foundry creation time", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "untagged", created_at: 5 }, { id: "c1", metadata: { provisioningToken: "t" }, created_at: 10 }], has_more: true, last_id: "c1" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "c2", metadata: { provisioningToken: "t" }, created_at: 20 }], has_more: false })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const credential = { getToken: vi.fn(async () => ({ token: "access-token", expiresOnTimestamp: Date.now() + 60_000 })) };
      const restClient = createFoundryClient({ projectEndpoint: "https://example.services.ai.azure.com/api/projects/test", credentialFactory: () => credential as never }) as Required<FoundryClient>;
      await expect(restClient.listConversations("t")).resolves.toEqual([
        { id: "untagged", metadata: {}, createdAt: "1970-01-01T00:00:05.000Z" },
        { id: "c1", metadata: { provisioningToken: "t" }, createdAt: "1970-01-01T00:00:10.000Z" },
        { id: "c2", metadata: { provisioningToken: "t" }, createdAt: "1970-01-01T00:00:20.000Z" },
      ]);
      expect(credential.getToken).toHaveBeenCalledWith("https://ai.azure.com/.default");
      expect(fetchMock).toHaveBeenNthCalledWith(1, "https://example.services.ai.azure.com/api/projects/test/openai/v1/conversations?limit=100", { headers: { Authorization: "Bearer access-token" } });
      expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.services.ai.azure.com/api/projects/test/openai/v1/conversations?limit=100&after=c1", { headers: { Authorization: "Bearer access-token" } });
    } finally { vi.unstubAllGlobals(); }
  });

  it("maps an authoritative 404 to not_found, but propagates other errors", async () => {
    conversationsRetrieve.mockRejectedValueOnce(Object.assign(new Error("gone"), { status: 404 }));
    await expect(client().getConversation("gone")).resolves.toEqual({ kind: "not_found" });
    const err = Object.assign(new Error("unauthorized"), { status: 401 });
    conversationsRetrieve.mockRejectedValueOnce(err);
    await expect(client().getConversation("x")).rejects.toBe(err);
  });

  it("reads all pages and maps input/output text in chronological order, ignoring tools", async () => {
    conversationsItemsList
      .mockResolvedValueOnce({ data: [{ type: "output_text", text: "first" }, { type: "tool_call", name: "x" }], has_more: true, last_id: "p1" })
      .mockResolvedValueOnce({ data: [{ type: "input_text", text: "second" }, { type: "output_text", text: "third" }], has_more: false });
    await expect(client().getConversationMessages("conv_1")).resolves.toEqual([
      { role: "assistant", content: "first" }, { role: "user", content: "second" }, { role: "assistant", content: "third" },
    ]);
    expect(conversationsItemsList).toHaveBeenNthCalledWith(1, "conv_1", { order: "asc" });
    expect(conversationsItemsList).toHaveBeenNthCalledWith(2, "conv_1", { after: "p1", order: "asc" });
  });

  it("appends user and assistant items in one ordered call", async () => {
    conversationsItemsCreate.mockResolvedValueOnce({});
    await client().appendConversationItems("conv_1", [{ role: "user", content: "u" }, { role: "assistant", content: "a" }]);
    expect(conversationsItemsCreate).toHaveBeenCalledWith("conv_1", { items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "u" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
    ] });
  });
});

describe("validateMcpConversation", () => {
  it("validates owner/persona/agent metadata without raw username", () => {
    expect(validateMcpConversation({ id: "c", metadata: { app: "m8t", platform: "mcp", ownerKey: "8f2f3f5c4f3e3f2f6dd5bb5e2f7f6b93e6adf51c4ec5a9983c8f45a2ab2f8df0", persona: "cmo", agent: "CMO" } }, { ownerKey: "8f2f3f5c4f3e3f2f6dd5bb5e2f7f6b93e6adf51c4ec5a9983c8f45a2ab2f8df0", personaKey: "cmo", activeAgentName: "CMO" })).toEqual({ kind: "valid" });
    expect(validateMcpConversation({ id: "c", metadata: { app: "m8t", platform: "mcp", ownerKey: "wrong", persona: "cmo", agent: "CMO" } }, { ownerKey: "expected", personaKey: "cmo", activeAgentName: "CMO" })).toEqual({ kind: "mismatch" });
  });
});

describe("createFoundryClient.createResponse", () => {
  it("returns { id, output, model } from the Foundry response", async () => {
    responsesCreate.mockResolvedValueOnce({
      id: "resp_1",
      output_text: "hi",
      model: "gpt-5.1",
    });
    const client = createFoundryClient({
      projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
      credentialFactory: () => ({} as never),
    });

    const r = await client.createResponse({
      agentName: "CMO",
      conversationId: "conv_1",
      message: "hi",
      kind: "prompt",
    });
    expect(r).toEqual({ id: "resp_1", output: "hi", model: "gpt-5.1" });
  });
});

function streamOf(events: unknown[]): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
}

describe("createFoundryClient.createResponse (hosted)", () => {
  it("hosted: stream-and-collect, NO conversation, returns collected text", async () => {
    responsesCreate.mockResolvedValueOnce(
      streamOf([
        { type: "response.created", response: { id: "caresp_h", model: "" } },
        { type: "response.output_text.delta", delta: "te" },
        { type: "response.output_text.delta", delta: "al" },
        { type: "response.completed", response: { id: "caresp_h", model: "" } },
      ]),
    );
    const client = createFoundryClient({
      projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
      credentialFactory: () => ({} as never),
    });
    const r = await client.createResponse({
      agentName: "coder",
      conversationId: "conv_ignored",
      message: "what's my color?",
      kind: "hosted",
      history: [
        { role: "user", content: "remember teal" },
        { role: "assistant", content: "noted" },
        { role: "user", content: "what's my color?" },
      ],
    });
    expect(r).toMatchObject({ id: "caresp_h", output: "teal", model: "", artifacts: [] });
    // hosted body: full history, stream:true, NO conversation, NO 2nd arg
    expect(responsesCreate).toHaveBeenCalledWith({
      input: [
        { role: "user", content: "remember teal" },
        { role: "assistant", content: "noted" },
        { role: "user", content: "what's my color?" },
      ],
      stream: true,
    });
  });
});

describe("isM8tStackAgent", () => {
  it("returns true for an agent with metadata.source === 'm8t'", () => {
    expect(
      isM8tStackAgent({
        metadata: { source: "m8t", persona: "cmo" },
      }),
    ).toBe(true);
  });

  it("returns false for an agent without the source marker", () => {
    expect(
      isM8tStackAgent({
        metadata: { source: "manual-portal-build" },
      }),
    ).toBe(false);
  });

  it("returns false for an agent with no metadata at all", () => {
    expect(isM8tStackAgent({ metadata: {} })).toBe(false);
  });
});
