/**
 * Disposable browser cold-load/projection/chart microbenchmark, not transport.
 * Run from packages/web after temporal.ts has exported its private binaries:
 * node --import tsx ../../docs/spikes/1398/temporal-browser.ts <input-directory>
 *   <private-chart-deps> <private-chromium-directory> <private-scratch>
 * Dependencies and browser installation belong in run-private scratch. This
 * script never reads project binding, starts a hub, or opens a production editor.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "../../../packages/web/node_modules/@playwright/test";
import type { ViteDevServer } from "../../../packages/web/node_modules/vite";
import { readData, variants } from "./representations.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("./", import.meta.url));
const webRequire = createRequire(join(root, "packages/web/package.json"));
const Y = await import(join(dirname(webRequire.resolve("yjs")), "yjs.mjs"));
const yjsVersion = webRequire("yjs/package.json").version;
assert.equal(yjsVersion, "13.6.32");
const { createServer } = await import(webRequire.resolve("vite"));
const input = resolve(process.argv[2] ?? "");
const chartDeps = resolve(process.argv[3] ?? "");
const chromiumDirectory = resolve(process.argv[4] ?? "");
const scratch = resolve(process.argv[5] ?? "");
assert(process.argv.length === 6, "pass input, private Chart.js, private Chromium, and private scratch directories");
assert(input !== root && scratch !== root);
const chartRequire = createRequire(join(chartDeps, "package.json"));
assert.equal(chartRequire("chart.js").Chart.version, "4.5.1");
// Playwright reads its cache location when first imported; keep it private.
process.env.PLAYWRIGHT_BROWSERS_PATH = chromiumDirectory;
const { chromium } = webRequire("@playwright/test");
const runDirectory = mkdtempSync(join(scratch, "temporal-browser-runtime-f6532a96c0274c069626c2452994d451-"));
// Playwright's profile/temp files also belong to this disposable run directory.
process.env.TMPDIR = runDirectory;
const workloadNames = [
  "delivery",
  "code-health-change-aware",
  "code-health-rewrite-all",
  "model-evaluation",
  "api-health",
];
const fileNames = new Set(workloadNames.flatMap((workload) => variants.flatMap((variant) =>
  ["history", "fresh"].map((state) => `${workload}-${variant}-${state}.bin`))));
let browser: Browser | undefined;
let vite: ViteDevServer | undefined;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await browser?.close();
  await vite?.close();
  rmSync(runDirectory, { recursive: true, force: true });
}
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 180_000);
process.on("SIGTERM", () => { void cleanup().finally(() => process.exit(1)); });
process.on("SIGINT", () => { void cleanup().finally(() => process.exit(1)); });

// Sort object keys but retain record/array order, making equality independent
// of an envelope versus a keyed projection's object insertion order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

// This browser module is generated into disposable scratch. The source is
// retained here so future runs need no discarded application files.
const client = `
import * as Y from "yjs";
import Chart from "chart.js/auto";
import { readData } from "./representations.mjs";
${canonical.toString()}
let currentChart;
const payloads = new Map();
async function fingerprint(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
window.temporalProbe = {
  drop(fileNames) { for (const fileName of fileNames) payloads.delete(fileName); },
  async load(fileName) {
    const response = await fetch("/binary/" + fileName);
    if (!response.ok) throw new Error("binary request failed " + response.status);
    payloads.set(fileName, new Uint8Array(await response.arrayBuffer()));
  },
  async sample(fileName, variant) {
    const bytes = payloads.get(fileName);
    if (!bytes) throw new Error("load before sample");
    if (currentChart) { currentChart.destroy(); currentChart = undefined; }
    const doc = new Y.Doc();
    const root = doc.getMap("spikeData");
    let localUpdates = 0;
    let remoteUpdates = 0;
    let observerCalls = 0;
    let chartRenders = 0;
    let applyMs;
    let projection;
    let resolveRender;
    let rejectRender;
    const rendered = new Promise((resolve, reject) => { resolveRender = resolve; rejectRender = reject; });
    doc.on("update", (_update, _origin, _doc, transaction) => {
      if (transaction.local) localUpdates += 1; else remoteUpdates += 1;
    });
    root.observeDeep(() => {
      observerCalls += 1;
      queueMicrotask(() => {
        try {
          const projectionStarted = performance.now();
          projection = readData(doc, variant);
          const rows = projection.collections.summaries.records;
          const labels = rows.map((row) => row.day);
          const values = rows.map((row) => row.value);
          const projected = performance.now();
          currentChart = new Chart(document.getElementById("chart"), {
            type: "line",
            data: { labels, datasets: [{ label: "Synthetic daily/run summaries", data: values, borderColor: "#2563eb", pointRadius: 0, borderWidth: 2 }] },
            options: { animation: false, responsive: false, devicePixelRatio: 1,
              plugins: { legend: { display: true } },
              scales: { x: { ticks: { maxTicksLimit: 12 } } } },
          });
          chartRenders += 1;
          const drawn = performance.now();
          requestAnimationFrame(() => resolveRender({
            projectionMs: projected - projectionStarted,
            chartDrawMs: drawn - projected,
            nextAnimationFrameMs: performance.now() - drawn,
            summaryRecords: rows.length,
            totalRecords: Object.values(projection.collections).reduce((sum, collection) => sum + collection.records.length, 0),
          }));
        } catch (error) { rejectRender(error); }
      });
    });
    try {
      const applyStarted = performance.now();
      Y.applyUpdate(doc, bytes, "temporal-cold-load");
      applyMs = performance.now() - applyStarted;
      const timing = await rendered;
      const hash = await fingerprint(projection);
      return { browserApplyMs: applyMs, ...timing, fingerprint: hash,
        localUpdates, remoteUpdates, observerCalls, chartRenders };
    } finally { doc.destroy(); }
  },
};
`;

interface BrowserSample {
  browserApplyMs: number;
  projectionMs: number;
  chartDrawMs: number;
  nextAnimationFrameMs: number;
  summaryRecords: number;
  totalRecords: number;
  fingerprint: string;
  localUpdates: number;
  remoteUpdates: number;
  observerCalls: number;
  chartRenders: number;
}
function summary(samples: BrowserSample[]) {
  return Object.fromEntries(["browserApplyMs", "projectionMs", "chartDrawMs", "nextAnimationFrameMs"].map((metric) => {
    const values = samples.map((sample) => sample[metric]).sort((a, b) => a - b);
    return [metric, { median: values[3], min: values[0], max: values[6] }];
  }));
}

try {
  writeFileSync(join(runDirectory, "index.html"), '<!doctype html><meta charset="utf-8"><title>Private temporal chart probe</title><canvas id="chart" width="940" height="430"></canvas><script type="module" src="/client.mjs"></script>');
  writeFileSync(join(runDirectory, "client.mjs"), client);
  copyFileSync(join(output, "representations.mjs"), join(runDirectory, "representations.mjs"));
  vite = await createServer({
    configFile: false,
    root: runDirectory,
    cacheDir: join(runDirectory, "vite-f6532a96c0274c069626c2452994d451"),
    logLevel: "error",
    resolve: { alias: {
      yjs: join(dirname(webRequire.resolve("yjs")), "yjs.mjs"),
      "chart.js/auto": chartRequire.resolve("chart.js/auto"),
    } },
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root, chartDeps, runDirectory] } },
    plugins: [{ name: "private-temporal-binary", configureServer(server) {
      server.middlewares.use("/binary", (request, response) => {
        const name = request.url?.slice(1);
        if (!name || !fileNames.has(name)) { response.statusCode = 404; response.end(); return; }
        response.setHeader("Content-Type", "application/octet-stream");
        response.end(readFileSync(join(input, name)));
      });
    } }],
  });
  await vite.listen();
  const vitePort = vite.httpServer.address().port;
  browser = await chromium.launch({ headless: true, timeout: 15_000 });
  const context = await browser.newContext({ viewport: { width: 1120, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(String(error)); });
  await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: "networkidle", timeout: 15_000 });
  await page.waitForFunction(() => window.temporalProbe !== undefined);
  const results = {
    method: {
      kind: "Browser microbenchmark only; no hub, transport, MCP tool, editor or ub open path.",
      histories: "365-day deterministic final historical/full-state binaries and freshly encoded identical live data produced by temporal.ts; comparison isolates history effects at the same live-record count.",
      samples: "One discarded warmup for each state, then seven retained samples. Every sample creates an empty Y.Doc and a new Chart.js line chart; JavaScript engine/modules stay warm. Historical/fresh sample order alternates per repetition.",
      inputs: "One historical/fresh binary pair is fetched/cached before timing, then dropped before the next pair. Browser context/page startup, fetching, reference comparison and SHA-256 hashing are outside timing.",
      browserApply: "performance.now around synchronous Y.applyUpdate on an empty Y.Doc, with one read-only observer that queues a microtask. This includes synchronous observer scheduling and update callbacks, but excludes projection and chart work.",
      projection: "Existing readData full projection of all three collections, including clones/scans/sort; plus arrays of summary days and values for the chart. No changed-key incremental projection.",
      chartDraw: "New Chart.js line instance on fixed 940 x 430 canvas, DPR 1, animation/responsive disabled, no point markers; summaries collection only, with at most 12 x ticks. All collections remain in the document/projection.",
      observer: "Cold-load update triggers one deep observer and one queued chart render. The fixture observer only projects and draws; detached readData values expose no Yjs mutation handles. Assertions require zero local updates. This is not a production capability-enforcement test.",
      nextFrame: "requestAnimationFrame after synchronous drawing is a paint opportunity proxy, not GPU presentation or user-visible completion.",
      equality: "Canonical SHA-256 of full detached projection; sorted object keys, retained array/record order. Compare browser against Node reference and all variants' historical/fresh live data. Exact Node deep equality also checked.",
      precision: "Non-isolated Chromium performance.now may quantize around 0.1 ms; tiny operations may read zero. Seven samples support only median/min/max, not stable tail-latency claims.",
    },
    environment: { platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    versions: { node: process.versions.node, chromium: browser.version(), playwright: webRequire("@playwright/test/package.json").version, vite: webRequire("vite/package.json").version, yjs: yjsVersion, chartjs: "4.5.1" },
    samples: 7,
    warmups: 1,
    cases: [],
    assertions: { pageErrors: 0, allProjectionsEqualToReferences: true, allLocalUpdatesZero: true },
  };
  for (const workload of workloadNames) {
    let reference: unknown;
    for (const variant of variants) {
      const stateFiles = Object.fromEntries(["history", "fresh"].map((state) => [state, `${workload}-${variant}-${state}.bin`]));
      const nodeData = {};
      for (const state of ["history", "fresh"]) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, readFileSync(join(input, stateFiles[state])));
        nodeData[state] = readData(doc, variant);
        doc.destroy();
        await page.evaluate((fileName) => window.temporalProbe.load(fileName), stateFiles[state]);
      }
      assert.deepEqual(nodeData.history, nodeData.fresh);
      if (reference === undefined) reference = nodeData.history;
      else assert.deepEqual(nodeData.history, reference);
      const expectedHash = fingerprint(nodeData.history);
      const retained: Record<string, BrowserSample[]> = { history: [], fresh: [] };
      for (let repetition = -1; repetition < 7; repetition += 1) {
        const stateOrder = repetition % 2 === 0 ? ["history", "fresh"] : ["fresh", "history"];
        for (const state of stateOrder) {
          const sample = await page.evaluate(({ fileName, variant }) => window.temporalProbe.sample(fileName, variant), { fileName: stateFiles[state], variant });
          assert.equal(sample.fingerprint, expectedHash);
          assert.equal(sample.localUpdates, 0);
          assert.equal(sample.remoteUpdates, 1);
          assert.equal(sample.observerCalls, 1);
          assert.equal(sample.chartRenders, 1);
          assert(Object.values(sample).filter((value) => typeof value === "number").every((value) => Number.isFinite(value) && value >= 0));
          if (repetition >= 0) retained[state].push(sample);
        }
      }
      for (const state of ["history", "fresh"]) {
        const samples = retained[state];
        const encoded = readFileSync(join(input, stateFiles[state]));
        results.cases.push({ workload, variant, state, encodedBytes: encoded.byteLength, encodedSha256: createHash("sha256").update(encoded).digest("hex"),
          fingerprint: expectedHash, summaryRecords: samples[0].summaryRecords, totalRecords: samples[0].totalRecords,
          summary: summary(samples), rawSamples: samples });
      }
      await page.evaluate((fileNames) => window.temporalProbe.drop(fileNames), Object.values(stateFiles));
      console.log(JSON.stringify({ workload, variant, history: summary(retained.history), fresh: summary(retained.fresh) }));
    }
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(output, "temporal-browser-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await context.close();
} finally {
  clearTimeout(deadline);
  await cleanup();
}
