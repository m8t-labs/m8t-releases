import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { mapFoundryError } from "./foundry-errors.js";
import {
  kindFromAgentRecord,
  hostedBlockFromAgentRecord,
  resolveResponsesTarget,
  collectHostedResponse,
  parseArtifacts,
  downloadArtifact as downloadArtifactFromInvoke,
  type WorkerKind,
  type HostedBlock,
  type Artifact,
} from "@m8t-stack/foundry-invoke";

export interface AgentRecord {
  id: string;             // agent id (from raw.id, falls back to name)
  name: string;           // agent name — used as `agent_reference.name` when invoking
  model: string;          // pulled from raw.versions.latest.definition.model
  description?: string;   // pulled from raw.versions.latest.description
  metadata: Record<string, string>;
  createdAt?: string;
  kind: WorkerKind;
  hosted?: HostedBlock;
}

export interface FoundryConversation { id: string; metadata: Record<string, string>; createdAt?: string }
export interface ChatTurn { role: "user" | "assistant"; content: string }
export type McpConversationValidation = { kind: "valid" } | { kind: "not_found" } | { kind: "mismatch" };

interface RawConversationPage {
  data: { id: string; metadata: Record<string, string>; createdAt?: string }[];
  hasMore: boolean;
  lastId?: string;
}

function parseConversationPage(value: unknown): RawConversationPage {
  if (!isRecord(value) || !Array.isArray(value.data) || (value.has_more !== undefined && typeof value.has_more !== "boolean") || (value.last_id !== undefined && typeof value.last_id !== "string")) {
    throw new Error("Foundry conversations.list returned an invalid response");
  }
  const data = value.data.map((candidate): RawConversationPage["data"][number] => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id || (candidate.metadata !== undefined && (!isRecord(candidate.metadata) || Object.values(candidate.metadata).some(item => typeof item !== "string")))) {
      throw new Error("Foundry conversations.list returned an invalid conversation");
    }
    const metadata = candidate.metadata === undefined ? {} : candidate.metadata as Record<string, string>;
    const createdAt = typeof candidate.created_at === "number" && Number.isFinite(candidate.created_at)
      ? new Date(candidate.created_at * 1_000).toISOString()
      : undefined;
    return { id: candidate.id, metadata, ...(createdAt ? { createdAt } : {}) };
  });
  if (value.has_more === true && !value.last_id) throw new Error("Foundry conversations.list returned has_more without last_id");
  return { data, hasMore: value.has_more === true, ...(typeof value.last_id === "string" ? { lastId: value.last_id } : {}) };
}

export interface FoundryClient {
  listAgents: () => Promise<AgentRecord[]>;
  createConversation: (metadata: Record<string, string>) => Promise<{ id: string }>;
  listConversations?: (provisioningToken?: string) => Promise<FoundryConversation[]>;
  getConversation: (id: string) => Promise<FoundryConversation | { kind: "not_found" }>;
  getConversationMessages: (id: string) => Promise<ChatTurn[]>;
  appendConversationItems: (id: string, turns: ChatTurn[]) => Promise<void>;
  createResponse: (args: {
    agentName: string;
    conversationId: string;
    message: string;
    kind: WorkerKind;
    history?: { role: string; content: string }[]; // hosted: full transcript incl. this turn
  }) => Promise<{ id: string; output: string; model?: string; artifacts?: Artifact[]; agentSessionId?: string }>;
  downloadArtifact: (agentName: string, sessionId: string, relPath: string) => Promise<Buffer>;
}

interface Options {
  projectEndpoint: string;
  credentialFactory?: () => InstanceType<typeof DefaultAzureCredential>;
}

// Shape of one agent record yielded by `project.agents.list()`.
// Mirrors the webapp's discovery — `model` is nested under
// versions.latest.definition.model, NOT at the top level.
// `metadata` is documented on the underlying OpenAI agents API at the top
// level; the webapp doesn't read it but the architect writes it via
// creationOptions.metadata, so it should round-trip via the SDK.
interface RawAgent {
  id?: string;
  name?: string;
  metadata?: Record<string, string>;
  versions?: {
    latest?: {
      status?: string;
      description?: string;
      definition?: {
        model?: string;
        kind?: string;
        image?: string;
        cpu?: string;
        memory?: string;
        container_protocol_versions?: { protocol?: string }[];
        protocol_versions?: { protocol?: string }[];
      };
      metadata?: Record<string, string>;     // fallback location
      created_at?: string;
    };
  };
  created_at?: string;
}

export function createFoundryClient(opts: Options): FoundryClient {
  const credential = opts.credentialFactory
    ? opts.credentialFactory()
    : new DefaultAzureCredential();
  const project = new AIProjectClient(opts.projectEndpoint, credential);
  const openai = project.getOpenAIClient();

  return {
    downloadArtifact: (agentName, sessionId, relPath) =>
      downloadArtifactFromInvoke(project, agentName, sessionId, relPath),
    listAgents: async () => {
      try {
        const agents: AgentRecord[] = [];
        // project.agents.list() lives on the AIProjectClient directly, NOT on
        // the OpenAI sub-client — same pattern as apps/web/lib/foundry.ts.
        const iter = (project as unknown as {
          agents: { list: () => AsyncIterable<RawAgent> };
        }).agents.list();
        for await (const raw of iter) {
          if (!raw.name && !raw.id) continue;
          const name = String(raw.name ?? raw.id);
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `||` (not `??`) is deliberate: an empty-string id must also fall back to name, not just undefined.
          const id = raw.id || name;
          const model = raw.versions?.latest?.definition?.model ?? "";
          const description = raw.versions?.latest?.description;
          // Metadata can be on the agent (creationOptions.metadata) OR nested
          // on the latest version. Check both — the architect's tag should win
          // either way.
          const metadata = raw.metadata ?? raw.versions?.latest?.metadata ?? {};
          const createdAt = raw.versions?.latest?.created_at ?? raw.created_at;
          agents.push({
            id,
            name,
            model,
            description,
            metadata,
            createdAt,
            kind: kindFromAgentRecord(raw),
            hosted: hostedBlockFromAgentRecord(raw),
          });
        }
        return agents;
      } catch (e) {
        throw mapFoundryError(e);
      }
    },

    createConversation: async (metadata) => {
      try {
        const conv = (await (openai as unknown as {
          conversations: {
            create: (args: { metadata: Record<string, string> }) => Promise<{ id: string }>;
          };
        }).conversations.create({ metadata }));
        return { id: conv.id };
      } catch (e) {
        throw mapFoundryError(e);
      }
    },
    listConversations: async () => {
      const out: FoundryConversation[] = [];
      const accessToken = await credential.getToken("https://ai.azure.com/.default");
      if (!accessToken.token) throw new Error("Unable to authenticate Foundry conversation discovery");
      let after: string | undefined;
      for (;;) {
        const params = new URLSearchParams({ limit: "100" });
        if (after) params.set("after", after);
        const response = await fetch(`${opts.projectEndpoint.replace(/\/+$/, "")}/openai/v1/conversations?${params}`, {
          headers: { Authorization: `Bearer ${accessToken.token}` },
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Foundry conversations.list returned HTTP ${response.status.toString()}: ${body.slice(0, 300)}`);
        }
        const page = parseConversationPage(await response.json());
        out.push(...page.data);
        if (!page.hasMore) break;
        after = page.lastId;
      }
      return out;
    },
    getConversation: async (id) => {
      try {
        const conversation = await (openai as unknown as { conversations: { retrieve: (conversationId: string) => Promise<{ id: string; metadata?: Record<string, string> }> } }).conversations.retrieve(id);
        return { id: conversation.id, metadata: conversation.metadata ?? {} };
      } catch (e) {
        if (isNotFound(e)) return { kind: "not_found" };
        throw e;
      }
    },
    getConversationMessages: async (id) => {
      const turns: ChatTurn[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await (openai as unknown as { conversations: { items: { list: (conversationId: string, params?: { after?: string; order?: "asc" | "desc" }) => Promise<{ data?: unknown[]; has_more?: boolean; last_id?: string }> } } }).conversations.items.list(id, after ? { after, order: "asc" } : { order: "asc" });
        for (const raw of page.data ?? []) {
          const item = raw as { type?: string; role?: string; text?: string; content?: unknown[] };
          const role = item.role === "user" || item.type === "input_text" ? "user" : item.role === "assistant" || item.type === "output_text" ? "assistant" : undefined;
          if (!role) continue;
          const texts = item.type === "input_text" || item.type === "output_text"
            ? [item.text]
            : (item.content ?? []).map(part => { const p = part as { type?: string; text?: string }; return (p.type === "input_text" || p.type === "output_text" || typeof p.text === "string") ? p.text : undefined; });
          for (const text of texts) if (typeof text === "string") turns.push({ role, content: text });
        }
        if (!page.has_more || !page.last_id) break;
        after = page.last_id;
      }
      return turns;
    },
    appendConversationItems: async (id, turns) => {
      await (openai as unknown as { conversations: { items: { create: (conversationId: string, args: { items: unknown[] }) => Promise<unknown> } } }).conversations.items.create(id, {
        items: turns.map(turn => ({ type: "message", role: turn.role, content: [{ type: turn.role === "user" ? "input_text" : "output_text", text: turn.content }] })),
      });
    },

    createResponse: async ({ agentName, conversationId, message, kind, history }) => {
      try {
        const { client, extraBody } = resolveResponsesTarget(project, { kind, name: agentName });
        if (kind === "hosted") {
          // Hosted: stateless container — replay the transcript, stream-and-collect.
          // NO project conversation (hosted rejects it).
          const collected = await collectHostedResponse(
            client,
            history ?? [{ role: "user", content: message }],
          );
          const { text, artifacts } = parseArtifacts(collected.text);
          return {
            id: collected.responseId,
            output: text,
            model: collected.model ?? "",
            artifacts,
            agentSessionId: collected.agentSessionId,
          };
        }
        const resp = (await (client as unknown as {
          responses: {
            create: (
              args: { conversation: string; input: { role: string; content: string }[] },
              extra?: { body?: { agent_reference: { name: string; type: "agent_reference" } } },
            ) => Promise<{ id: string; output_text?: string; model?: string }>;
          };
        }).responses.create(
          { conversation: conversationId, input: [{ role: "user", content: message }] },
          extraBody ? { body: extraBody } : undefined,
        ));
        return { id: resp.id, output: resp.output_text ?? "", model: resp.model };
      } catch (e) {
        throw mapFoundryError(e, { workerName: agentName });
      }
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function isNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const candidate = error;
  return candidate.status === 404 || candidate.statusCode === 404 || candidate.code === "404";
}

export function validateMcpConversation(conversation: FoundryConversation, expected: { ownerKey: string; personaKey: string; activeAgentName: string }): McpConversationValidation {
  const metadata = conversation.metadata;
  return metadata.app === "m8t" && metadata.platform === "mcp" && metadata.ownerKey === expected.ownerKey && metadata.persona === expected.personaKey && metadata.agent === expected.activeAgentName
    ? { kind: "valid" }
    : { kind: "mismatch" };
}

export function isM8tStackAgent(agent: Pick<AgentRecord, "metadata">): boolean {
  return agent.metadata.source === "m8t";
}
