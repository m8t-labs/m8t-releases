import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-cfg-"));
    delete process.env.M8T_POLL_INTERVAL_SECONDS;
    delete process.env.M8T_RESPONSE_WAIT_BUDGET_SECONDS;
    delete process.env.M8T_LOG_LEVEL;
    delete process.env.PROJECT_ENDPOINT;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it("returns defaults when nothing is configured", async () => {
    const cfg = await loadConfig({ configPath: path.join(tmpDir, "missing.yaml") });
    expect(cfg.pollIntervalSeconds).toBe(300);
    expect(cfg.responseWaitBudgetSeconds).toBe(90);
    expect(cfg.logLevel).toBe("info");
  });

  it("reads from the yaml file when present", async () => {
    const cfgPath = path.join(tmpDir, "cfg.yaml");
    await fs.writeFile(cfgPath, "pollIntervalSeconds: 60\nlogLevel: debug\n");
    const cfg = await loadConfig({ configPath: cfgPath });
    expect(cfg.pollIntervalSeconds).toBe(60);
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.responseWaitBudgetSeconds).toBe(90);
  });

  it("env vars override yaml values", async () => {
    const cfgPath = path.join(tmpDir, "cfg.yaml");
    await fs.writeFile(cfgPath, "pollIntervalSeconds: 60\n");
    process.env.M8T_POLL_INTERVAL_SECONDS = "30";
    const cfg = await loadConfig({ configPath: cfgPath });
    expect(cfg.pollIntervalSeconds).toBe(30);
  });

  // Number() silently turns "foo" / "" / "abc123" into NaN, and setInterval(_, NaN * 1000)
  // is treated by Node as 1ms — the server would hammer Foundry on every event-loop turn.
  // Guard against that here: invalid values fall back to defaults.
  it("falls back to default when M8T_POLL_INTERVAL_SECONDS is non-numeric", async () => {
    process.env.M8T_POLL_INTERVAL_SECONDS = "foo";
    const cfg = await loadConfig({ configPath: path.join(tmpDir, "missing.yaml") });
    expect(cfg.pollIntervalSeconds).toBe(300);
  });

  it("falls back to default when M8T_POLL_INTERVAL_SECONDS is empty", async () => {
    process.env.M8T_POLL_INTERVAL_SECONDS = "";
    const cfg = await loadConfig({ configPath: path.join(tmpDir, "missing.yaml") });
    expect(cfg.pollIntervalSeconds).toBe(300);
  });

  it("falls back to default when M8T_POLL_INTERVAL_SECONDS is negative", async () => {
    process.env.M8T_POLL_INTERVAL_SECONDS = "-1";
    const cfg = await loadConfig({ configPath: path.join(tmpDir, "missing.yaml") });
    expect(cfg.pollIntervalSeconds).toBe(300);
  });

  it("falls back to default when M8T_POLL_INTERVAL_SECONDS is zero", async () => {
    process.env.M8T_POLL_INTERVAL_SECONDS = "0";
    const cfg = await loadConfig({ configPath: path.join(tmpDir, "missing.yaml") });
    expect(cfg.pollIntervalSeconds).toBe(300);
  });

  it("falls back to default when M8T_POLL_INTERVAL_SECONDS has trailing garbage", async () => {
    process.env.M8T_POLL_INTERVAL_SECONDS = "abc123";
    const cfg = await loadConfig({ configPath: path.join(tmpDir, "missing.yaml") });
    expect(cfg.pollIntervalSeconds).toBe(300);
  });

  it("validates M8T_RESPONSE_WAIT_BUDGET_SECONDS the same way", async () => {
    process.env.M8T_RESPONSE_WAIT_BUDGET_SECONDS = "bogus";
    const cfg = await loadConfig({ configPath: path.join(tmpDir, "missing.yaml") });
    expect(cfg.responseWaitBudgetSeconds).toBe(90);
  });

  it("validates numeric fields loaded from yaml too", async () => {
    const cfgPath = path.join(tmpDir, "cfg.yaml");
    // Intentionally bogus values written to the user's yaml file.
    await fs.writeFile(cfgPath, "pollIntervalSeconds: -5\nresponseWaitBudgetSeconds: 0\n");
    const cfg = await loadConfig({ configPath: cfgPath });
    expect(cfg.pollIntervalSeconds).toBe(300);
    expect(cfg.responseWaitBudgetSeconds).toBe(90);
  });
});
