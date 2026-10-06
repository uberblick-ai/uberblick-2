/**
 * Build the `ub` the suite spawns — once per `vitest run`, not once per spawn.
 *
 * Every process test used to go through `bin/ub.mjs`, which registers tsx and
 * transpiles the CLI, the schema package and the MCP server afresh in each
 * child. That is a tenth of a second of pure boot per spawn, several hundred
 * times a run. Bundling `src/main.ts` to plain JavaScript once moves that cost
 * to a single ~200 ms step here.
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
import { createBoundFixtureParent } from "./binding-fixtures.js";
import { BUILT_UB, PACKAGE_ROOT } from "./helpers.js";

export default async function setup(project: TestProject): Promise<() => void> {
  await build({
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
    // Minified because the file is read and compiled on every spawn and this is
    // measurably half of what is left: 2.0 MB unminified starts in 0.166 s on
    // the machine this was written on, 1.0 MB minified in 0.143 s. The map is a
    // sibling file rather than inline, so `--enable-source-maps` still gives a
    // readable stack when a spawned run fails, and a run that does not ask pays
    // nothing for it.
    minify: true,
    sourcemap: true,
  });
  const parent = createBoundFixtureParent();
  project.provide("boundFixtureRoot", parent.root);
  return parent.teardown;
}
