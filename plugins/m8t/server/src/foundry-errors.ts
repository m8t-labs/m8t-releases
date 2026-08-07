import { APIError, NotFoundError, RateLimitError } from "openai";
import { openAIErrorStatus } from "@m8t-stack/foundry-invoke";

export class FoundryError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "FoundryError";
  }
}

export class WorkerNotFoundError extends FoundryError {
  constructor(workerName: string, body?: unknown) {
    super(
      `Worker '${workerName}' no longer exists in Foundry. ` +
        `Run the refresh_workers tool (or /m8t:workers refresh) to update the list.`,
      404,
      body,
    );
    this.name = "WorkerNotFoundError";
  }
}

export class RateLimitedError extends FoundryError {
  constructor(body?: unknown) {
    super("Rate limited by Foundry. Wait a moment and try again.", 429, body);
    this.name = "RateLimitedError";
  }
}

interface Ctx {
  workerName?: string;
}

// Translate openai-SDK errors thrown by listAgents / createConversation /
// createResponse into typed FoundryError subclasses with user-facing messages.
// Mirrors apps/web/lib/foundry.ts:mapOpenAIError but speaks the MCP server's
// vocabulary ("worker", not "agent") and points users at refresh_workers.
//
// instanceof on the openai-package classes is paired with a duck-typed
// `.status` read (openAIErrorStatus): @azure/ai-projects nests its own copy of
// `openai`, so a client obtained through the Azure SDK throws THAT copy's
// error classes — instanceof against this file's top-level `openai` import
// misses even though status/code/message are identical.
export function mapFoundryError(err: unknown, ctx: Ctx = {}): FoundryError {
  const status = openAIErrorStatus(err);
  const body = (err as { error?: unknown } | null)?.error;
  if (err instanceof NotFoundError || status === 404) {
    return new WorkerNotFoundError(ctx.workerName ?? "<unknown>", body);
  }
  if (err instanceof RateLimitError || status === 429) {
    return new RateLimitedError(body);
  }
  if (err instanceof APIError || status !== undefined) {
    return new FoundryError(
      `Foundry SDK error ${status?.toString() ?? "unknown"}: ${err instanceof Error ? err.message : String(err)}`,
      status,
      body,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new FoundryError(`Foundry call failed: ${message}`);
}
