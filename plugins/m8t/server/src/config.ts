import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  pollIntervalSeconds: number;
  responseWaitBudgetSeconds: number;
  logLevel: LogLevel;
  projectEndpointOverride: string | null;
}

const DEFAULTS: Config = {
  pollIntervalSeconds: 300,
  responseWaitBudgetSeconds: 90,
  logLevel: "info",
  projectEndpointOverride: null,
};

// `Number("foo")` returns NaN; `setInterval(_, NaN * 1000)` is treated by Node
// as 1 ms — the server would hammer Foundry. Treat anything that isn't a
// finite positive number as "use the default".
const parseIntPositive = (val: unknown): number | null => {
  if (val === undefined || val === null || val === "") return null;
  const n = typeof val === "number" ? val : Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function loadConfig(opts: { configPath?: string } = {}): Promise<Config> {
  const fp = opts.configPath ?? path.join(os.homedir(), ".m8t", "m8t.yaml");
  let fileCfg: Partial<Config> = {};
  try {
    const raw = await fs.readFile(fp, "utf-8");
    const parsed = parseYaml(raw) as Partial<Config> | null;
    if (parsed) fileCfg = parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const cfg: Config = { ...DEFAULTS };

  const filePoll = parseIntPositive(fileCfg.pollIntervalSeconds);
  if (filePoll !== null) cfg.pollIntervalSeconds = filePoll;

  const fileBudget = parseIntPositive(fileCfg.responseWaitBudgetSeconds);
  if (fileBudget !== null) cfg.responseWaitBudgetSeconds = fileBudget;

  if (fileCfg.logLevel) cfg.logLevel = fileCfg.logLevel;
  if (fileCfg.projectEndpointOverride) cfg.projectEndpointOverride = fileCfg.projectEndpointOverride;

  const envPoll = parseIntPositive(process.env.M8T_POLL_INTERVAL_SECONDS);
  if (envPoll !== null) cfg.pollIntervalSeconds = envPoll;

  const envBudget = parseIntPositive(process.env.M8T_RESPONSE_WAIT_BUDGET_SECONDS);
  if (envBudget !== null) cfg.responseWaitBudgetSeconds = envBudget;

  if (process.env.M8T_LOG_LEVEL) {
    cfg.logLevel = process.env.M8T_LOG_LEVEL as LogLevel;
  }
  if (process.env.PROJECT_ENDPOINT) {
    cfg.projectEndpointOverride = process.env.PROJECT_ENDPOINT;
  }

  return cfg;
}
