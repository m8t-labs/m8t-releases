import { randomUUID } from "node:crypto";
import type { LocalArtifact } from "./artifact-store.js";

interface ResponseResult { reply: string; conversationId: string; responseId: string; files?: LocalArtifact[] }

type State =
  | { kind: "still_running"; startedAt: number }
  | { kind: "completed"; reply: string; conversationId: string; responseId: string; files?: LocalArtifact[] }
  | { kind: "failed"; error: string };

export type PeekResult =
  | { kind: "still_running"; elapsedMs?: number }
  | { kind: "completed"; reply: string; conversationId: string; responseId: string; files?: LocalArtifact[] }
  | { kind: "failed"; error: string }
  | { kind: "not_found" };

export interface InFlightRegistry {
  register: (p: Promise<ResponseResult>) => string;
  peek: (taskId: string) => PeekResult;
}

export function createInFlightRegistry(): InFlightRegistry {
  const tasks = new Map<string, State>();

  return {
    register: (p) => {
      const id = randomUUID();
      tasks.set(id, { kind: "still_running", startedAt: Date.now() });
      p.then(
        (r) => tasks.set(id, { kind: "completed", ...r }),
        (e: unknown) =>
          tasks.set(id, {
            kind: "failed",
            error: e instanceof Error ? e.message : String(e),
          }),
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
    },
  };
}
