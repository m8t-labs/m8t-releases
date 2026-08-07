import { describe, it, expect, vi } from "vitest";
import { createPoller } from "./poller.js";

describe("createPoller", () => {
  it("fires the callback at the configured interval", async () => {
    const fetcher = vi.fn(async () => [{ name: "a" }]);
    const onUpdate = vi.fn();
    const poller = createPoller({ intervalMs: 20, fetcher, onUpdate });
    poller.start();
    await new Promise((res) => setTimeout(res, 70));
    poller.stop();
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onUpdate).toHaveBeenCalled();
  });

  it("does not crash if fetcher throws (silent failure)", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("net");
    });
    const onUpdate = vi.fn();
    const poller = createPoller({ intervalMs: 10, fetcher, onUpdate });
    poller.start();
    await new Promise((res) => setTimeout(res, 30));
    poller.stop();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("runOnce swallows fetcher errors and routes them to onError", async () => {
    const err = new Error("auth expired");
    const fetcher = vi.fn(async () => {
      throw err;
    });
    const onError = vi.fn();
    const poller = createPoller({ intervalMs: 9999, fetcher, onUpdate: () => {}, onError });
    await expect(poller.runOnce()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("runOnceOrThrow re-throws fetcher errors", async () => {
    const err = new Error("auth expired");
    const fetcher = vi.fn(async () => {
      throw err;
    });
    const onError = vi.fn();
    const poller = createPoller({ intervalMs: 9999, fetcher, onUpdate: () => {}, onError });
    await expect(poller.runOnceOrThrow()).rejects.toThrow("auth expired");
    expect(onError).not.toHaveBeenCalled();
  });

  it("runOnceOrThrow calls onUpdate on success", async () => {
    const fetcher = vi.fn(async () => ["w1"]);
    const onUpdate = vi.fn();
    const poller = createPoller({ intervalMs: 9999, fetcher, onUpdate });
    await poller.runOnceOrThrow();
    expect(onUpdate).toHaveBeenCalledWith(["w1"]);
  });
});
