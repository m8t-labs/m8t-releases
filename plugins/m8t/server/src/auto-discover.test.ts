import { describe, it, expect, vi } from "vitest";
import { autoDiscoverProjectEndpoint } from "./auto-discover.js";

const SUB_ID = "11111111-1111-1111-1111-111111111111";

function fakeCredential(token: string | null = "fake-token") {
  return {
    getToken: vi.fn(async () => (token ? { token, expiresOnTimestamp: Date.now() + 3600_000 } : null)),
  } as never;
}

function fakeFetch(routes: Record<string, { ok: boolean; status?: number; body?: unknown }>) {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [pattern, response] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return {
          ok: response.ok,
          status: response.status ?? (response.ok ? 200 : 500),
          json: async () => response.body ?? {},
        } as unknown as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
}

describe("autoDiscoverProjectEndpoint", () => {
  it("returns no-login when token acquisition fails", async () => {
    const result = await autoDiscoverProjectEndpoint({
      credential: fakeCredential(null),
      fetchFn: fakeFetch({}),
      subscriptionIdProvider: async () => SUB_ID,
    });
    expect(result.kind).toBe("no-login");
  });

  it("returns no-accounts when there are no AIServices accounts", async () => {
    const result = await autoDiscoverProjectEndpoint({
      credential: fakeCredential(),
      fetchFn: fakeFetch({
        "/providers/Microsoft.CognitiveServices/accounts?api-version": {
          ok: true,
          body: { value: [{ id: "/subscriptions/x/resourceGroups/rg/providers/y", name: "vision-1", kind: "ComputerVision" }] },
        },
      }),
      subscriptionIdProvider: async () => SUB_ID,
    });
    expect(result.kind).toBe("no-accounts");
  });

  it("returns found when exactly one project matches", async () => {
    const accountId = `/subscriptions/${SUB_ID}/resourceGroups/my-rg/providers/Microsoft.CognitiveServices/accounts/my-foundry`;
    const result = await autoDiscoverProjectEndpoint({
      credential: fakeCredential(),
      fetchFn: fakeFetch({
        "/providers/Microsoft.CognitiveServices/accounts?api-version": {
          ok: true,
          body: { value: [{ id: accountId, name: "my-foundry", kind: "AIServices" }] },
        },
        "/accounts/my-foundry/projects?api-version": {
          ok: true,
          body: {
            value: [
              {
                name: "my-project",
                properties: {
                  endpoints: { "AI Foundry API": "https://my-foundry.services.ai.azure.com/api/projects/my-project" },
                },
              },
            ],
          },
        },
      }),
      subscriptionIdProvider: async () => SUB_ID,
    });
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.endpoint).toBe("https://my-foundry.services.ai.azure.com/api/projects/my-project");
    }
  });

  it("returns ambiguous when multiple projects exist", async () => {
    const accountId = `/subscriptions/${SUB_ID}/resourceGroups/my-rg/providers/Microsoft.CognitiveServices/accounts/my-foundry`;
    const result = await autoDiscoverProjectEndpoint({
      credential: fakeCredential(),
      fetchFn: fakeFetch({
        "/providers/Microsoft.CognitiveServices/accounts?api-version": {
          ok: true,
          body: { value: [{ id: accountId, name: "my-foundry", kind: "AIServices" }] },
        },
        "/accounts/my-foundry/projects?api-version": {
          ok: true,
          body: {
            value: [
              {
                name: "proj-a",
                properties: { endpoints: { "AI Foundry API": "https://my-foundry.services.ai.azure.com/api/projects/proj-a" } },
              },
              {
                name: "proj-b",
                properties: { endpoints: { "AI Foundry API": "https://my-foundry.services.ai.azure.com/api/projects/proj-b" } },
              },
            ],
          },
        },
      }),
      subscriptionIdProvider: async () => SUB_ID,
    });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0].projectName).toBe("proj-a");
      expect(result.candidates[1].projectName).toBe("proj-b");
    }
  });

  it("returns error when ARM call fails", async () => {
    const result = await autoDiscoverProjectEndpoint({
      credential: fakeCredential(),
      fetchFn: fakeFetch({
        "/providers/Microsoft.CognitiveServices/accounts?api-version": {
          ok: false,
          status: 403,
          body: { error: "Forbidden" },
        },
      }),
      subscriptionIdProvider: async () => SUB_ID,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/403/);
  });

  it("returns error when subscription cannot be resolved", async () => {
    const result = await autoDiscoverProjectEndpoint({
      credential: fakeCredential(),
      fetchFn: fakeFetch({}),
      subscriptionIdProvider: async () => null,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/subscription/i);
  });

  it("calls onWarn when a per-account project listing throws", async () => {
    const accountId = `/subscriptions/${SUB_ID}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/broken`;
    const goodId = `/subscriptions/${SUB_ID}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/good`;
    const onWarn = vi.fn();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/providers/Microsoft.CognitiveServices/accounts?api-version")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              { id: accountId, name: "broken", kind: "AIServices" },
              { id: goodId, name: "good", kind: "AIServices" },
            ],
          }),
        } as unknown as Response;
      }
      if (url.includes("/accounts/broken/projects?api-version")) {
        throw new Error("ECONNRESET");
      }
      if (url.includes("/accounts/good/projects?api-version")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                name: "g-proj",
                properties: { endpoints: { "AI Foundry API": "https://good.services.ai.azure.com/api/projects/g-proj" } },
              },
            ],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    const result = await autoDiscoverProjectEndpoint({
      credential: fakeCredential(),
      fetchFn,
      subscriptionIdProvider: async () => SUB_ID,
      onWarn,
    });
    expect(result.kind).toBe("found");
    expect(onWarn).toHaveBeenCalled();
    const warnMsg = onWarn.mock.calls[0][0] as string;
    expect(warnMsg).toContain("broken");
    expect(warnMsg).toContain("ECONNRESET");
  });

  it("calls onWarn when a per-account project listing returns non-ok", async () => {
    const accountId = `/subscriptions/${SUB_ID}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/forbidden`;
    const onWarn = vi.fn();
    const result = await autoDiscoverProjectEndpoint({
      credential: fakeCredential(),
      fetchFn: fakeFetch({
        "/providers/Microsoft.CognitiveServices/accounts?api-version": {
          ok: true,
          body: { value: [{ id: accountId, name: "forbidden", kind: "AIServices" }] },
        },
        "/accounts/forbidden/projects?api-version": {
          ok: false,
          status: 403,
          body: { error: "Forbidden" },
        },
      }),
      subscriptionIdProvider: async () => SUB_ID,
      onWarn,
    });
    expect(result.kind).toBe("no-accounts");
    expect(onWarn).toHaveBeenCalled();
    const warnMsg = onWarn.mock.calls[0][0] as string;
    expect(warnMsg).toContain("forbidden");
    expect(warnMsg).toContain("403");
  });
});
