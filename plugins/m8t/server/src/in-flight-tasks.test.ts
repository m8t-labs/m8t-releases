import { describe, it, expect } from "vitest";
import { createInFlightRegistry } from "./in-flight-tasks.js";

describe("in-flight task registry", () => {
  it("registers a promise and returns running until it resolves", async () => {
    const reg = createInFlightRegistry();
    let resolveOuter!: (v: { reply: string; conversationId: string; responseId: string }) => void;
    const p = new Promise<{ reply: string; conversationId: string; responseId: string }>(
      (res) => {
        resolveOuter = res;
      },
    );
    const taskId = reg.register(p);

    const initial = reg.peek(taskId);
    expect(initial.kind).toBe("still_running");

    resolveOuter({ reply: "done", conversationId: "c", responseId: "r" });
    await p;
    await new Promise((res) => setTimeout(res, 5));

    expect(reg.peek(taskId)).toEqual({
      kind: "completed",
      reply: "done",
      conversationId: "c",
      responseId: "r",
    });
  });

  it("reports failed for rejected promises", async () => {
    const reg = createInFlightRegistry();
    const p = Promise.reject(new Error("boom"));
    const taskId = reg.register(p);
    await p.catch(() => undefined);
    await new Promise((res) => setTimeout(res, 5));
    const state = reg.peek(taskId);
    expect(state.kind).toBe("failed");
    if (state.kind === "failed") expect(state.error).toMatch(/boom/);
  });

  it("returns 'not_found' for an unknown task id", () => {
    const reg = createInFlightRegistry();
    expect(reg.peek("nope").kind).toBe("not_found");
  });
});
