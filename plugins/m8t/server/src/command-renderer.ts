import fs from "node:fs/promises";
import path from "node:path";
import type { WorkerRecord } from "./worker-builder.js";

// Always-quote, always-escape so a future persona with `:`, `#`, `"`, or a
// leading `-` in its description can't produce malformed frontmatter.
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function renderCommandFile(worker: WorkerRecord, targetPath: string): Promise<void> {
  const desc = worker.role ? `${worker.role} — ${worker.description}` : worker.description;

  const content = [
    "---",
    `description: ${yamlQuote(desc)}`,
    "m8t-generated: true",
    `m8t-worker: ${worker.name}`,
    `m8t-persona: ${worker.persona ?? "(none)"}`,
    "---",
    `Use the m8t MCP server's \`send_to_worker\` tool with \`name="${worker.name}"\` and \`message="$ARGUMENTS"\`. Return the worker's reply verbatim to the user.`,
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf-8");
}

export async function parseExistingMagicKey(filePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return /^m8t-generated:\s*true\s*$/m.test(content);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
