import dns from "node:dns";

let installed = false;

/** Route *.services.ai.azure.com lookups through dns.resolve4 (c-ares), which
 *  follows the 6-hop CNAME that macOS getaddrinfo can't. Idempotent. Handles
 *  undici's {all:true} form (must return an address array) and the 2-arg
 *  (hostname, callback) form. Falls back to the original lookup otherwise. */
export function installFoundryDnsShim(): void {
  if (installed) return;
  installed = true;
  const origLookup = dns.lookup.bind(dns);
  // @ts-expect-error overriding the overloaded lookup signature
  dns.lookup = (hostname: string, options: unknown, cb: unknown) => {
    const opts = (typeof options === "function" ? {} : options) as { all?: boolean };
    const callback = (typeof options === "function" ? options : cb) as (
      err: NodeJS.ErrnoException | null, addr: unknown, fam?: number,
    ) => void;
    if (typeof hostname === "string" && hostname.endsWith("services.ai.azure.com")) {
      dns.resolve4(hostname, (err, addrs) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Node types `addrs` as string[], but on error the c-ares callback passes it undefined; the guard protects the .length access.
        if (err || !addrs?.length) { origLookup(hostname, options as never, cb as never); return; }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `opts` is cast from `unknown` options; a caller passing `lookup(host, undefined, cb)` leaves it undefined despite the cast asserting an object.
        if (opts?.all) callback(null, addrs.map((a) => ({ address: a, family: 4 })));
        else callback(null, addrs[0], 4);
      });
      return;
    }
    origLookup(hostname, options as never, cb as never);
  };
}
