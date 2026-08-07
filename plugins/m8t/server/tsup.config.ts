import { defineConfig } from "tsup";
import path from "node:path";

// The MCP is a standalone, separately-distributed plugin (committed dist/, no
// consumer build). The @m8t-stack/* packages are workspace:* *devDependencies*
// only — present at dev/CI time for type resolution, turbo build-ordering, and
// linting, but NEVER runtime `dependencies`, so nothing about them reaches a
// consumer install. They are bundled FROM SOURCE via the aliases below (tsup
// externalizes only `dependencies`, so devDeps + alias = inlined). All real npm
// deps (in package.json "dependencies") stay external and resolve from node_modules.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  bundle: true,
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
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
      "@m8t-stack/github-app-auth": path.resolve(
        __dirname,
        "../../../packages/github-app-auth/src/index.ts",
      ),
    };
  },
});
