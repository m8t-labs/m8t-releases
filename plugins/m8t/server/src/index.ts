import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { installFoundryDnsShim } from "./dns-shim.js";
import { resolveWaitBudget } from "./wait-budget.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DefaultAzureCredential } from "@azure/identity";
import { resolveProjectEndpoint } from "./project-endpoint.js";
import { readRepoRoot } from "./repo-root.js";
import { createFoundryClient, type FoundryClient } from "./foundry-client.js";
import { createConversationStore, type ConversationStore } from "./conversation-store.js";
import { createInFlightRegistry, type InFlightRegistry } from "./in-flight-tasks.js";
import { loadConfig, type Config } from "./config.js";
import { createPoller, type Poller } from "./poller.js";
import { syncCommandsToFs } from "./sync-commands.js";
import { createLogger, type Logger } from "./logger.js";
import { handleListWorkers } from "./tools/list-workers.js";
import { handleSendToWorker } from "./tools/send-to-worker.js";
import { handleCheckWorker } from "./tools/check-worker.js";
import { friendlyToolError } from "./tools/tool-errors.js";
import { createLazyInit } from "./lazy-init.js";
import type { WorkerRecord } from "./worker-builder.js";
import type { LedgerEvent } from "@m8t-stack/agent-ledger";
import { discoverStorageAccountName } from "./ledger/storage-discovery.js";
import { createLedgerTableClient } from "./ledger/table-client.js";
import { createMcpLedgerEmitter } from "./ledger/emit.js";
import { SERVER_VERSION } from "./version.js";

// Install DNS shim before any network activity so undici {all:true} lookups
// for *.services.ai.azure.com route through c-ares (bypasses macOS getaddrinfo
// which can't follow the 6-hop CNAME). Must run before AIProjectClient init.
installFoundryDnsShim();

// Lazy state — populated by initWorkerInfrastructure() on first tool call.
interface WorkerInfra {
  config: Config;
  client: FoundryClient;
  store: ConversationStore;
  registry: InFlightRegistry;
  logger: Logger;
  poller: Poller;
  projectEndpoint: string;
  repoRoot: string;
  getCache: () => WorkerRecord[];
  emitLedger: (e: LedgerEvent) => Promise<void>;
}

async function initWorkerInfrastructure(): Promise<WorkerInfra> {
  const config = await loadConfig();
  const projectEndpoint = config.projectEndpointOverride ?? (await resolveProjectEndpoint());
  const repoRoot = await readRepoRoot();
  const client = createFoundryClient({ projectEndpoint });
  const logger = createLogger({
    filePath: path.join(os.homedir(), ".m8t", "logs", "m8t.log"),
    level: config.logLevel,
  });
  const store = createConversationStore({
    observe: (event) => {
      // Registry outcomes are deliberately content-free: endpoint and local
      // username never enter logs, while hashed identity fields aid diagnosis.
      const details = event as Partial<{
        installationHash: string;
        personaKey: string;
        activeAgentName: string;
        conversationId: string;
        errorCode: string;
      }>;
      logger.info("conversation registry outcome", {
        outcome: event.kind,
        ...(details.installationHash ? { installationHash: details.installationHash } : {}),
        ...(details.personaKey ? { persona: details.personaKey } : {}),
        ...(details.activeAgentName ? { agent: details.activeAgentName } : {}),
        ...(details.conversationId ? { conversationId: details.conversationId } : {}),
        ...(details.errorCode ? { errorCode: details.errorCode } : {}),
      });
    },
  });
  const registry = createInFlightRegistry();
  logger.info("m8t MCP infrastructure initialized", {
    installationHash: createHash("sha256").update(projectEndpoint).digest("hex"),
    pollIntervalSeconds: config.pollIntervalSeconds,
    responseWaitBudgetSeconds: config.responseWaitBudgetSeconds,
  });

  // Ledger emitter — secondary to send_to_worker. Degrade to a no-op if the
  // storage account can't be discovered, so ledger problems never break tools.
  let emitLedger: (e: LedgerEvent) => Promise<void> = () => Promise.resolve();
  try {
    const account = await discoverStorageAccountName();
    if (account) {
      emitLedger = createMcpLedgerEmitter(
        createLedgerTableClient(account, new DefaultAzureCredential()),
        logger,
      );
      logger.info("ledger emitter ready", { storageAccount: account });
    } else {
      logger.warn("ledger storage account not discovered — ledger disabled this session");
    }
  } catch (e) {
    logger.warn("ledger init failed — ledger disabled", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  let workersCache: WorkerRecord[] = [];
  let previousWorkers: WorkerRecord[] = [];
  const commandsDir = path.join(os.homedir(), ".claude", "commands");

  const poller = createPoller<WorkerRecord[]>({
    intervalMs: config.pollIntervalSeconds * 1000,
    fetcher: () => handleListWorkers({ client, repoRoot, projectEndpoint }),
    onUpdate: (latest) => {
      workersCache = latest;
      void syncCommandsToFs({
        commandsDir,
        previous: previousWorkers,
        current: latest,
      })
        .then((report) => {
          previousWorkers = latest;
          if (
            report.added.length ||
            report.removed.length ||
            report.changed.length ||
            report.collisions.length
          ) {
            logger.info("synced commands", { ...report });
          }
        })
        .catch((err: unknown) => {
          logger.warn("sync-commands failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    onError: (err) =>
      { logger.warn("poller fetch failed", {
        error: err instanceof Error ? err.message : String(err),
      }); },
  });
  poller.start();

  return {
    config,
    client,
    store,
    registry,
    logger,
    poller,
    projectEndpoint,
    repoRoot,
    getCache: () => workersCache,
    emitLedger,
  };
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional low-level Server API: this server registers raw request handlers (ListTools/CallTool schemas) rather than using the high-level McpServer; migrating is a separate refactor.
  const server = new Server(
    { name: "m8t", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Lazy infrastructure with retry-on-failure. The first failed init (e.g.
  // ambiguous PROJECT_ENDPOINT, expired az login) must NOT poison every
  // subsequent call — createLazyInit clears the cached promise on rejection
  // so the next call re-runs initWorkerInfrastructure() and picks up any
  // user-side fixes like a freshly-written seed.yaml.
  const getInfra = createLazyInit(initWorkerInfrastructure);
  let cachedInfra: WorkerInfra | null = null;

  const shutdown = () => {
    if (cachedInfra) {
      cachedInfra.poller.stop();
      void cachedInfra.logger.flush().finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "list_workers",
        description:
          "List all m8t virtual workers currently deployed in the configured Foundry project. Returns name, displayName, role, description, agentId, projectEndpoint, model, persona, personaVersion, deployedAt.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "send_to_worker",
        description:
          "Send a message to a deployed virtual worker. When invoking, the `message` field should include any relevant context from the current coding-agent session that the worker needs to do its job — be selective. The local user resumes the durable conversation for this persona and installation.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Worker name (case-insensitive)." },
            message: { type: "string", description: "Message text including any relevant context." },
          },
          required: ["name", "message"],
          additionalProperties: false,
        },
      },
      {
        name: "check_worker",
        description:
          "Check on a previously-detached worker task. Returns still_running, completed, or failed.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "Task ID returned by a previous send_to_worker call that detached.",
            },
          },
          required: ["taskId"],
          additionalProperties: false,
        },
      },
      {
        name: "refresh_workers",
        description:
          "Force an immediate re-fetch of workers from Foundry and regenerate the slash command files. Use when a new worker was just deployed and you want it to appear in autocomplete without waiting for the next poll cycle.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      const infra = await getInfra();
      cachedInfra = infra;

      if (name === "list_workers") {
        // Cold-cache path: re-throw so an auth/network failure surfaces as a real
        // error instead of being misreported as "no workers deployed".
        if (!infra.getCache().length) await infra.poller.runOnceOrThrow();
        return { content: [{ type: "text", text: JSON.stringify(infra.getCache(), null, 2) }] };
      }
      if (name === "send_to_worker") {
        const workerName = (args as { name?: unknown }).name;
        if (typeof workerName !== "string" || !workerName.trim()) {
          throw new Error("send_to_worker requires a non-empty 'name' argument (the worker to message).");
        }
        if (!infra.getCache().length) await infra.poller.runOnceOrThrow();
        const workers = infra.getCache();
        const workerKind =
          workers.find((w) => w.name.toLowerCase() === workerName.toLowerCase())?.kind ?? "prompt";
        const result = await handleSendToWorker({
          workers,
          name: workerName,
          message: (args as { message: string }).message,
          client: infra.client,
          store: infra.store,
          waitBudgetSeconds: resolveWaitBudget(workerKind, infra.config.responseWaitBudgetSeconds),
          registry: infra.registry,
          emitLedger: infra.emitLedger,
        });
        let text = JSON.stringify(result, null, 2);
        if (result.kind === "completed" && result.files?.length) {
          const lines = result.files.map((f) => `  - ${f.localPath} (${f.mime}, ${f.size.toString()} bytes)`);
          text += `\n\n📎 Files saved locally:\n${lines.join("\n")}`;
        }
        return { content: [{ type: "text", text }] };
      }
      if (name === "check_worker") {
        const taskId = (args as { taskId?: unknown }).taskId;
        if (typeof taskId !== "string" || !taskId.trim()) {
          throw new Error("check_worker requires a non-empty 'taskId' argument (from a prior detached send_to_worker).");
        }
        const result = handleCheckWorker({
          registry: infra.registry,
          taskId,
        });
        let text = JSON.stringify(result, null, 2);
        if (result.kind === "completed" && result.files?.length) {
          const lines = result.files.map((f) => `  - ${f.localPath} (${f.mime}, ${f.size.toString()} bytes)`);
          text += `\n\n📎 Files saved locally:\n${lines.join("\n")}`;
        }
        return { content: [{ type: "text", text }] };
      }
      if (name === "refresh_workers") {
        await infra.poller.runOnce();
        return { content: [{ type: "text", text: JSON.stringify(infra.getCache(), null, 2) }] };
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      throw friendlyToolError(err, SERVER_VERSION);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("m8t MCP server crashed:", err);
  process.exit(1);
});
