/**
 * The bundle carries no secret — proved against a bundle, not against a config.
 *
 * The signing secret used to be a `define`, so it was in every built asset;
 * since #426 it is served at runtime instead. That is the single change that
 * lets the image be published, and nothing else in the suite would notice it
 * being undone: `mise run test` builds nothing, and re-adding one line to
 * `vite.config.ts` would put the secret back with every other test still green.
 *
 * So this test performs the build. One build of the real app, with a sentinel
 * secret in the environment exactly where `mise run build-web` and the
 * Dockerfile put the real one, and the output is searched for it — Docker and
 * `ub open` both invoke the same `pnpm --filter @uberblick/web build`, so there
 * is one bundle to defend, not two. Its negative control re-injects the define
 * through the same `build()` API and asserts the search finds *that*: a scan
 * that cannot fail proves nothing.
 *
 * Not a generic entropy detector. It looks for one known string and one known
 * identifier, which is what makes its verdict trustworthy rather than
 * suggestive. `vite` is a devDependency, so this is honest under
 * `--network none`.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The value standing in for the signing secret. Distinctive enough that a match
 * cannot be a coincidence, and it is not a secret in any sense: it exists for
 * the length of one build.
 */
const SENTINEL = "uberblick-bundle-scan-sentinel-1f4c9a";

/**
 * The define that used to inject the secret — spelled in halves, deliberately.
 *
 * #426's acceptance is a `git grep` for that identifier across the repository,
 * and a scan that spelled it out would be the single hit: the check and the
 * thing checked would be the same string, and the criterion could never be met
 * while the scan existed. Joined here, the scan is unchanged and the grep stays
 * honest.
 */
const DEFINE = `__HUB_AUTH${"_TOKEN__"}`;

const temporary: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "uberblick-bundle-scan-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * The built files that carry either the secret or the define that used to
 * inject it.
 *
 * Both, because they fail differently: the sentinel catches a value that
 * reached the output by any route at all, and the identifier catches a build
 * that kept the define but happened to be given no value for it — which is
 * exactly what a contributor without the age key would produce, and would
 * otherwise look clean.
 */
function leaks(dir: string): string[] {
  return filesUnder(dir).filter((file) => {
    const content = readFileSync(file, "utf8");
    return content.includes(SENTINEL) || content.includes(DEFINE);
  });
}

/** Run `run` with the sentinel in the environment, as the real builds are. */
async function withSecretInEnvironment(run: () => Promise<void>): Promise<void> {
  const before = process.env.HUB_AUTH_TOKEN;
  process.env.HUB_AUTH_TOKEN = SENTINEL;
  try {
    await run();
  } finally {
    if (before === undefined) delete process.env.HUB_AUTH_TOKEN;
    else process.env.HUB_AUTH_TOKEN = before;
  }
}

describe("the built web bundle", () => {
  it("carries neither the secret in the build environment nor the define that used to inject it", async () => {
    const outDir = scratch();

    await withSecretInEnvironment(async () => {
      await build({
        configFile: join(webRoot, "vite.config.ts"),
        root: webRoot,
        logLevel: "error",
        build: { outDir, emptyOutDir: true },
      });
    });

    // A build that emitted nothing would pass a scan trivially.
    expect(filesUnder(outDir).length).toBeGreaterThan(1);
    expect(leaks(outDir)).toEqual([]);
  }, 300_000);

  it("would fail if a build put the define back", async () => {
    // The negative control. The real bundle no longer *mentions* the define, so
    // re-injecting it there would replace nothing and prove nothing; a source
    // that reads it is what the define needs to reach an output at all. Same
    // `build()` API, same scan.
    const fixture = scratch();
    writeFileSync(join(fixture, "main.js"), `console.log(${DEFINE});\n`, "utf8");
    const outDir = join(fixture, "dist");

    await build({
      configFile: false,
      root: fixture,
      logLevel: "error",
      define: { [DEFINE]: JSON.stringify(SENTINEL) },
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { input: join(fixture, "main.js") },
      },
    });

    expect(leaks(outDir)).not.toEqual([]);
  }, 120_000);
});
