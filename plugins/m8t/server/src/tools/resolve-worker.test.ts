import { describe, it, expect } from "vitest";
import { resolveWorker } from "./resolve-worker.js";
import type { WorkerRecord } from "../worker-builder.js";

const sample: WorkerRecord[] = [
  {
    name: "carolyn",
    displayName: "Carolyn",
    role: "CMO",
    description: "CMO",
    persona: "cmo",
    personaVersion: "0.2",
    agentId: "1",
    projectEndpoint: "x",
    model: "gpt-4.1-mini",
    deployedAt: null,
    kind: "prompt",
  },
  {
    name: "carry",
    displayName: "Carry",
    role: "PA",
    description: "PA",
    persona: "pa",
    personaVersion: "0.1",
    agentId: "2",
    projectEndpoint: "x",
    model: "gpt-4.1-mini",
    deployedAt: null,
    kind: "prompt",
  },
];

describe("resolveWorker", () => {
  it("returns the exact match (case insensitive)", () => {
    const r = resolveWorker(sample, "Carolyn");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.worker.name).toBe("carolyn");
  });

  it("returns 'not-found' with closest matches when no exact hit", () => {
    const r = resolveWorker(sample, "carol");
    expect(r.kind).toBe("not-found");
    if (r.kind === "not-found") expect(r.closest).toContain("carolyn");
  });

  it("returns 'not-found' with empty closest list when nothing remotely matches", () => {
    const r = resolveWorker(sample, "zzz");
    expect(r.kind).toBe("not-found");
  });

  it("returns 'not-found' with empty closest for an empty target (no false matches)", () => {
    // With `target = ""`, every worker name `.includes("")` returns true,
    // so the closest list would otherwise contain every worker — noise that
    // implies a fuzzy match where the caller passed nothing at all.
    const r = resolveWorker(sample, "");
    expect(r.kind).toBe("not-found");
    if (r.kind === "not-found") expect(r.closest).toEqual([]);
  });

  it("returns 'not-found' with empty closest for whitespace-only target", () => {
    const r = resolveWorker(sample, "   ");
    expect(r.kind).toBe("not-found");
    if (r.kind === "not-found") expect(r.closest).toEqual([]);
  });
});
