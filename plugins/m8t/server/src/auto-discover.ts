import { DefaultAzureCredential } from "@azure/identity";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface DiscoveryCandidate {
  endpoint: string;
  resourceName: string;
  projectName: string;
}

export type DiscoveryResult =
  | { kind: "found"; endpoint: string }
  | { kind: "ambiguous"; candidates: DiscoveryCandidate[] }
  | { kind: "no-accounts" }
  | { kind: "no-login" }
  | { kind: "error"; message: string };

interface Options {
  credential?: InstanceType<typeof DefaultAzureCredential>;
  fetchFn?: typeof fetch;
  subscriptionIdProvider?: () => Promise<string | null>;
  // Called once per AIServices account when its inner projects.list ARM call
  // either throws or returns a non-2xx response. Lets the caller surface
  // partial-failure signal (e.g. one good account + one 403'd account) instead
  // of having that account silently dropped.
  onWarn?: (message: string) => void;
}

export async function defaultSubscriptionIdProvider(): Promise<string | null> {
  if (process.env.AZURE_SUBSCRIPTION_ID) return process.env.AZURE_SUBSCRIPTION_ID;
  try {
    const { stdout } = await execAsync("az account show --query id -o tsv");
    const id = stdout.trim();
    return id || null;
  } catch {
    return null;
  }
}

export async function autoDiscoverProjectEndpoint(opts: Options = {}): Promise<DiscoveryResult> {
  const credential = opts.credential ?? new DefaultAzureCredential();
  const fetcher = opts.fetchFn ?? fetch;
  const subProvider = opts.subscriptionIdProvider ?? defaultSubscriptionIdProvider;

  let token: string;
  try {
    const tokenResp = await credential.getToken("https://management.azure.com/.default");
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- DefaultAzureCredential's concrete type narrows getToken to Promise<AccessToken>, but the underlying TokenCredential contract (and injected mock credentials) can resolve null at runtime.
    if (!tokenResp) return { kind: "no-login" };
    token = tokenResp.token;
  } catch {
    return { kind: "no-login" };
  }

  const subscriptionId = await subProvider();
  if (!subscriptionId) {
    return {
      kind: "error",
      message:
        "Could not determine your Azure subscription. Set AZURE_SUBSCRIPTION_ID or run `az login`.",
    };
  }

  const candidates: DiscoveryCandidate[] = [];
  const authHeaders = { Authorization: `Bearer ${token}` };

  let accountsData: { value?: { id?: string; name?: string; kind?: string }[] } = {};
  try {
    const res = await fetcher(
      `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=2024-10-01`,
      { headers: authHeaders },
    );
    if (!res.ok) {
      return {
        kind: "error",
        message: `ARM accounts.list failed with HTTP ${res.status.toString()}. Check subscription access.`,
      };
    }
    accountsData = (await res.json()) as typeof accountsData;
  } catch (err) {
    return {
      kind: "error",
      message: `Network error listing Cognitive Services accounts: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  for (const account of accountsData.value ?? []) {
    if (account.kind !== "AIServices") continue;
    if (!account.id || !account.name) continue;

    const rgMatch = /\/resourceGroups\/([^/]+)\//i.exec(account.id);
    if (!rgMatch) continue;
    const resourceGroup = rgMatch[1];

    try {
      const res = await fetcher(
        `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${account.name}/projects?api-version=2025-04-01-preview`,
        { headers: authHeaders },
      );
      if (!res.ok) {
        opts.onWarn?.(
          `auto-discover: listing projects under AIServices account '${account.name}' failed with HTTP ${res.status.toString()}; skipping.`,
        );
        continue;
      }
      const projectsData = (await res.json()) as {
        value?: {
          name?: string;
          properties?: { endpoints?: Record<string, string> };
        }[];
      };

      for (const project of projectsData.value ?? []) {
        const endpoint = project.properties?.endpoints?.["AI Foundry API"];
        if (endpoint && project.name) {
          candidates.push({
            endpoint,
            resourceName: account.name,
            projectName: project.name,
          });
        }
      }
    } catch (err: unknown) {
      // Skip this account on transient errors; the others might still resolve.
      // Surface the signal so the caller (server logger) can record it.
      const message = err instanceof Error ? err.message : String(err);
      opts.onWarn?.(
        `auto-discover: listing projects under AIServices account '${account.name}' threw (${message}); skipping.`,
      );
    }
  }

  if (candidates.length === 0) return { kind: "no-accounts" };
  if (candidates.length === 1) return { kind: "found", endpoint: candidates[0].endpoint };
  return { kind: "ambiguous", candidates };
}
