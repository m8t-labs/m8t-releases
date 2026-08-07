import { describe, it, expect } from "vitest";
import { friendlyToolError } from "./tool-errors.js";

describe("friendlyToolError", () => {
  it("wraps a TypeError with a stale-plugin hint naming the version", () => {
    const out = friendlyToolError(new TypeError("Cannot read properties of undefined (reading 'toLowerCase')"), "0.1.18");
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/0\.1\.18/);
    expect((out as Error).message).toMatch(/claude plugin update/);
    expect((out as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError);
  });
  it("passes a normal Error through unchanged", () => {
    const original = new Error("Worker 'x' not found.");
    expect(friendlyToolError(original, "0.1.18")).toBe(original);
  });
  it("passes a non-Error value through unchanged", () => {
    expect(friendlyToolError("boom", "0.1.18")).toBe("boom");
  });
});
