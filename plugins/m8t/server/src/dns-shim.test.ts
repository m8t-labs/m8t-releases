import { describe, it, expect, vi, afterEach } from "vitest";
import dns from "node:dns";
import { installFoundryDnsShim } from "./dns-shim.js";

afterEach(() => vi.restoreAllMocks());

describe("installFoundryDnsShim", () => {
  it("returns an address array for {all:true} on a *.services.ai.azure.com host", async () => {
    vi.spyOn(dns, "resolve4").mockImplementation(((h: string, cb: (e: null, a: string[]) => void) => { cb(null, ["1.2.3.4"]); }) as never);
    installFoundryDnsShim();
    const out = await new Promise((res) => { dns.lookup("x.services.ai.azure.com", { all: true } as never, (_e, a) => { res(a); }); });
    expect(out).toEqual([{ address: "1.2.3.4", family: 4 }]);
  });
  it("returns a single address (non-all form) for a Foundry host", async () => {
    vi.spyOn(dns, "resolve4").mockImplementation(((h: string, cb: (e: null, a: string[]) => void) => { cb(null, ["5.6.7.8"]); }) as never);
    installFoundryDnsShim();
    const fam = await new Promise((res) => { dns.lookup("y.services.ai.azure.com", (_e: unknown, addr: unknown, family: unknown) => { res({ addr, family }); }); });
    expect(fam).toEqual({ addr: "5.6.7.8", family: 4 });
  });
});
