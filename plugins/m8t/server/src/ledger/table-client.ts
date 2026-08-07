import { TableClient } from "@azure/data-tables";
import type { DefaultAzureCredential } from "@azure/identity";

export function createLedgerTableClient(
  accountName: string,
  credential: InstanceType<typeof DefaultAzureCredential>,
): TableClient {
  return new TableClient(
    `https://${accountName}.table.core.windows.net`,
    "AgentLedger",
    credential,
  );
}

/** Create the AgentLedger table if absent (the MCP may run before the webapp). */
export async function ensureLedgerTable(client: TableClient): Promise<void> {
  try {
    await client.createTable();
  } catch (e) {
    if (!isTableAlreadyExists(e)) throw e;
  }
}

function isTableAlreadyExists(e: unknown): boolean {
  // `e` is a caught value (genuinely unknown): the cast asserts an object shape,
  // but at runtime it may be null/undefined or a non-object, so the optional
  // chains below are load-bearing despite the cast.
  const anyE = e as { statusCode?: number; code?: string; details?: { errorCode?: string } };
  return (
    /* eslint-disable @typescript-eslint/no-unnecessary-condition -- see note above: `anyE` may be null/non-object at runtime. */
    anyE?.statusCode === 409 &&
    (anyE?.code === "TableAlreadyExists" || anyE?.details?.errorCode === "TableAlreadyExists")
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  );
}
