import { createHash, randomUUID as cryptoRandomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { open as openFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface McpConversationKey { installationKey: string; platform: "mcp"; nativeUserKey: string; personaKey: string }
export type McpConversationRecord =
  | { state: "ready"; key: McpConversationKey; activeAgentName: string; activeConversationId: string; createdAt: string; updatedAt: string }
  | { state: "broken"; key: McpConversationKey; activeAgentName: string; activeConversationId: string; reason: "conversation_not_found" | "conversation_mismatch"; createdAt: string; updatedAt: string };
export type McpConversationValidation = { kind: "valid" } | { kind: "not_found" } | { kind: "mismatch" };
export interface DiscoveredMcpConversation { id: string; metadata: Record<string, string>; createdAt?: string }
export interface ResolveMcpConversationDeps { createConversation(provisioningToken: string): Promise<{ id: string }>; validateConversation(conversationId: string): Promise<McpConversationValidation>; discoverConversations?: (provisioningToken: string) => Promise<DiscoveredMcpConversation[]> }
export type McpConversationStoreEvent =
  | { kind: "found" | "created"; installationHash: string; personaKey: string; activeAgentName: string; conversationId: string }
  | { kind: "validation_failed"; installationHash: string; personaKey: string; activeAgentName: string; errorCode: "conversation_not_found" | "conversation_mismatch" }
  | { kind: "registry_corrupt" | "registry_version_unsupported" | "lock_failed"; installationHash?: string; errorCode: string };
export interface ConversationStoreOptions { filePath?: string; now?: () => Date; randomUUID?: () => string; sleep?: (ms: number) => Promise<void>; observe?: (event: McpConversationStoreEvent) => void }

export class ConversationRegistryCorruptError extends Error { constructor(message = "conversation registry is corrupt") { super(message); this.name = "ConversationRegistryCorruptError" } }
export class ConversationRegistryVersionError extends Error { constructor(message = "unsupported conversation registry schema version") { super(message); this.name = "ConversationRegistryVersionError" } }
export class ConversationAgentMismatchError extends Error { constructor(message = "conversation active agent does not match") { super(message); this.name = "ConversationAgentMismatchError" } }
export class ConversationRegistryLockError extends Error { constructor(message = "unable to acquire conversation registry lock") { super(message); this.name = "ConversationRegistryLockError" } }

export interface ConversationStore {
  resolve(key: McpConversationKey, activeAgentName: string, deps: ResolveMcpConversationDeps): Promise<{ conversationId: string; outcome: "found" | "created" }>;
  acquireTurn(key: McpConversationKey): Promise<{ release: () => Promise<void> }>;
}

interface ProvisioningRecord { state: "provisioning"; key: McpConversationKey; activeAgentName: string; provisioningToken: string; createdAt: string; updatedAt: string }
interface Registry { schemaVersion: 2; records: (McpConversationRecord | ProvisioningRecord)[] }
interface LockData { token: string; pid: number; expiresAt: string }
type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null;
const errorCode = (error: unknown): string | undefined => isRecord(error) && typeof error.code === "string" ? error.code : undefined;
const parseJson = (text: string): unknown => JSON.parse(text) as unknown;
const LOCK_MS = 30_000;
const normalize = (s: string) => s.trim().toLowerCase();
const normalizedKey = (k: McpConversationKey): McpConversationKey => ({ installationKey: normalizeEndpoint(k.installationKey), platform: "mcp", nativeUserKey: normalize(k.nativeUserKey), personaKey: normalize(k.personaKey) });
const normalizeEndpoint = (s: string) => { const v = s.trim(); try { const u = new URL(v); u.hostname = u.hostname.toLowerCase(); u.pathname = u.pathname.replace(/\/+$/, ""); return u.toString().replace(/\/$/, ""); } catch { return normalize(v).replace(/\/+$/, ""); } };
const keyString = (k: McpConversationKey) => JSON.stringify([k.installationKey, k.platform, k.nativeUserKey, k.personaKey]);
const installationHash = (k: McpConversationKey) => createHash("sha256").update(k.installationKey).digest("hex");
const privacyHash = (s: string) => createHash("sha256").update(s).digest("hex");
const ownerHash = (key: McpConversationKey) => privacyHash(`${key.installationKey}\0${key.nativeUserKey}`);
const timestamp = (value: unknown): number => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : 0;

export function createConversationStore(options: ConversationStoreOptions = {}): ConversationStore {
  const filePath = options.filePath ?? process.env.M8T_CONVERSATION_REGISTRY_PATH ?? path.join(os.homedir(), ".m8t", "conversation-registry.json");
  const lockPath = `${filePath}.lock`;
  const now = options.now ?? (() => new Date());
  const uuid = options.randomUUID ?? cryptoRandomUUID;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const observe = (event: McpConversationStoreEvent) => { try { options.observe?.(event); } catch { /* observers are non-critical */ } };

  async function load(): Promise<Registry> {
    let text: string; try { text = await fs.readFile(filePath, "utf8"); } catch (e: unknown) { if (errorCode(e) === "ENOENT") return { schemaVersion: 2, records: [] }; throw e; }
    let value: unknown; try { value = parseJson(text); } catch { throw new ConversationRegistryCorruptError(); }
    if (!isRecord(value)) throw new ConversationRegistryCorruptError();
    if (typeof value.schemaVersion !== "number" || !Array.isArray(value.records)) throw new ConversationRegistryCorruptError();
    if (value.schemaVersion !== 1 && value.schemaVersion !== 2) throw new ConversationRegistryVersionError();
    if (Object.keys(value).some(k => k !== "schemaVersion" && k !== "records")) throw new ConversationRegistryCorruptError();
    const seen = new Set<string>();
    for (const r of value.records) {
      if (!isRecord(r) || !["ready", "broken", "provisioning"].includes(String(r.state)) || !isRecord(r.key)) throw new ConversationRegistryCorruptError();
      if (value.schemaVersion === 1 && r.state === "provisioning") throw new ConversationRegistryCorruptError();
      if (r.state === "provisioning") {
        if (Object.keys(r).some(k => !["state", "key", "activeAgentName", "provisioningToken", "createdAt", "updatedAt"].includes(k)) || typeof r.provisioningToken !== "string" || !r.provisioningToken || typeof r.activeAgentName !== "string" || !normalize(r.activeAgentName) || r.activeAgentName !== normalize(r.activeAgentName) || typeof r.createdAt !== "string" || typeof r.updatedAt !== "string" || Number.isNaN(Date.parse(r.createdAt)) || Number.isNaN(Date.parse(r.updatedAt)) || Object.keys(r.key).some(k => !["installationKey", "platform", "nativeUserKey", "personaKey"].includes(k)) || r.key.platform !== "mcp" || typeof r.key.installationKey !== "string" || typeof r.key.nativeUserKey !== "string" || typeof r.key.personaKey !== "string" || !normalizeEndpoint(r.key.installationKey) || !normalize(r.key.nativeUserKey) || !normalize(r.key.personaKey) || r.key.installationKey !== normalizeEndpoint(r.key.installationKey) || r.key.nativeUserKey !== normalize(r.key.nativeUserKey) || r.key.personaKey !== normalize(r.key.personaKey)) throw new ConversationRegistryCorruptError();
        const k = keyString(normalizedKey(r.key as unknown as McpConversationKey)); if (seen.has(k)) throw new ConversationRegistryCorruptError(); seen.add(k);
      }
      if (r.state === "provisioning") continue;
      const allowedRecord = r.state === "ready" ? ["state", "key", "activeAgentName", "activeConversationId", "createdAt", "updatedAt"] : ["state", "key", "activeAgentName", "activeConversationId", "reason", "createdAt", "updatedAt"];
      if (Object.keys(r).some(k => !allowedRecord.includes(k)) || Object.keys(r.key).some(k => !["installationKey", "platform", "nativeUserKey", "personaKey"].includes(k)) || r.key.platform !== "mcp" || typeof r.key.installationKey !== "string" || typeof r.key.nativeUserKey !== "string" || typeof r.key.personaKey !== "string" || !normalizeEndpoint(r.key.installationKey) || !normalize(r.key.nativeUserKey) || !normalize(r.key.personaKey) || r.key.installationKey !== normalizeEndpoint(r.key.installationKey) || r.key.nativeUserKey !== normalize(r.key.nativeUserKey) || r.key.personaKey !== normalize(r.key.personaKey) || typeof r.activeAgentName !== "string" || !normalize(r.activeAgentName) || r.activeAgentName !== normalize(r.activeAgentName) || typeof r.activeConversationId !== "string" || !normalize(r.activeConversationId) || typeof r.createdAt !== "string" || typeof r.updatedAt !== "string" || Number.isNaN(Date.parse(r.createdAt)) || Number.isNaN(Date.parse(r.updatedAt)) || (r.state === "broken" && r.reason !== "conversation_not_found" && r.reason !== "conversation_mismatch")) throw new ConversationRegistryCorruptError();
      const k = keyString(normalizedKey(r.key as unknown as McpConversationKey)); if (seen.has(k)) throw new ConversationRegistryCorruptError(); seen.add(k);
    }
    return { schemaVersion: 2, records: value.records as (McpConversationRecord | ProvisioningRecord)[] };
  }
  async function publish(reg: Registry) {
    const parent = path.dirname(filePath); let createdParent = false; try { await fs.mkdir(parent, { recursive: false, mode: 0o700 }); createdParent = true; } catch (e: unknown) { if (errorCode(e) !== "EEXIST") throw e; }
    if (!createdParent) { try { await fs.access(parent); } catch { await fs.mkdir(parent, { recursive: true, mode: 0o700 }); } }
    const tmp = `${filePath}.${uuid()}.tmp`; const fh = await openFile(tmp, "wx", 0o600);
    try { await fh.writeFile(JSON.stringify(reg) + "\n", "utf8"); await fh.sync(); } finally { await fh.close(); }
    await fs.rename(tmp, filePath); await fs.chmod(filePath, 0o600).catch(() => undefined); const dh = await openFile(parent, "r"); try { await dh.sync(); } finally { await dh.close(); }
  }
  async function acquire(targetLockPath = lockPath): Promise<{ token: string; release: () => Promise<void> }> {
    const lockParent = path.dirname(targetLockPath); try { await fs.mkdir(lockParent, { recursive: false, mode: 0o700 }); } catch (e: unknown) { if (errorCode(e) === "ENOENT") await fs.mkdir(lockParent, { recursive: true, mode: 0o700 }); else if (errorCode(e) !== "EEXIST") throw e; }
    const token = uuid();
    for (let attempt = 0; attempt < 80; attempt++) {
      try { const fh = await openFile(targetLockPath, "wx", 0o600); const data: LockData = { token, pid: process.pid, expiresAt: new Date(now().getTime() + LOCK_MS).toISOString() }; await fh.writeFile(JSON.stringify(data)); await fh.sync(); await fh.close();
        let stopped = false;
        const renewLease = async () => {
          if (stopped) return;
          let lockHandle: Awaited<ReturnType<typeof openFile>> | undefined;
          try {
            lockHandle = await openFile(targetLockPath, "r+");
            const current = parseJson(await lockHandle.readFile("utf8"));
            if (!isRecord(current) || current.token !== token) return;
            const renewed = JSON.stringify({ token, pid: process.pid, expiresAt: new Date(now().getTime() + LOCK_MS).toISOString() });
            await lockHandle.write(renewed, 0, "utf8");
            await lockHandle.truncate(Buffer.byteLength(renewed));
            await lockHandle.sync();
          } catch { /* a lost or unreadable lease is never reclaimed by renewal */ }
          finally { await lockHandle?.close().catch(() => undefined); }
        };
        const renew = setInterval(() => { void renewLease(); }, Math.floor(LOCK_MS / 3));
        renew.unref();
        return { token, release: async () => { stopped = true; clearInterval(renew); try { const cur = parseJson(await fs.readFile(targetLockPath, "utf8")); if (isRecord(cur) && cur.token === token) await fs.unlink(targetLockPath); } catch (e: unknown) { if (errorCode(e) !== "ENOENT") throw e; } } }; } catch (e: unknown) { if (errorCode(e) !== "EEXIST") throw e; }
      let current: LockData | undefined;
      try {
        const parsed = parseJson(await fs.readFile(targetLockPath, "utf8"));
        if (!isRecord(parsed) || typeof parsed.pid !== "number" || typeof parsed.token !== "string" || typeof parsed.expiresAt !== "string") throw new ConversationRegistryLockError("conversation registry lock is invalid; remove it only after inspection");
        current = { pid: parsed.pid, token: parsed.token, expiresAt: parsed.expiresAt };
      } catch (e: unknown) {
        // A contender can observe the lock file between exclusive creation and
        // publication of its JSON payload. Treat this as contention and retry;
        // after bounded retries a persistently malformed lock fails closed.
        if (errorCode(e) === "ENOENT" || e instanceof SyntaxError) {
          await sleep(Math.min(10 + attempt * 2, 100));
          continue;
        }
        throw new ConversationRegistryLockError("conversation registry lock is unreadable; remove it only after inspection");
      }
      const expired = Date.parse(current.expiresAt) <= now().getTime(); let alive = true; try { process.kill(current.pid, 0); } catch (e: unknown) { alive = errorCode(e) !== "ESRCH"; }
      if (expired && !alive) {
        const guard = `${targetLockPath}.reclaim`; let owned = false; try { await fs.mkdir(guard, { mode: 0o700 }); owned = true; } catch (e: unknown) { if (errorCode(e) !== "EEXIST") throw e; }
        if (owned) {
          try { const parsed = parseJson(await fs.readFile(targetLockPath, "utf8")); if (isRecord(parsed) && typeof parsed.pid === "number" && typeof parsed.token === "string" && typeof parsed.expiresAt === "string") { const reread = parsed as unknown as LockData; let dead = false; try { process.kill(reread.pid, 0); } catch (e: unknown) { dead = errorCode(e) === "ESRCH"; } if (reread.token === current.token && reread.pid === current.pid && Date.parse(reread.expiresAt) <= now().getTime() && dead) await fs.unlink(targetLockPath).catch(() => undefined); } } finally { await fs.rmdir(guard).catch(() => undefined); }
        }
      } else if (expired && alive) { /* never reclaim live owners */ }
      await sleep(Math.min(50 + Math.floor(Math.random() * 25) + attempt * 5, 250));
    }
    throw new ConversationRegistryLockError();
  }
  async function resolve(keyInput: McpConversationKey, activeAgentNameInput: string, deps: ResolveMcpConversationDeps) {
    const key = normalizedKey(keyInput); const activeAgentName = normalize(activeAgentNameInput); if (!key.installationKey || !key.nativeUserKey || !key.personaKey || !activeAgentName) throw new ConversationRegistryCorruptError(); const hash = installationHash(key);
    let lease: { token: string; release: () => Promise<void> };
    try { lease = await acquire(); } catch (e: unknown) { observe({ kind: "lock_failed", installationHash: hash, errorCode: e instanceof Error ? e.name : "lock_failed" }); throw e; }
    try {
      let reg = await load(); const found = reg.records.find(r => keyString(r.key) === keyString(key));
      if (found?.state === "provisioning") {
        if (normalize(found.activeAgentName) !== activeAgentName) throw new ConversationAgentMismatchError();
        if (!deps.discoverConversations) throw new ConversationRegistryLockError("conversation provisioning requires discovery support");
        let discovered: DiscoveredMcpConversation[];
        try { discovered = await deps.discoverConversations(found.provisioningToken); } catch { throw new ConversationRegistryLockError("conversation discovery failed; refusing to create"); }
        const ownerKey = ownerHash(key);
        const exact = discovered.filter(c => c.metadata.app === "m8t" && c.metadata.platform === "mcp" && c.metadata.ownerKey === ownerKey && c.metadata.persona === key.personaKey && c.metadata.agent === activeAgentName && c.metadata.provisioningToken === found.provisioningToken && typeof c.id === "string" && c.id.length > 0);
        if (exact.length) {
          exact.sort((a, b) =>
            timestamp(b.metadata.createdAt) - timestamp(a.metadata.createdAt)
            || timestamp(b.createdAt) - timestamp(a.createdAt)
            || a.id.localeCompare(b.id));
          const winner = exact[0]; const at = now().toISOString(); reg.records = reg.records.map(r => r === found ? { state: "ready", key, activeAgentName, activeConversationId: winner.id, createdAt: found.createdAt, updatedAt: at } : r); await publish(reg); return { conversationId: winner.id, outcome: "found" as const };
        }
      }
      if (found && found.state !== "provisioning") {
        if (normalize(found.activeAgentName) !== activeAgentName) { observe({ kind: "validation_failed", installationHash: hash, personaKey: privacyHash(key.personaKey), activeAgentName: privacyHash(activeAgentName), errorCode: "conversation_mismatch" }); throw new ConversationAgentMismatchError(); }
        if (found.state === "broken") { observe({ kind: "validation_failed", installationHash: hash, personaKey: privacyHash(key.personaKey), activeAgentName: privacyHash(activeAgentName), errorCode: found.reason }); throw new ConversationAgentMismatchError(`conversation is broken: ${found.reason}`); }
        const validation = await deps.validateConversation(found.activeConversationId);
        if (validation.kind === "valid") { observe({ kind: "found", installationHash: hash, personaKey: privacyHash(key.personaKey), activeAgentName: privacyHash(activeAgentName), conversationId: privacyHash(found.activeConversationId) }); return { conversationId: found.activeConversationId, outcome: "found" as const }; }
        const broken: McpConversationRecord = { ...found, state: "broken", reason: validation.kind === "not_found" ? "conversation_not_found" : "conversation_mismatch", updatedAt: now().toISOString() }; reg.records = reg.records.map(r => r === found ? broken : r); await publish(reg); observe({ kind: "validation_failed", installationHash: hash, personaKey: privacyHash(key.personaKey), activeAgentName: privacyHash(activeAgentName), errorCode: broken.reason }); throw new ConversationAgentMismatchError(`conversation validation failed: ${broken.reason}`);
      }
      const provisioningToken = found?.state === "provisioning" ? found.provisioningToken : uuid();
      if (!found) { const at = now().toISOString(); reg.records.push({ state: "provisioning", key, activeAgentName, provisioningToken, createdAt: at, updatedAt: at }); await publish(reg); }
      const created = await deps.createConversation(provisioningToken); const at = now().toISOString(); reg = await load();
      const raced = reg.records.find(r => keyString(r.key) === keyString(key));
      if (raced && raced.state !== "provisioning") {
        if (normalize(raced.activeAgentName) !== activeAgentName) throw new ConversationAgentMismatchError();
        if (raced.state === "broken") throw new ConversationAgentMismatchError(`conversation is broken: ${raced.reason}`);
        return { conversationId: raced.activeConversationId, outcome: "found" as const };
      }
      reg.records = reg.records.filter(r => r !== raced); reg.records.push({ state: "ready", key, activeAgentName, activeConversationId: created.id, createdAt: at, updatedAt: at }); await publish(reg); observe({ kind: "created", installationHash: hash, personaKey: privacyHash(key.personaKey), activeAgentName: privacyHash(activeAgentName), conversationId: privacyHash(created.id) }); return { conversationId: created.id, outcome: "created" as const };
    } catch (e: unknown) { if (e instanceof ConversationRegistryCorruptError) observe({ kind: "registry_corrupt", installationHash: hash, errorCode: e.name }); else if (e instanceof ConversationRegistryVersionError) observe({ kind: "registry_version_unsupported", installationHash: hash, errorCode: e.name }); throw e; } finally { await lease.release(); }
  }
  async function acquireTurn(keyInput: McpConversationKey) {
    const key = normalizedKey(keyInput);
    if (!key.installationKey || !key.nativeUserKey || !key.personaKey) throw new ConversationRegistryCorruptError();
    const turnPath = `${filePath}.${privacyHash(keyString(key))}.turn.lock`;
    const lease = await acquire(turnPath);
    return { release: lease.release };
  }
  return { resolve, acquireTurn };
}
