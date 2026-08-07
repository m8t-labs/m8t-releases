import type { WorkerKind } from "@m8t-stack/foundry-invoke";

/** Hosted coders cold-start + crunch for ~10s+, so they get a longer default
 *  wait budget (env-configurable) before detaching to check_worker. Prompt
 *  agents keep the caller's budget. */
export function resolveWaitBudget(kind: WorkerKind, fallbackSeconds: number): number {
  if (kind === "hosted") {
    // Guard empty/whitespace: Number("") === 0 would silently disable the wait
    // (instant detach). Only a non-empty numeric string overrides the 60s default.
    const raw = process.env.M8T_HOSTED_WAIT_BUDGET_SECONDS?.trim();
    const env = raw ? Number(raw) : NaN;
    return Number.isFinite(env) && env >= 0 ? env : 60;
  }
  return fallbackSeconds;
}
