/**
 * Map an unexpected handler error to a friendly one. A `TypeError` (e.g.
 * "Cannot read properties of undefined") is the signature of a shape mismatch —
 * almost always a stale local plugin against a newer gateway. Surface the fix
 * instead of the cryptic MCP -32603. Intentional errors (Worker not found, usage
 * errors) are plain `Error`s and pass through unchanged.
 */
export function friendlyToolError(err: unknown, serverVersion: string): unknown {
  if (err instanceof TypeError) {
    return new Error(
      `m8t plugin error (server v${serverVersion}). This usually means the local plugin is out of date — ` +
        `run \`claude plugin update\` and restart Claude Code, then retry. (underlying: ${err.message})`,
      { cause: err },
    );
  }
  return err;
}
