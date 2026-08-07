import os from "node:os";
import { createHash } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { rotateConnectionAuth } from "@m8t-stack/github-app-auth";
import { isAppMode, isInContainer } from "../brain-link.js";
import type { FoundryClient } from "../foundry-client.js";
import type { WorkerRecord } from "../worker-builder.js";
import type { ConversationStore } from "../conversation-store.js";
import { validateMcpConversation } from "../foundry-client.js";
import type { McpConversationKey } from "../conversation-store.js";
import type { InFlightRegistry } from "../in-flight-tasks.js";
import { resolveWorker } from "./resolve-worker.js";
import type { LedgerEvent } from "@m8t-stack/agent-ledger";
import { saveArtifact, type LocalArtifact } from "../artifact-store.js";
import type { Artifact } from "@m8t-stack/foundry-invoke";

export type SendResult =
  | { kind: "completed"; reply: string; conversationId: string; responseId: string; files?: LocalArtifact[] }
  | { kind: "detached"; taskId: string; conversationId: string; note: string };

interface Args {
  workers: WorkerRecord[];
  name: string;
  message: string;
  client: FoundryClient;
  store: ConversationStore;
  waitBudgetSeconds: number;
  registry: InFlightRegistry;
  emitLedger: (e: LedgerEvent) => Promise<void>;
}

const BUDGET_EXPIRED = Symbol("budget_expired");

const normalizeProjectEndpoint = (endpoint: string): string => {
  const value = endpoint.trim();
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.toLowerCase().replace(/\/+$/, "");
  }
};

const canonicalPersonaKey = (persona: string): string => persona.trim().toLowerCase();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const ownerKeyFor = (key: McpConversationKey): string => hash(`${key.installationKey}\0${key.nativeUserKey}`);
const isNotFoundConversation = (value: unknown): value is { kind: "not_found" } => typeof value === "object" && value !== null && "kind" in value && value.kind === "not_found";

function buildMcpConversationMetadata(args: {
  key: McpConversationKey;
  activeAgentName: string;
  provisioningToken: string;
}): Record<string, string> {
  return {
    app: "m8t",
    platform: "mcp",
    ownerKey: ownerKeyFor(args.key),
    persona: args.key.personaKey,
    agent: args.activeAgentName.trim().toLowerCase(),
    provisioningToken: args.provisioningToken,
    createdAt: new Date().toISOString(),
  };
}

export async function handleSendToWorker(args: Args): Promise<SendResult> {
  const resolved = resolveWorker(args.workers, args.name);
  if (resolved.kind === "not-found") {
    const hint = resolved.closest.length
      ? ` Closest matches: ${resolved.closest.join(", ")}.`
      : "";
    throw new Error(`Worker '${args.name}' not found.${hint}`);
  }
  const worker = resolved.worker;

  if (!worker.persona?.trim()) throw new Error(`Worker '${worker.name}' has no persona and cannot be resumed.`);
  const nativeUserKey = os.userInfo().username.trim().toLowerCase();
  if (!nativeUserKey) throw new Error("Unable to determine the local OS username.");
  const key: McpConversationKey = {
    installationKey: normalizeProjectEndpoint(worker.projectEndpoint),
    platform: "mcp",
    nativeUserKey,
    personaKey: canonicalPersonaKey(worker.persona),
  };
  const expectedMetadata = {
    ownerKey: ownerKeyFor(key),
    personaKey: key.personaKey,
    activeAgentName: worker.name.trim().toLowerCase(),
  };
  const active = await args.store.resolve(key, worker.name, {
    createConversation: (provisioningToken) => args.client.createConversation(buildMcpConversationMetadata({ key, activeAgentName: worker.name, provisioningToken })),
    validateConversation: async (id) => {
      const conversation = await args.client.getConversation(id);
      if (isNotFoundConversation(conversation)) return { kind: "not_found" };
      return validateMcpConversation(conversation, expectedMetadata);
    },
    discoverConversations: async (token) => {
      if (!args.client.listConversations) throw new Error("conversation discovery unavailable");
      const conversations = await args.client.listConversations(token);
      return conversations.map(conversation => ({
        id: conversation.id,
        metadata: conversation.metadata,
        createdAt: conversation.createdAt,
      }));
    },
  });
  const conversationId = active.conversationId;
  // Download hosted artifacts to a local folder. Best-effort: a failed download
  // omits that file (the text answer still returns). Returns [] for prompt / no files.
  const downloadFiles = async (r: { artifacts?: Artifact[]; agentSessionId?: string }): Promise<LocalArtifact[]> => {
    if (worker.kind !== "hosted" || !r.artifacts?.length || !r.agentSessionId) return [];
    const out: LocalArtifact[] = [];
    for (const a of r.artifacts) {
      try {
        const bytes = await args.client.downloadArtifact(worker.name, r.agentSessionId, a.path);
        out.push({ name: a.name, localPath: saveArtifact(r.agentSessionId, a.name, bytes), mime: a.mime, size: a.size_bytes });
      } catch (e) {
        console.error(`[send_to_worker] artifact download failed: ${a.path}`, e);
      }
    }
    return out;
  };

  const userRef = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return undefined;
    }
  })();
  const ledgerBase = {
    agentName: worker.name,
    source: "mcp" as const,
    userRef,
    foundryConversationId: conversationId,
    inputSnippet: args.message,
    agentKind: worker.kind,
  };
  const startedAt = Date.now();

  // Brain-mode prompt workers: lazily refresh the GitHub App installation token
  // in the Foundry connection BEFORE invoking. Cache-aware — hot path is free
  // (~0 ms); cold start pays ~300 ms. PAT-mode and non-brain workers
  // are gated by isAppMode and no-op immediately. Operator sets these env vars
  // in their shell config once (they're not per-session secrets).
  if (worker.brain && isAppMode(worker.brain) && !isInContainer(worker.brain)) {
    const projectArmId = process.env.AZURE_FOUNDRY_PROJECT_ARM_ID;
    if (!projectArmId) {
      throw new Error(
        "AZURE_FOUNDRY_PROJECT_ARM_ID env var is required to invoke brain workers from the MCP plugin (set it in your shell config)",
      );
    }
    const kvUri = process.env.AZURE_KEYVAULT_URI;
    if (!kvUri) {
      throw new Error(
        "AZURE_KEYVAULT_URI env var is required to invoke brain workers from the MCP plugin (set it in your shell config)",
      );
    }
    await rotateConnectionAuth({
      credential: new DefaultAzureCredential(),
      kvUri,
      projectArmId,
      connectionName: worker.brain.credentialRef,
      installationId: worker.brain.installationId,
      repository: worker.brain.repo,
    });
  }

  // Hosted conversations are replayed and appended by this process, so hold
  // a cross-process turn lease across the entire response/persistence cycle.
  // Acquire only after all pre-invocation setup (including brain token
  // rotation) has succeeded, so failures cannot strand a lease.
  const turnLease = worker.kind === "hosted" ? await args.store.acquireTurn(key) : undefined;
  let turnReleased = false;
  const releaseTurn = async () => {
    if (turnLease && !turnReleased) {
      turnReleased = true;
      await turnLease.release();
    }
  };

  // Hosted workers are stateless: replay the server transcript and include
  // this turn exactly once. Prompt workers use Foundry's durable conversation.
  let history: Awaited<ReturnType<FoundryClient["getConversationMessages"]>> | undefined;
  try {
    history = worker.kind === "hosted"
      ? [...await args.client.getConversationMessages(conversationId), { role: "user" as const, content: args.message }]
      : undefined;
  } catch (error) {
    await releaseTurn();
    throw error;
  }

  // Invoke by NAME, not by id — agent_reference.name is what Foundry's
  // canonical responses.create body shape expects (see foundry-client.ts).
  let responsePromise: ReturnType<FoundryClient["createResponse"]>;
  try {
    responsePromise = args.client.createResponse({
      agentName: worker.name,
      conversationId,
      message: args.message,
      kind: worker.kind,
      history,
    });
  } catch (error) {
    await releaseTurn();
    throw error;
  }

  const persistHostedTurn = async (r: Awaited<typeof responsePromise>): Promise<void> => {
    if (worker.kind === "hosted") {
      await args.client.appendConversationItems(conversationId, [
        { role: "user", content: args.message },
        { role: "assistant", content: r.output },
      ]);
    }
  };

  const budgetMs = Math.max(0, args.waitBudgetSeconds * 1000);
  const budgetPromise = new Promise<typeof BUDGET_EXPIRED>((resolve) => {
    setTimeout(() => { resolve(BUDGET_EXPIRED); }, budgetMs);
  });

  let raceResult: Awaited<typeof responsePromise> | typeof BUDGET_EXPIRED;
  try {
    raceResult = await Promise.race([responsePromise, budgetPromise]);
  } catch (err) {
    await releaseTurn();
    await args.emitLedger({
      ...ledgerBase,
      eventId: `${conversationId}:err:${Date.now().toString()}`,
      timestamp: new Date().toISOString(),
      outcome: "error",
      errorCode: err instanceof Error ? err.name : "unknown",
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }

  if (raceResult === BUDGET_EXPIRED) {
    const finalConversationId = conversationId;
    const completionPromise = responsePromise.then(async (r) => {
      try {
        await persistHostedTurn(r);
        await releaseTurn();
        const isEmpty = !r.output.trim() && !(r.artifacts?.length);
        await args.emitLedger({
          ...ledgerBase,
          eventId: r.id,
          timestamp: new Date().toISOString(),
          responseId: r.id,
          model: r.model,
          outcome: isEmpty ? "empty" : "ok",
          replySnippet: r.output,
          latencyMs: Date.now() - startedAt,
        });
        return {
          reply: r.output,
          conversationId: finalConversationId,
          responseId: r.id,
          files: await downloadFiles(r),
        };
      } finally {
        await releaseTurn();
      }
    }).catch(async (err: unknown) => {
      await args.emitLedger({
        ...ledgerBase,
        eventId: `${finalConversationId}:err:${Date.now().toString()}`,
        timestamp: new Date().toISOString(),
        outcome: "error",
        errorCode: err instanceof Error ? err.name : "unknown",
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    });
    const taskId = args.registry.register(
      completionPromise,
    );
    return {
      kind: "detached",
      taskId,
      conversationId,
      note: `${worker.displayName} is still working — check back via check_worker("${taskId}").`,
    };
  }

  const isSyncEmpty = !raceResult.output.trim() && !(raceResult.artifacts?.length);
  try {
    await persistHostedTurn(raceResult);
  } catch (err) {
    await releaseTurn();
    await args.emitLedger({
      ...ledgerBase,
      eventId: `${conversationId}:err:${Date.now().toString()}`,
      timestamp: new Date().toISOString(),
      outcome: "error",
      errorCode: err instanceof Error ? err.name : "unknown",
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }
  await releaseTurn();

  await args.emitLedger({
    ...ledgerBase,
    eventId: raceResult.id,
    timestamp: new Date().toISOString(),
    responseId: raceResult.id,
    model: raceResult.model,
    outcome: isSyncEmpty ? "empty" : "ok",
    replySnippet: raceResult.output,
    latencyMs: Date.now() - startedAt,
  });

  const files = await downloadFiles(raceResult);

  return {
    kind: "completed",
    reply: raceResult.output,
    conversationId,
    responseId: raceResult.id,
    files,
  };
}
