/** A released bundle gets every deployment value from its served document. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it("builds without deployment values and has no endpoint or workspace fallback", async () => {
  const scratchRoot = process.env.UB_AGENTS_SCRATCH ?? tmpdir();
  const run = process.env.UB_AGENTS_RUN ?? basename(dirname(scratchRoot));
  const scratch = mkdtempSync(join(scratchRoot, `release-config-${run}-`));
  const before = { ...process.env };
  try {
    process.env.UBERBLICK_RELEASE_WEB = "1";
    process.env.HUB_URL = "wss://release-build-sentinel.invalid/ws";
    process.env.WORKSPACE_ID = "release-build-workspace-sentinel";
    process.env.WORKSPACES = "release-build-workspaces-sentinel";
    writeFileSync(join(scratch, "entry.ts"), `export { readClientConfig } from ${JSON.stringify(join(webRoot, "src/config.ts"))};\n`);
    const outDir = join(scratch, "dist");
    await build({
      configFile: join(webRoot, "vite.config.ts"), root: webRoot, logLevel: "error",
      build: { outDir, emptyOutDir: true, minify: false,
        lib: { entry: join(scratch, "entry.ts"), formats: ["es"], fileName: () => "config.mjs" } },
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
    expect(runtime.workspaces).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(runtime.workspacesSource).toBe("document");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
