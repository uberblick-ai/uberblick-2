import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { appendBlock, initDoc } from "@uberblick/schema";
import { WEB_CONTENT_SECURITY_POLICY } from "@uberblick/schema/web-policy";
import * as Y from "yjs";
import globalSetup from "../../e2e/global-setup.js";
import { sharedAppBundle } from "../../e2e/bundle.js";
import { startHarness } from "../../e2e/harness.js";
import { digest, sourceFacts } from "../../e2e/scenario-recording.js";
import { scenario } from "./scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../..");
process.chdir(web);
const evidence = join(web, "scenario-evidence", scenario.id);
const mode = process.argv[2];

function recordings() {
  if (!existsSync(evidence)) return [];
  return readdirSync(evidence).filter(id => existsSync(join(evidence, id, "manifest.json")))
    .map(id => ({ ...JSON.parse(readFileSync(join(evidence, id, "manifest.json"), "utf8")), id }))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

async function record() {
  // Resolve the link against registered tests, without restoring a mandatory gate.
  const listing = JSON.parse(execFileSync("pnpm", ["exec", "playwright", "test", scenario.testFile,
    "--project=chromium", "--grep", scenario.testTitle, "--list", "--reporter=json"], { encoding: "utf8" }));
  const specs: { title: string; tests: { annotations: { type: string; description: string }[] }[] }[] = [];
  type Suite = { specs?: typeof specs; suites?: Suite[] };
  const visit = (suite: Suite): void => {
    specs.push(...suite.specs ?? []);
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of listing.suites) visit(suite);
  if (listing.errors?.length || specs.length !== 1 || specs[0]?.tests.length !== 1 ||
    !specs[0].tests[0]?.annotations.some(a => a.type === "scenario" && a.description === scenario.id)) {
    throw new Error("Scenario must resolve to exactly one registered Chromium test with its annotation.");
  }
  mkdirSync(evidence, { recursive: true });
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const output = join(evidence, id);
  mkdirSync(output);
  const started = Date.now();
  const child = spawn("mise", ["run", "e2e", "--", scenario.testFile, "--project=chromium",
    "--grep", scenario.testTitle, "--trace=off", "--reporter=list,json"], {
    cwd: web, stdio: "inherit", detached: true,
    env: { ...process.env, UB_SCENARIO_RECORDING_DIR: output,
      PLAYWRIGHT_JSON_OUTPUT_FILE: join(output, "test-result.json") },
  });
  const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} } };
  const deadline = setTimeout(stop, 180_000);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const code = await new Promise<number>(resolveExit => child.once("exit", value => resolveExit(value ?? 1)));
  clearTimeout(deadline);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  const captureFile = join(output, "capture.json");
  const capture = existsSync(captureFile) ? JSON.parse(readFileSync(captureFile, "utf8")) : {
    scenario, ...sourceFacts(), recordedAt: new Date(started).toISOString(), scenarioCompleted: false,
    media: "missing — test did not finish capture", moments: [], actor: "member", clip: "member.webm",
  };
  const clip = join(output, "member.webm");
  const manifest = { ...capture, id, testStatus: code === 0 ? "passed" : "failed",
    wallSeconds: (Date.now() - started) / 1000,
    mediaSha256: existsSync(clip) ? digest(readFileSync(clip)) : null,
    publication: "local filesystem only", environment: `${process.platform}/${process.arch}; synthetic hub and workspace` };
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`Recording: ${output}\nTest: ${manifest.testStatus}; scenario: ${manifest.scenarioCompleted}; media: ${manifest.media}`);
  process.exitCode = code;
}

async function serve() {
  const runs = recordings();
  if (runs.length === 0) throw new Error("Record the scenario first.");
  const cleanupBundle = await globalSetup();
  let harness: Awaited<ReturnType<typeof startHarness>> | undefined;
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  try {
    harness = await startHarness();
    // Stable identities let a copied address reopen after this disposable server restarts.
    const uuid = "b52ad909-69aa-4a48-a534-56f29f61a22e";
    const doc = new Y.Doc();
    initDoc(doc, { uuid, title: scenario.title });
    appendBlock(doc, { type: "paragraph", text: `Scenario: ${scenario.id}. ${scenario.startingState}` });
    appendBlock(doc, { type: "paragraph", text: `Actor: ${scenario.actor}.` });
    for (const text of scenario.steps) appendBlock(doc, { type: "list-item", list: "ordered", text });
    appendBlock(doc, { type: "paragraph", text: `Expected: ${scenario.expected}` });
    appendBlock(doc, { type: "paragraph", text: `Checked: ${scenario.assertions}` });
    appendBlock(doc, { type: "paragraph", text: "Recordings below are historical evidence from synthetic data. The optional local player is a disposable prototype." });
    await harness.seedDocument(doc);
    doc.destroy();
    const bundle = sharedAppBundle().directory;
    const assets = join(bundle, "_spike");
    mkdirSync(assets);
    copyFileSync(join(here, "player.js"), join(assets, "player.js"));
    for (const run of runs) {
      const target = join(assets, run.id);
      mkdirSync(target);
      if (existsSync(join(evidence, run.id, "member.webm"))) copyFileSync(join(evidence, run.id, "member.webm"), join(target, "member.webm"));
    }
    writeFileSync(join(assets, "index.json"), JSON.stringify({ runs, current: sourceFacts(), scenario, uuid }));
    const index = join(bundle, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace("</body>", '<script type="module" src="/_spike/player.js"></script></body>'));
    const port = Number(process.env.UB_SCENARIO_PORT ?? 4178);
    writeFileSync(join(bundle, "uberblick-config.json"), JSON.stringify({
      hubUrl: `ws://127.0.0.1:${port}/ws`, workspaces: [harness.workspace], hubAuthToken: harness.authSecret,
    }));
    server = await preview({ configFile: false, root: web, build: { outDir: bundle },
      preview: { port, strictPort: true, host: "127.0.0.1", headers: { "Content-Security-Policy": WEB_CONTENT_SECURITY_POLICY },
        proxy: { "/ws": { target: harness.hubUrl, ws: true } } } });
    console.log(`\nOpen http://127.0.0.1:${port}/?scenario=${scenario.id}\nLocal synthetic workspace; closes on Ctrl-C or after 45 minutes.\n`);
    await new Promise<void>(resolveStop => {
      const stop = () => { clearTimeout(deadline); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolveStop(); };
      const deadline = setTimeout(stop, 45 * 60_000);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    if (server && "closeAllConnections" in server.httpServer) server.httpServer.closeAllConnections();
    if (server) await new Promise<void>(resolveClose => server?.httpServer.close(() => resolveClose()));
    await harness?.stop();
    await cleanupBundle();
  }
}

if (mode === "record") await record();
else if (mode === "serve") await serve();
else throw new Error("Use: mise exec -- pnpm --filter @uberblick/web exec tsx scripts/scenario-spike/run.ts <record|serve>.");
