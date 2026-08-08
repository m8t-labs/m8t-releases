import { defineConfig } from "tsup";
import path from "node:path";

// The MCP is a standalone, separately-distributed plugin (committed dist/, no
// consumer build). The @m8t-stack/* packages are workspace:* *devDependencies*
// only — present at dev/CI time for type resolution, turbo build-ordering, and
// linting, but NEVER runtime `dependencies`, so nothing about them reaches a
// consumer install. They are bundled FROM SOURCE via the aliases below (tsup
// externalizes only `dependencies`, so devDeps + alias = inlined).
//
// EVERYTHING ELSE IS BUNDLED TOO. This used to read "all real npm deps stay
// external and resolve from node_modules" — a coherent design with nowhere to
// stand: the plugin is distributed as committed files, `server/node_modules` is
// gitignored, and no step of any install ever created one. So the shipped server
// died on its first import with ERR_MODULE_NOT_FOUND, on every clean profile, in
// silence. It only ever worked on a machine that happened to have run a workspace
// install. `dist/index.js` is now the whole program: node builtins are the only
// thing it reaches for.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  platform: "node",
  // Every non-builtin, not a list of the seven that happen to be declared today: a
  // dependency added later must be carried by the same rule that carries these,
  // or it reintroduces exactly the failure above with nothing to notice.
  noExternal: [/.*/],
  // One file. Splitting emits sibling chunks that only resolve relative to the
  // entrypoint, and the entrypoint is launched by path from `.mcp.json` — a shape
  // with more ways to arrive incomplete, for no gain in a single-entry program.
  splitting: false,
  // The bundled tree contains CommonJS (jsonwebtoken → jws → safe-buffer, among
  // others) whose `require()` esbuild rewrites to a stub that throws in ESM
  // output. Handing it a real `require` built from this module's own URL is what
  // makes those packages work bundled; without it the server dies at import on
  // "Dynamic require of 'buffer' is not supported".
  banner: {
    js: [
      'import { createRequire as __m8tCreateRequire } from "node:module";',
      "const require = __m8tCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // No sourcemap. Bundling vendor code takes the map from 219 KB to ~11 MB, and
  // it is dead weight where it lands: Node reads it only under
  // `--enable-source-maps`, and the plugin is launched as a bare `node dist/index.js`.
  // It is also republished in full on every dependency bump, into the public
  // repository a founder clones to install — and it inlines the sources of the
  // private platform packages this bundle draws from. The bundle stays unminified
  // instead, so a stack trace still names a readable frame and the mirrored
  // artifact stays auditable by reading it.
  sourcemap: false,
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
