import { describe, it, expect, vi } from "vitest";
import { createMcpLedgerEmitter } from "./emit.js";

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() } as never;
}

describe("createMcpLedgerEmitter", () => {
  it("ensures the table once, then upserts (Replace)", async () => {
    const createTable = vi.fn().mockResolvedValue(undefined);
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const client = { createTable, upsertEntity } as never;
    const emit = createMcpLedgerEmitter(client, fakeLogger());

    await emit({ eventId: "r1", timestamp: "2026-05-22T12:00:00.000Z", agentName: "CMO", source: "mcp", outcome: "ok", responseId: "resp_1" });
    await emit({ eventId: "r2", timestamp: "2026-05-22T12:01:00.000Z", agentName: "CMO", source: "mcp", outcome: "ok", responseId: "resp_2" });

    expect(createTable).toHaveBeenCalledOnce(); // ensured once, cached
    expect(upsertEntity).toHaveBeenCalledTimes(2);
    expect(upsertEntity.mock.calls[0][1]).toBe("Replace");
  });

  it("never throws when upsert fails (routes to logger.warn)", async () => {
    const logger = fakeLogger();
    const client = {
      createTable: vi.fn().mockResolvedValue(undefined),
      upsertEntity: vi.fn().mockRejectedValue(new Error("boom")),
    } as never;
    const emit = createMcpLedgerEmitter(client, logger);
    await expect(
      emit({ eventId: "r1", timestamp: "2026-05-22T12:00:00.000Z", agentName: "CMO", source: "mcp", outcome: "ok" }),
    ).resolves.toBeUndefined();
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });
});
