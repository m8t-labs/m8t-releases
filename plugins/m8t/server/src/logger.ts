import fs from "node:fs/promises";
import path from "node:path";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

export interface Logger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
}

interface Args {
  filePath: string;
  level: Level;
}

export function createLogger(args: Args): Logger {
  const levelIndex = LEVELS.indexOf(args.level);
  let queue: string[] = [];
  let flushing: Promise<void> = Promise.resolve();

  const write = (lvl: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS.indexOf(lvl) < levelIndex) return;
    const ts = new Date().toISOString();
    const metaStr = meta ? " " + JSON.stringify(meta) : "";
    queue.push(`${ts} ${lvl.toUpperCase()} ${msg}${metaStr}`);
  };

  const flush = async () => {
    if (queue.length === 0) return;
    const batch = queue.join("\n") + "\n";
    queue = [];
    await fs.mkdir(path.dirname(args.filePath), { recursive: true });
    await fs.appendFile(args.filePath, batch, "utf-8");
  };

  const enqueueFlush = () => {
    flushing = flushing.then(flush);
  };

  return {
    debug: (m, x) => { write("debug", m, x); enqueueFlush(); },
    info:  (m, x) => { write("info",  m, x); enqueueFlush(); },
    warn:  (m, x) => { write("warn",  m, x); enqueueFlush(); },
    error: (m, x) => { write("error", m, x); enqueueFlush(); },
    flush: async () => { enqueueFlush(); await flushing; },
  };
}
