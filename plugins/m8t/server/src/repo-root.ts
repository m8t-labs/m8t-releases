import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function readRepoRoot(pointerPath?: string): Promise<string> {
  const fp = pointerPath ?? path.join(os.homedir(), ".m8t", "repo-root");
  try {
    const content = await fs.readFile(fp, "utf-8");
    return content.trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "m8t isn't installed (missing ~/.m8t/repo-root). " +
          "Run the m8t installer — paste the install line from " +
          "https://github.com/m8t-labs/m8t into your coding agent. " +
          "That's what writes ~/.m8t/repo-root.",
      );
    }
    throw err;
  }
}
