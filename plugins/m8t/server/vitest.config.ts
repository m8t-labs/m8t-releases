import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@m8t-stack/agent-ledger": path.resolve(
        __dirname,
        "../../../packages/agent-ledger/src/index.ts",
      ),
      "@m8t-stack/api-contract": path.resolve(
        __dirname,
        "../../../packages/api-contract/src/index.ts",
      ),
      "@m8t-stack/foundry-invoke": path.resolve(
        __dirname,
        "../../../packages/foundry-invoke/src/index.ts",
      ),
    },
  },
});
