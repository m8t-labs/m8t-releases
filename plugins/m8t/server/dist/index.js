// src/index.ts
import os7 from "os";
import path10 from "path";
import { createHash as createHash3 } from "crypto";

// src/dns-shim.ts
import dns from "dns";
var installed = false;
function installFoundryDnsShim() {
  if (installed) return;
  installed = true;
  const origLookup = dns.lookup.bind(dns);
  dns.lookup = (hostname, options, cb) => {
    const opts = typeof options === "function" ? {} : options;
    const callback = typeof options === "function" ? options : cb;
    if (typeof hostname === "string" && hostname.endsWith("services.ai.azure.com")) {
      dns.resolve4(hostname, (err, addrs) => {
        if (err || !addrs?.length) {
          origLookup(hostname, options, cb);
          return;
        }
        if (opts?.all) callback(null, addrs.map((a) => ({ address: a, family: 4 })));
        else callback(null, addrs[0], 4);
      });
      return;
    }
    origLookup(hostname, options, cb);
  };
}

// src/wait-budget.ts
function resolveWaitBudget(kind, fallbackSeconds) {
  if (kind === "hosted") {
    const raw = process.env.M8T_HOSTED_WAIT_BUDGET_SECONDS?.trim();
    const env = raw ? Number(raw) : NaN;
    return Number.isFinite(env) && env >= 0 ? env : 60;
  }
  return fallbackSeconds;
}

// src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DefaultAzureCredential as DefaultAzureCredential5 } from "@azure/identity";

// src/project-endpoint.ts
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parse as parseYaml } from "yaml";

// src/auto-discover.ts
import { DefaultAzureCredential } from "@azure/identity";
import { exec } from "child_process";
import { promisify } from "util";
var execAsync = promisify(exec);
async function defaultSubscriptionIdProvider() {
  if (process.env.AZURE_SUBSCRIPTION_ID) return process.env.AZURE_SUBSCRIPTION_ID;
  try {
    const { stdout } = await execAsync("az account show --query id -o tsv");
    const id = stdout.trim();
    return id || null;
  } catch {
    return null;
  }
}
async function autoDiscoverProjectEndpoint(opts = {}) {
  const credential = opts.credential ?? new DefaultAzureCredential();
  const fetcher = opts.fetchFn ?? fetch;
  const subProvider = opts.subscriptionIdProvider ?? defaultSubscriptionIdProvider;
  let token;
  try {
    const tokenResp = await credential.getToken("https://management.azure.com/.default");
    if (!tokenResp) return { kind: "no-login" };
    token = tokenResp.token;
  } catch {
    return { kind: "no-login" };
  }
  const subscriptionId = await subProvider();
  if (!subscriptionId) {
    return {
      kind: "error",
      message: "Could not determine your Azure subscription. Set AZURE_SUBSCRIPTION_ID or run `az login`."
    };
  }
  const candidates = [];
  const authHeaders = { Authorization: `Bearer ${token}` };
  let accountsData = {};
  try {
    const res = await fetcher(
      `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=2024-10-01`,
      { headers: authHeaders }
    );
    if (!res.ok) {
      return {
        kind: "error",
        message: `ARM accounts.list failed with HTTP ${res.status.toString()}. Check subscription access.`
      };
    }
    accountsData = await res.json();
  } catch (err) {
    return {
      kind: "error",
      message: `Network error listing Cognitive Services accounts: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  for (const account of accountsData.value ?? []) {
    if (account.kind !== "AIServices") continue;
    if (!account.id || !account.name) continue;
    const rgMatch = /\/resourceGroups\/([^/]+)\//i.exec(account.id);
    if (!rgMatch) continue;
    const resourceGroup = rgMatch[1];
    try {
      const res = await fetcher(
        `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${account.name}/projects?api-version=2025-04-01-preview`,
        { headers: authHeaders }
      );
      if (!res.ok) {
        opts.onWarn?.(
          `auto-discover: listing projects under AIServices account '${account.name}' failed with HTTP ${res.status.toString()}; skipping.`
        );
        continue;
      }
      const projectsData = await res.json();
      for (const project of projectsData.value ?? []) {
        const endpoint = project.properties?.endpoints?.["AI Foundry API"];
        if (endpoint && project.name) {
          candidates.push({
            endpoint,
            resourceName: account.name,
            projectName: project.name
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.onWarn?.(
        `auto-discover: listing projects under AIServices account '${account.name}' threw (${message}); skipping.`
      );
    }
  }
  if (candidates.length === 0) return { kind: "no-accounts" };
  if (candidates.length === 1) return { kind: "found", endpoint: candidates[0].endpoint };
  return { kind: "ambiguous", candidates };
}

// src/project-endpoint.ts
async function resolveProjectEndpoint(opts = {}) {
  if (process.env.PROJECT_ENDPOINT) {
    return process.env.PROJECT_ENDPOINT;
  }
  const foundryDir = opts.foundryYamlDir ?? path.join(os.homedir(), ".m8t", "foundry");
  try {
    const entries = await fs.readdir(foundryDir);
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
      const parsed = parseYaml(content);
      if (parsed?.projectEndpoint) {
        return parsed.projectEndpoint;
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  if (opts.autoDiscoverFn !== false) {
    const discover = opts.autoDiscoverFn ?? (() => autoDiscoverProjectEndpoint({
      // `resolveProjectEndpoint` runs before the MCP logger is wired up,
      // so route partial-failure warnings (e.g. one good account + one
      // 403'd account) through stderr — the MCP host captures it.
      onWarn: (msg) => {
        console.warn(`[m8t] ${msg}`);
      }
    }));
    const result = await discover();
    if (result.kind === "found") {
      await persistAutoEndpoint(foundryDir, result.endpoint);
      return result.endpoint;
    }
    if (result.kind === "ambiguous") {
      const list = result.candidates.map(
        (c, i) => `  ${(i + 1).toString()}. ${c.endpoint}  (resource: ${c.resourceName}, project: ${c.projectName})`
      ).join("\n");
      throw new Error(
        `Multiple Foundry projects accessible to this account. Pick one by either:
  \u2022 setting PROJECT_ENDPOINT to the chosen URL, or
  \u2022 writing it to ~/.m8t/foundry/seed.yaml as \`projectEndpoint: <url>\`.

Candidates:
${list}`
      );
    }
    if (result.kind === "no-accounts") {
      throw new Error(
        "No Foundry projects found in your accessible Azure subscriptions. Deploy one via the m8t-architect skill (e.g. `spin up the CMO`), or set PROJECT_ENDPOINT to point at an existing project."
      );
    }
    if (result.kind === "no-login") {
      throw new Error("Could not authenticate to Azure. Run `az login` first, then retry.");
    }
    throw new Error(`Auto-discovery failed: ${result.message}`);
  }
  throw new Error(
    "Could not resolve PROJECT_ENDPOINT. Set the PROJECT_ENDPOINT env var, or run the m8t-architect skill to deploy a worker (which writes ~/.m8t/foundry/<name>.yaml with the endpoint)."
  );
}
async function persistAutoEndpoint(foundryDir, endpoint) {
  try {
    await fs.mkdir(foundryDir, { recursive: true });
    const content = [
      "# Auto-discovered by the m8t plugin on first run.",
      "# Safe to delete; the plugin will re-discover on the next session.",
      `# If you have multiple Foundry projects and want a different one, edit this file or`,
      "# set PROJECT_ENDPOINT \u2014 the env var wins over any yaml.",
      `projectEndpoint: ${endpoint}`,
      ""
    ].join("\n");
    await fs.writeFile(path.join(foundryDir, "_auto.yaml"), content, "utf-8");
  } catch {
  }
}

// src/repo-root.ts
import fs2 from "fs/promises";
import os2 from "os";
import path2 from "path";
async function readRepoRoot(pointerPath) {
  const fp = pointerPath ?? path2.join(os2.homedir(), ".m8t", "repo-root");
  try {
    const content = await fs2.readFile(fp, "utf-8");
    return content.trim();
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        "m8t isn't installed (missing ~/.m8t/repo-root). Run the m8t installer \u2014 paste the install line from https://github.com/m8t-labs/m8t into your coding agent. That's what writes ~/.m8t/repo-root."
      );
    }
    throw err;
  }
}

// src/foundry-client.ts
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential as DefaultAzureCredential2 } from "@azure/identity";

// src/foundry-errors.ts
import { APIError as APIError2, NotFoundError as NotFoundError2, RateLimitError as RateLimitError2 } from "openai";

// ../../../packages/foundry-invoke/src/kind.ts
function kindFromAgentRecord(raw) {
  return raw.versions?.latest?.definition?.kind === "hosted" ? "hosted" : "prompt";
}
function hostedBlockFromAgentRecord(raw) {
  const version = raw.versions?.latest;
  const def = version?.definition;
  if (def?.kind !== "hosted") return void 0;
  const protocols = (def.container_protocol_versions ?? def.protocol_versions ?? []).map((p) => p.protocol).filter((p) => typeof p === "string");
  const block = { protocols };
  if (def.image) block.containerImage = def.image;
  if (def.cpu && def.memory) block.sandbox = { cpu: def.cpu, memory: def.memory };
  if (version?.status) block.versionStatus = version.status;
  return block;
}

// ../../../packages/foundry-invoke/src/invoke.ts
function resolveResponsesTarget(project, worker) {
  if (worker.kind === "hosted") {
    return {
      client: project.getOpenAIClient({ azureConfig: { agentName: worker.name, allowPreview: true } })
    };
  }
  const agent_reference = {
    name: worker.name,
    type: "agent_reference"
  };
  if (worker.version) agent_reference.version = worker.version;
  return { client: project.getOpenAIClient(), extraBody: { agent_reference } };
}
async function collectHostedResponse(client, input, opts) {
  const body = { input, stream: true };
  if (opts?.agentSessionId) body.agent_session_id = opts.agentSessionId;
  const responses = client.responses;
  const stream = await (opts?.signal ? responses.create(body, { signal: opts.signal }) : responses.create(body));
  let text = "";
  let responseId = "";
  let model;
  let agentSessionId;
  for await (const ev of stream) {
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
      text += ev.delta;
    }
    if (ev.response) {
      if (ev.response.id) responseId = ev.response.id;
      if (ev.response.model) model = ev.response.model;
      if (ev.response.agent_session_id) agentSessionId = ev.response.agent_session_id;
    }
  }
  return { text, responseId, model, agentSessionId };
}

// ../../../packages/foundry-invoke/src/invoke-cli-core.ts
import { APIError, NotFoundError, RateLimitError, AuthenticationError } from "openai";

// ../../../packages/foundry-invoke/src/openai-error.ts
function openAIErrorStatus(err) {
  if (typeof err !== "object" || err === null) return void 0;
  const status = err.status;
  return typeof status === "number" ? status : void 0;
}

// ../../../packages/foundry-invoke/src/artifacts.ts
var FENCE_RE = /```json m8t:artifacts\s*\n([\s\S]*?)\n```/;
function parseArtifacts(raw) {
  const text = raw;
  const m = FENCE_RE.exec(text);
  if (!m) return { text: text.trimEnd(), artifacts: [] };
  let artifacts = [];
  try {
    const parsed = JSON.parse(m[1]);
    if (Array.isArray(parsed)) artifacts = parsed;
  } catch {
    artifacts = [];
  }
  const clean = text.slice(0, m.index).trimEnd();
  return { text: clean, artifacts };
}
var ArtifactDownloadError = class extends Error {
  constructor(relPath, cause) {
    super(`Failed to download artifact "${relPath}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.relPath = relPath;
    this.name = "ArtifactDownloadError";
  }
  relPath;
};
var FILES_PREFIX = "files/";
async function downloadArtifact(project, agentName, sessionId, relPath) {
  const apiPath = FILES_PREFIX + relPath;
  try {
    const res = await project.beta.agents.downloadSessionFile(agentName, sessionId, apiPath);
    const stream = res.readableStreamBody;
    if (!stream) throw new Error("no readableStreamBody (browser blobBody is server-unsupported)");
    const chunks = [];
    for await (const c of stream) {
      if (Buffer.isBuffer(c)) chunks.push(c);
      else if (typeof c === "string") chunks.push(Buffer.from(c));
      else chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  } catch (e) {
    if (e instanceof ArtifactDownloadError) throw e;
    throw new ArtifactDownloadError(relPath, e);
  }
}

// src/foundry-errors.ts
var FoundryError = class extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "FoundryError";
  }
  status;
  body;
};
var WorkerNotFoundError = class extends FoundryError {
  constructor(workerName, body) {
    super(
      `Worker '${workerName}' no longer exists in Foundry. Run the refresh_workers tool (or /m8t:workers refresh) to update the list.`,
      404,
      body
    );
    this.name = "WorkerNotFoundError";
  }
};
var RateLimitedError = class extends FoundryError {
  constructor(body) {
    super("Rate limited by Foundry. Wait a moment and try again.", 429, body);
    this.name = "RateLimitedError";
  }
};
function mapFoundryError(err, ctx = {}) {
  const status = openAIErrorStatus(err);
  const body = err?.error;
  if (err instanceof NotFoundError2 || status === 404) {
    return new WorkerNotFoundError(ctx.workerName ?? "<unknown>", body);
  }
  if (err instanceof RateLimitError2 || status === 429) {
    return new RateLimitedError(body);
  }
  if (err instanceof APIError2 || status !== void 0) {
    return new FoundryError(
      `Foundry SDK error ${status?.toString() ?? "unknown"}: ${err instanceof Error ? err.message : String(err)}`,
      status,
      body
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new FoundryError(`Foundry call failed: ${message}`);
}

// src/foundry-client.ts
function parseConversationPage(value) {
  if (!isRecord(value) || !Array.isArray(value.data) || value.has_more !== void 0 && typeof value.has_more !== "boolean" || value.last_id !== void 0 && typeof value.last_id !== "string") {
    throw new Error("Foundry conversations.list returned an invalid response");
  }
  const data = value.data.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id || candidate.metadata !== void 0 && (!isRecord(candidate.metadata) || Object.values(candidate.metadata).some((item) => typeof item !== "string"))) {
      throw new Error("Foundry conversations.list returned an invalid conversation");
    }
    const metadata = candidate.metadata === void 0 ? {} : candidate.metadata;
    const createdAt = typeof candidate.created_at === "number" && Number.isFinite(candidate.created_at) ? new Date(candidate.created_at * 1e3).toISOString() : void 0;
    return { id: candidate.id, metadata, ...createdAt ? { createdAt } : {} };
  });
  if (value.has_more === true && !value.last_id) throw new Error("Foundry conversations.list returned has_more without last_id");
  return { data, hasMore: value.has_more === true, ...typeof value.last_id === "string" ? { lastId: value.last_id } : {} };
}
function createFoundryClient(opts) {
  const credential = opts.credentialFactory ? opts.credentialFactory() : new DefaultAzureCredential2();
  const project = new AIProjectClient(opts.projectEndpoint, credential);
  const openai = project.getOpenAIClient();
  return {
    downloadArtifact: (agentName, sessionId, relPath) => downloadArtifact(project, agentName, sessionId, relPath),
    listAgents: async () => {
      try {
        const agents = [];
        const iter = project.agents.list();
        for await (const raw of iter) {
          if (!raw.name && !raw.id) continue;
          const name = String(raw.name ?? raw.id);
          const id = raw.id || name;
          const model = raw.versions?.latest?.definition?.model ?? "";
          const description = raw.versions?.latest?.description;
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
            hosted: hostedBlockFromAgentRecord(raw)
          });
        }
        return agents;
      } catch (e) {
        throw mapFoundryError(e);
      }
    },
    createConversation: async (metadata) => {
      try {
        const conv = await openai.conversations.create({ metadata });
        return { id: conv.id };
      } catch (e) {
        throw mapFoundryError(e);
      }
    },
    listConversations: async () => {
      const out = [];
      const accessToken = await credential.getToken("https://ai.azure.com/.default");
      if (!accessToken.token) throw new Error("Unable to authenticate Foundry conversation discovery");
      let after;
      for (; ; ) {
        const params = new URLSearchParams({ limit: "100" });
        if (after) params.set("after", after);
        const response = await fetch(`${opts.projectEndpoint.replace(/\/+$/, "")}/openai/v1/conversations?${params}`, {
          headers: { Authorization: `Bearer ${accessToken.token}` }
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
        const conversation = await openai.conversations.retrieve(id);
        return { id: conversation.id, metadata: conversation.metadata ?? {} };
      } catch (e) {
        if (isNotFound(e)) return { kind: "not_found" };
        throw e;
      }
    },
    getConversationMessages: async (id) => {
      const turns = [];
      let after;
      for (; ; ) {
        const page = await openai.conversations.items.list(id, after ? { after, order: "asc" } : { order: "asc" });
        for (const raw of page.data ?? []) {
          const item = raw;
          const role = item.role === "user" || item.type === "input_text" ? "user" : item.role === "assistant" || item.type === "output_text" ? "assistant" : void 0;
          if (!role) continue;
          const texts = item.type === "input_text" || item.type === "output_text" ? [item.text] : (item.content ?? []).map((part) => {
            const p = part;
            return p.type === "input_text" || p.type === "output_text" || typeof p.text === "string" ? p.text : void 0;
          });
          for (const text of texts) if (typeof text === "string") turns.push({ role, content: text });
        }
        if (!page.has_more || !page.last_id) break;
        after = page.last_id;
      }
      return turns;
    },
    appendConversationItems: async (id, turns) => {
      await openai.conversations.items.create(id, {
        items: turns.map((turn) => ({ type: "message", role: turn.role, content: [{ type: turn.role === "user" ? "input_text" : "output_text", text: turn.content }] }))
      });
    },
    createResponse: async ({ agentName, conversationId, message, kind, history }) => {
      try {
        const { client, extraBody } = resolveResponsesTarget(project, { kind, name: agentName });
        if (kind === "hosted") {
          const collected = await collectHostedResponse(
            client,
            history ?? [{ role: "user", content: message }]
          );
          const { text, artifacts } = parseArtifacts(collected.text);
          return {
            id: collected.responseId,
            output: text,
            model: collected.model ?? "",
            artifacts,
            agentSessionId: collected.agentSessionId
          };
        }
        const resp = await client.responses.create(
          { conversation: conversationId, input: [{ role: "user", content: message }] },
          extraBody ? { body: extraBody } : void 0
        );
        return { id: resp.id, output: resp.output_text ?? "", model: resp.model };
      } catch (e) {
        throw mapFoundryError(e, { workerName: agentName });
      }
    }
  };
}
var isRecord = (value) => typeof value === "object" && value !== null;
function isNotFound(error) {
  if (!isRecord(error)) return false;
  const candidate = error;
  return candidate.status === 404 || candidate.statusCode === 404 || candidate.code === "404";
}
function validateMcpConversation(conversation, expected) {
  const metadata = conversation.metadata;
  return metadata.app === "m8t" && metadata.platform === "mcp" && metadata.ownerKey === expected.ownerKey && metadata.persona === expected.personaKey && metadata.agent === expected.activeAgentName ? { kind: "valid" } : { kind: "mismatch" };
}
function isM8tStackAgent(agent) {
  return agent.metadata.source === "m8t";
}

// src/conversation-store.ts
import { createHash, randomUUID as cryptoRandomUUID } from "crypto";
import { promises as fs3 } from "fs";
import { open as openFile } from "fs/promises";
import os3 from "os";
import path3 from "path";
var ConversationRegistryCorruptError = class extends Error {
  constructor(message = "conversation registry is corrupt") {
    super(message);
    this.name = "ConversationRegistryCorruptError";
  }
};
var ConversationRegistryVersionError = class extends Error {
  constructor(message = "unsupported conversation registry schema version") {
    super(message);
    this.name = "ConversationRegistryVersionError";
  }
};
var ConversationAgentMismatchError = class extends Error {
  constructor(message = "conversation active agent does not match") {
    super(message);
    this.name = "ConversationAgentMismatchError";
  }
};
var ConversationRegistryLockError = class extends Error {
  constructor(message = "unable to acquire conversation registry lock") {
    super(message);
    this.name = "ConversationRegistryLockError";
  }
};
var isRecord2 = (value) => typeof value === "object" && value !== null;
var errorCode = (error) => isRecord2(error) && typeof error.code === "string" ? error.code : void 0;
var parseJson = (text) => JSON.parse(text);
var LOCK_MS = 3e4;
var normalize = (s) => s.trim().toLowerCase();
var normalizedKey = (k) => ({ installationKey: normalizeEndpoint(k.installationKey), platform: "mcp", nativeUserKey: normalize(k.nativeUserKey), personaKey: normalize(k.personaKey) });
var normalizeEndpoint = (s) => {
  const v = s.trim();
  try {
    const u = new URL(v);
    u.hostname = u.hostname.toLowerCase();
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return normalize(v).replace(/\/+$/, "");
  }
};
var keyString = (k) => JSON.stringify([k.installationKey, k.platform, k.nativeUserKey, k.personaKey]);
var installationHash = (k) => createHash("sha256").update(k.installationKey).digest("hex");
var privacyHash = (s) => createHash("sha256").update(s).digest("hex");
var ownerHash = (key2) => privacyHash(`${key2.installationKey}\0${key2.nativeUserKey}`);
var timestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : 0;
function createConversationStore(options = {}) {
  const filePath = options.filePath ?? process.env.M8T_CONVERSATION_REGISTRY_PATH ?? path3.join(os3.homedir(), ".m8t", "conversation-registry.json");
  const lockPath = `${filePath}.lock`;
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const uuid = options.randomUUID ?? cryptoRandomUUID;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const observe = (event) => {
    try {
      options.observe?.(event);
    } catch {
    }
  };
  async function load() {
    let text;
    try {
      text = await fs3.readFile(filePath, "utf8");
    } catch (e) {
      if (errorCode(e) === "ENOENT") return { schemaVersion: 2, records: [] };
      throw e;
    }
    let value;
    try {
      value = parseJson(text);
    } catch {
      throw new ConversationRegistryCorruptError();
    }
    if (!isRecord2(value)) throw new ConversationRegistryCorruptError();
    if (typeof value.schemaVersion !== "number" || !Array.isArray(value.records)) throw new ConversationRegistryCorruptError();
    if (value.schemaVersion !== 1 && value.schemaVersion !== 2) throw new ConversationRegistryVersionError();
    if (Object.keys(value).some((k) => k !== "schemaVersion" && k !== "records")) throw new ConversationRegistryCorruptError();
    const seen = /* @__PURE__ */ new Set();
    for (const r of value.records) {
      if (!isRecord2(r) || !["ready", "broken", "provisioning"].includes(String(r.state)) || !isRecord2(r.key)) throw new ConversationRegistryCorruptError();
      if (value.schemaVersion === 1 && r.state === "provisioning") throw new ConversationRegistryCorruptError();
      if (r.state === "provisioning") {
        if (Object.keys(r).some((k3) => !["state", "key", "activeAgentName", "provisioningToken", "createdAt", "updatedAt"].includes(k3)) || typeof r.provisioningToken !== "string" || !r.provisioningToken || typeof r.activeAgentName !== "string" || !normalize(r.activeAgentName) || r.activeAgentName !== normalize(r.activeAgentName) || typeof r.createdAt !== "string" || typeof r.updatedAt !== "string" || Number.isNaN(Date.parse(r.createdAt)) || Number.isNaN(Date.parse(r.updatedAt)) || Object.keys(r.key).some((k3) => !["installationKey", "platform", "nativeUserKey", "personaKey"].includes(k3)) || r.key.platform !== "mcp" || typeof r.key.installationKey !== "string" || typeof r.key.nativeUserKey !== "string" || typeof r.key.personaKey !== "string" || !normalizeEndpoint(r.key.installationKey) || !normalize(r.key.nativeUserKey) || !normalize(r.key.personaKey) || r.key.installationKey !== normalizeEndpoint(r.key.installationKey) || r.key.nativeUserKey !== normalize(r.key.nativeUserKey) || r.key.personaKey !== normalize(r.key.personaKey)) throw new ConversationRegistryCorruptError();
        const k2 = keyString(normalizedKey(r.key));
        if (seen.has(k2)) throw new ConversationRegistryCorruptError();
        seen.add(k2);
      }
      if (r.state === "provisioning") continue;
      const allowedRecord = r.state === "ready" ? ["state", "key", "activeAgentName", "activeConversationId", "createdAt", "updatedAt"] : ["state", "key", "activeAgentName", "activeConversationId", "reason", "createdAt", "updatedAt"];
      if (Object.keys(r).some((k2) => !allowedRecord.includes(k2)) || Object.keys(r.key).some((k2) => !["installationKey", "platform", "nativeUserKey", "personaKey"].includes(k2)) || r.key.platform !== "mcp" || typeof r.key.installationKey !== "string" || typeof r.key.nativeUserKey !== "string" || typeof r.key.personaKey !== "string" || !normalizeEndpoint(r.key.installationKey) || !normalize(r.key.nativeUserKey) || !normalize(r.key.personaKey) || r.key.installationKey !== normalizeEndpoint(r.key.installationKey) || r.key.nativeUserKey !== normalize(r.key.nativeUserKey) || r.key.personaKey !== normalize(r.key.personaKey) || typeof r.activeAgentName !== "string" || !normalize(r.activeAgentName) || r.activeAgentName !== normalize(r.activeAgentName) || typeof r.activeConversationId !== "string" || !normalize(r.activeConversationId) || typeof r.createdAt !== "string" || typeof r.updatedAt !== "string" || Number.isNaN(Date.parse(r.createdAt)) || Number.isNaN(Date.parse(r.updatedAt)) || r.state === "broken" && r.reason !== "conversation_not_found" && r.reason !== "conversation_mismatch") throw new ConversationRegistryCorruptError();
      const k = keyString(normalizedKey(r.key));
      if (seen.has(k)) throw new ConversationRegistryCorruptError();
      seen.add(k);
    }
    return { schemaVersion: 2, records: value.records };
  }
  async function publish(reg) {
    const parent = path3.dirname(filePath);
    let createdParent = false;
    try {
      await fs3.mkdir(parent, { recursive: false, mode: 448 });
      createdParent = true;
    } catch (e) {
      if (errorCode(e) !== "EEXIST") throw e;
    }
    if (!createdParent) {
      try {
        await fs3.access(parent);
      } catch {
        await fs3.mkdir(parent, { recursive: true, mode: 448 });
      }
    }
    const tmp = `${filePath}.${uuid()}.tmp`;
    const fh = await openFile(tmp, "wx", 384);
    try {
      await fh.writeFile(JSON.stringify(reg) + "\n", "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs3.rename(tmp, filePath);
    await fs3.chmod(filePath, 384).catch(() => void 0);
    const dh = await openFile(parent, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }
  async function acquire(targetLockPath = lockPath) {
    const lockParent = path3.dirname(targetLockPath);
    try {
      await fs3.mkdir(lockParent, { recursive: false, mode: 448 });
    } catch (e) {
      if (errorCode(e) === "ENOENT") await fs3.mkdir(lockParent, { recursive: true, mode: 448 });
      else if (errorCode(e) !== "EEXIST") throw e;
    }
    const token = uuid();
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const fh = await openFile(targetLockPath, "wx", 384);
        const data = { token, pid: process.pid, expiresAt: new Date(now().getTime() + LOCK_MS).toISOString() };
        await fh.writeFile(JSON.stringify(data));
        await fh.sync();
        await fh.close();
        let stopped = false;
        const renewLease = async () => {
          if (stopped) return;
          let lockHandle;
          try {
            lockHandle = await openFile(targetLockPath, "r+");
            const current2 = parseJson(await lockHandle.readFile("utf8"));
            if (!isRecord2(current2) || current2.token !== token) return;
            const renewed = JSON.stringify({ token, pid: process.pid, expiresAt: new Date(now().getTime() + LOCK_MS).toISOString() });
            await lockHandle.write(renewed, 0, "utf8");
            await lockHandle.truncate(Buffer.byteLength(renewed));
            await lockHandle.sync();
          } catch {
          } finally {
            await lockHandle?.close().catch(() => void 0);
          }
        };
        const renew = setInterval(() => {
          void renewLease();
        }, Math.floor(LOCK_MS / 3));
        renew.unref();
        return { token, release: async () => {
          stopped = true;
          clearInterval(renew);
          try {
            const cur = parseJson(await fs3.readFile(targetLockPath, "utf8"));
            if (isRecord2(cur) && cur.token === token) await fs3.unlink(targetLockPath);
          } catch (e) {
            if (errorCode(e) !== "ENOENT") throw e;
          }
        } };
      } catch (e) {
        if (errorCode(e) !== "EEXIST") throw e;
      }
      let current;
      try {
        const parsed = parseJson(await fs3.readFile(targetLockPath, "utf8"));
        if (!isRecord2(parsed) || typeof parsed.pid !== "number" || typeof parsed.token !== "string" || typeof parsed.expiresAt !== "string") throw new ConversationRegistryLockError("conversation registry lock is invalid; remove it only after inspection");
        current = { pid: parsed.pid, token: parsed.token, expiresAt: parsed.expiresAt };
      } catch (e) {
        if (errorCode(e) === "ENOENT" || e instanceof SyntaxError) {
          await sleep(Math.min(10 + attempt * 2, 100));
          continue;
        }
        throw new ConversationRegistryLockError("conversation registry lock is unreadable; remove it only after inspection");
      }
      const expired = Date.parse(current.expiresAt) <= now().getTime();
      let alive = true;
      try {
        process.kill(current.pid, 0);
      } catch (e) {
        alive = errorCode(e) !== "ESRCH";
      }
      if (expired && !alive) {
        const guard = `${targetLockPath}.reclaim`;
        let owned = false;
        try {
          await fs3.mkdir(guard, { mode: 448 });
          owned = true;
        } catch (e) {
          if (errorCode(e) !== "EEXIST") throw e;
        }
        if (owned) {
          try {
            const parsed = parseJson(await fs3.readFile(targetLockPath, "utf8"));
            if (isRecord2(parsed) && typeof parsed.pid === "number" && typeof parsed.token === "string" && typeof parsed.expiresAt === "string") {
              const reread = parsed;
              let dead = false;
              try {
                process.kill(reread.pid, 0);
              } catch (e) {
                dead = errorCode(e) === "ESRCH";
              }
              if (reread.token === current.token && reread.pid === current.pid && Date.parse(reread.expiresAt) <= now().getTime() && dead) await fs3.unlink(targetLockPath).catch(() => void 0);
            }
          } finally {
            await fs3.rmdir(guard).catch(() => void 0);
          }
        }
      } else if (expired && alive) {
      }
      await sleep(Math.min(50 + Math.floor(Math.random() * 25) + attempt * 5, 250));
    }
    throw new ConversationRegistryLockError();
  }
  async function resolve(keyInput, activeAgentNameInput, deps) {
    const key2 = normalizedKey(keyInput);
    const activeAgentName = normalize(activeAgentNameInput);
    if (!key2.installationKey || !key2.nativeUserKey || !key2.personaKey || !activeAgentName) throw new ConversationRegistryCorruptError();
    const hash2 = installationHash(key2);
    let lease;
    try {
      lease = await acquire();
    } catch (e) {
      observe({ kind: "lock_failed", installationHash: hash2, errorCode: e instanceof Error ? e.name : "lock_failed" });
      throw e;
    }
    try {
      let reg = await load();
      const found = reg.records.find((r) => keyString(r.key) === keyString(key2));
      if (found?.state === "provisioning") {
        if (normalize(found.activeAgentName) !== activeAgentName) throw new ConversationAgentMismatchError();
        if (!deps.discoverConversations) throw new ConversationRegistryLockError("conversation provisioning requires discovery support");
        let discovered;
        try {
          discovered = await deps.discoverConversations(found.provisioningToken);
        } catch {
          throw new ConversationRegistryLockError("conversation discovery failed; refusing to create");
        }
        const ownerKey = ownerHash(key2);
        const exact = discovered.filter((c) => c.metadata.app === "m8t" && c.metadata.platform === "mcp" && c.metadata.ownerKey === ownerKey && c.metadata.persona === key2.personaKey && c.metadata.agent === activeAgentName && c.metadata.provisioningToken === found.provisioningToken && typeof c.id === "string" && c.id.length > 0);
        if (exact.length) {
          exact.sort((a, b) => timestamp(b.metadata.createdAt) - timestamp(a.metadata.createdAt) || timestamp(b.createdAt) - timestamp(a.createdAt) || a.id.localeCompare(b.id));
          const winner = exact[0];
          const at2 = now().toISOString();
          reg.records = reg.records.map((r) => r === found ? { state: "ready", key: key2, activeAgentName, activeConversationId: winner.id, createdAt: found.createdAt, updatedAt: at2 } : r);
          await publish(reg);
          return { conversationId: winner.id, outcome: "found" };
        }
      }
      if (found && found.state !== "provisioning") {
        if (normalize(found.activeAgentName) !== activeAgentName) {
          observe({ kind: "validation_failed", installationHash: hash2, personaKey: privacyHash(key2.personaKey), activeAgentName: privacyHash(activeAgentName), errorCode: "conversation_mismatch" });
          throw new ConversationAgentMismatchError();
        }
        if (found.state === "broken") {
          observe({ kind: "validation_failed", installationHash: hash2, personaKey: privacyHash(key2.personaKey), activeAgentName: privacyHash(activeAgentName), errorCode: found.reason });
          throw new ConversationAgentMismatchError(`conversation is broken: ${found.reason}`);
        }
        const validation = await deps.validateConversation(found.activeConversationId);
        if (validation.kind === "valid") {
          observe({ kind: "found", installationHash: hash2, personaKey: privacyHash(key2.personaKey), activeAgentName: privacyHash(activeAgentName), conversationId: privacyHash(found.activeConversationId) });
          return { conversationId: found.activeConversationId, outcome: "found" };
        }
        const broken = { ...found, state: "broken", reason: validation.kind === "not_found" ? "conversation_not_found" : "conversation_mismatch", updatedAt: now().toISOString() };
        reg.records = reg.records.map((r) => r === found ? broken : r);
        await publish(reg);
        observe({ kind: "validation_failed", installationHash: hash2, personaKey: privacyHash(key2.personaKey), activeAgentName: privacyHash(activeAgentName), errorCode: broken.reason });
        throw new ConversationAgentMismatchError(`conversation validation failed: ${broken.reason}`);
      }
      const provisioningToken = found?.state === "provisioning" ? found.provisioningToken : uuid();
      if (!found) {
        const at2 = now().toISOString();
        reg.records.push({ state: "provisioning", key: key2, activeAgentName, provisioningToken, createdAt: at2, updatedAt: at2 });
        await publish(reg);
      }
      const created = await deps.createConversation(provisioningToken);
      const at = now().toISOString();
      reg = await load();
      const raced = reg.records.find((r) => keyString(r.key) === keyString(key2));
      if (raced && raced.state !== "provisioning") {
        if (normalize(raced.activeAgentName) !== activeAgentName) throw new ConversationAgentMismatchError();
        if (raced.state === "broken") throw new ConversationAgentMismatchError(`conversation is broken: ${raced.reason}`);
        return { conversationId: raced.activeConversationId, outcome: "found" };
      }
      reg.records = reg.records.filter((r) => r !== raced);
      reg.records.push({ state: "ready", key: key2, activeAgentName, activeConversationId: created.id, createdAt: at, updatedAt: at });
      await publish(reg);
      observe({ kind: "created", installationHash: hash2, personaKey: privacyHash(key2.personaKey), activeAgentName: privacyHash(activeAgentName), conversationId: privacyHash(created.id) });
      return { conversationId: created.id, outcome: "created" };
    } catch (e) {
      if (e instanceof ConversationRegistryCorruptError) observe({ kind: "registry_corrupt", installationHash: hash2, errorCode: e.name });
      else if (e instanceof ConversationRegistryVersionError) observe({ kind: "registry_version_unsupported", installationHash: hash2, errorCode: e.name });
      throw e;
    } finally {
      await lease.release();
    }
  }
  async function acquireTurn(keyInput) {
    const key2 = normalizedKey(keyInput);
    if (!key2.installationKey || !key2.nativeUserKey || !key2.personaKey) throw new ConversationRegistryCorruptError();
    const turnPath = `${filePath}.${privacyHash(keyString(key2))}.turn.lock`;
    const lease = await acquire(turnPath);
    return { release: lease.release };
  }
  return { resolve, acquireTurn };
}

// src/in-flight-tasks.ts
import { randomUUID } from "crypto";
function createInFlightRegistry() {
  const tasks = /* @__PURE__ */ new Map();
  return {
    register: (p) => {
      const id = randomUUID();
      tasks.set(id, { kind: "still_running", startedAt: Date.now() });
      p.then(
        (r) => tasks.set(id, { kind: "completed", ...r }),
        (e) => tasks.set(id, {
          kind: "failed",
          error: e instanceof Error ? e.message : String(e)
        })
      );
      return id;
    },
    peek: (taskId) => {
      const state = tasks.get(taskId);
      if (!state) return { kind: "not_found" };
      if (state.kind === "still_running") {
        return { kind: "still_running", elapsedMs: Date.now() - state.startedAt };
      }
      return state;
    }
  };
}

// src/config.ts
import fs4 from "fs/promises";
import os4 from "os";
import path4 from "path";
import { parse as parseYaml2 } from "yaml";
var DEFAULTS = {
  pollIntervalSeconds: 300,
  responseWaitBudgetSeconds: 90,
  logLevel: "info",
  projectEndpointOverride: null
};
var parseIntPositive = (val) => {
  if (val === void 0 || val === null || val === "") return null;
  const n = typeof val === "number" ? val : Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
};
async function loadConfig(opts = {}) {
  const fp = opts.configPath ?? path4.join(os4.homedir(), ".m8t", "m8t.yaml");
  let fileCfg = {};
  try {
    const raw = await fs4.readFile(fp, "utf-8");
    const parsed = parseYaml2(raw);
    if (parsed) fileCfg = parsed;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const cfg = { ...DEFAULTS };
  const filePoll = parseIntPositive(fileCfg.pollIntervalSeconds);
  if (filePoll !== null) cfg.pollIntervalSeconds = filePoll;
  const fileBudget = parseIntPositive(fileCfg.responseWaitBudgetSeconds);
  if (fileBudget !== null) cfg.responseWaitBudgetSeconds = fileBudget;
  if (fileCfg.logLevel) cfg.logLevel = fileCfg.logLevel;
  if (fileCfg.projectEndpointOverride) cfg.projectEndpointOverride = fileCfg.projectEndpointOverride;
  const envPoll = parseIntPositive(process.env.M8T_POLL_INTERVAL_SECONDS);
  if (envPoll !== null) cfg.pollIntervalSeconds = envPoll;
  const envBudget = parseIntPositive(process.env.M8T_RESPONSE_WAIT_BUDGET_SECONDS);
  if (envBudget !== null) cfg.responseWaitBudgetSeconds = envBudget;
  if (process.env.M8T_LOG_LEVEL) {
    cfg.logLevel = process.env.M8T_LOG_LEVEL;
  }
  if (process.env.PROJECT_ENDPOINT) {
    cfg.projectEndpointOverride = process.env.PROJECT_ENDPOINT;
  }
  return cfg;
}

// src/poller.ts
function createPoller(args) {
  let timer = null;
  let running = false;
  const tick = async () => {
    try {
      const latest = await args.fetcher();
      args.onUpdate(latest);
    } catch (err) {
      if (args.onError) args.onError(err);
    }
  };
  const runOnceOrThrow = async () => {
    const latest = await args.fetcher();
    args.onUpdate(latest);
  };
  return {
    start: () => {
      if (running) return;
      running = true;
      void tick();
      timer = setInterval(() => void tick(), args.intervalMs);
    },
    stop: () => {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce: tick,
    runOnceOrThrow
  };
}

// src/sync-commands.ts
import fs6 from "fs/promises";
import path6 from "path";

// src/command-renderer.ts
import fs5 from "fs/promises";
import path5 from "path";
function yamlQuote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
async function renderCommandFile(worker, targetPath) {
  const desc = worker.role ? `${worker.role} \u2014 ${worker.description}` : worker.description;
  const content = [
    "---",
    `description: ${yamlQuote(desc)}`,
    "m8t-generated: true",
    `m8t-worker: ${worker.name}`,
    `m8t-persona: ${worker.persona ?? "(none)"}`,
    "---",
    `Use the m8t MCP server's \`send_to_worker\` tool with \`name="${worker.name}"\` and \`message="$ARGUMENTS"\`. Return the worker's reply verbatim to the user.`,
    ""
  ].join("\n");
  await fs5.mkdir(path5.dirname(targetPath), { recursive: true });
  await fs5.writeFile(targetPath, content, "utf-8");
}
async function parseExistingMagicKey(filePath) {
  try {
    const content = await fs5.readFile(filePath, "utf-8");
    return /^m8t-generated:\s*true\s*$/m.test(content);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// src/worker-diff.ts
function diffWorkers(previous, current) {
  const prevMap = new Map(previous.map((w) => [w.name, w]));
  const currMap = new Map(current.map((w) => [w.name, w]));
  const added = [];
  const changed = [];
  for (const [name, w] of currMap) {
    const prior = prevMap.get(name);
    if (!prior) {
      added.push(name);
    } else if (prior.role !== w.role || prior.description !== w.description || prior.displayName !== w.displayName) {
      changed.push(name);
    }
  }
  const removed = [];
  for (const name of prevMap.keys()) {
    if (!currMap.has(name)) removed.push(name);
  }
  return { added, removed, changed };
}

// src/sync-commands.ts
async function syncCommandsToFs(args) {
  await fs6.mkdir(args.commandsDir, { recursive: true });
  const diff = diffWorkers(args.previous, args.current);
  const report = { added: [], removed: [], changed: [], collisions: [] };
  const workersByName = new Map(args.current.map((w) => [w.name, w]));
  for (const name of [...diff.added, ...diff.changed]) {
    const worker = workersByName.get(name);
    if (!worker) continue;
    const target = path6.join(args.commandsDir, `${name}.md`);
    const ours = await parseExistingMagicKey(target);
    if (!ours) {
      try {
        await fs6.access(target);
        report.collisions.push(name);
        continue;
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    await renderCommandFile(worker, target);
    if (diff.added.includes(name)) report.added.push(name);
    else report.changed.push(name);
  }
  for (const name of diff.removed) {
    const target = path6.join(args.commandsDir, `${name}.md`);
    const ours = await parseExistingMagicKey(target);
    if (ours) {
      await fs6.unlink(target);
      report.removed.push(name);
    }
  }
  return report;
}

// src/logger.ts
import fs7 from "fs/promises";
import path7 from "path";
var LEVELS = ["debug", "info", "warn", "error"];
function createLogger(args) {
  const levelIndex = LEVELS.indexOf(args.level);
  let queue = [];
  let flushing = Promise.resolve();
  const write = (lvl, msg, meta) => {
    if (LEVELS.indexOf(lvl) < levelIndex) return;
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const metaStr = meta ? " " + JSON.stringify(meta) : "";
    queue.push(`${ts} ${lvl.toUpperCase()} ${msg}${metaStr}`);
  };
  const flush = async () => {
    if (queue.length === 0) return;
    const batch = queue.join("\n") + "\n";
    queue = [];
    await fs7.mkdir(path7.dirname(args.filePath), { recursive: true });
    await fs7.appendFile(args.filePath, batch, "utf-8");
  };
  const enqueueFlush = () => {
    flushing = flushing.then(flush);
  };
  return {
    debug: (m, x) => {
      write("debug", m, x);
      enqueueFlush();
    },
    info: (m, x) => {
      write("info", m, x);
      enqueueFlush();
    },
    warn: (m, x) => {
      write("warn", m, x);
      enqueueFlush();
    },
    error: (m, x) => {
      write("error", m, x);
      enqueueFlush();
    },
    flush: async () => {
      enqueueFlush();
      await flushing;
    }
  };
}

// src/persona-file.ts
import fs8 from "fs/promises";
import path8 from "path";
import { parse as parseYaml3 } from "yaml";
async function readPersonaFrontmatter(args) {
  const filePath = path8.join(args.repoRoot, "personas", args.persona, "persona.md");
  let raw;
  try {
    raw = await fs8.readFile(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!match) return null;
  const fm = parseYaml3(match[1]);
  if (!fm?.name || !fm.description) return null;
  return {
    name: fm.name,
    role: fm.role ?? null,
    description: fm.description
  };
}

// src/persona-resolver.ts
function renderRoleHint(args) {
  if (!args.persona) return null;
  if (args.frontmatter?.role) {
    return args.frontmatter.role;
  }
  if (args.frontmatter && !args.frontmatter.role) {
    return titleCaseSlug(args.persona);
  }
  return `${args.persona} (persona file not found)`;
}
function titleCaseSlug(slug) {
  return slug.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}
function shortenDescription(desc) {
  if (!desc) return "";
  const firstSentenceMatch = /^([^.!?]+)([.!?]|$)/.exec(desc);
  let result = firstSentenceMatch ? firstSentenceMatch[1].trim() : desc.trim();
  if (result.length > 80) {
    result = result.slice(0, 80) + "...";
  }
  return result;
}

// ../../../packages/api-contract/src/delegated-identity.ts
var END_USER_KEY_MAX_LENGTH = 200;
var END_USER_KEY_PATTERN = new RegExp(
  `^[A-Za-z0-9._-]{1,${String(END_USER_KEY_MAX_LENGTH)}}$`
);

// ../../../packages/api-contract/src/brain-link.ts
function parseBrainLink(metadata) {
  const raw = metadata?.brain;
  if (!raw) return void 0;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.repo !== "string" || obj.repo.length === 0) return void 0;
    return {
      repo: obj.repo,
      branch: typeof obj.branch === "string" && obj.branch ? obj.branch : "main",
      topology: obj.topology === "shared" ? "shared" : "per-worker",
      schemaVersion: typeof obj.schemaVersion === "string" && obj.schemaVersion ? obj.schemaVersion : "1",
      credentialRef: typeof obj.credentialRef === "string" ? obj.credentialRef : "",
      ...typeof obj.installationId === "string" ? { installationId: obj.installationId } : {},
      ...typeof obj.instanceFolder === "string" ? { instanceFolder: obj.instanceFolder } : {}
    };
  } catch {
    return void 0;
  }
}
function isAppMode(link) {
  return typeof link.installationId === "string" && link.installationId.length > 0;
}
var IN_CONTAINER_CREDENTIAL_REF = "in-container";
function isInContainer(link) {
  return link.credentialRef === IN_CONTAINER_CREDENTIAL_REF;
}

// src/worker-builder.ts
async function buildWorkerRecord(agent, opts) {
  const persona = agent.metadata.persona ?? null;
  const frontmatter = persona ? await readPersonaFrontmatter({ repoRoot: opts.repoRoot, persona }) : null;
  const role = renderRoleHint({ persona, frontmatter });
  const description = frontmatter ? shortenDescription(frontmatter.description) : "";
  return {
    name: agent.name.toLowerCase(),
    displayName: agent.name,
    role,
    description,
    persona,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- same as `persona` above: the personaVersion key is often absent at runtime; `?? null` normalizes it.
    personaVersion: agent.metadata.personaVersion ?? null,
    agentId: agent.id,
    projectEndpoint: opts.projectEndpoint,
    model: agent.model,
    deployedAt: agent.createdAt ?? null,
    kind: agent.kind,
    hosted: agent.hosted,
    brain: parseBrainLink(agent.metadata)
  };
}

// src/tools/list-workers.ts
async function handleListWorkers(args) {
  const agents = await args.client.listAgents();
  const m8tAgents = agents.filter(isM8tStackAgent);
  return Promise.all(
    m8tAgents.map(
      (agent) => buildWorkerRecord(agent, {
        repoRoot: args.repoRoot,
        projectEndpoint: args.projectEndpoint
      })
    )
  );
}

// src/tools/send-to-worker.ts
import os6 from "os";
import { createHash as createHash2 } from "crypto";
import { DefaultAzureCredential as DefaultAzureCredential3 } from "@azure/identity";

// ../../../packages/github-app-auth/src/jwt.ts
import { createSign, createPrivateKey } from "crypto";
function signAppJwt(args) {
  const appIdNum = Number(args.appId);
  if (!Number.isInteger(appIdNum) || appIdNum <= 0) {
    throw new Error(`signAppJwt: appId must be a positive numeric string, got '${args.appId}'`);
  }
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 30, exp: now - 30 + 600, iss: appIdNum };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64url(header)}.${b64url(payload)}`;
  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  sign.end();
  const signature = sign.sign(createPrivateKey(args.privateKeyPem)).toString("base64url");
  return `${unsigned}.${signature}`;
}

// ../../../packages/github-app-auth/src/secrets.ts
import { SecretClient } from "@azure/keyvault-secrets";
var SECRET_NAMES = {
  appId: "github-app-id",
  slug: "github-app-slug",
  privateKeyPem: "github-app-private-key"
};
var cache = /* @__PURE__ */ new Map();
async function fetchAllSecrets(credential, kvUri) {
  const client = new SecretClient(kvUri, credential);
  const [appId, slug, pem] = await Promise.all([
    client.getSecret(SECRET_NAMES.appId),
    client.getSecret(SECRET_NAMES.slug),
    client.getSecret(SECRET_NAMES.privateKeyPem)
  ]);
  const v = (sec, name) => {
    if (typeof sec.value !== "string" || sec.value.length === 0) {
      throw new Error(`readAppSecrets: secret '${name}' is missing or empty in ${kvUri}`);
    }
    return sec.value;
  };
  return {
    appId: v(appId, SECRET_NAMES.appId),
    slug: v(slug, SECRET_NAMES.slug),
    privateKeyPem: v(pem, SECRET_NAMES.privateKeyPem)
  };
}
function readAppSecrets(args) {
  const existing = cache.get(args.kvUri);
  if (existing) return existing;
  const promise = fetchAllSecrets(args.credential, args.kvUri).catch((e) => {
    cache.delete(args.kvUri);
    throw e;
  });
  cache.set(args.kvUri, promise);
  return promise;
}

// ../../../packages/github-app-auth/src/cache.ts
var EXPIRY_SAFETY_MS = 10 * 60 * 1e3;
var cache2 = /* @__PURE__ */ new Map();
function key(installationId, repository) {
  return `${installationId}:${repository}`;
}
function getCachedToken(installationId, repository) {
  const e = cache2.get(key(installationId, repository));
  if (!e) return null;
  if (e.expiresAt.getTime() - Date.now() <= EXPIRY_SAFETY_MS) return null;
  return e;
}
function putCachedToken(installationId, repository, token, expiresAt) {
  cache2.set(key(installationId, repository), { token, expiresAt });
}

// ../../../packages/github-app-auth/src/mint.ts
async function mintInstallationToken(args) {
  const cached = getCachedToken(args.installationId, args.repository);
  if (cached) {
    return {
      token: cached.token,
      expiresAt: cached.expiresAt,
      permissions: {},
      // not tracked in cache; callers usually don't need it on hit
      repositorySelection: "selected"
    };
  }
  const { appId, privateKeyPem } = await readAppSecrets({
    credential: args.credential,
    kvUri: args.kvUri
  });
  const appJwt = signAppJwt({ appId, privateKeyPem });
  const url = `https://api.github.com/app/installations/${args.installationId}/access_tokens`;
  const repoName = args.repository.includes("/") ? args.repository.split("/", 2)[1] : args.repository;
  const body = JSON.stringify({
    repositories: [repoName],
    ...args.permissions ? { permissions: args.permissions } : {}
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `mintInstallationToken: HTTP ${String(res.status)} from ${url}
${text.slice(0, 500)}`
    );
  }
  const parsed = JSON.parse(text);
  const expiresAt = new Date(parsed.expires_at);
  putCachedToken(args.installationId, args.repository, parsed.token, expiresAt);
  return {
    token: parsed.token,
    expiresAt,
    permissions: parsed.permissions,
    repositorySelection: parsed.repository_selection
  };
}

// ../../../packages/github-app-auth/src/rotate.ts
var ARM_SCOPE = "https://management.azure.com/.default";
var FOUNDRY_API = "2025-04-01-preview";
var connectionPatchState = /* @__PURE__ */ new Map();
function connectionStateKey(projectArmId, connectionName) {
  return `${projectArmId}/connections/${connectionName}`;
}
async function rotateConnectionAuth(args) {
  const minted = await mintInstallationToken({
    credential: args.credential,
    kvUri: args.kvUri,
    installationId: args.installationId,
    repository: args.repository
  });
  const stateKey = connectionStateKey(args.projectArmId, args.connectionName);
  if (connectionPatchState.get(stateKey) !== minted.token) {
    const armTokenResp = await args.credential.getToken(ARM_SCOPE);
    if (!armTokenResp?.token) {
      throw new Error("rotateConnectionAuth: failed to acquire ARM management token");
    }
    const url = `https://management.azure.com${args.projectArmId}/connections/${args.connectionName}?api-version=${FOUNDRY_API}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${armTokenResp.token}`,
        "Content-Type": "application/json"
      },
      // Foundry's connection resource is polymorphic on authType; the PATCH
      // deserializes as a full shape (NOT a shallow merge), so omitting the
      // discriminator returns 400 "Missing discriminator property [AuthType]".
      // Mirror the same auth shape the initial PUT in brain-link.ts uses.
      body: JSON.stringify({
        properties: {
          authType: "CustomKeys",
          category: "CustomKeys",
          credentials: { keys: { Authorization: `Bearer ${minted.token}` } }
        }
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `rotateConnectionAuth: HTTP ${String(res.status)} on PATCH ${url}
${text.slice(0, 500)}`
      );
    }
    connectionPatchState.set(stateKey, minted.token);
  }
  return { rotatedAt: /* @__PURE__ */ new Date(), expiresAt: minted.expiresAt };
}

// src/tools/resolve-worker.ts
function resolveWorker(workers, name) {
  const target = name.trim().toLowerCase();
  if (!target) return { kind: "not-found", closest: [] };
  const exact = workers.find((w) => w.name === target);
  if (exact) return { kind: "found", worker: exact };
  const closest = workers.filter((w) => w.name.includes(target) || target.includes(w.name)).map((w) => w.name);
  return { kind: "not-found", closest };
}

// src/artifact-store.ts
import { mkdirSync, writeFileSync } from "fs";
import os5 from "os";
import path9 from "path";
function artifactRoot() {
  return process.env.M8T_ARTIFACT_ROOT ?? path9.join(os5.homedir(), ".m8t", "artifacts");
}
function saveArtifact(sessionId, name, bytes) {
  const safeName = path9.basename(name) || "artifact";
  const dir = path9.join(artifactRoot(), path9.basename(sessionId) || "session");
  mkdirSync(dir, { recursive: true });
  const dest = path9.join(dir, safeName);
  writeFileSync(dest, bytes);
  return dest;
}

// src/tools/send-to-worker.ts
var BUDGET_EXPIRED = /* @__PURE__ */ Symbol("budget_expired");
var normalizeProjectEndpoint = (endpoint) => {
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
var canonicalPersonaKey = (persona) => persona.trim().toLowerCase();
var hash = (value) => createHash2("sha256").update(value).digest("hex");
var ownerKeyFor = (key2) => hash(`${key2.installationKey}\0${key2.nativeUserKey}`);
var isNotFoundConversation = (value) => typeof value === "object" && value !== null && "kind" in value && value.kind === "not_found";
function buildMcpConversationMetadata(args) {
  return {
    app: "m8t",
    platform: "mcp",
    ownerKey: ownerKeyFor(args.key),
    persona: args.key.personaKey,
    agent: args.activeAgentName.trim().toLowerCase(),
    provisioningToken: args.provisioningToken,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function handleSendToWorker(args) {
  const resolved = resolveWorker(args.workers, args.name);
  if (resolved.kind === "not-found") {
    const hint = resolved.closest.length ? ` Closest matches: ${resolved.closest.join(", ")}.` : "";
    throw new Error(`Worker '${args.name}' not found.${hint}`);
  }
  const worker = resolved.worker;
  if (!worker.persona?.trim()) throw new Error(`Worker '${worker.name}' has no persona and cannot be resumed.`);
  const nativeUserKey = os6.userInfo().username.trim().toLowerCase();
  if (!nativeUserKey) throw new Error("Unable to determine the local OS username.");
  const key2 = {
    installationKey: normalizeProjectEndpoint(worker.projectEndpoint),
    platform: "mcp",
    nativeUserKey,
    personaKey: canonicalPersonaKey(worker.persona)
  };
  const expectedMetadata = {
    ownerKey: ownerKeyFor(key2),
    personaKey: key2.personaKey,
    activeAgentName: worker.name.trim().toLowerCase()
  };
  const active = await args.store.resolve(key2, worker.name, {
    createConversation: (provisioningToken) => args.client.createConversation(buildMcpConversationMetadata({ key: key2, activeAgentName: worker.name, provisioningToken })),
    validateConversation: async (id) => {
      const conversation = await args.client.getConversation(id);
      if (isNotFoundConversation(conversation)) return { kind: "not_found" };
      return validateMcpConversation(conversation, expectedMetadata);
    },
    discoverConversations: async (token) => {
      if (!args.client.listConversations) throw new Error("conversation discovery unavailable");
      const conversations = await args.client.listConversations(token);
      return conversations.map((conversation) => ({
        id: conversation.id,
        metadata: conversation.metadata,
        createdAt: conversation.createdAt
      }));
    }
  });
  const conversationId = active.conversationId;
  const downloadFiles = async (r) => {
    if (worker.kind !== "hosted" || !r.artifacts?.length || !r.agentSessionId) return [];
    const out = [];
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
      return os6.userInfo().username;
    } catch {
      return void 0;
    }
  })();
  const ledgerBase = {
    agentName: worker.name,
    source: "mcp",
    userRef,
    foundryConversationId: conversationId,
    inputSnippet: args.message,
    agentKind: worker.kind
  };
  const startedAt = Date.now();
  if (worker.brain && isAppMode(worker.brain) && !isInContainer(worker.brain)) {
    const projectArmId = process.env.AZURE_FOUNDRY_PROJECT_ARM_ID;
    if (!projectArmId) {
      throw new Error(
        "AZURE_FOUNDRY_PROJECT_ARM_ID env var is required to invoke brain workers from the MCP plugin (set it in your shell config)"
      );
    }
    const kvUri = process.env.AZURE_KEYVAULT_URI;
    if (!kvUri) {
      throw new Error(
        "AZURE_KEYVAULT_URI env var is required to invoke brain workers from the MCP plugin (set it in your shell config)"
      );
    }
    await rotateConnectionAuth({
      credential: new DefaultAzureCredential3(),
      kvUri,
      projectArmId,
      connectionName: worker.brain.credentialRef,
      installationId: worker.brain.installationId,
      repository: worker.brain.repo
    });
  }
  const turnLease = worker.kind === "hosted" ? await args.store.acquireTurn(key2) : void 0;
  let turnReleased = false;
  const releaseTurn = async () => {
    if (turnLease && !turnReleased) {
      turnReleased = true;
      await turnLease.release();
    }
  };
  let history;
  try {
    history = worker.kind === "hosted" ? [...await args.client.getConversationMessages(conversationId), { role: "user", content: args.message }] : void 0;
  } catch (error) {
    await releaseTurn();
    throw error;
  }
  let responsePromise;
  try {
    responsePromise = args.client.createResponse({
      agentName: worker.name,
      conversationId,
      message: args.message,
      kind: worker.kind,
      history
    });
  } catch (error) {
    await releaseTurn();
    throw error;
  }
  const persistHostedTurn = async (r) => {
    if (worker.kind === "hosted") {
      await args.client.appendConversationItems(conversationId, [
        { role: "user", content: args.message },
        { role: "assistant", content: r.output }
      ]);
    }
  };
  const budgetMs = Math.max(0, args.waitBudgetSeconds * 1e3);
  const budgetPromise = new Promise((resolve) => {
    setTimeout(() => {
      resolve(BUDGET_EXPIRED);
    }, budgetMs);
  });
  let raceResult;
  try {
    raceResult = await Promise.race([responsePromise, budgetPromise]);
  } catch (err) {
    await releaseTurn();
    await args.emitLedger({
      ...ledgerBase,
      eventId: `${conversationId}:err:${Date.now().toString()}`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      outcome: "error",
      errorCode: err instanceof Error ? err.name : "unknown",
      latencyMs: Date.now() - startedAt
    });
    throw err;
  }
  if (raceResult === BUDGET_EXPIRED) {
    const finalConversationId = conversationId;
    const completionPromise = responsePromise.then(async (r) => {
      try {
        await persistHostedTurn(r);
        await releaseTurn();
        const isEmpty = !r.output.trim() && !r.artifacts?.length;
        await args.emitLedger({
          ...ledgerBase,
          eventId: r.id,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          responseId: r.id,
          model: r.model,
          outcome: isEmpty ? "empty" : "ok",
          replySnippet: r.output,
          latencyMs: Date.now() - startedAt
        });
        return {
          reply: r.output,
          conversationId: finalConversationId,
          responseId: r.id,
          files: await downloadFiles(r)
        };
      } finally {
        await releaseTurn();
      }
    }).catch(async (err) => {
      await args.emitLedger({
        ...ledgerBase,
        eventId: `${finalConversationId}:err:${Date.now().toString()}`,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        outcome: "error",
        errorCode: err instanceof Error ? err.name : "unknown",
        latencyMs: Date.now() - startedAt
      });
      throw err;
    });
    const taskId = args.registry.register(
      completionPromise
    );
    return {
      kind: "detached",
      taskId,
      conversationId,
      note: `${worker.displayName} is still working \u2014 check back via check_worker("${taskId}").`
    };
  }
  const isSyncEmpty = !raceResult.output.trim() && !raceResult.artifacts?.length;
  try {
    await persistHostedTurn(raceResult);
  } catch (err) {
    await releaseTurn();
    await args.emitLedger({
      ...ledgerBase,
      eventId: `${conversationId}:err:${Date.now().toString()}`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      outcome: "error",
      errorCode: err instanceof Error ? err.name : "unknown",
      latencyMs: Date.now() - startedAt
    });
    throw err;
  }
  await releaseTurn();
  await args.emitLedger({
    ...ledgerBase,
    eventId: raceResult.id,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    responseId: raceResult.id,
    model: raceResult.model,
    outcome: isSyncEmpty ? "empty" : "ok",
    replySnippet: raceResult.output,
    latencyMs: Date.now() - startedAt
  });
  const files = await downloadFiles(raceResult);
  return {
    kind: "completed",
    reply: raceResult.output,
    conversationId,
    responseId: raceResult.id,
    files
  };
}

// src/tools/check-worker.ts
function handleCheckWorker(args) {
  const peek = args.registry.peek(args.taskId);
  if (peek.kind === "not_found") {
    return { kind: "failed", error: `Unknown task id: ${args.taskId}` };
  }
  return peek;
}

// src/tools/tool-errors.ts
function friendlyToolError(err, serverVersion) {
  if (err instanceof TypeError) {
    return new Error(
      `m8t plugin error (server v${serverVersion}). This usually means the local plugin is out of date \u2014 run \`claude plugin update\` and restart Claude Code, then retry. (underlying: ${err.message})`,
      { cause: err }
    );
  }
  return err;
}

// src/lazy-init.ts
function createLazyInit(initFn) {
  let promise = null;
  return () => {
    if (!promise) {
      const fresh = initFn();
      promise = fresh;
      fresh.catch(() => {
        if (promise === fresh) promise = null;
      });
    }
    return promise;
  };
}

// src/ledger/storage-discovery.ts
import { DefaultAzureCredential as DefaultAzureCredential4 } from "@azure/identity";
async function discoverStorageAccountName(opts = {}) {
  const credential = opts.credential ?? new DefaultAzureCredential4();
  const fetcher = opts.fetchFn ?? fetch;
  const subProvider = opts.subscriptionIdProvider ?? defaultSubscriptionIdProvider;
  let token;
  try {
    const t = await credential.getToken("https://management.azure.com/.default");
    if (!t) return null;
    token = t.token;
  } catch {
    return null;
  }
  let subscriptionId;
  try {
    subscriptionId = await subProvider();
  } catch {
    return null;
  }
  if (!subscriptionId) return null;
  try {
    const res = await fetcher(
      `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-05-01`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const tagged = (data.value ?? []).filter((a) => a.tags?.managedBy === "m8t");
    const chosen = tagged.find((a) => a.tags?.m8t === "storage") ?? tagged[0];
    return chosen?.name ?? null;
  } catch {
    return null;
  }
}

// src/ledger/table-client.ts
import { TableClient } from "@azure/data-tables";
function createLedgerTableClient(accountName, credential) {
  return new TableClient(
    `https://${accountName}.table.core.windows.net`,
    "AgentLedger",
    credential
  );
}
async function ensureLedgerTable(client) {
  try {
    await client.createTable();
  } catch (e) {
    if (!isTableAlreadyExists(e)) throw e;
  }
}
function isTableAlreadyExists(e) {
  const anyE = e;
  return (
    /* eslint-disable @typescript-eslint/no-unnecessary-condition -- see note above: `anyE` may be null/non-object at runtime. */
    anyE?.statusCode === 409 && (anyE?.code === "TableAlreadyExists" || anyE?.details?.errorCode === "TableAlreadyExists")
  );
}

// ../../../packages/agent-ledger/src/row-key.ts
var MAX_MS = 864e13;
function makeRowKey(timestampIso, eventId) {
  const parsed = Date.parse(timestampIso);
  const epoch = Number.isFinite(parsed) ? parsed : Date.now();
  const reverse = MAX_MS - epoch;
  return `${String(reverse).padStart(19, "0")}_${eventId}`;
}

// ../../../packages/agent-ledger/src/entity.ts
var SNIPPET_MAX_LEN = 256;
function truncateSnippet(text) {
  if (text == null) return void 0;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return void 0;
  return oneLine.length <= SNIPPET_MAX_LEN ? oneLine : oneLine.slice(0, SNIPPET_MAX_LEN) + "\u2026";
}
function toLedgerEntity(e) {
  const entity = {
    partitionKey: e.agentName,
    rowKey: makeRowKey(e.timestamp, e.eventId),
    eventId: e.eventId,
    eventTimestamp: e.timestamp,
    agentName: e.agentName,
    source: e.source,
    outcome: e.outcome
  };
  const optional = {
    channel: e.channel,
    userRef: e.userRef,
    foundryConversationId: e.foundryConversationId,
    responseId: e.responseId,
    model: e.model,
    inputSnippet: truncateSnippet(e.inputSnippet),
    replySnippet: truncateSnippet(e.replySnippet),
    latencyMs: e.latencyMs,
    errorCode: e.errorCode,
    agentKind: e.agentKind,
    initiatingAgent: e.initiatingAgent,
    delegationId: e.delegationId,
    parentEventId: e.parentEventId,
    depth: e.depth,
    pendingItem: e.pendingItem,
    // Table Storage cells are scalar → serialize the pointer array to a JSON string
    // (the read side JSON.parses it). Same physical-mapping rationale as eventTimestamp.
    artifacts: e.artifacts?.length ? JSON.stringify(e.artifacts) : void 0
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v !== void 0 && v !== null) entity[k] = v;
  }
  return entity;
}

// ../../../packages/agent-ledger/src/emitter.ts
function toMirrorAttrs(e) {
  const a = {
    "ledger.agentName": e.agentName,
    "ledger.source": e.source,
    "ledger.outcome": e.outcome,
    "ledger.eventId": e.eventId
  };
  if (e.channel) a["ledger.channel"] = e.channel;
  if (e.foundryConversationId) a["ledger.foundryConversationId"] = e.foundryConversationId;
  if (e.responseId) a["ledger.responseId"] = e.responseId;
  if (e.model) a["ledger.model"] = e.model;
  if (e.latencyMs != null) a["ledger.latencyMs"] = e.latencyMs;
  if (e.errorCode) a["ledger.errorCode"] = e.errorCode;
  return a;
}
function createLedgerEmitter(sinks) {
  const onError = sinks.onError ?? ((msg, err) => {
    console.warn(msg, err);
  });
  return async (e) => {
    try {
      await sinks.writeEntity(toLedgerEntity(e));
    } catch (err) {
      onError("[ledger] write failed (non-fatal)", err);
      return;
    }
    if (sinks.mirror) {
      try {
        sinks.mirror("m8t.ledger.event", toMirrorAttrs(e));
      } catch (err) {
        onError("[ledger] mirror failed (non-fatal)", err);
      }
    }
  };
}

// src/ledger/emit.ts
function createMcpLedgerEmitter(client, logger) {
  let ensured = null;
  const ensureOnce = () => ensured ??= ensureLedgerTable(client);
  return createLedgerEmitter({
    writeEntity: async (entity) => {
      await ensureOnce();
      await client.upsertEntity(
        entity,
        "Replace"
      );
    },
    onError: (msg, err) => {
      logger.warn(msg, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// src/version.ts
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
var SERVER_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
).version;

// src/index.ts
installFoundryDnsShim();
async function initWorkerInfrastructure() {
  const config = await loadConfig();
  const projectEndpoint = config.projectEndpointOverride ?? await resolveProjectEndpoint();
  const repoRoot = await readRepoRoot();
  const client = createFoundryClient({ projectEndpoint });
  const logger = createLogger({
    filePath: path10.join(os7.homedir(), ".m8t", "logs", "m8t.log"),
    level: config.logLevel
  });
  const store = createConversationStore({
    observe: (event) => {
      const details = event;
      logger.info("conversation registry outcome", {
        outcome: event.kind,
        ...details.installationHash ? { installationHash: details.installationHash } : {},
        ...details.personaKey ? { persona: details.personaKey } : {},
        ...details.activeAgentName ? { agent: details.activeAgentName } : {},
        ...details.conversationId ? { conversationId: details.conversationId } : {},
        ...details.errorCode ? { errorCode: details.errorCode } : {}
      });
    }
  });
  const registry = createInFlightRegistry();
  logger.info("m8t MCP infrastructure initialized", {
    installationHash: createHash3("sha256").update(projectEndpoint).digest("hex"),
    pollIntervalSeconds: config.pollIntervalSeconds,
    responseWaitBudgetSeconds: config.responseWaitBudgetSeconds
  });
  let emitLedger = () => Promise.resolve();
  try {
    const account = await discoverStorageAccountName();
    if (account) {
      emitLedger = createMcpLedgerEmitter(
        createLedgerTableClient(account, new DefaultAzureCredential5()),
        logger
      );
      logger.info("ledger emitter ready", { storageAccount: account });
    } else {
      logger.warn("ledger storage account not discovered \u2014 ledger disabled this session");
    }
  } catch (e) {
    logger.warn("ledger init failed \u2014 ledger disabled", {
      error: e instanceof Error ? e.message : String(e)
    });
  }
  let workersCache = [];
  let previousWorkers = [];
  const commandsDir = path10.join(os7.homedir(), ".claude", "commands");
  const poller = createPoller({
    intervalMs: config.pollIntervalSeconds * 1e3,
    fetcher: () => handleListWorkers({ client, repoRoot, projectEndpoint }),
    onUpdate: (latest) => {
      workersCache = latest;
      void syncCommandsToFs({
        commandsDir,
        previous: previousWorkers,
        current: latest
      }).then((report) => {
        previousWorkers = latest;
        if (report.added.length || report.removed.length || report.changed.length || report.collisions.length) {
          logger.info("synced commands", { ...report });
        }
      }).catch((err) => {
        logger.warn("sync-commands failed", {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    },
    onError: (err) => {
      logger.warn("poller fetch failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
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
    emitLedger
  };
}
async function main() {
  const server = new Server(
    { name: "m8t", version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  const getInfra = createLazyInit(initWorkerInfrastructure);
  let cachedInfra = null;
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
        description: "List all m8t virtual workers currently deployed in the configured Foundry project. Returns name, displayName, role, description, agentId, projectEndpoint, model, persona, personaVersion, deployedAt.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "send_to_worker",
        description: "Send a message to a deployed virtual worker. When invoking, the `message` field should include any relevant context from the current coding-agent session that the worker needs to do its job \u2014 be selective. The local user resumes the durable conversation for this persona and installation.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Worker name (case-insensitive)." },
            message: { type: "string", description: "Message text including any relevant context." }
          },
          required: ["name", "message"],
          additionalProperties: false
        }
      },
      {
        name: "check_worker",
        description: "Check on a previously-detached worker task. Returns still_running, completed, or failed.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "Task ID returned by a previous send_to_worker call that detached."
            }
          },
          required: ["taskId"],
          additionalProperties: false
        }
      },
      {
        name: "refresh_workers",
        description: "Force an immediate re-fetch of workers from Foundry and regenerate the slash command files. Use when a new worker was just deployed and you want it to appear in autocomplete without waiting for the next poll cycle.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      }
    ]
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      const infra = await getInfra();
      cachedInfra = infra;
      if (name === "list_workers") {
        if (!infra.getCache().length) await infra.poller.runOnceOrThrow();
        return { content: [{ type: "text", text: JSON.stringify(infra.getCache(), null, 2) }] };
      }
      if (name === "send_to_worker") {
        const workerName = args.name;
        if (typeof workerName !== "string" || !workerName.trim()) {
          throw new Error("send_to_worker requires a non-empty 'name' argument (the worker to message).");
        }
        if (!infra.getCache().length) await infra.poller.runOnceOrThrow();
        const workers = infra.getCache();
        const workerKind = workers.find((w) => w.name.toLowerCase() === workerName.toLowerCase())?.kind ?? "prompt";
        const result = await handleSendToWorker({
          workers,
          name: workerName,
          message: args.message,
          client: infra.client,
          store: infra.store,
          waitBudgetSeconds: resolveWaitBudget(workerKind, infra.config.responseWaitBudgetSeconds),
          registry: infra.registry,
          emitLedger: infra.emitLedger
        });
        let text = JSON.stringify(result, null, 2);
        if (result.kind === "completed" && result.files?.length) {
          const lines = result.files.map((f) => `  - ${f.localPath} (${f.mime}, ${f.size.toString()} bytes)`);
          text += `

\u{1F4CE} Files saved locally:
${lines.join("\n")}`;
        }
        return { content: [{ type: "text", text }] };
      }
      if (name === "check_worker") {
        const taskId = args.taskId;
        if (typeof taskId !== "string" || !taskId.trim()) {
          throw new Error("check_worker requires a non-empty 'taskId' argument (from a prior detached send_to_worker).");
        }
        const result = handleCheckWorker({
          registry: infra.registry,
          taskId
        });
        let text = JSON.stringify(result, null, 2);
        if (result.kind === "completed" && result.files?.length) {
          const lines = result.files.map((f) => `  - ${f.localPath} (${f.mime}, ${f.size.toString()} bytes)`);
          text += `

\u{1F4CE} Files saved locally:
${lines.join("\n")}`;
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
main().catch((err) => {
  console.error("m8t MCP server crashed:", err);
  process.exit(1);
});
//# sourceMappingURL=index.js.map