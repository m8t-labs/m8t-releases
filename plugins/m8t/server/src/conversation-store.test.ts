import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createConversationStore } from "./conversation-store.js";

describe("conversation store", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
  const ownerKeyFor = (installationKey: string, nativeUserKey: string) => createHash("sha256").update(`${installationKey}\0${nativeUserKey}`).digest("hex");

  it("serializes turn leases across independent store instances without exposing the conversation key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-turn-lock-")); dirs.push(dir);
    const filePath = path.join(dir, "registry.json");
    const key = { installationKey: "https://example.test/project", platform: "mcp" as const, nativeUserKey: "user", personaKey: "persona" };
    const first = createConversationStore({ filePath });
    const second = createConversationStore({ filePath });
    const held = await first.acquireTurn(key);
    const contender = second.acquireTurn(key);
    let acquired = false;
    void contender.then(() => { acquired = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(acquired).toBe(false);
    const names = await readdir(dir);
    expect(names.some(name => name.includes("example.test"))).toBe(false);
    await held.release();
    await expect(contender).resolves.toBeDefined();
  });

  it("fails closed when a turn lock is persistently corrupt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-turn-lock-corrupt-")); dirs.push(dir);
    const filePath = path.join(dir, "registry.json");
    const key = { installationKey: "x", platform: "mcp" as const, nativeUserKey: "u", personaKey: "p" };
    const hash = createHash("sha256").update(JSON.stringify(["x", "mcp", "u", "p"])).digest("hex");
    await writeFile(`${filePath}.${hash}.turn.lock`, "not-json");
    await expect(createConversationStore({ filePath, sleep: async () => undefined }).acquireTurn(key)).rejects.toThrow(/lock/i);
  });

  it("persists one pointer across store instances and concurrent creators", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir);
    const filePath = path.join(dir, "nested", "conversation-registry.json");
    let creates = 0;
    const deps = { createConversation: async () => { creates++; await new Promise(r => setTimeout(r, 5)); return { id: "conv_1" }; }, validateConversation: async () => ({ kind: "valid" as const }) };
    const key = { installationKey: "https://Example.test/project/", platform: "mcp" as const, nativeUserKey: "Alice", personaKey: "Carolyn" };
    const first = createConversationStore({ filePath });
    const results = await Promise.all(Array.from({ length: 20 }, () => first.resolve(key, "Agent", deps)));
    expect(new Set(results.map(r => r.conversationId))).toEqual(new Set(["conv_1"])); expect(creates).toBe(1);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600); expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    const second = createConversationStore({ filePath });
    expect((await second.resolve(key, "Agent", { ...deps, createConversation: async () => ({ id: "wrong" }) })).conversationId).toBe("conv_1");
  });

  it("converges across two child processes with one exclusive creation marker", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-process-")); dirs.push(dir);
    const filePath = path.join(dir, "conversation-registry.json");
    const markerPath = path.join(dir, "creation.marker");
    const fixturePath = path.join(dir, "child-fixture.mjs");
    const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "conversation-store.ts");
    await writeFile(fixturePath, `
      import { open } from "node:fs/promises";
      import { createConversationStore } from ${JSON.stringify(sourcePath)};
      const filePath = process.argv[2];
      const markerPath = process.argv[3];
      const key = { installationKey: "https://example.test/project", platform: "mcp", nativeUserKey: "user", personaKey: "persona" };
      const result = await createConversationStore({ filePath }).resolve(key, "agent", {
        createConversation: async () => {
          const marker = await open(markerPath, "wx");
          await marker.writeFile(JSON.stringify({ pid: process.pid, conversationId: "conv_process" }));
          await marker.close();
          await new Promise(resolve => setTimeout(resolve, 40));
          return { id: "conv_process" };
        },
        validateConversation: async () => ({ kind: "valid" }),
      });
      console.log(JSON.stringify(result));
    `);

    const childTimeoutMs = 2_000;
    const runChild = () => {
      const child = spawn(process.execPath, ["--experimental-strip-types", fixturePath, filePath, markerPath], { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; let error = "";
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { error += String(chunk); });
      let spawnError: Error | undefined;
      child.once("error", cause => { spawnError = cause; });
      const result = new Promise<{ output: string }>((resolve, reject) => {
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, childTimeoutMs);
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          const diagnostics = `stdout=${JSON.stringify(output)} stderr=${JSON.stringify(error)}`;
          if (spawnError) { reject(new Error(`child failed to spawn: ${spawnError.message}; ${diagnostics}`)); return; }
          if (timedOut) { reject(new Error(`child timed out after ${String(childTimeoutMs)}ms and exited via ${String(signal)}; ${diagnostics}`)); return; }
          if (code === 0) { resolve({ output }); return; }
          reject(new Error(`child exited ${String(code)} via ${String(signal)}; ${diagnostics}`));
        });
      });
      const closed = new Promise<void>(resolve => { child.once("close", () => { resolve(); }); });
      return { child, result, closed };
    };
    const children = [runChild(), runChild()];
    let results: { output: string }[];
    try {
      results = await Promise.all(children.map(({ result }) => result));
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(children.map(({ closed }) => closed));
      expect(children.every(({ child }) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    }
    expect(results.map(r => JSON.parse(r.output.trim()).conversationId)).toEqual(["conv_process", "conv_process"]);
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({ conversationId: "conv_process" });
    expect(JSON.parse(await readFile(filePath, "utf8")).records).toHaveLength(1);
  });

  it("fails closed on corrupt and unsupported registries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir); const filePath = path.join(dir, "conversation-registry.json");
    await writeFile(filePath, "not json", { mode: 0o600 });
    await expect(createConversationStore({ filePath }).resolve({ installationKey: "x", platform: "mcp", nativeUserKey: "u", personaKey: "p" }, "a", { createConversation: async () => ({ id: "x" }), validateConversation: async () => ({ kind: "valid" }) })).rejects.toThrow("corrupt");
    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, records: [] }));
    await expect(createConversationStore({ filePath }).resolve({ installationKey: "x", platform: "mcp", nativeUserKey: "u", personaKey: "p" }, "a", { createConversation: async () => ({ id: "x" }), validateConversation: async () => ({ kind: "valid" }) })).rejects.toThrow("unsupported");
  });

  it("rejects malformed records, duplicate keys, and does not overwrite the registry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir); const filePath = path.join(dir, "conversation-registry.json");
    const key = { installationKey: "https://example.test", platform: "mcp" as const, nativeUserKey: "u", personaKey: "p" };
    const base = { state: "ready", key, activeAgentName: "a", activeConversationId: "c", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    for (const records of [[{ ...base, activeConversationId: 4 }], [base, { ...base }], [{ ...base, key: { ...key, platform: "slack" } }]]) {
      const original = JSON.stringify({ schemaVersion: 1, records }); await writeFile(filePath, original);
      await expect(createConversationStore({ filePath }).resolve(key, "a", { createConversation: async () => ({ id: "new" }), validateConversation: async () => ({ kind: "valid" }) })).rejects.toThrow("corrupt");
      expect(await readFile(filePath, "utf8")).toBe(original);
    }
  });

  it("preserves an existing parent directory mode while securing newly created parents", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir); await mkdir(path.join(dir, "existing"), { mode: 0o755 });
    const existing = path.join(dir, "existing", "registry.json");
    await createConversationStore({ filePath: existing }).resolve({ installationKey: "x", platform: "mcp", nativeUserKey: "u", personaKey: "p" }, "a", { createConversation: async () => ({ id: "c" }), validateConversation: async () => ({ kind: "valid" }) });
    expect((await stat(path.dirname(existing))).mode & 0o777).toBe(0o755);
    const fresh = path.join(dir, "fresh", "nested", "registry.json");
    await createConversationStore({ filePath: fresh }).resolve({ installationKey: "x", platform: "mcp", nativeUserKey: "u", personaKey: "q" }, "a", { createConversation: async () => ({ id: "c" }), validateConversation: async () => ({ kind: "valid" }) });
    expect((await stat(path.dirname(fresh))).mode & 0o777).toBe(0o700);
  });

  it("passes a UUID provisioning token to conversation creation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir); const filePath = path.join(dir, "registry.json"); let token = "";
    await createConversationStore({ filePath, randomUUID: () => "uuid-token" }).resolve({ installationKey: "x", platform: "mcp", nativeUserKey: "u", personaKey: "p" }, "a", { createConversation: async (t) => { token = t; return { id: "c" }; }, validateConversation: async () => ({ kind: "valid" }) });
    expect(token).toBe("uuid-token");
  });

  it("publishes schema v2 and accepts v1 only for ready or broken migration records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-schema-")); dirs.push(dir); const filePath = path.join(dir, "registry.json");
    const key = { installationKey: "x", platform: "mcp" as const, nativeUserKey: "u", personaKey: "p" };
    await createConversationStore({ filePath }).resolve(key, "a", { createConversation: async () => ({ id: "c" }), validateConversation: async () => ({ kind: "valid" }) });
    expect(JSON.parse(await readFile(filePath, "utf8")).schemaVersion).toBe(2);
    const at = new Date().toISOString();
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, records: [{ state: "provisioning", key, activeAgentName: "a", provisioningToken: "t", createdAt: at, updatedAt: at }] }));
    await expect(createConversationStore({ filePath }).resolve(key, "a", { createConversation: async () => ({ id: "c" }), validateConversation: async () => ({ kind: "valid" }), discoverConversations: async () => [] })).rejects.toThrow(/corrupt/i);
  });

  it("adopts the exact remote conversation after creation crashes before registry publication", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-crash-")); dirs.push(dir);
    const filePath = path.join(dir, "registry.json");
    const key = { installationKey: "https://example.test/project", platform: "mcp" as const, nativeUserKey: "alice", personaKey: "cmo" };
    const ownerKey = ownerKeyFor(key.installationKey, key.nativeUserKey);
    let token = "";
    await expect(createConversationStore({ filePath, randomUUID: () => "stable-token" }).resolve(key, "agent", {
      createConversation: async (provisioningToken) => { token = provisioningToken; throw new Error("process died after remote create"); },
      validateConversation: async () => ({ kind: "valid" }),
    })).rejects.toThrow("process died");
    expect(JSON.parse(await readFile(filePath, "utf8")).records[0]).toMatchObject({ state: "provisioning", provisioningToken: "stable-token" });

    const createConversation = vi.fn(async () => ({ id: "duplicate" }));
    const result = await createConversationStore({ filePath }).resolve(key, "agent", {
      createConversation,
      validateConversation: async () => ({ kind: "valid" }),
      discoverConversations: async (provisioningToken) => [{ id: "conv_remote", metadata: { app: "m8t", platform: "mcp", ownerKey, persona: "cmo", agent: "agent", provisioningToken }, createdAt: "2026-07-21T01:00:00.000Z" }],
    });
    expect(token).toBe("stable-token");
    expect(result).toEqual({ conversationId: "conv_remote", outcome: "found" });
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("excludes discovery candidates with a wrong owner, persona, agent, or token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-filter-")); dirs.push(dir);
    const filePath = path.join(dir, "registry.json");
    const key = { installationKey: "https://example.test/project", platform: "mcp" as const, nativeUserKey: "alice", personaKey: "cmo" };
    const at = "2026-07-21T00:00:00.000Z";
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, records: [{ state: "provisioning", key, activeAgentName: "agent", provisioningToken: "token", createdAt: at, updatedAt: at }] }));
    const valid = { app: "m8t", platform: "mcp", ownerKey: ownerKeyFor(key.installationKey, key.nativeUserKey), persona: "cmo", agent: "agent", provisioningToken: "token" };
    const createConversation = vi.fn(async () => ({ id: "new" }));
    const result = await createConversationStore({ filePath }).resolve(key, "agent", {
      createConversation,
      validateConversation: async () => ({ kind: "valid" }),
      discoverConversations: async () => [
        { id: "wrong-owner", metadata: { ...valid, ownerKey: "wrong" } },
        { id: "wrong-persona", metadata: { ...valid, persona: "other" } },
        { id: "wrong-agent", metadata: { ...valid, agent: "other" } },
        { id: "wrong-token", metadata: { ...valid, provisioningToken: "other" } },
        { id: "winner", metadata: valid },
      ],
    });
    expect(result.conversationId).toBe("winner");
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("chooses the deterministic newest exact discovery candidate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-newest-")); dirs.push(dir);
    const filePath = path.join(dir, "registry.json");
    const key = { installationKey: "https://example.test/project", platform: "mcp" as const, nativeUserKey: "alice", personaKey: "cmo" };
    const at = "2026-07-21T00:00:00.000Z";
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, records: [{ state: "provisioning", key, activeAgentName: "agent", provisioningToken: "token", createdAt: at, updatedAt: at }] }));
    const metadata = { app: "m8t", platform: "mcp", ownerKey: ownerKeyFor(key.installationKey, key.nativeUserKey), persona: "cmo", agent: "agent", provisioningToken: "token" };
    const result = await createConversationStore({ filePath }).resolve(key, "agent", {
      createConversation: async () => ({ id: "duplicate" }), validateConversation: async () => ({ kind: "valid" }),
      discoverConversations: async () => [{ id: "older", metadata, createdAt: "2026-07-20T00:00:00Z" }, { id: "z-new", metadata, createdAt: "2026-07-21T00:00:00Z" }, { id: "a-new", metadata, createdAt: "2026-07-21T00:00:00Z" }],
    });
    expect(result.conversationId).toBe("a-new");
  });

  it("does not create when recovery discovery fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-discovery-")); dirs.push(dir);
    const filePath = path.join(dir, "registry.json"); const key = { installationKey: "x", platform: "mcp" as const, nativeUserKey: "u", personaKey: "p" }; const at = new Date().toISOString();
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, records: [{ state: "provisioning", key, activeAgentName: "a", provisioningToken: "token", createdAt: at, updatedAt: at }] }));
    const createConversation = vi.fn(async () => ({ id: "duplicate" }));
    await expect(createConversationStore({ filePath }).resolve(key, "a", { createConversation, validateConversation: async () => ({ kind: "valid" }), discoverConversations: async () => { throw new Error("network"); } })).rejects.toThrow(/discovery failed/i);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("renews the live lock during slow creation and keeps a contender out", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
      const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-heartbeat-")); dirs.push(dir); const filePath = path.join(dir, "registry.json");
      const key = { installationKey: "x", platform: "mcp" as const, nativeUserKey: "u", personaKey: "p" };
      let finish!: (value: { id: string }) => void; const slow = new Promise<{ id: string }>(resolve => { finish = resolve; }); let creates = 0;
      const deps = { createConversation: async () => { creates++; return slow; }, validateConversation: async () => ({ kind: "valid" as const }), discoverConversations: async () => [] };
      // The lease file is read repeatedly below. Reading it is only safe inside a
      // waitFor: between the holder's renewals the file is briefly reopened, and a
      // contender that judges the lease expired unlinks it outright — so a bare read
      // can legitimately ENOENT at any instant.
      const readLease = async () => JSON.parse(await readFile(`${filePath}.lock`, "utf8")) as { expiresAt: string };

      const first = createConversationStore({ filePath }).resolve(key, "a", deps);
      await vi.waitFor(async () => { expect((await readLease()).expiresAt).toBeTruthy(); });

      // Wait for creation to have STARTED rather than assuming it has. Getting from
      // "lock acquired" to "createConversation called" runs through real filesystem
      // I/O (registry load, discovery), and fake timers cannot advance real I/O —
      // advanceTimersByTimeAsync only drains timers and microtasks. On a fast machine
      // that I/O happens to land inside those drains; on a loaded CI runner it does
      // not, and every later step inherits the skew. waitFor polls in real time, so
      // it is the only thing here that actually waits for the I/O.
      await vi.waitFor(() => { expect(creates).toBe(1); });

      const initialExpiry = (await readLease()).expiresAt;
      await vi.advanceTimersByTimeAsync(10_001);
      await vi.waitFor(async () => {
        expect(Date.parse((await readLease()).expiresAt)).toBeGreaterThan(Date.parse(initialExpiry));
      });

      const contender = createConversationStore({ filePath }).resolve(key, "a", deps);
      // Step in renewal-sized slices instead of one 35s jump. Each renewal is an async
      // fs write kicked off by an interval; a single large jump fires several of them
      // and can outrun their writes, letting a lease that was never abandoned read as
      // expired — at which point the contender reclaims it and the test is measuring
      // the wrong thing.
      for (let i = 0; i < 7; i++) await vi.advanceTimersByTimeAsync(5_000);

      // The real invariant: the contender never started a second creation.
      expect(creates).toBe(1);
      finish({ id: "conv_slow" });
      await expect(first).resolves.toEqual({ conversationId: "conv_slow", outcome: "created" });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(contender).resolves.toEqual({ conversationId: "conv_slow", outcome: "found" });
    } finally { vi.useRealTimers(); }
  });

  it("fails closed when a stale lock has an ownership guard left behind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir); const filePath = path.join(dir, "registry.json"); const lock = `${filePath}.lock`;
    await mkdir(dir, { recursive: true }); await writeFile(lock, JSON.stringify({ token: "old", pid: 999999, expiresAt: new Date(0).toISOString() })); await mkdir(`${lock}.reclaim`);
    await expect(createConversationStore({ filePath, sleep: async () => undefined }).resolve({ installationKey: "x", platform: "mcp", nativeUserKey: "u", personaKey: "p" }, "a", { createConversation: async () => ({ id: "c" }), validateConversation: async () => ({ kind: "valid" }) })).rejects.toThrow(/lock/i);
    expect(await readFile(lock, "utf8")).toContain("old");
    expect((await stat(`${lock}.reclaim`)).isDirectory()).toBe(true);
  });

  it("retries an active reclaim guard and eventually acquires after it clears", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir); const filePath = path.join(dir, "registry.json"); const lock = `${filePath}.lock`;
    await writeFile(lock, JSON.stringify({ token: "old", pid: 999999, expiresAt: new Date(0).toISOString() })); await mkdir(`${lock}.reclaim`);
    setTimeout(() => rm(`${lock}.reclaim`, { recursive: true, force: true }), 5);
    const result = await createConversationStore({ filePath, sleep: async () => new Promise(resolve => setTimeout(resolve, 1)) }).resolve({ installationKey: "x", platform: "mcp", nativeUserKey: "u", personaKey: "p" }, "a", { createConversation: async () => ({ id: "c" }), validateConversation: async () => ({ kind: "valid" }) });
    expect(result.outcome).toBe("created");
  });

  it("retries a lock observed before its payload is published", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir);
    const filePath = path.join(dir, "registry.json");
    const lockPath = `${filePath}.lock`;
    await writeFile(lockPath, "", { mode: 0o600 });
    let retries = 0;
    const result = await createConversationStore({
      filePath,
      sleep: async () => {
        retries++;
        if (retries === 1) {
          await writeFile(lockPath, JSON.stringify({ token: "owner", pid: 999999, expiresAt: new Date(0).toISOString() }));
          await rm(lockPath, { force: true });
        }
      },
    }).resolve({ installationKey: "x", platform: "mcp", nativeUserKey: "u", personaKey: "p" }, "a", {
      createConversation: async () => ({ id: "c" }), validateConversation: async () => ({ kind: "valid" }),
    });
    expect(result.outcome).toBe("created");
    expect(retries).toBeGreaterThan(0);
  });

  it("treats missing schema version as corrupt and rejects unknown fields and empty values", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir); const filePath = path.join(dir, "registry.json");
    const key = { installationKey: "x", platform: "mcp" as const, nativeUserKey: "u", personaKey: "p" };
    const record = { state: "ready", key, activeAgentName: "a", activeConversationId: "c", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    for (const value of [{ records: [] }, { schemaVersion: 1, records: [record], extra: true }, { schemaVersion: 1, records: [{ ...record, extra: true }] }, { schemaVersion: 1, records: [{ ...record, key: { ...key, nativeUserKey: "  " } }] }]) {
      await writeFile(filePath, JSON.stringify(value));
      await expect(createConversationStore({ filePath }).resolve(key, "a", { createConversation: async () => ({ id: "x" }), validateConversation: async () => ({ kind: "valid" }) })).rejects.toThrow(/corrupt/i);
    }
  });

  it("emits validation failure for an already broken record without mutation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "m8t-registry-")); dirs.push(dir); const filePath = path.join(dir, "registry.json"); const events: any[] = [];
    const key = { installationKey: "x", platform: "mcp" as const, nativeUserKey: "u", personaKey: "p" }; const record = { state: "broken", key, activeAgentName: "a", activeConversationId: "c", reason: "conversation_not_found", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, records: [record] }));
    await expect(createConversationStore({ filePath, observe: e => events.push(e) }).resolve(key, "a", { createConversation: async () => ({ id: "x" }), validateConversation: async () => ({ kind: "valid" }) })).rejects.toThrow(/broken/i);
    expect(events.at(-1)).toMatchObject({ kind: "validation_failed", errorCode: "conversation_not_found" });
  });
});
