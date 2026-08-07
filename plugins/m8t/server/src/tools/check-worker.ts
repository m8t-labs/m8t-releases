import type { InFlightRegistry } from "../in-flight-tasks.js";
import type { LocalArtifact } from "../artifact-store.js";

export type CheckResult =
  | { kind: "still_running"; elapsedMs?: number }
  | { kind: "completed"; reply: string; conversationId: string; responseId: string; files?: LocalArtifact[] }
  | { kind: "failed"; error: string };

interface Args {
  registry: InFlightRegistry;
  taskId: string;
}

export function handleCheckWorker(args: Args): CheckResult {
  const peek = args.registry.peek(args.taskId);
  if (peek.kind === "not_found") {
    return { kind: "failed", error: `Unknown task id: ${args.taskId}` };
  }
  return peek;
}
