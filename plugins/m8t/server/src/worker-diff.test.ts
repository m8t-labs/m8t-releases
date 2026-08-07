import { describe, it, expect } from "vitest";
import { diffWorkers } from "./worker-diff.js";
import type { WorkerRecord } from "./worker-builder.js";

const base = (overrides: Partial<WorkerRecord> = {}): WorkerRecord => ({
  name: "a",
  displayName: "A",
  role: "X",
  description: "x",
  persona: null,
  personaVersion: null,
  agentId: "id-a",
  projectEndpoint: "x",
  model: "m",
  deployedAt: null,
  kind: "prompt",
  ...overrides,
});

describe("diffWorkers", () => {
  it("reports additions", () => {
    const diff = diffWorkers([], [base()]);
    expect(diff.added).toEqual(["a"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("reports removals", () => {
    const diff = diffWorkers([base()], []);
    expect(diff.removed).toEqual(["a"]);
  });

  it("reports changes when description or role differ", () => {
    const diff = diffWorkers([base({ role: "OLD" })], [base({ role: "NEW" })]);
    expect(diff.changed).toEqual(["a"]);
  });

  it("reports no changes for byte-identical workers", () => {
    const w = base();
    const diff = diffWorkers([w], [w]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});
