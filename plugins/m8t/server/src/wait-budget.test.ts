import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveWaitBudget } from "./wait-budget.js";

describe("resolveWaitBudget", () => {
  const ENV_KEY = "M8T_HOSTED_WAIT_BUDGET_SECONDS";
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env.M8T_HOSTED_WAIT_BUDGET_SECONDS;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.M8T_HOSTED_WAIT_BUDGET_SECONDS;
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  it("hosted → 60 by default (no env var)", () => {
    expect(resolveWaitBudget("hosted", 30)).toBe(60);
  });

  it("hosted → honors M8T_HOSTED_WAIT_BUDGET_SECONDS=15", () => {
    process.env[ENV_KEY] = "15";
    expect(resolveWaitBudget("hosted", 30)).toBe(15);
  });

  it("hosted → falls back to 60 when env is non-numeric", () => {
    process.env[ENV_KEY] = "bananas";
    expect(resolveWaitBudget("hosted", 30)).toBe(60);
  });

  it("hosted → honors an explicit 0 (instant detach)", () => {
    process.env[ENV_KEY] = "0";
    expect(resolveWaitBudget("hosted", 30)).toBe(0);
  });

  it("hosted → empty/whitespace env falls back to 60 (not Number(\"\")===0)", () => {
    process.env[ENV_KEY] = "  ";
    expect(resolveWaitBudget("hosted", 30)).toBe(60);
  });

  it("prompt → returns the fallback unchanged", () => {
    expect(resolveWaitBudget("prompt", 90)).toBe(90);
  });
});
