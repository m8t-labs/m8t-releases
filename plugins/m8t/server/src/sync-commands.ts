import fs from "node:fs/promises";
import path from "node:path";
import type { WorkerRecord } from "./worker-builder.js";
import { renderCommandFile, parseExistingMagicKey } from "./command-renderer.js";
import { diffWorkers } from "./worker-diff.js";

export interface SyncReport {
  added: string[];
  removed: string[];
  changed: string[];
  collisions: string[];
}

interface Args {
  commandsDir: string;
  previous: WorkerRecord[];
  current: WorkerRecord[];
}

export async function syncCommandsToFs(args: Args): Promise<SyncReport> {
  await fs.mkdir(args.commandsDir, { recursive: true });
  const diff = diffWorkers(args.previous, args.current);
  const report: SyncReport = { added: [], removed: [], changed: [], collisions: [] };

  const workersByName = new Map(args.current.map((w) => [w.name, w]));

  for (const name of [...diff.added, ...diff.changed]) {
    const worker = workersByName.get(name);
    if (!worker) continue;
    const target = path.join(args.commandsDir, `${name}.md`);
    const ours = await parseExistingMagicKey(target);
    if (!ours) {
      try {
        await fs.access(target);
        report.collisions.push(name);
        continue;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    await renderCommandFile(worker, target);
    if (diff.added.includes(name)) report.added.push(name);
    else report.changed.push(name);
  }

  for (const name of diff.removed) {
    const target = path.join(args.commandsDir, `${name}.md`);
    const ours = await parseExistingMagicKey(target);
    if (ours) {
      await fs.unlink(target);
      report.removed.push(name);
    }
  }

  return report;
}
