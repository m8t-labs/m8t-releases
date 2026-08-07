import type { WorkerRecord } from "../worker-builder.js";

export type ResolveResult =
  | { kind: "found"; worker: WorkerRecord }
  | { kind: "not-found"; closest: string[] };

export function resolveWorker(workers: WorkerRecord[], name: string): ResolveResult {
  const target = name.trim().toLowerCase();
  // `"".includes("")` is true for every name, so an empty target would
  // return every worker as a fuzzy match. Bail out before that.
  if (!target) return { kind: "not-found", closest: [] };

  const exact = workers.find((w) => w.name === target);
  if (exact) return { kind: "found", worker: exact };

  const closest = workers
    .filter((w) => w.name.includes(target) || target.includes(w.name))
    .map((w) => w.name);

  return { kind: "not-found", closest };
}
