import { describe, it, expect, vi } from "vitest";
import { createLazyInit } from "./lazy-init.js";

describe("createLazyInit", () => {
  it("calls the init function once and caches success", async () => {
    const initFn = vi.fn(async () => "result");
    const lazy = createLazyInit(initFn);

    expect(await lazy()).toBe("result");
    expect(await lazy()).toBe("result");
    expect(await lazy()).toBe("result");
    expect(initFn).toHaveBeenCalledTimes(1);
  });

  it("clears the cache on rejection so the next call retries", async () => {
    let attempt = 0;
    const initFn = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("first call fails");
      return "second call wins";
    });
    const lazy = createLazyInit(initFn);

    await expect(lazy()).rejects.toThrow("first call fails");
    expect(initFn).toHaveBeenCalledTimes(1);

    // The cache should have cleared — next call retries.
    expect(await lazy()).toBe("second call wins");
    expect(initFn).toHaveBeenCalledTimes(2);

    // And subsequent calls now cache the successful result.
    expect(await lazy()).toBe("second call wins");
    expect(initFn).toHaveBeenCalledTimes(2);
  });

  it("does not race-overwrite the cache when two callers hit a failing init in parallel", async () => {
    let attempts = 0;
    const initFn = vi.fn(async () => {
      attempts++;
      if (attempts <= 2) throw new Error(`attempt ${attempts.toString()} fails`);
      return "third call wins";
    });
    const lazy = createLazyInit(initFn);

    // Two parallel callers see the SAME first-attempt rejection (cache de-dupes
    // in-flight calls). Both reject; cache then clears.
    const [r1, r2] = await Promise.allSettled([lazy(), lazy()]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    expect(initFn).toHaveBeenCalledTimes(1);

    // Next call retries.
    await expect(lazy()).rejects.toThrow("attempt 2 fails");
    expect(initFn).toHaveBeenCalledTimes(2);

    // And finally succeeds.
    expect(await lazy()).toBe("third call wins");
    expect(initFn).toHaveBeenCalledTimes(3);
  });
});
