/**
 * Isolated real-hub browser probe. Run from packages/web:
 * node --import tsx ../../docs/spikes/1398/browser.ts <private-scratch> <chart-deps>
 * chart-deps is a private directory containing Chart.js 4.5.1 in node_modules.
 * All database and browser-profile paths are private, and removed on completion.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHub, type Hub } from "../../../packages/hub/src/server.js";
import { silentLogger } from "../../../packages/hub/src/log.js";
import { importRootSecret, mintToken } from "../../../packages/hub/src/token.js";
import { wrapToken } from "../../../packages/hub/src/protocol.js";
import { readData } from "./representations.mjs";
import { getBlocks } from "../../../packages/schema/src/blocks.js";
import type { Browser } from "../../../packages/web/node_modules/@playwright/test";
import type { ViteDevServer } from "../../../packages/web/node_modules/vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("./", import.meta.url));
const webRequire = createRequire(join(root, "packages/web/package.json"));
const Y = await import(join(dirname(webRequire.resolve("yjs")), "yjs.mjs"));
const { chromium } = webRequire("@playwright/test");
const { createServer } = await import(webRequire.resolve("vite"));
const scratch = process.argv[2];
const chartDeps = process.argv[3];
assert(scratch && chartDeps, "pass a private scratch and Chart.js dependency directory");
const chartRequire = createRequire(join(resolve(chartDeps), "package.json"));
assert.equal(chartRequire("chart.js").Chart.version, "4.5.1");
const runDirectory = mkdtempSync(join(resolve(scratch), "browser-f113f7929192418db18d6b630011c30d-"));
const epochNow = () => performance.timeOrigin + performance.now();
let browser: Browser | undefined;
let hub: Hub | undefined;
let vite: ViteDevServer | undefined;
let child: ChildProcess | undefined;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { child?.kill("SIGKILL"); }, 2_000);
      child?.once("exit", () => { clearTimeout(timer); done(); });
    });
  }
  await browser?.close();
  await vite?.close();
  await hub?.stop();
  rmSync(runDirectory, { recursive: true, force: true });
}
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 120_000);
process.on("SIGTERM", () => { void cleanup().finally(() => process.exit(1)); });
process.on("SIGINT", () => { void cleanup().finally(() => process.exit(1)); });

interface WriterResponse {
  command: string;
  message?: string;
  read?: unknown;
  startEpochMs: number;
  transactionEndedEpochMs: number;
  writerCrdtApplyMs: number;
  writerTransactionMs: number;
}

function request(command: Record<string, unknown>): Promise<WriterResponse> {
  return new Promise((done, fail) => {
    const running = child;
    assert(running);
    const timer = setTimeout(() => { detach(); fail(new Error(`writer command timeout: ${command.command}`)); }, 15_000);
    const listener = (raw: unknown) => {
      const message = raw as WriterResponse;
      if (message.command === "error") { detach(); fail(new Error(String(message.message))); }
      else { detach(); done(message); }
    };
    const exited = (code) => { detach(); fail(new Error(`writer exited with ${code}`)); };
    function detach() { clearTimeout(timer); running?.off("message", listener); running?.off("exit", exited); }
    running.once("message", listener);
    running.once("exit", exited);
    running.send(command);
  });
}

try {
  const authSecret = randomBytes(32).toString("hex");
  const workspaceId = randomUUID();
  const databasePath = join(runDirectory, "hub.sqlite");
  hub = await createHub({ port: 0, address: "127.0.0.1", databasePath, authSecret, log: silentLogger, debounce: 5_000, maxDebounce: 30_000, shutdownTimeoutMs: 5_000 });
  const hubUrl = `ws://127.0.0.1:${hub.port}`;
  let browserConfig = { variant: "", hubUrl: "", room: "", token: "" };
  vite = await createServer({
    configFile: false,
    root: output,
    cacheDir: join(runDirectory, "vite-f113f7929192418db18d6b630011c30d"),
    logLevel: "error",
    resolve: {
      alias: {
        yjs: join(dirname(webRequire.resolve("yjs")), "yjs.mjs"),
        "@hocuspocus/provider": join(dirname(webRequire.resolve("@hocuspocus/provider")), "hocuspocus-provider.esm.js"),
        "chart.js/auto": chartRequire.resolve("chart.js/auto"),
      },
    },
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root, chartDeps] } },
    plugins: [{
      name: "private-spike-config",
      configureServer(server) {
        server.middlewares.use("/spike-config.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(browserConfig));
        });
      },
    }],
  });
  await vite.listen();
  const vitePort = vite.httpServer.address().port;
  browser = await chromium.launch({ headless: true, timeout: 15_000 });
  const results = {
    method: {
      topology: "Separate Node writer with MCP Replicas+MirrorStore and its own database → actual project loopback Hocuspocus hub → browser HocuspocusProvider directly; no ub open serving replica.",
      isolation: "Fresh random workspace UUID; ephemeral loopback endpoints; private disposable SQLite and browser profiles; explicit configs, no project binding resolution or inherited writer environment; read-only browser room token.",
      data: "1500 deterministic records across three collections, 25 fields each; existing prose and metadata plus optional spikeData root; one collection's 500 records shown.",
      cadence: "Ten corrections, requested 250 ms after each preceding correction request was sent, then one append; later writer updates begin only after the already-open tab's initial chart was observed. The writer process seeds the document before the browser opens.",
      clocks: "Same-host epoch monotonic timestamps performance.timeOrigin + performance.now() in Node and Chromium; delivery = browser beforeTransaction - writer transaction completion (excludes sender transaction, includes hub path). Not a network-only latency or remote-host clock measurement.",
      clockPrecision: "Chromium's non-isolated performance timestamps are quantized at about 0.1 ms; very small remote applications can report 0 ms. Epoch floating point conversion is also finite precision.",
      writerApply: "Local beforeTransaction → afterTransaction includes operation-body cloning, Yjs changes and synchronous observers. The full writerTransactionMs wraps correct/append and also includes later update callbacks (encoding, SQLite log append, transport queueing). Neither is the isolated applyUpdate microbenchmark.",
      browserApply: "Remote transaction beforeTransaction → afterTransaction; includes Yjs synchronous observer scheduling but excludes queued chart projection and drawing.",
      render: "Queued microtask projection and synchronous Chart.js update('none') are timed separately; nextAnimationFrame is a paint opportunity proxy, not GPU presentation.",
      polling: "No view polling, reload or manual update trigger. Playwright polls assertions only; observer queues a microtask. Direct hub topology has no SQLite foreign-commit poll.",
      durability: "After final convergence, explicitly await hub.flush(), then read and apply the stored document BLOB from hub SQLite; hub acknowledgement alone is not durability.",
    },
    versions: { node: process.versions.node, chromium: browser.version(), yjs: "13.6.32", hocuspocus: "4.6.0", chartjs: "4.5.1" },
    variants: [],
  };

  for (const variant of ["keyed-records", "document-envelope"]) {
    const docId = randomUUID();
    const room = `${workspaceId}/${docId}`;
    const key = await importRootSecret(authSecret);
    const token = wrapToken(await mintToken(key, { typ: "room", sub: "synthetic-read-only-browser", workspace: workspaceId, scope: "read-only", kid: null, lifetimeSeconds: 120 }));
    browserConfig = { variant, hubUrl, room, token };
    child = spawn(process.execPath, ["--import", "tsx", join(output, "writer.ts")], {
      cwd: join(root, "packages/mcp-server"),
      // Preserve no ambient settings or credentials. Even loader caches go
      // into this run's disposable scratch, rather than the system temp area.
      env: { TMPDIR: runDirectory },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const seeded = await request({ command: "start", variant, workspaceId, hubUrl, authSecret, databasePath: join(runDirectory, `${variant}-writer.sqlite`), docId });
    const context = await browser.newContext({ viewport: { width: 1120, height: 800 }, recordVideo: { dir: runDirectory, size: { width: 1120, height: 800 } } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => { errors.push(String(error)); });
    let mainFrameNavigations = 0;
    let configRequests = 0;
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) mainFrameNavigations += 1; });
    page.on("request", (request) => { if (request.url().includes("spike-config.json")) configRequests += 1; });
    await page.goto(`http://127.0.0.1:${vitePort}/chart.html`, { waitUntil: "networkidle", timeout: 15_000 });
    await page.waitForFunction(() => window.spike?.events.length > 0, { timeout: 15_000 });
    const initial = await page.evaluate(() => ({ event: window.spike.events[0], data: window.spike.read() }));
    assert.deepEqual(initial.data, seeded.read);
    assert.equal(initial.event.totalRecords, 1500);
    await page.screenshot({ path: join(output, `browser-${variant}-before.png`) });
    const video = page.video();
    const writerEvents = [];
    let previousStarted = epochNow();
    for (let index = 1; index <= 10; index += 1) {
      await new Promise((done) => setTimeout(done, Math.max(0, 250 - (epochNow() - previousStarted))));
      previousStarted = epochNow();
      const event = await request({ command: "correct", value: 60 + index * 4 });
      writerEvents.push(event);
      await page.waitForFunction((value) => window.spike.events.some((event) => event.firstValue === value), 60 + index * 4, { timeout: 5_000 });
    }
    const appended = await request({ command: "append" });
    writerEvents.push(appended);
    await page.waitForFunction(() => window.spike.events.at(-1)?.totalRecords === 1501, { timeout: 5_000 });
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(output, `browser-${variant}-after.png`) });
    const final = await page.evaluate(() => ({ events: window.spike.events, data: window.spike.read(), localDocumentUpdates: window.spike.localDocumentUpdates, remoteDocumentUpdates: window.spike.remoteDocumentUpdates, observerCalls: window.spike.observerCalls }));
    const stopped = await request({ command: "stop" });
    await new Promise<void>((done, fail) => {
      if (child?.exitCode !== null) { if (child?.exitCode === 0) done(); else fail(new Error(stderr)); return; }
      child?.once("exit", (code) => { if (code === 0) done(); else fail(new Error(stderr)); });
    });
    child = undefined;
    assert.deepEqual(final.data, stopped.read);
    assert.equal(final.localDocumentUpdates, 0);
    assert.equal(final.events.length, 12);
    assert.equal(mainFrameNavigations, 1);
    assert.equal(configRequests, 1);
    assert.deepEqual(errors, []);
    await hub.flush();
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare('SELECT data FROM documents WHERE name = ?').get(room);
    db.close();
    assert(row?.data instanceof Uint8Array);
    const durable = new Y.Doc();
    Y.applyUpdate(durable, row.data);
    assert.deepEqual(readData(durable, variant), final.data);
    assert.equal(durable.getMap("meta").get("uuid"), docId);
    assert.equal(durable.getMap("meta").get("title"), "Synthetic chart feasibility document");
    assert.equal(getBlocks(durable).length, 1);
    assert.equal(getBlocks(durable)[0].text, "This is an existing document with prose and optional structured data.");
    const durableHubSnapshotBytes = row.data.byteLength;
    durable.destroy();
    const firstEpoch = final.events[0].renderedEpochMs;
    const timedUpdates = writerEvents.map((writer, index) => {
      const event = final.events[index + 1];
      return {
        kind: writer.command === "appended" ? "append" : "correction",
        value: event.firstValue,
        records: event.totalRecords,
        elapsedMs: event.renderedEpochMs - firstEpoch,
        actualWriterSpacingMs: index === 0 ? null : writer.startEpochMs - writerEvents[index - 1].startEpochMs,
        writerCrdtApplyMs: writer.writerCrdtApplyMs,
        writerTransactionMs: writer.writerTransactionMs,
        deliveryMs: event.receivedEpochMs - writer.transactionEndedEpochMs,
        browserApplyMs: event.browserApplyMs,
        projectionMs: event.projectionMs,
        chartDrawMs: event.chartDrawMs,
        nextAnimationFrameMs: event.nextAnimationFrameMs,
      };
    });
    assert(timedUpdates.every((entry) => entry.deliveryMs >= -1 && Number.isFinite(entry.browserApplyMs)));
    results.variants.push({
      variant,
      initial: { firstValue: initial.event.firstValue, totalRecords: 1500, projectionMs: initial.event.projectionMs, chartDrawMs: initial.event.chartDrawMs, browserApplyMs: initial.event.browserApplyMs },
      updates: timedUpdates,
      assertions: { exactWriterBrowserAndDurableHubData: true, existingMetadataAndProseRetained: true, localBrowserDocumentUpdates: final.localDocumentUpdates, remoteBrowserDocumentUpdates: final.remoteDocumentUpdates, observerCalls: final.observerCalls, chartRenders: final.events.length, mainFrameNavigations, configRequests, pageErrors: errors.length },
      durableHubSnapshotBytes,
      evidence: [`browser-${variant}-before.png`, `browser-${variant}-after.png`, `browser-${variant}-session.webm`],
    });
    await context.close();
    await video.saveAs(join(output, `browser-${variant}-session.webm`));
    console.log(JSON.stringify({ variant, chartRenders: final.events.length, localBrowserDocumentUpdates: 0, durableHubSnapshotBytes, correctionDeliveryMs: timedUpdates.filter((entry) => entry.kind === "correction").map((entry) => Number(entry.deliveryMs.toFixed(3))) }));
  }
  writeFileSync(join(output, "browser-results.json"), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  clearTimeout(deadline);
  await cleanup();
}
