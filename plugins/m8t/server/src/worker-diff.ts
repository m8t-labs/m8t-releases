import type { WorkerRecord } from "./worker-builder.js";

export interface WorkerDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffWorkers(previous: WorkerRecord[], current: WorkerRecord[]): WorkerDiff {
  const prevMap = new Map(previous.map((w) => [w.name, w] as const));
  const currMap = new Map(current.map((w) => [w.name, w] as const));

  const added: string[] = [];
  const changed: string[] = [];
  for (const [name, w] of currMap) {
    const prior = prevMap.get(name);
    if (!prior) {
      added.push(name);
    } else if (
      prior.role !== w.role ||
      prior.description !== w.description ||
      prior.displayName !== w.displayName
    ) {
      changed.push(name);
    }
  }

  const removed: string[] = [];
  for (const name of prevMap.keys()) {
    if (!currMap.has(name)) removed.push(name);
  }

  return { added, removed, changed };
}
