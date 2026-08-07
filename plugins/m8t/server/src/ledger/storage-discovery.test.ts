import { describe, it, expect, vi } from "vitest";
import { discoverStorageAccountName } from "./storage-discovery.js";

function fakeCredential() {
  return { getToken: vi.fn().mockResolvedValue({ token: "t" }) } as never;
}

describe("discoverStorageAccountName", () => {
  it("returns the m8t=storage-tagged account", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        value: [
          { name: "unrelated", tags: {} },
          { name: "m8tstoreabc", tags: { managedBy: "m8t", "m8t": "storage" } },
        ],
      }),
    });
    const name = await discoverStorageAccountName({
      credential: fakeCredential(),
      fetchFn: fetchFn as never,
      subscriptionIdProvider: async () => "sub-1",
    });
    expect(name).toBe("m8tstoreabc");
  });

  it("returns null when no m8t account is tagged", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: [{ name: "x", tags: {} }] }),
    });
    const name = await discoverStorageAccountName({
      credential: fakeCredential(),
      fetchFn: fetchFn as never,
      subscriptionIdProvider: async () => "sub-1",
    });
    expect(name).toBeNull();
  });

  it("returns null when not logged in", async () => {
    const credential = { getToken: vi.fn().mockResolvedValue(null) } as never;
    const name = await discoverStorageAccountName({
      credential,
      fetchFn: vi.fn() as never,
      subscriptionIdProvider: async () => "sub-1",
    });
    expect(name).toBeNull();
  });

  it("returns null when ARM responds non-2xx", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    });
    const name = await discoverStorageAccountName({
      credential: fakeCredential(),
      fetchFn: fetchFn as never,
      subscriptionIdProvider: async () => "sub-1",
    });
    expect(name).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const name = await discoverStorageAccountName({
      credential: fakeCredential(),
      fetchFn: fetchFn as never,
      subscriptionIdProvider: async () => "sub-1",
    });
    expect(name).toBeNull();
  });
});
