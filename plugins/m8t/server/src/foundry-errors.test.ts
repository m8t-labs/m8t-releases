import { describe, it, expect } from "vitest";
import { APIError, NotFoundError, RateLimitError } from "openai";
import {
  mapFoundryError,
  FoundryError,
  WorkerNotFoundError,
  RateLimitedError,
} from "./foundry-errors.js";

// Construct openai-SDK error instances via the canonical 4-arg constructor.
// The shape (status, error-body, message, headers) is the same one the
// SDK uses internally and what we observe at runtime.
const makeNotFound = () =>
  new NotFoundError(
    404,
    { error: { message: "Agent not found", type: "not_found" } },
    "Agent not found",
    new Headers({ "x-request-id": "abc" }),
  );

const makeRateLimit = () =>
  new RateLimitError(
    429,
    { error: { message: "Rate limited" } },
    "Rate limited",
    new Headers(),
  );

const makeGenericAPIError = () =>
  new APIError(
    500,
    { error: { message: "Internal server error" } },
    "Internal server error",
    new Headers(),
  );

describe("mapFoundryError", () => {
  it("maps NotFoundError to WorkerNotFoundError with a refresh hint", () => {
    const mapped = mapFoundryError(makeNotFound(), { workerName: "carolyn" });
    expect(mapped).toBeInstanceOf(WorkerNotFoundError);
    expect(mapped.message).toContain("carolyn");
    expect(mapped.message).toContain("no longer exists in Foundry");
    expect(mapped.message).toContain("refresh_workers");
  });

  it("maps a foreign-copy-shaped 404 (no instanceof match) to WorkerNotFoundError, same as a same-copy NotFoundError", () => {
    // @azure/ai-projects nests its own copy of `openai`; a client obtained
    // through the Azure SDK throws that copy's classes, so `instanceof
    // NotFoundError` against this file's top-level import misses even though
    // status/code/message are identical.
    const foreign = Object.assign(
      new Error("404 Worker 'carolyn' not found [Request ID: abc]"),
      { status: 404, code: "not_found", type: "error" },
    );
    expect(foreign instanceof NotFoundError).toBe(false);
    const mapped = mapFoundryError(foreign, { workerName: "carolyn" });
    expect(mapped).toBeInstanceOf(WorkerNotFoundError);
    expect(mapped.message).toContain("carolyn");
    expect(mapped.message).toContain("no longer exists in Foundry");
  });

  it("maps RateLimitError to RateLimitedError", () => {
    const mapped = mapFoundryError(makeRateLimit());
    expect(mapped).toBeInstanceOf(RateLimitedError);
    expect(mapped.message).toMatch(/rate limit/i);
  });

  it("maps a foreign-copy-shaped 429 (no instanceof match) to RateLimitedError", () => {
    const foreign = Object.assign(new Error("Concurrent request limit exceeded for this API key."), { status: 429, code: "requests_limit_exceeded" });
    expect(foreign instanceof RateLimitError).toBe(false);
    const mapped = mapFoundryError(foreign);
    expect(mapped).toBeInstanceOf(RateLimitedError);
  });

  it("maps generic APIError to FoundryError preserving status", () => {
    const mapped = mapFoundryError(makeGenericAPIError());
    expect(mapped).toBeInstanceOf(FoundryError);
    expect(mapped).not.toBeInstanceOf(WorkerNotFoundError);
    expect(mapped).not.toBeInstanceOf(RateLimitedError);
    expect((mapped).status).toBe(500);
    expect(mapped.message).toContain("500");
  });

  it("maps a foreign-copy-shaped generic 5xx (no instanceof match) to FoundryError preserving status", () => {
    const foreign = Object.assign(new Error("Internal server error"), { status: 500, code: "internal_error" });
    expect(foreign instanceof APIError).toBe(false);
    const mapped = mapFoundryError(foreign);
    expect(mapped).toBeInstanceOf(FoundryError);
    expect(mapped).not.toBeInstanceOf(WorkerNotFoundError);
    expect(mapped).not.toBeInstanceOf(RateLimitedError);
    expect(mapped.status).toBe(500);
    expect(mapped.message).toContain("500");
  });

  it("wraps non-openai errors in FoundryError preserving the message", () => {
    const original = new Error("ECONNRESET");
    const mapped = mapFoundryError(original);
    expect(mapped).toBeInstanceOf(FoundryError);
    expect(mapped.message).toContain("ECONNRESET");
  });

  it("wraps non-Error throws as FoundryError stringified", () => {
    const mapped = mapFoundryError("plain string error");
    expect(mapped).toBeInstanceOf(FoundryError);
    expect(mapped.message).toContain("plain string error");
  });

  it("omits the workerName hint when no context is provided", () => {
    const mapped = mapFoundryError(makeNotFound());
    expect(mapped).toBeInstanceOf(WorkerNotFoundError);
    // Generic-not-found path falls back to the agent-name placeholder.
    expect(mapped.message).toMatch(/no longer exists in Foundry/);
  });
});
