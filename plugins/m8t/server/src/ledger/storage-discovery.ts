import { DefaultAzureCredential } from "@azure/identity";
import { defaultSubscriptionIdProvider } from "../auto-discover.js";

interface Options {
  credential?: InstanceType<typeof DefaultAzureCredential>;
  fetchFn?: typeof fetch;
  subscriptionIdProvider?: () => Promise<string | null>;
}

/**
 * Find the AgentLedger storage account by ARM tag (managedBy=m8t),
 * preferring the m8t=storage-tagged one. Mirrors auto-discover.ts's
 * token + ARM-list pattern. Returns null on any failure (caller degrades to a
 * no-op emitter — ledger is secondary to send_to_worker).
 */
export async function discoverStorageAccountName(opts: Options = {}): Promise<string | null> {
  const credential = opts.credential ?? new DefaultAzureCredential();
  const fetcher = opts.fetchFn ?? fetch;
  const subProvider = opts.subscriptionIdProvider ?? defaultSubscriptionIdProvider;

  let token: string;
  try {
    const t = await credential.getToken("https://management.azure.com/.default");
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- DefaultAzureCredential's concrete type narrows getToken to Promise<AccessToken>, but the underlying TokenCredential contract (and injected mock credentials) can resolve null at runtime.
    if (!t) return null;
    token = t.token;
  } catch {
    return null;
  }

  let subscriptionId: string | null;
  try {
    subscriptionId = await subProvider();
  } catch {
    return null;
  }
  if (!subscriptionId) return null;

  try {
    const res = await fetcher(
      `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-05-01`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      value?: { name?: string; tags?: Record<string, string> }[];
    };
    const tagged = (data.value ?? []).filter((a) => a.tags?.managedBy === "m8t");
    const chosen = tagged.find((a) => a.tags?.m8t === "storage") ?? tagged[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `tagged[0]` is typed T (noUncheckedIndexedAccess is off) but is undefined at runtime when no storage account carries the managedBy tag.
    return chosen?.name ?? null;
  } catch {
    return null;
  }
}
