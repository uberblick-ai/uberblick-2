// @vitest-environment node
/**
 * What a build emits — proved against a bundle, not against a config.
 *
 * The bundle carries no secret. The signing secret used to be a `define`, so
 * it was in every built asset; since #426 it is served at runtime instead.
 * That is the single change that lets the image be published, and nothing else
 * in the suite would notice it being undone: `mise run test` builds nothing,
 * and re-adding one line to `vite.config.ts` would put the secret back with
 * every other test still green.
 *
 * So this file performs the build. One build of the real app, with a sentinel
 * secret in the environment where `mise run build-web` and `ub open` build,
 * and the output is searched for it. The release payload also uses Vite's
 * build pipeline, so the guard covers its assets too. The negative control
 * re-injects the define through the same `build()` API and asserts the search
 * finds *that*: a scan that cannot fail proves nothing.
 *
 * Not a generic entropy detector. It looks for one known string and one known
 * identifier, which is what makes its verdict trustworthy rather than
 * suggestive. `vite` is a devDependency, so this is honest under
 * `--network none`.
 *
 * That one build is also where the protocol stamp is checked (#452) and where
 * the font licenses are found beside the faces they cover. A stamp asserted
 * against a fixture would prove nothing about what Vite emits — which is the
 * whole claim `ub open` rests its refusal on.
 *
 * The release build is the other configuration: `UBERBLICK_RELEASE_WEB=1`
 * compiles in no deployment value at all, so it is built on its own, as a
 * library of the one module that reads them.
 *
 * Node rather than jsdom: nothing here renders.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/**
 * Every vendored face and the OFL text that has to travel with it. Geist ships
 * as two files under one license; Fraunces is its own (#536). The OFL requires
 * its text to accompany the font software wherever the font is distributed —
 * a built `dist/` included — and `public/` is how it gets there. A face added
 * without its license, or a license deleted from under a face, is the
 * regression this defends.
 */
const bundledFonts = [
  { woff2: "Geist-Variable.woff2", license: "LICENSE-Geist.txt" },
  { woff2: "GeistMono-Variable.woff2", license: "LICENSE-Geist.txt" },
  { woff2: "Fraunces-Variable-latin.woff2", license: "LICENSE-Fraunces.txt" },
  { woff2: "Fraunces-Variable-latin-ext.woff2", license: "LICENSE-Fraunces.txt" },
  { woff2: "Fraunces-Variable-vietnamese.woff2", license: "LICENSE-Fraunces.txt" },
];

const temporary: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "uberblick-bundle-scan-"));
  temporary.push(dir);
  return dir;
}

afterAll(() => {
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
  /** The one build of the real app every claim below reads. */
  let outDir = "";

  beforeAll(async () => {
    outDir = scratch();
    await withSecretInEnvironment(async () => {
      await build({
        configFile: join(webRoot, "vite.config.ts"),
        root: webRoot,
        logLevel: "error",
        build: { outDir, emptyOutDir: true },
      });
    });
  }, 300_000);

  it("carries neither the secret in the build environment nor the define that used to inject it", () => {
    // A build that emitted nothing would pass a scan trivially.
    expect(filesUnder(outDir).length).toBeGreaterThan(1);
    expect(leaks(outDir)).toEqual([]);
  });

  it("stamps the protocol it speaks, which is what `ub open` refuses a stale bundle on", () => {
    // The value is the one the client itself compiles in.
    expect(JSON.parse(readFileSync(join(outDir, "uberblick-build.json"), "utf8"))).toEqual({
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    });
  });

  it("ships the OFL text beside every vendored face", () => {
    const vendored = readdirSync(resolve(webRoot, "src/assets/fonts"));
    expect(vendored.filter((f) => f.endsWith(".woff2")).sort()).toEqual(
      bundledFonts.map((face) => face.woff2).sort(),
    );

    for (const { license } of bundledFonts) {
      expect(readFileSync(join(outDir, license), "utf8")).toContain("SIL OPEN FONT LICENSE");
    }
  });

  it("would fail if a build put the define back", async () => {
    // The negative control. The real bundle no longer *mentions* the define, so
    // re-injecting it there would replace nothing and prove nothing; a source
    // that reads it is what the define needs to reach an output at all. Same
    // `build()` API, same scan.
    const fixture = scratch();
    writeFileSync(join(fixture, "main.js"), `console.log(${DEFINE});\n`, "utf8");
    const fixtureOut = join(fixture, "dist");

    await build({
      configFile: false,
      root: fixture,
      logLevel: "error",
      define: { [DEFINE]: JSON.stringify(SENTINEL) },
      build: {
        outDir: fixtureOut,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { input: join(fixture, "main.js") },
      },
    });

    expect(leaks(fixtureOut)).not.toEqual([]);
  }, 120_000);
});

/** A released bundle gets every deployment value from its served document. */
it("a release build has no endpoint or workspace fallback, and takes every deployment value from its served document", async () => {
  const scratchRoot = process.env.UB_AGENTS_SCRATCH ?? tmpdir();
  const run = process.env.UB_AGENTS_RUN ?? basename(dirname(scratchRoot));
  const releaseDir = mkdtempSync(join(scratchRoot, `release-config-${run}-`));
  const before = { ...process.env };
  try {
    process.env.UBERBLICK_RELEASE_WEB = "1";
    process.env.HUB_URL = "wss://release-build-sentinel.invalid/ws";
    process.env.WORKSPACE_ID = "release-build-workspace-sentinel";
    process.env.WORKSPACES = "release-build-workspaces-sentinel";
    writeFileSync(join(releaseDir, "entry.ts"), `export { readClientConfig } from ${JSON.stringify(join(webRoot, "src/config.ts"))};\n`);
    const outDir = join(releaseDir, "dist");
    await build({
      configFile: join(webRoot, "vite.config.ts"), root: webRoot, logLevel: "error",
      build: { outDir, emptyOutDir: true, minify: false,
        lib: { entry: join(releaseDir, "entry.ts"), formats: ["es"], fileName: () => "config.mjs" } },
    });
    const output = readdirSync(outDir).filter((name) => name.endsWith(".mjs"))
      .map((name) => readFileSync(join(outDir, name), "utf8")).join("\n");
    expect(output).not.toContain("release-build-sentinel");
    expect(output).not.toContain("release-build-workspace");
    expect(output).not.toContain("ws://localhost:1234");
    // Execute the emitted module with Node, outside Vitest's source transforms.
    const executed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readClientConfig } from ${JSON.stringify(pathToFileURL(join(outDir, "config.mjs")).href)};
      const missing = await readClientConfig(async () => new Response("missing", { status: 404 }));
      const runtime = await readClientConfig(async () => new Response(JSON.stringify({
        hubUrl: "wss://runtime.tailnet.ts.net/ws",
        workspaces: ["00000000-0000-4000-8000-000000000001"],
        hubAuthToken: "synthetic-runtime-token",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
      const invalid = await readClientConfig(async () => new Response(JSON.stringify({
        hubUrl: "https://not-a-websocket.invalid/", workspaces: ["not-a-workspace"],
        hubAuthToken: "synthetic-runtime-token",
      }), { status: 200 }));
      console.log(JSON.stringify({ missing, invalid, runtime }));
    `], { encoding: "utf8", timeout: 10_000 });
    expect(executed.status, executed.stderr).toBe(0);
    const { missing, invalid, runtime } = JSON.parse(executed.stdout);
    expect(missing.hubUrl).toBe("");
    expect(missing.workspaces).toEqual([]);
    expect(invalid.hubUrl).toBe("");
    expect(invalid.workspaces).toEqual([]);
    expect(runtime.hubUrl).toBe("wss://runtime.tailnet.ts.net/ws");
    expect(runtime.hubUrlSource).toBe("document");
    expect(runtime.hubAuthToken).toBe("");
    expect(runtime.workspaces).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(runtime.workspacesSource).toBe("document");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    rmSync(releaseDir, { recursive: true, force: true });
  }
}, 120_000);
