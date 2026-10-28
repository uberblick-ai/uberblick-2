/**
 * Build the `ub` the suite spawns — once per `vitest run`, not once per spawn.
 *
 * `bin/ub.mjs` registers tsx and transpiles the CLI, schema and MCP server in
 * each child. Bundling `src/main.ts` once avoids that cost across the suite's
 * several hundred spawns.
 *
 * **Why a bundler at all.** The workspace packages export TypeScript
 * (`"exports": {".": "./src/index.ts"}`) and `tsconfig.base.json` sets
 * `noEmit` — tsc is a typechecker in this repository, never a build step. So
 * Node's own type stripping cannot run `src/main.ts` (the repo writes `.js`
 * specifiers beside `.ts` source, which Node does not rewrite and TypeScript
 * and esbuild both do), and a tsc emit of this package alone would still
 * resolve `@uberblick/schema` to a `.ts` file at run time. esbuild resolves
 * both, and it is already in this lockfile as vite's own dependency.
 *
 * **Why the output sits one directory below the package root.** Three modules
 * resolve real files relative to `import.meta.url` — `version.ts` reads
 * `../package.json`, `starter.ts` reads `../templates`, `open.ts` walks up to
 * the package root. `.test-build/ub.mjs` is at the same depth as `src/*.ts`,
 * so every one of those resolves to exactly the path it resolves to from
 * source. Moving this output would silently break all three.
 *
 * Nothing here replaces the shipped launcher: `bin/ub.mjs` owns contracts a
 * bundle does not inherit, and `test/launcher.test.ts` still spawns the real
 * one.
 *
 * **Boundary: `vitest --watch` re-runs against a stale bundle.** vitest runs a
 * global setup once per process and not again on a file change, so a watch
 * session keeps spawning the `ub` it built when it started, however much
 * `src/` has moved since. `vitest run` — what `mise run test` and both merge
 * gates use — starts a process per run and is unaffected. A watch session that
 * is editing `src/` should be restarted, or the change confirmed with a plain
 * `vitest run`.
 */

import { build } from "esbuild";
import type { TestProject } from "vitest/node";
import { measureSharedSetup } from "../../../scripts/report-shared-setup.mjs";
import { BUILT_UB, PACKAGE_ROOT, TEST_PORTS } from "./helpers.js";

export default async function setup(project: TestProject): Promise<void> {
  // One rotation per run, shared by its workers: see `freePort`.
  project.provide("testPortOffset", Math.floor(Math.random() * TEST_PORTS.count));
  await measureSharedSetup("cli: shared ub bundle build", "setup", () => build({
    entryPoints: [`${PACKAGE_ROOT}/src/main.ts`],
    outfile: BUILT_UB,
    bundle: true,
    platform: "node",
    format: "esm",
    // Node's own version, so nothing is down-levelled into a shape the real
    // `ub` would never run.
    target: "node26",
    // Everything is bundled, including `yjs`: a single file is the whole point,
    // and one bundle is still exactly one `yjs` module instance in the process
    // (the pnpm catalog pins one version, so every import resolves to one file
    // and esbuild includes it once). Only Node's builtins stay external, which
    // `platform: "node"` already arranges.
    //
    // Minify to reduce the file read and compiled on every spawn. A sibling
    // map gives `--enable-source-maps` readable failure stacks without adding
    // bytes to runs that do not request maps.
    minify: true,
    sourcemap: true,
  }));
}
