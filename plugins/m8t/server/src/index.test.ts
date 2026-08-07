import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../dist/index.js");

describe("MCP server bootstrap", () => {
  it(
    "responds to a stdin initialize request with the server name",
    async () => {
      const proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
      // Capture stderr so a boot failure surfaces in the assertion instead of a
      // bare timeout (the server logs diagnostics to stderr; stdout is the
      // JSON-RPC channel).
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      const request = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      };

      proc.stdin.write(JSON.stringify(request) + "\n");

      try {
        const response = await new Promise<string>((resolve, reject) => {
          // A cold `node` spawn + bundle load + MCP init handshake can take
          // several seconds under CI / merge-queue load (the old 5s budget
          // flaked there). Stay under the vitest test timeout below so this
          // descriptive error — with stderr — wins the race.
          const timer = setTimeout(() => {
            reject(new Error(`timeout waiting for initialize response.\nstderr:\n${stderr}`));
          }, 20000);
          let buf = "";
          proc.stdout.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf-8");
            if (buf.includes('"id":1')) {
              clearTimeout(timer);
              resolve(buf);
            }
          });
          // Fail fast (and informatively) if the process can't start or dies
          // before answering, rather than hanging until the timeout.
          proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          proc.on("exit", (code) => {
            if (!buf.includes('"id":1')) {
              clearTimeout(timer);
              reject(
                new Error(`server exited early (code ${String(code)}) before responding.\nstderr:\n${stderr}`),
              );
            }
          });
        });

        const responseLine = response
          .trim()
          .split("\n")
          .find((line) => line.includes('"id":1'));
        expect(responseLine).toBeDefined();
        const parsed = JSON.parse(responseLine!) as {
          result: { serverInfo: { name: string } };
        };
        expect(parsed.result.serverInfo.name).toBe("m8t");
      } finally {
        proc.kill();
      }
    },
    30000,
  );
});
