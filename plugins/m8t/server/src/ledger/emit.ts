import { createLedgerEmitter, type LedgerEvent } from "@m8t-stack/agent-ledger";
import type { TableClient } from "@azure/data-tables";
import type { Logger } from "../logger.js";
import { ensureLedgerTable } from "./table-client.js";

/**
 * The MCP's emitLedgerEvent. Table-only (no App Insights mirror — keeps stdout
 * clean for the stdio protocol; errors go to the file logger). Ensures the
 * table exists once before the first write. Fire-and-forget.
 */
export function createMcpLedgerEmitter(
  client: TableClient,
  logger: Logger,
): (e: LedgerEvent) => Promise<void> {
  let ensured: Promise<void> | null = null;
  const ensureOnce = (): Promise<void> => (ensured ??= ensureLedgerTable(client));

  return createLedgerEmitter({
    writeEntity: async (entity) => {
      await ensureOnce();
      await client.upsertEntity(
        entity as Parameters<TableClient["upsertEntity"]>[0],
        "Replace",
      );
    },
    onError: (msg, err) =>
      { logger.warn(msg, { error: err instanceof Error ? err.message : String(err) }); },
  });
}
