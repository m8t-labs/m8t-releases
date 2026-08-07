import { describe, it, expect } from "vitest";
import { handleCheckWorker } from "./check-worker.js";
import { createInFlightRegistry } from "../in-flight-tasks.js";

describe("handleCheckWorker", () => {
  it("returns still_running for an unresolved task", () => {
    const registry = createInFlightRegistry();
    const taskId = registry.register(new Promise(() => {}));
    const result = handleCheckWorker({ registry, taskId });
    expect(result.kind).toBe("still_running");
  });

  it("returns completed for a resolved task", async () => {
    const registry = createInFlightRegistry();
    const taskId = registry.register(
      Promise.resolve({
        reply: "done",
        conversationId: "c",
        responseId: "r",
      }),
    );
    await new Promise((res) => setTimeout(res, 5));
    const result = handleCheckWorker({ registry, taskId });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") expect(result.reply).toBe("done");
  });

  it("returns failed for a rejected task", async () => {
    const registry = createInFlightRegistry();
    const taskId = registry.register(Promise.reject(new Error("boom")));
    await new Promise((res) => setTimeout(res, 5));
    const result = handleCheckWorker({ registry, taskId });
    expect(result.kind).toBe("failed");
  });

  it("returns a clear error for an unknown task id", () => {
    const result = handleCheckWorker({ registry: createInFlightRegistry(), taskId: "nope" });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toMatch(/unknown task/i);
  });

  it("passes files through to the completed result", async () => {
    const registry = createInFlightRegistry();
    const files = [{ name: "chart.png", localPath: "/tmp/chart.png", mime: "image/png", size: 42 }];
    const taskId = registry.register(
      Promise.resolve({
        reply: "done",
        conversationId: "c",
        responseId: "r",
        files,
      }),
    );
    await new Promise((res) => setTimeout(res, 5));
    const result = handleCheckWorker({ registry, taskId });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.files).toEqual(files);
    }
  });
});
