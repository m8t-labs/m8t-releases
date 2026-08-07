import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "m8t-log-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes log lines to the given file", async () => {
    const logPath = path.join(tmpDir, "test.log");
    const log = createLogger({ filePath: logPath, level: "info" });
    log.info("hello");
    log.warn("careful");
    await log.flush();
    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toMatch(/INFO.*hello/);
    expect(content).toMatch(/WARN.*careful/);
  });

  it("filters out lines below the configured level", async () => {
    const logPath = path.join(tmpDir, "test.log");
    const log = createLogger({ filePath: logPath, level: "warn" });
    log.debug("debug");
    log.info("info");
    log.warn("warn");
    await log.flush();
    const content = await fs.readFile(logPath, "utf-8");
    expect(content).not.toMatch(/debug/);
    expect(content).not.toMatch(/INFO/);
    expect(content).toMatch(/WARN.*warn/);
  });
});
