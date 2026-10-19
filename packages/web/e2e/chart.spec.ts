/**
 * Charts consume document data through the production serving replica.
 * The writer is a different `ub mcp serve` process with its own SQLite state;
 * none of these browsers bypasses `ub open` by dialing the upstream hub.
 */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { writeFileSync } from "node:fs";
import { composite, pageGrounds } from "../test/colour.js";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { setNativeSelection } from "./native-selection.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { renderedText, strokeSeparation } from "./contrast-helpers.js";
import { expectMcp, proveMcpArrival, waitForDocumentDraw } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-chart-${process.env.UB_AGENTS_RUN ?? "local"}-`,
  });
});
test.afterEach(async () => {
  await agent?.closeSessions();
});
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: chart MCP agent is not configured");
  return agent.open({ name: "chart-data-e2e" });
}

test("all eight panel caption colours keep AA on the blue tint in both appearances", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const mapping = { ...MAPPING, layout: "panels", y: Array.from({ length: 8 }, (_, index) => ({
    field: "latency", label: `Series ${index + 1}`, unit: "ms",
  })) };
  const uuid = await chartDoc(session, "Eight panel inks", mapping);
  await measurements(session, uuid);
  for (const appearance of ["light", "dark"] as const) {
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { viewport: { width: 1366, height: 900 }, colorScheme: appearance },
    });
    await expectReady(page, session, uuid);
    const panels = page.locator(".ub-chart-series-panel");
    await expect(panels).toHaveCount(8);
    const colours = await panels.locator(".ub-chart-series-header").evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).color));
    expect(new Set(colours).size).toBe(8);
    for (let index = 0; index < 8; index += 1) {
      const selector = `.ub-chart-series-panel:nth-child(${index + 1}) .ub-chart-series-header`;
      await page.locator(selector).scrollIntoViewIfNeeded();
      const readings = await renderedText(page, selector);
      expect(readings.length).toBeGreaterThan(0);
      for (const reading of readings) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
    }
  }
});

interface DocPayload {
  uuid: string;
  blocks: { id: string; type: string; text: string; rev: string }[];
}

const MAPPING = {
  version: 1, type: "line", collection: "measurements", title: "API latency",
  x: { field: "day", type: "date", label: "Day" },
  y: [
    { field: "latency", label: "Latency", unit: "ms" },
    { field: "errors", label: "Errors", unit: "requests" },
  ],
};
const SCHEMA = {
  version: 1,
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      day: { type: "string" },
      latency: { type: ["number", "null"] },
      errors: { type: ["number", "null"] },
    },
    required: ["day"],
  },
};

interface PaintedText { canvas: number; text: string; x: number; y: number; width: number; left: number; right: number; font: string; rotated: boolean }
interface PaintedPoint { canvas: number; x: number; y: number; radius: number }
interface ChartPaintProbe { texts: string[]; ink: PaintedText[]; points: PaintedPoint[] }
interface PaintedRectangle { left: number; right: number; top: number; bottom: number }
interface PaintedBar extends PaintedRectangle { canvas: number; color: string; clip: PaintedRectangle | null; sequence: number }
interface BarPaintProbe { bars: PaintedBar[]; points: { canvas: number; sequence: number }[] }

/** Tick anchors and point anchors are observed independently from canvas calls. */
async function expectObservationGeometry(
  page: Page, observations: { value: number; label: string }[], pattern: RegExp, all = false, canvasIndex = 0,
  minimumGap = 0,
): Promise<PaintedText[]> {
  const probe = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe);
  const pointXs = [...new Set(probe.points.filter((point) => point.canvas === canvasIndex)
    .map((point) => Number(point.x.toFixed(6))))].sort((a, b) => a - b);
  expect(pointXs).toHaveLength(observations.length);
  const first = pointXs[0], last = pointXs.at(-1);
  const firstValue = observations[0]?.value, lastValue = observations.at(-1)?.value;
  if (first === undefined || last === undefined || firstValue === undefined || lastValue === undefined) {
    throw new Error("e2e: chart observation anchors are missing");
  }
  if (observations.length > 1) {
    observations.forEach((observation, index) => {
      expect(((pointXs[index] ?? NaN) - first) / (last - first))
        .toBeCloseTo((observation.value - firstValue) / (lastValue - firstValue), 5);
    });
  }
  const labels = probe.ink.filter((entry) => entry.canvas === canvasIndex && pattern.test(entry.text)).sort((a, b) => a.x - b.x);
  expect(labels.length).toBeGreaterThan(0);
  const labeled = new Set<number>();
  for (const label of labels) {
    const index = pointXs.findIndex((pointX) => Math.abs(pointX - label.x) < 0.5);
    expect(index, `tick ${label.text} has no plotted observation`).toBeGreaterThanOrEqual(0);
    expect(label.text).toBe(observations[index]?.label);
    expect(labeled.has(index)).toBe(false);
    labeled.add(index);
    expect(label.rotated).toBe(false);
  }
  for (let index = 1; index < labels.length; index += 1) {
    expect((labels[index]?.left ?? -Infinity) - (labels[index - 1]?.right ?? Infinity)).toBeGreaterThanOrEqual(minimumGap - 0.5);
  }
  if (all) expect(labels).toHaveLength(observations.length);
  else {
    const widths = await page.locator(".ub-chart canvas").nth(canvasIndex).evaluate((element, options) => {
      const context = (element as HTMLCanvasElement).getContext("2d");
      if (context === null) throw new Error("e2e: chart has no drawing context");
      context.save();
      context.font = options.font;
      const measured = options.labels.map((label) => context.measureText(label).width);
      context.restore();
      return measured;
    }, { font: labels[0]?.font ?? "", labels: observations.map((observation) => observation.label) });
    observations.forEach((_observation, index) => {
      if (labeled.has(index)) return;
      const x = pointXs[index] ?? NaN;
      const halfWidth = ((widths[index] ?? NaN) + minimumGap) / 2;
      expect(labels.some((label) => x - halfWidth < label.x + (label.width + minimumGap) / 2
        && x + halfWidth > label.x - (label.width + minimumGap) / 2), `observation ${index} was omitted without overlap`).toBe(true);
    });
  }
  return labels;
}

/** Data-point anchors independently recover the value at each painted y label. */
async function expectPanelTickGeometry(
  page: Page, canvasIndex: number, values: number[], unit: string, markerHeadroom = false, maximumTicks = 3,
): Promise<PaintedText[]> {
  const probe = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe);
  const points = probe.points.filter(entry => entry.canvas === canvasIndex);
  expect(points).toHaveLength(values.length);
  const ticks = probe.ink.filter(entry => entry.canvas === canvasIndex && entry.text.endsWith(unit));
  expect(ticks.length).toBeGreaterThanOrEqual(2);
  expect(ticks.length).toBeLessThanOrEqual(maximumTicks);
  const first = points[0], last = points.at(-1), firstValue = values[0], lastValue = values.at(-1);
  if (first === undefined || last === undefined || firstValue === undefined || lastValue === undefined) {
    throw new Error("e2e: panel value anchors are missing");
  }
  expect(lastValue).not.toBe(firstValue);
  for (const tick of ticks) {
    const number = tick.text.slice(0, -unit.length).trim().replaceAll(",", "");
    const match = /^(-?\d+(?:\.\d+)?)([KMBT]?)$/.exec(number);
    expect(match, `unrecognized compact tick ${tick.text}`).not.toBeNull();
    const divisors: Record<string, number> = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    const labeledValue = Number(match?.[1]) * (divisors[match?.[2] ?? ""] ?? NaN);
    const plottedValue = firstValue + (tick.y - first.y) / (last.y - first.y) * (lastValue - firstValue);
    expect(labeledValue, `tick ${tick.text} misstates its gridline value`).toBeCloseTo(plottedValue, 3);
    expect(tick.left, `tick ${tick.text} extends outside its canvas`).toBeGreaterThanOrEqual(-0.5);
  }
  const top = Math.min(...ticks.map(entry => entry.y)), bottom = Math.max(...ticks.map(entry => entry.y));
  for (const point of points) {
    const radius = markerHeadroom ? point.radius : 0;
    expect(point.y - radius, "marker has no headroom above the plotted value").toBeGreaterThan(top);
    expect(point.y + radius, "marker has no headroom below the plotted value").toBeLessThan(bottom);
  }
  return ticks;
}

/** Read a full-width neutral stroke at the value recovered from painted ticks. */
async function referenceInk(page: Page, canvasIndex: number, value: number, unit: string, bounds?: PaintedRectangle): Promise<number> {
  return page.evaluate(({ canvasIndex, value, unit, bounds }) => {
    const probe = (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe;
    const canvas = document.querySelectorAll<HTMLCanvasElement>(".ub-chart canvas")[canvasIndex];
    const colourProbe = document.querySelector(".ub-chart-probe");
    if (canvas === undefined || colourProbe === null) throw new Error("e2e: reference canvas is missing");
    const ticks = probe.ink.filter(entry => entry.canvas === canvasIndex && entry.text.endsWith(unit))
      .map(entry => ({ y: entry.y, value: Number(entry.text.slice(0, -unit.length).trim().replaceAll(",", "")) }))
      .filter(entry => Number.isFinite(entry.value)).sort((a, b) => a.value - b.value);
    const first = ticks[0], last = ticks.at(-1);
    const points = probe.points.filter(entry => entry.canvas === canvasIndex);
    if (first === undefined || last === undefined || first.value === last.value || (bounds === undefined && points.length === 0)) {
      throw new Error(`e2e: reference geometry is missing: ${JSON.stringify({ ticks, points: points.length })}`);
    }
    const y = first.y + (value - first.value) / (last.value - first.value) * (last.y - first.y);
    const box = canvas.getBoundingClientRect();
    const scaleX = canvas.width / box.width, scaleY = canvas.height / box.height;
    const left = Math.ceil(((bounds?.left ?? Math.min(...points.map(point => point.x))) + 8) * scaleX);
    const right = Math.floor(((bounds?.right ?? Math.max(...points.map(point => point.x))) - 8) * scaleX);
    const context = canvas.getContext("2d");
    const sample = document.createElement("canvas").getContext("2d");
    if (context === null || sample === null) throw new Error("e2e: reference pixels are unavailable");
    sample.fillStyle = getComputedStyle(colourProbe).color;
    sample.fillRect(0, 0, 1, 1);
    const neutral = sample.getImageData(0, 0, 1, 1).data;
    let coverage = 0;
    for (let row = Math.floor(y * scaleY) - 2; row <= Math.ceil(y * scaleY) + 2; row += 1) {
      const pixels = context.getImageData(left, row, right - left, 1).data;
      let matching = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if ((pixels[offset + 3] ?? 0) >= 100 && [0, 1, 2].every(channel =>
          Math.abs((pixels[offset + channel] ?? 0) - (neutral[channel] ?? 0)) < 20)) matching += 1;
      }
      coverage = Math.max(coverage, matching / (right - left));
    }
    return coverage;
  }, { canvasIndex, value, unit, bounds });
}

/** One caption holds the chart label, title and controls in every state. */
async function expectCornerControls(page: Page, sourceName = "Open chart source"): Promise<void> {
  const root = page.locator(".ub-chart");
  const caption = root.locator(".ub-block-caption");
  const source = page.getByRole("button", { name: sourceName, exact: true });
  const copy = root.locator(".ub-copy");
  await expect(source).toHaveText("Source");
  await expect(source).toBeVisible();
  await expect(copy).toBeVisible();
  await expect(caption).toHaveCount(1);
  await expect(caption).toBeVisible();
  await expect(caption.locator(".ub-block-label")).toContainText("Chart");
  const rootBox = await root.boundingBox();
  const captionBox = await caption.boundingBox();
  const sourceBox = await source.boundingBox();
  const copyBox = await copy.boundingBox();
  if (rootBox === null || captionBox === null || sourceBox === null || copyBox === null) throw new Error("e2e: chart caption controls have no box");
  expect(copyBox.x).toBeGreaterThan(rootBox.x + rootBox.width / 2);
  expect(sourceBox.x).toBeGreaterThanOrEqual(copyBox.x + copyBox.width);
  expect(sourceBox.x + sourceBox.width).toBeLessThanOrEqual(rootBox.x + rootBox.width);
  for (const box of [sourceBox, copyBox]) {
    expect(box.y).toBeGreaterThanOrEqual(captionBox.y);
    expect(box.y + box.height).toBeLessThanOrEqual(captionBox.y + captionBox.height + 0.5);
  }
  const title = caption.locator(".ub-chart-title");
  if (await title.isVisible()) {
    const titleBox = await title.boundingBox();
    if (titleBox === null) throw new Error("e2e: chart title has no box");
    expect(Math.max(sourceBox.y, titleBox.y)).toBeLessThan(Math.min(sourceBox.y + sourceBox.height, titleBox.y + titleBox.height));
    expect(Math.max(copyBox.y, titleBox.y)).toBeLessThan(Math.min(copyBox.y + copyBox.height, titleBox.y + titleBox.height));
  }
}

async function canvasEvidence(canvas: Locator, info: TestInfo, name: string): Promise<void> {
  const screenshot = info.outputPath(`${name}.png`);
  await canvas.screenshot({ path: screenshot });
  await info.attach(name, { path: screenshot, contentType: "image/png" });
}

async function chartDoc(session: McpSession, title: string, mapping: unknown = MAPPING): Promise<string> {
  const result = await session.call<{ uuid: string }>("create_doc", {
    title, description: "Live line-chart browser proof from document-owned measurements.",
    blocks: [
      { type: "paragraph", text: "Read the live measurements below." },
      { type: "chart", text: JSON.stringify(mapping) },
    ],
  });
  return result.uuid;
}

async function editMapping(session: McpSession, uuid: string, text: string, index = 0): Promise<void> {
  const doc = await session.call<DocPayload>("get_doc", { uuid });
  const block = doc.blocks.filter((entry) => entry.type === "chart")[index];
  if (block === undefined) throw new Error("e2e: no chart block in get_doc");
  await session.call("edit_block", {
    uuid, block_id: block.id, old_text: block.text, new_text: text, rev: block.rev,
  });
}

async function measurements(session: McpSession, uuid: string, latency = 125): Promise<void> {
  await session.call("update_data", {
    uuid,
    operations: [{
      collection: "measurements", schema: SCHEMA,
      replaceRecords: [
        { id: "first", value: { day: "2026-01-01", latency: 80, errors: 3 } },
        { id: "latest", value: { day: "2026-01-02", latency, errors: 4 } },
        { id: "missing", value: { day: "2026-01-03", latency: null, errors: null } },
        { id: "bad-date", value: { day: "2026-02-31", latency: 70, errors: 2 } },
      ],
    }],
  });
}

async function expectReady(page: Page, session: McpSession, uuid: string): Promise<void> {
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.getByRole("img", { name: "API latency", exact: true })).toBeVisible();
}

/**
 * Read Tiptap's existing editor reference and y-sync plugin, never a product
 * test hook. A data-map observation marks when the browser has applied an
 * update; the drawn revision marks the completion of the synchronous
 * Chart.js draw. Instrumentation subscribes read-only and is removed on page
 * destruction. The measured interval includes the scheduled animation frame,
 * whole-area validation, projection, canvas update and text alternative.
 */
async function installProbe(page: Page, uuid: string): Promise<void> {
  await page.addInitScript((targetUuid) => {
    type DataMap = {
      size: number;
      _map?: Map<string, unknown>;
      doc?: SharedDoc;
      observe(listener: () => void): void;
      unobserve(listener: () => void): void;
    };
    type SharedDoc = {
      share: Map<string, DataMap>;
      getMap(name: string): { get(key: string): unknown };
      on(event: string, listener: (...args: unknown[]) => void): void;
      off(event: string, listener: (...args: unknown[]) => void): void;
    };
    type EditorState = { plugins: { key: string; getState(state: EditorState): { doc?: SharedDoc } }[] };
    type MountedEditor = HTMLElement & { editor?: { state: EditorState } };
    const probe = {
      localUpdates: 0, appliedAt: 0, availableAt: 0, availableEntries: 0,
      first: null as number | null,
      durations: [] as number[], texts: [] as string[], paints: [] as string[], lastRevision: "",
      ink: [] as PaintedText[], points: [] as PaintedPoint[],
    };
    (window as unknown as { chartProbe: typeof probe }).chartProbe = probe;
    // Yjs integrates a shared root before inserting it into doc.share. Observe
    // that existing native Map operation so the availability clock can start
    // after the initial data transaction, before an editor exists. The owning
    // doc, root identity and stored UUID distinguish this from ordinary maps.
    // AbstractType becomes Y.Map later; the doc-level listener survives that.
    const nativeSet = Map.prototype.set;
    const initialDocs = new Map<SharedDoc, (...args: unknown[]) => void>();
    Map.prototype.set = function (key: unknown, value: unknown): Map<unknown, unknown> {
      const result = nativeSet.call(this, key, value) as Map<unknown, unknown>;
      if (key === "data" && typeof value === "object" && value !== null) {
        const root = value as DataMap;
        const owning = root.doc;
        if (owning?.share === this && !initialDocs.has(owning)) {
          const after = (): void => {
            const dataRoot = owning.share.get("data");
            const entries = dataRoot?.size ?? dataRoot?._map?.size ?? 0;
            if (probe.availableAt === 0 && entries > 0 && owning.share.has("meta") &&
                owning.getMap("meta").get("uuid") === targetUuid) {
              probe.availableAt = performance.now();
              probe.availableEntries = entries;
            }
          };
          initialDocs.set(owning, after);
          owning.on("afterTransaction", after);
        }
      }
      return result;
    };
    let doc: SharedDoc | undefined;
    let data: DataMap | undefined;
    const applied = (): void => { probe.appliedAt = performance.now(); };
    const updated = (...args: unknown[]): void => {
      const transaction = args[3] as { local?: boolean } | undefined;
      if (transaction?.local === true) probe.localUpdates += 1;
    };
    const mutations = new MutationObserver(() => {
      const mounted = document.querySelector<MountedEditor>(".ub-editor .ProseMirror");
      const state = mounted?.editor?.state;
      const nextDoc = state?.plugins.find((plugin) => plugin.key.startsWith("y-sync"))?.getState(state).doc;
      if (nextDoc !== undefined && nextDoc !== doc) {
        doc?.off("update", updated);
        data?.unobserve(applied);
        doc = nextDoc;
        data = doc.share.get("data");
        doc.on("update", updated);
        data?.observe(applied);
        if ((data?.size ?? 0) > 0) applied();
      }
      // A missing data root can arrive after the editor mounts.
      if (doc !== undefined && data === undefined) {
        data = doc.share.get("data");
        data?.observe(applied);
      }
      const drawn = document.querySelector<HTMLElement>('.ub-chart[data-draw-state="success"]');
      const revision = drawn?.dataset.dataRev ?? "";
      if (revision !== "" && revision !== probe.lastRevision) {
        probe.lastRevision = revision;
        if (probe.appliedAt !== 0) {
          const duration = performance.now() - probe.appliedAt;
          if (probe.first === null && probe.availableAt !== 0) {
            probe.first = performance.now() - probe.availableAt;
          }
          else probe.durations.push(duration);
        }
      }
    });
    mutations.observe(document, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-source-rev", "data-data-rev", "data-draw-state"] });
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args: Parameters<typeof clearRect>): void {
      if (this.canvas.closest(".ub-chart") !== null && args[0] === 0 && args[1] === 0
        && args[2] === this.canvas.width && args[3] === this.canvas.height) {
        // Geometry belongs to the current draw, not an accumulation of old
        // ranges, responsive layouts or appearance changes.
        const canvas = [...document.querySelectorAll(".ub-chart canvas")].indexOf(this.canvas);
        probe.ink = probe.ink.filter((entry) => entry.canvas !== canvas);
        probe.points = probe.points.filter((entry) => entry.canvas !== canvas);
      }
      clearRect.apply(this, args);
    };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof fillText>): void {
      if (this.canvas.closest(".ub-chart") !== null) {
        probe.texts.push(args[0]);
        if (typeof this.fillStyle === "string") probe.paints.push(this.fillStyle);
        const transform = this.getTransform();
        const position = transform.transformPoint({ x: args[1], y: args[2] });
        const box = this.canvas.getBoundingClientRect();
        const metrics = this.measureText(args[0]);
        const left = transform.transformPoint({ x: args[1] - metrics.actualBoundingBoxLeft, y: args[2] });
        const right = transform.transformPoint({ x: args[1] + metrics.actualBoundingBoxRight, y: args[2] });
        probe.ink.push({ canvas: [...document.querySelectorAll(".ub-chart canvas")].indexOf(this.canvas),
          text: args[0], x: position.x * box.width / this.canvas.width,
          y: position.y * box.height / this.canvas.height,
          width: metrics.width * Math.hypot(transform.a, transform.b) * box.width / this.canvas.width,
          left: left.x * box.width / this.canvas.width, right: right.x * box.width / this.canvas.width, font: this.font,
          rotated: Math.abs(transform.b) > 0.000001 || Math.abs(transform.c) > 0.000001 });
      }
      fillText.apply(this, args);
    };
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function (...args: Parameters<typeof arc>): void {
      if (this.canvas.closest(".ub-chart") !== null && args[2] > 0) {
        const position = this.getTransform().transformPoint({ x: args[0], y: args[1] });
        const box = this.canvas.getBoundingClientRect();
        probe.points.push({ canvas: [...document.querySelectorAll(".ub-chart canvas")].indexOf(this.canvas),
          x: position.x * box.width / this.canvas.width,
          y: position.y * box.height / this.canvas.height, radius: args[2] });
      }
      arc.apply(this, args);
    };
    addEventListener("pagehide", () => {
      mutations.disconnect();
      doc?.off("update", updated);
      data?.unobserve(applied);
      for (const [initial, listener] of initialDocs) initial.off("afterTransaction", listener);
      initialDocs.clear();
      Map.prototype.set = nativeSet;
      CanvasRenderingContext2D.prototype.clearRect = clearRect;
      CanvasRenderingContext2D.prototype.fillText = fillText;
      CanvasRenderingContext2D.prototype.arc = arc;
    });
  }, uuid);
}

/** Observe the native bar fill and its clipping rectangle, independently of Chart.js state. */
async function installBarProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: BarPaintProbe = { bars: [], points: [] };
    (window as unknown as { barProbe: BarPaintProbe }).barProbe = probe;
    let sequence = 0;
    const states = new WeakMap<CanvasRenderingContext2D, {
      path: PaintedRectangle[]; clip: PaintedRectangle | null; saved: (PaintedRectangle | null)[];
    }>();
    const state = (context: CanvasRenderingContext2D) => {
      let current = states.get(context);
      if (current === undefined) {
        current = { path: [], clip: null, saved: [] };
        states.set(context, current);
      }
      return current;
    };
    const canvasIndex = (context: CanvasRenderingContext2D): number =>
      [...document.querySelectorAll(".ub-chart canvas")].indexOf(context.canvas);
    const prototype = CanvasRenderingContext2D.prototype;
    const { save, restore, beginPath, rect, clip, fill, arc, clearRect } = prototype;
    prototype.save = function (): void { state(this).saved.push(state(this).clip); save.call(this); };
    prototype.restore = function (): void { state(this).clip = state(this).saved.pop() ?? null; restore.call(this); };
    prototype.beginPath = function (): void { state(this).path = []; beginPath.call(this); };
    prototype.rect = function (...args: Parameters<typeof rect>): void {
      if (canvasIndex(this) >= 0) {
        const transform = this.getTransform();
        const first = transform.transformPoint({ x: args[0], y: args[1] });
        const last = transform.transformPoint({ x: args[0] + args[2], y: args[1] + args[3] });
        const box = this.canvas.getBoundingClientRect();
        state(this).path.push({
          left: Math.min(first.x, last.x) * box.width / this.canvas.width,
          right: Math.max(first.x, last.x) * box.width / this.canvas.width,
          top: Math.min(first.y, last.y) * box.height / this.canvas.height,
          bottom: Math.max(first.y, last.y) * box.height / this.canvas.height,
        });
      }
      rect.apply(this, args);
    };
    prototype.clip = function (path?: CanvasFillRule | Path2D, fillRule?: CanvasFillRule): void {
      const rectangle = state(this).path.at(-1);
      if (rectangle !== undefined) state(this).clip = rectangle;
      Reflect.apply(clip, this, path === undefined ? [] : [path, fillRule]);
    };
    prototype.fill = function (path?: CanvasFillRule | Path2D, fillRule?: CanvasFillRule): void {
      const canvas = canvasIndex(this);
      if (canvas >= 0) {
        for (const rectangle of state(this).path) {
          probe.bars.push({ ...rectangle, canvas, clip: state(this).clip,
            color: String(this.fillStyle), sequence: sequence++ });
        }
      }
      Reflect.apply(fill, this, path === undefined ? [] : [path, fillRule]);
    };
    prototype.arc = function (...args: Parameters<typeof arc>): void {
      const canvas = canvasIndex(this);
      if (canvas >= 0 && state(this).clip !== null && args[2] > 0) probe.points.push({ canvas, sequence: sequence++ });
      arc.apply(this, args);
    };
    prototype.clearRect = function (...args: Parameters<typeof clearRect>): void {
      if (args[0] === 0 && args[1] === 0 && args[2] === this.canvas.width && args[3] === this.canvas.height) {
        const canvas = canvasIndex(this);
        probe.bars = probe.bars.filter(entry => entry.canvas !== canvas);
        probe.points = probe.points.filter(entry => entry.canvas !== canvas);
      }
      clearRect.apply(this, args);
    };
    addEventListener("pagehide", () => Object.assign(prototype, { save, restore, beginPath, rect, clip, fill, arc, clearRect }));
  });
}

async function barGeometry(page: Page): Promise<PaintedBar[]> {
  const bars = await page.evaluate(() => (window as unknown as { barProbe: BarPaintProbe }).barProbe.bars);
  return bars.filter(bar => bar.clip !== null && bar.clip.bottom - bar.clip.top > 40 && bar.right > bar.left && bar.bottom > bar.top);
}

function expectContainedBars(bars: PaintedBar[]): void {
  expect(bars.length).toBeGreaterThan(0);
  for (const bar of bars) {
    if (bar.clip === null) throw new Error("e2e: bar has no plot clip");
    expect(bar.left).toBeGreaterThanOrEqual(bar.clip.left - 0.5);
    expect(bar.right).toBeLessThanOrEqual(bar.clip.right + 0.5);
    expect(bar.top).toBeGreaterThanOrEqual(bar.clip.top - 0.5);
    expect(bar.bottom).toBeLessThanOrEqual(bar.clip.bottom + 0.5);
  }
}

test("mixed charts paint grouped bars behind lines with ordered legend and shared tooltips", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const mapping = {
    version: 1, type: "line", collection: "measurements", title: "Monthly survey", missing: "connect",
    x: { field: "day", type: "date" }, y: [
      { field: "responses", label: "Responses", unit: "responses", type: "bar" },
      { field: "score", label: "Score", unit: "%" },
      { field: "returning", label: "Returning", unit: "responses", type: "bar" },
    ],
  };
  const uuid = await chartDoc(session, "Survey with observation counts", mapping);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements",
    schema: { version: 1, schema: { type: "object" } }, replaceRecords: [
      { id: "first", value: { day: "2026-01-01", score: 42, responses: 320, returning: 120 } },
      { id: "middle", value: { day: "2026-02-01", score: 58, responses: 45, returning: 22 } },
      { id: "last", value: { day: "2026-03-01", score: 65, responses: 410, returning: 240 } },
    ],
  }] });
  for (const appearance of ["light", "dark"] as const) {
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: async loading => { await installProbe(loading, uuid); await installBarProbe(loading); },
      contextOptions: { viewport: { width: 1366, height: 900 }, locale: "en-US", colorScheme: appearance },
    });
    await waitForDocumentDraw(page, session, uuid);
    const image = page.getByRole("img", { name: "Monthly survey", exact: true });
    await expect(image).toBeVisible();
    const bars = await barGeometry(page);
    expect(bars).toHaveLength(6);
    expectContainedBars(bars);
    const probe = await page.evaluate(() => (window as unknown as { barProbe: BarPaintProbe }).barProbe);
    expect(probe.points).toHaveLength(3);
    expect(Math.max(...bars.map(bar => bar.sequence))).toBeLessThan(Math.min(...probe.points.map(point => point.sequence)));
    const ink = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink);
    const legend = ink.filter(entry => ["Responses (responses)", "Score (%)", "Returning (responses)"].includes(entry.text));
    expect(legend.map(entry => entry.text)).toEqual(["Responses (responses)", "Score (%)", "Returning (responses)"]);
    const swatches = probe.bars.filter(bar => bar.clip !== null && bar.clip.bottom - bar.clip.top <= 40 && bar.bottom > bar.top);
    expect(swatches).toHaveLength(2);
    expect(swatches[0]?.color).not.toBe(swatches[1]?.color);
    const responses = bars.filter(bar => bar.color === swatches[0]?.color).sort((a, b) => a.left - b.left);
    const returning = bars.filter(bar => bar.color === swatches[1]?.color).sort((a, b) => a.left - b.left);
    expect(responses).toHaveLength(3);
    expect(returning).toHaveLength(3);
    responses.forEach((bar, index) => { expect(bar.right).toBeLessThan(returning[index]?.left ?? -Infinity); });
    const leftTicks = ink.filter(entry => /^\d+%$/.test(entry.text));
    const rightTicks = ink.filter(entry => /^\d+ responses$/.test(entry.text));
    expect(leftTicks.length).toBeGreaterThan(0);
    expect(rightTicks.length).toBeGreaterThan(0);
    expect(Math.max(...leftTicks.map(entry => entry.right))).toBeLessThan(Math.min(...bars.map(bar => bar.left)));
    expect(Math.min(...rightTicks.map(entry => entry.left))).toBeGreaterThan(Math.max(...bars.map(bar => bar.right)));
    const block = page.locator(".ub-chart");
    await canvasEvidence(block, info, `chart-mixed-desktop-${appearance}`);
    const box = await image.boundingBox();
    if (box === null) throw new Error("e2e: mixed chart has no canvas box");
    const middle = responses[1];
    if (middle === undefined) throw new Error("e2e: grouped bar is missing");
    await page.evaluate(() => { (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts = []; });
    await page.mouse.move(box.x + (middle.left + middle.right) / 2, box.y + box.height / 3);
    const tooltip = ["Responses: 45 responses", "Score: 58 %", "Returning: 22 responses"];
    await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts
      .filter(text => /^(Responses|Score|Returning):/.test(text)))).toEqual(tooltip);
  }
});

test("bar charts keep negative endpoints, missing values and a lone x inside the plot in overlay and panels", async ({ browser }) => {
  const session = writer();
  const mapping = {
    version: 1, type: "line", collection: "measurements", missing: "connect",
    x: { field: "day", type: "number" }, y: [
      { field: "a", label: "First", unit: "responses", type: "bar", range: [-40, -1], reference: -15 },
      { field: "b", label: "Second", unit: "responses", type: "bar" },
    ],
  };
  const uuid = await chartDoc(session, "Grouped bar extremes", mapping);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements",
    schema: { version: 1, schema: { type: "object" } }, replaceRecords: [
      { id: "first", value: { day: 1, a: -5, b: -10 } },
      { id: "middle", value: { day: 4, a: null, b: "wrong" } },
      { id: "last", value: { day: 10, a: -20, b: -40 } },
      { id: "absent", value: { day: 20 } },
    ],
  }] });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: async loading => { await installProbe(loading, uuid); await installBarProbe(loading); },
    contextOptions: { viewport: { width: 1366, height: 900 }, locale: "en-US" },
  });
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.getByRole("img", { name: /^Bar chart of/ })).toBeVisible();
  const bars = await barGeometry(page);
  expect(bars).toHaveLength(4);
  expectContainedBars(bars);
  expect(await page.evaluate(() => (window as unknown as { barProbe: BarPaintProbe }).barProbe.points)).toHaveLength(0);
  const zero = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink.find(entry => entry.text === "0 responses")?.y);
  expect(zero).toBeDefined();
  for (const bar of bars) expect(Math.abs(bar.top - (zero ?? NaN))).toBeLessThanOrEqual(0.5);
  expect(await referenceInk(page, 0, -15, "responses", bars[0]?.clip ?? undefined)).toBeGreaterThan(0.75);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", replaceRecords: [
    { id: "narrow-first", value: { day: 123456789.1, a: -5, b: -10 } },
    { id: "narrow-middle", value: { day: 123456789.2, a: -8, b: -20 } },
    { id: "narrow-last", value: { day: 123456789.3, a: -10, b: -30 } },
  ] }] });
  await waitForDocumentDraw(page, session, uuid);
  await page.locator(".ub-chart-screen").evaluate(element => { (element as HTMLElement).style.width = "320px"; });
  await expect.poll(() => page.locator(".ub-chart canvas").evaluate(element => element.getBoundingClientRect().width)).toBe(320);
  await expect.poll(async () => {
    const labels = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink
      .filter(entry => /^123,456,789\.[123]$/.test(entry.text)).sort((a, b) => a.x - b.x));
    return labels.length > 0 && labels.every((label, index) => label.left >= 0 && label.right <= 320
      && (index === 0 || label.left >= (labels[index - 1]?.right ?? Infinity)));
  }).toBe(true);
  expectContainedBars(await barGeometry(page));
  await page.locator(".ub-chart-screen").evaluate(element => { (element as HTMLElement).style.removeProperty("width"); });
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", replaceRecords: [
    { id: "only", value: { day: 10, a: -5, b: -10 } },
  ] }] });
  await waitForDocumentDraw(page, session, uuid);
  const lone = await barGeometry(page);
  expect(lone).toHaveLength(2);
  expectContainedBars(lone);
  await editMapping(session, uuid, JSON.stringify({ ...mapping, layout: "panels" }));
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.locator(".ub-chart-series-panel")).toHaveCount(2);
  const panels = await barGeometry(page);
  expect(panels).toHaveLength(2);
  expectContainedBars(panels);
  expect(panels[0]?.top).toBeCloseTo(panels[1]?.top ?? NaN, 5);
  expect(await page.evaluate(() => (window as unknown as { barProbe: BarPaintProbe }).barProbe.points)).toHaveLength(0);
  await proveMcpArrival(page, session, uuid, { path: "upstream" });
  expect(await page.evaluate(() => (window as unknown as { chartProbe: { localUpdates: number } }).chartProbe.localUpdates)).toBe(1);
});

test("editor insertion and the source control work by pointer and keyboard in both appearances", async ({ browser }, info) => {
  const session = writer();
  for (const appearance of ["light", "dark"] as const) {
    const page = await openApp(browser, "/", { contextOptions: { colorScheme: appearance } });
    await expect(page.locator(".ub-document-sidebar")).toBeVisible();
    const uuid = await createDoc(page, `Chart source ${appearance}`);
    await editor(page).locator(":scope > p").first().click();
    await page.keyboard.insertText("A source-editable chart follows.");
    await editor(page).locator(":scope > *").last().hover();
    await page.getByRole("button", { name: "Insert block below" }).click();
    await page.getByRole("option", { name: "Line chart", exact: true }).click();
    const source = page.locator(".ub-chart-source");
    await expect(source).toBeVisible();
    await source.click();
    // Select only this source; the block menu may insert a starter mapping.
    await setNativeSelection(source, () => source.evaluate((element) => {
      const root = element.closest(".ProseMirror") as (HTMLElement & { editor: Editor }) | null;
      if (root === null) throw new Error("e2e: chart source has no editor");
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return { anchor: root.editor.view.posAtDOM(range.startContainer, range.startOffset),
        head: root.editor.view.posAtDOM(range.endContainer, range.endOffset) };
    }));
    await page.keyboard.insertText(JSON.stringify(MAPPING));
    await expect(source).toHaveText(JSON.stringify(MAPPING));
    // A newly created browser document may be known to the agent directory
    // before its room is hydrated; the writer waits for the authored source.
    await expectMcp(() => session.call<DocPayload>("get_doc", { uuid }), doc => {
      expect(doc.blocks.find((entry) => entry.type === "chart")?.text).toBe(JSON.stringify(MAPPING));
    });
    await measurements(session, uuid);
    await waitForDocumentDraw(page, session, uuid);
    await editor(page).locator(":scope > p").first().click();
    await expectReady(page, session, uuid);
    await expectCornerControls(page);
    await expect(source).toBeHidden();
    await page.locator(".ub-chart-screen").click();
    await expect(source).toBeVisible();
    await expect(page.locator(".ub-chart .ub-copy")).toBeVisible();
    await editor(page).locator(":scope > p").first().click();
    await expectReady(page, session, uuid);
    const openSource = page.getByRole("button", { name: "Open chart source", exact: true });
    // Native Tab order, rather than focusing the button by script.
    for (let count = 0; count < 20; count += 1) {
      if (await openSource.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(openSource).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(source).toBeVisible();
    await expect.poll(() => source.evaluate((element) => element.contains(document.getSelection()?.focusNode ?? null))).toBe(true);
    // ProseMirror's focus sync can undo an End key; a checked scripted caret survives it.
    await setNativeSelection(source, () => source.evaluate((element) => {
      const root = element.closest(".ProseMirror") as (HTMLElement & { editor: Editor }) | null;
      if (root === null) throw new Error("e2e: chart source has no editor");
      const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      while (texts.nextNode()) last = texts.currentNode;
      if (last === null) throw new Error("e2e: chart source has no text");
      const range = document.createRange();
      range.setStart(last, last.textContent?.length ?? 0);
      range.collapse(true);
      const position = root.editor.view.posAtDOM(range.startContainer, range.startOffset);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return { anchor: position, head: position };
    }));
    await page.keyboard.insertText(" ");
    // toHaveText trims, so compare the exact source.
    await expect.poll(() => source.textContent()).toBe(`${JSON.stringify(MAPPING)} `);
    await editor(page).locator(":scope > p").first().click();
    await page.keyboard.press("ArrowLeft");
    await waitForDocumentDraw(page, session, uuid, { source: `${JSON.stringify(MAPPING)} ` });
    await expectReady(page, session, uuid);
    await expectCornerControls(page);
    await canvasEvidence(page.locator(".ub-chart"), info, `chart-${appearance}`);
    // The browser edit reaches the writer's replica through `ub open` and the hub.
    await expectMcp(() => session.call<DocPayload>("get_doc", { uuid }), stored => {
      expect(stored.blocks.find((entry) => entry.type === "chart")?.text).toBe(`${JSON.stringify(MAPPING)} `);
    });
  }
});

test("MCP updates and mapping edits redraw charts and tables, preserve data and survive reload and reopen", async ({ browser }) => {
  const session = writer();
  const target = "https://example.invalid/table-evidence";
  const tableMapping = {
    version: 1, type: "table", collection: "evidence", title: "Delivery evidence", pageSize: 2,
    columns: [
      { field: "name", label: "Name" },
      { field: "value", label: "Autonomous", format: "number", unit: "%", decimals: 2 },
      { field: "day", label: "Day", format: "date" },
      { field: "url", label: "Evidence", format: "link" },
    ],
  };
  const records = [
    { id: "a", value: { name: "<strong>kept as text</strong>", value: 12.5, day: "2026-01-01", url: target } },
    { id: "b", value: {} },
    { id: "c", value: { name: null, value: null, day: null, url: null } },
    { id: "d", value: { name: "Invalid values", value: "12", day: "2026-02-31", url: "javascript:alert(1)" } },
    { id: "e", value: { name: { compact: true }, value: 20, day: "2026-01-02T12:30:00Z", url: "data:text/html,<script>alert(1)</script>" } },
    { id: "f", value: { name: "Relative link", value: 0, day: "2026-01-03", url: "/relative" } },
  ];
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Live chart and data table", description: "Two generated views receive document data and mapping updates.",
    blocks: [
      { type: "paragraph", text: "Read the live measurements and evidence below." },
      { type: "chart", text: JSON.stringify(MAPPING) },
      { type: "chart", text: JSON.stringify(tableMapping) },
    ],
  });
  await measurements(session, uuid);
  await session.call("update_data", { uuid, operations: [{ collection: "evidence", schema: { version: 1, schema: { type: "object" } }, replaceRecords: records }] });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { beforeNavigate: (loading) => installProbe(loading, uuid) });
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  await expect(page.locator(".ub-chart-panel").first()).toHaveAttribute("data-state", "ready");
  const canvas = page.getByRole("img", { name: "API latency", exact: true });
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAccessibleDescription(/Latency.*125.*ms/);
  await expect(canvas).toHaveAccessibleDescription(/Errors.*4.*requests/);
  const chart = page.locator(".ub-chart").first();
  await expect(chart.locator(".ub-chart-diagnostics")).toContainText(/1.*(?:date|x)/i);
  await expect(chart.locator(".ub-chart-description")).not.toHaveAttribute("aria-live", /.*/);
  const table = page.getByRole("table", { name: "Delivery evidence", exact: true });
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(records.length);
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await session.call("update_data", {
    uuid, operations: [
      { collection: "measurements", upsert: [{ id: "latest", value: { day: "2026-01-02", latency: 250, errors: 9 } }] },
      { collection: "evidence", upsert: [{ id: "d", value: { name: "Arriving update", value: 42, day: "2026-01-04", url: target } }] },
    ],
  });
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  await expect(canvas).toHaveAccessibleDescription(/Latency.*250.*ms/);
  await expect(canvas).toHaveAccessibleDescription(/Errors.*9.*requests/);
  await expect(table).toContainText("Arriving update");
  await expect(table.locator("tbody tr")).toHaveCount(records.length);
  const beforeMapping = await session.call("get_data", { uuid });
  const beforeMeasurements = await session.call("get_data", { uuid, collection: "measurements" });
  const updatedMapping = { ...MAPPING, title: "Live API health", y: [{ field: "latency", label: "Response time", unit: "ms" }] };
  await editMapping(session, uuid, JSON.stringify(updatedMapping));
  const updatedTableMapping = { ...tableMapping, title: "Live evidence", pageSize: 5, sort: { field: "value", direction: "desc" },
    columns: tableMapping.columns.map((column) => column.field === "name" ? { ...column, label: "Observation" } : column) };
  await editMapping(session, uuid, JSON.stringify(updatedTableMapping), 1);
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  const renamed = page.getByRole("img", { name: "Live API health", exact: true });
  const renamedTable = page.getByRole("table", { name: "Live evidence", exact: true });
  await expect(renamed).toBeVisible();
  await expect(renamed).toHaveAccessibleDescription(/Response time.*250.*ms/);
  await expect(renamedTable.getByRole("columnheader", { name: "Observation", exact: true })).toBeVisible();
  await expect(renamedTable.locator("tbody tr")).toHaveCount(records.length);
  await expect(renamedTable.locator("tbody tr").first()).toContainText("Arriving update");
  await proveMcpArrival(page, session, uuid, { path: "upstream" });
  await expectMcp(async () => {
    expect(await session.call("get_data", { uuid })).toEqual(beforeMapping);
    expect(await session.call("get_data", { uuid, collection: "measurements" })).toEqual(beforeMeasurements);
  });
  await session.call("update_data", {
    uuid, operations: [
      { collection: "measurements", upsert: [{ id: "latest", value: { day: "2026-01-02", latency: 375, errors: 11 } }] },
      { collection: "evidence", upsert: [{ id: "d", value: { name: "Later update", value: 43, day: "2026-01-04", url: target } }] },
    ],
  });
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  await expect(renamed).toHaveAccessibleDescription(/Response time.*375.*ms/);
  await expect(renamedTable).toContainText("Later update");
  await expect(renamedTable.locator("tbody tr").first()).toContainText("Later update");
  await session.call("update_data", { uuid, operations: [{ collection: "evidence", deleteRecords: ["e", "f"] }] });
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  await expect(renamedTable.locator("tbody tr")).toHaveCount(4);
  await expect(renamedTable).toContainText("Later update");
  // The arrival proof deliberately writes one tag transaction to this document.
  expect(await page.evaluate(() => (window as unknown as { chartProbe: { localUpdates: number } }).chartProbe.localUpdates)).toBe(1);
  const lightCanvas = await renamed.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const lightInk = await page.evaluate(() => (window as unknown as { chartProbe: { paints: string[] } }).chartProbe.paints.at(-1));
  const lightTableInk = await renamedTable.evaluate((element) => getComputedStyle(element.querySelector("td") ?? element).color);
  // System appearance changes repaint the mounted chart and table without
  // navigating away from either generated view.
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
  await expect.poll(() => renamed.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(lightCanvas);
  expect(await page.evaluate(() => (window as unknown as { chartProbe: { paints: string[] } }).chartProbe.paints.at(-1))).not.toBe(lightInk);
  await expect.poll(() => renamedTable.evaluate((element) => getComputedStyle(element.querySelector("td") ?? element).color)).not.toBe(lightTableInk);
  const paintedText = await page.evaluate(() => (window as unknown as { chartProbe: { texts: string[] } }).chartProbe.texts);
  expect(paintedText).toContain("Latency (ms)");
  expect(paintedText).toContain("Errors (requests)");
  expect(paintedText).not.toContain("2026");
  expect(paintedText.some((text) => /^Jan [12]$/.test(text))).toBe(true);
  expect(paintedText.some((text) => /Jan [12], 2026/.test(text))).toBe(false);
  expect(navigations).toBe(0);
  await page.reload();
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  await expect(renamed).toHaveAccessibleDescription(/Response time.*375.*ms/);
  await expect(renamedTable).toBeVisible();
  await expect(renamedTable.locator("tbody tr")).toHaveCount(4);
  await expect(renamedTable.locator("tbody tr").first()).toContainText("Later update");
  const reopened = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await waitForDocumentDraw(reopened, session, uuid, { index: "all" });
  await expect(reopened.getByRole("img", { name: "Live API health", exact: true })).toHaveAccessibleDescription(/Response time.*375.*ms/);
  const reopenedTable = reopened.getByRole("table", { name: "Live evidence", exact: true });
  await expect(reopenedTable).toBeVisible();
  await expect(reopenedTable.locator("tbody tr")).toHaveCount(4);
  await expect(reopenedTable).toContainText("Later update");
  await expectMcp(async () => {
    const stored = await session.call<DocPayload>("get_doc", { uuid });
    expect(stored.blocks.filter((entry) => entry.type === "chart").map((entry) => entry.text)).toEqual([
      JSON.stringify(updatedMapping), JSON.stringify(updatedTableMapping),
    ]);
    const data = await session.call<{ records: { id: string; value: unknown }[] }>("get_data", { uuid, collection: "measurements" });
    expect(data.records.find((entry) => entry.id === "latest")?.value).toEqual({ day: "2026-01-02", latency: 375, errors: 11 });
  });
});

test("a record limit follows the latest x values with a neutral count and unchanged source", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const mapping = { ...MAPPING, limit: 2, y: [{ field: "latency", label: "Latency", unit: "ms" }] };
  const uuid = await chartDoc(session, "Limited live line chart", mapping);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", schema: SCHEMA, replaceRecords: [
    { id: "a", value: { day: "2026-01-03", latency: 130 } },
    { id: "middle", value: { day: "2026-01-02", latency: 120 } },
    { id: "z", value: { day: "2026-01-01", latency: 110 } },
    { id: "bad-date", value: { day: "2026-02-31", latency: 140 } },
  ] }] });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: (loading) => installProbe(loading, uuid),
    contextOptions: { locale: "en-US" },
  });
  await expectReady(page, session, uuid);
  const canvas = page.getByRole("img", { name: "API latency", exact: true });
  const notice = page.locator(".ub-chart-notice");
  const diagnostics = page.locator(".ub-chart-diagnostics");
  await expect(canvas).toHaveAccessibleDescription(/2 plotted records\. First Day: Jan 2, 2026\. Last: Jan 3, 2026\./);
  await expectObservationGeometry(page, [
    { value: Date.UTC(2026, 0, 2), label: "Jan 2" }, { value: Date.UTC(2026, 0, 3), label: "Jan 3" },
  ], /^Jan \d+$/, true);
  await expect(notice).toHaveText("Showing the latest 2 of 3 records");
  await expect(notice).not.toHaveAttribute("aria-live", /.*/);
  await expect(notice).not.toHaveAttribute("role", /alert|status/);
  await expect(notice).toHaveCSS("color", await page.locator(".ub-chart-open").evaluate((element) => getComputedStyle(element).color));
  await expect(diagnostics).toHaveText("1 records not plotted (1 wrong-type or invalid x).");

  await session.call("update_data", { uuid, operations: [{ collection: "measurements", upsert: [
    { id: "0-newest", value: { day: "2026-01-04", latency: 150 } },
  ] }] });
  await waitForDocumentDraw(page, session, uuid);
  await expect(canvas).toHaveAccessibleDescription(/2 plotted records\. First Day: Jan 3, 2026\. Last: Jan 4, 2026\./);
  await expect(canvas).toHaveAccessibleDescription(/Latency: 150 ms/);
  await expectObservationGeometry(page, [
    { value: Date.UTC(2026, 0, 3), label: "Jan 3" }, { value: Date.UTC(2026, 0, 4), label: "Jan 4" },
  ], /^Jan \d+$/, true);
  await expect(notice).toHaveText("Showing the latest 2 of 4 records");
  await expect(diagnostics).toHaveText("1 records not plotted (1 wrong-type or invalid x).");
  await proveMcpArrival(page, session, uuid, { path: "upstream" });
  await expectMcp(() => session.call<DocPayload>("get_doc", { uuid }), doc => {
    expect(doc.blocks.find((block) => block.type === "chart")?.text).toBe(JSON.stringify(mapping));
  });

  await editMapping(session, uuid, JSON.stringify({ ...mapping, limit: 4 }));
  await waitForDocumentDraw(page, session, uuid);
  await expect(canvas).toHaveAccessibleDescription(/4 plotted records/);
  await expect(notice).toBeHidden();
  await editMapping(session, uuid, JSON.stringify({ ...mapping, limit: 0 }));
  await waitForDocumentDraw(page, session, uuid, { outcome: "error" });
  await expect(page.locator(".ub-chart-panel")).toHaveAttribute("data-state", "invalid-configuration");
  await expect(notice).toBeHidden();
});

test("daily observation labels fit at desktop and iPad widths in both appearances", { tag: "@webkit" }, async ({ browser }, info) => {
  test.setTimeout(120_000);
  const session = writer();
  const uuid = await chartDoc(session, "Daily chart observations");
  const observations = Array.from({ length: 7 }, (_, index) => ({
    value: Date.UTC(2026, 9, index + 1), label: `Oct ${index + 1}`,
  }));
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", schema: SCHEMA,
    replaceRecords: [
      ...observations.map((observation, index) => ({ id: `day-${index}`, value: {
        day: new Date(observation.value).toISOString().slice(0, 10), latency: 80 + index * 5, errors: 3 + index,
      } })),
      { id: "tied", value: { day: "2026-10-03", latency: 98, errors: 6 } },
      { id: "empty-intraday", value: { day: "2026-10-02T12:00:00Z", latency: null, errors: null } },
      { id: "empty-last", value: { day: "2026-10-08", latency: null, errors: null } },
    ],
  }] });
  for (const touch of [false, true]) {
    for (const appearance of ["light", "dark"] as const) {
      const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
        beforeNavigate: (loading) => installProbe(loading, uuid),
        contextOptions: {
          ...(touch ? devices["iPad Pro 11"] : { viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false }),
          locale: "en-US", colorScheme: appearance,
        },
      });
      await expectReady(page, session, uuid);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(touch);
      const labels = await expectObservationGeometry(page, observations, /^Oct \d+$/, true);
      expect(new Set(labels.map((label) => label.y)).size).toBe(1);
      const ink = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink);
      expect(ink.some((entry) => /^2026$|^\d{2}:\d{2}(?::\d{2})?$|^UTC$/.test(entry.text))).toBe(false);
      expect(ink.some((entry) => entry.text === "Oct 8")).toBe(false);
      await canvasEvidence(page.locator(".ub-chart"), info, `chart-daily-${touch ? "ipad" : "desktop"}-${appearance}`);
    }
  }
});

test("crowded daily endpoint labels stay inside the canvas after resizing", { tag: "@webkit" }, async ({ browser }, info) => {
  test.skip(info.project.name === "webkit-ipad", "Explicit canvas widths own this desktop resize proof.");
  const session = writer();
  const uuid = await chartDoc(session, "Daily endpoint padding", {
    ...MAPPING, y: [{ field: "latency", label: "Latency", unit: "ms" }],
  });
  const observations = Array.from({ length: 21 }, (_, index) => ({
    value: Date.UTC(2026, 6, index + 1), label: `Jul ${index + 1}`,
  }));
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", schema: SCHEMA,
    replaceRecords: observations.map((observation, index) => ({ id: `day-${index}`, value: {
      day: new Date(observation.value).toISOString().slice(0, 10), latency: 80 + index * 5,
    } })),
  }] });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: (loading) => installProbe(loading, uuid),
    contextOptions: { viewport: { width: 1280, height: 800 }, locale: "en-US" },
  });
  await expectReady(page, session, uuid);
  await page.evaluate(() => document.fonts.ready);
  const canvas = page.locator(".ub-chart canvas");
  // At 312px the retained endpoint tick must fit its padding.
  // Nearby widths also exercise responsive draws.
  for (const width of [312, 317, 311]) {
    await page.locator(".ub-chart-screen").evaluate((element, nextWidth) => {
      const probe = (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe;
      probe.ink = []; probe.points = [];
      (element as HTMLElement).style.width = `${nextWidth}px`;
    }, width);
    await expect.poll(() => canvas.evaluate((element) => ({
      css: element.getBoundingClientRect().width,
      bitmap: (element as HTMLCanvasElement).width / devicePixelRatio,
    }))).toEqual({ css: width, bitmap: width });
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.points.length)).toBe(observations.length);
    const labels = await expectObservationGeometry(page, observations, /^Jul \d+$/);
    for (const label of labels) {
      expect(label.left, `${label.text} left edge at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(label.right, `${label.text} right edge at ${width}px`).toBeLessThanOrEqual(width);
    }
  }
});

test("observation ink, independent unit axes and nearest-x tooltips keep sparse and single-x charts readable", async ({ browser }) => {
  const session = writer();
  const uuid = await chartDoc(session, "Chart layout contract", { ...MAPPING, missing: "connect" });
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", schema: SCHEMA, replaceRecords: [
    { id: "first", value: { day: "2026-01-01", latency: 80, errors: 3 } },
    { id: "middle", value: { day: "2026-01-02", latency: 100, errors: 9 } },
    { id: "latest", value: { day: "2026-01-03", latency: 125, errors: 4 } },
  ] }] });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: (loading) => installProbe(loading, uuid), contextOptions: { locale: "en-US" },
  });
  await expectReady(page, session, uuid);
  await expectCornerControls(page);
  await expect(page.locator(".ub-chart-diagnostics")).toBeHidden();
  const canvas = page.getByRole("img", { name: "API latency", exact: true });
  const ink = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink);
  const leftTicks = ink.filter((entry) => /^[\d.,]+(?:[KM])? ms$/.test(entry.text));
  const rightTicks = ink.filter((entry) => /^[\d.,]+(?:[KM])? requests$/.test(entry.text));
  expect(leftTicks.length).toBeGreaterThan(0);
  expect(rightTicks.length).toBeGreaterThan(0);
  expect(Math.max(...leftTicks.map((entry) => entry.x))).toBeLessThan(Math.min(...rightTicks.map((entry) => entry.x)));
  const calendar = ink.filter((entry) => /^Jan [123]$/.test(entry.text));
  expect(calendar).toHaveLength(3);
  expect(ink.some((entry) => /^2026$|^\d{2}:\d{2}$|^UTC$/.test(entry.text))).toBe(false);
  expect(calendar.every((entry) => !entry.rotated && entry.font.includes("Geist"))).toBe(true);
  const legends = ink.filter((entry) => entry.text === "Latency (ms)" || entry.text === "Errors (requests)");
  expect(new Set(legends.map((entry) => entry.text))).toEqual(new Set(["Latency (ms)", "Errors (requests)"]));
  expect(Math.min(...legends.map((entry) => entry.y))).toBeGreaterThan(Math.max(...calendar.map((entry) => entry.y)));
  expect(ink.some((entry) => entry.text === "Day" || entry.text.includes("Latency (ms), Errors"))).toBe(false);

  await session.call("update_data", { uuid, operations: [{ collection: "measurements", upsert: [
    { id: "middle", value: { day: "2026-01-02", latency: null, errors: 9 } },
  ] }] });
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.locator(".ub-chart-diagnostics")).toContainText("Latency: 1 absent or null");
  const points = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.points);
  const box = await canvas.boundingBox();
  if (box === null || points.length === 0) throw new Error("e2e: chart has no painted points");
  await page.evaluate(() => { (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts = []; });
  // Under connect these arrays have different lengths. Index mode would pair
  // the last latency with the middle error; x-nearest must show the same record.
  await page.mouse.move(box.x + Math.max(...points.map((point) => point.x)) - 1, box.y + box.height / 3);
  await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts)).toContain("Latency: 125 ms");
  await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts)).toContain("Errors: 4 requests");
  await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts)).toContain("Jan 3, 2026");

  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const probe = (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe;
    probe.points = []; probe.texts = [];
  });
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", replaceRecords: [
    { id: "only", value: { day: "2026-01-03T09:30:00Z", latency: 125, errors: 4 } },
  ] }] });
  await waitForDocumentDraw(page, session, uuid);
  await expect(canvas).toHaveAccessibleDescription(/1 plotted record\./);
  await expect(page.locator(".ub-chart-diagnostics")).toBeHidden();
  const single = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.points);
  const singleBox = await canvas.boundingBox();
  if (singleBox === null) throw new Error("e2e: single-x chart has no box");
  const visible = single.filter((point) => point.radius > 0 && point.x > 0 && point.x < singleBox.width && point.y > 0 && point.y < singleBox.height);
  expect(visible.length).toBeGreaterThanOrEqual(2);
  await page.mouse.move(singleBox.x + (visible[0]?.x ?? 0), singleBox.y + singleBox.height / 3);
  await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts)).toContain("Jan 3, 2026, 9:30:00 AM UTC");

  await editMapping(session, uuid, JSON.stringify({ version: 1, type: "table", collection: "measurements",
    columns: [{ field: "day" }, { field: "latency", format: "number" }] }));
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator(".ub-chart-title")).toBeHidden();
  await page.locator(".ub-chart").hover();
  const tableSource = page.getByRole("button", { name: "Open table source", exact: true });
  await expect(tableSource).toHaveCSS("opacity", "1");
  const tableBox = await page.getByRole("table").boundingBox();
  const sourceBox = await tableSource.boundingBox();
  if (tableBox === null || sourceBox === null) throw new Error("e2e: table footer source has no box");
  expect(sourceBox.y).toBeGreaterThanOrEqual(tableBox.y + tableBox.height);
  await editMapping(session, uuid, JSON.stringify({ ...MAPPING, title: "" }));
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", replaceRecords: [] }] });
  await waitForDocumentDraw(page, session, uuid, { outcome: "error" });
  await expect(page.locator(".ub-chart-message")).toContainText("No plottable records");
  await expect(page.locator(".ub-chart-diagnostics")).toBeHidden();
  await expectCornerControls(page);
});

test("each value axis keeps a zero baseline only while its plotted values are non-negative", async ({ browser }) => {
  const session = writer();
  const uuid = await chartDoc(session, "Value-axis baselines");
  const cases = [
    { name: "positive", latency: [30, 36], errors: [100, 120], ranges: [[0, 36], [0, 120]] },
    { name: "single value", latency: [30], errors: [36], ranges: [[0, 30], [0, 36]] },
    { name: "all zero", latency: [0, 0], errors: [0, 0], ranges: [[0, 0], [0, 0]] },
    { name: "all negative", latency: [-40, -30], errors: [-100, -90], ranges: [[-40, -30], [-100, -90]] },
    { name: "mixed signs", latency: [-10, 30], errors: [-30, 10], ranges: [[-10, 30], [-30, 10]] },
    { name: "positive left, negative right", latency: [30, 36], errors: [-40, -30], ranges: [[0, 36], [-40, -30]] },
    { name: "negative left, positive right", latency: [-40, -30], errors: [30, 36], ranges: [[-40, -30], [0, 36]] },
  ];
  const replace = async (fixture: typeof cases[number]): Promise<void> => {
    await session.call("update_data", { uuid, operations: [{ collection: "measurements", schema: SCHEMA,
      replaceRecords: fixture.latency.map((latency, index) => ({ id: `point-${index}`, value: {
        day: `2026-01-0${index + 1}`, latency, errors: fixture.errors[index],
      } })),
    }] });
  };
  const first = cases[0];
  if (first === undefined) throw new Error("e2e: value-axis fixtures are empty");
  await replace(first);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: (loading) => installProbe(loading, uuid), contextOptions: { locale: "en-US" },
  });
  await expectReady(page, session, uuid);
  const canvas = page.getByRole("img", { name: "API latency", exact: true });
  for (const [index, fixture] of cases.entries()) {
    await test.step(fixture.name, async () => {
      if (index > 0) {
        // Earlier draws must not supply ticks for the new range.
        await page.evaluate(() => { (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink = []; });
        await replace(fixture);
      }
      await expect(canvas).toHaveAccessibleDescription(new RegExp(`Latency: ${fixture.latency.at(-1)} ms`));
      await expect(canvas).toHaveAccessibleDescription(new RegExp(`Errors: ${fixture.errors.at(-1)} requests`));
      for (const [axis, unit] of ["ms", "requests"].entries()) {
        const range = fixture.ranges[axis];
        if (range === undefined) throw new Error("e2e: value-axis range is missing");
        const values = await page.evaluate((suffix) => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink
          .filter((entry) => new RegExp(`^-?[\\d.]+ ${suffix}$`).test(entry.text))
          .map((entry) => Number(entry.text.slice(0, -(suffix.length + 1)))), unit);
        expect(values.length).toBeGreaterThan(1);
        expect(Math.min(...values)).toBe(range[0]);
        if (range[0] === 0) {
          expect(Math.max(...values)).toBeGreaterThan(0);
          expect(Math.max(...values)).toBeGreaterThanOrEqual(range[1] ?? 0);
        } else {
          // Chart.js's existing nice range is unchanged for these fixtures.
          expect(Math.max(...values)).toBe(range[1]);
        }
      }
    });
  }
});

for (const layout of ["overlay", "panels"] as const) {
  test(`non-round widening keeps declared-range labels on their gridline values in ${layout}`, async ({ browser }) => {
    const session = writer();
    const cases = [
      { name: "upper data near declared end", range: [0, 100], values: [60, 103.7, 90], reference: undefined },
      { name: "upper data beyond declared end", range: [0, 100], values: [60, 117.3, 90], reference: undefined },
      { name: "lower data", range: [-100, 100], values: [-60, -139.7, -90], reference: undefined },
      { name: "upper reference", range: [0, 100], values: [60, 75, 90], reference: 117.3 },
      { name: "lower reference", range: [-100, 100], values: [-60, -75, -90], reference: -139.7 },
    ];
    const mappingFor = (fixture: typeof cases[number]) => ({ ...MAPPING, title: "Widened tick geometry", layout,
      y: [{ field: "latency", unit: "%", range: fixture.range,
        ...(fixture.reference === undefined ? {} : { reference: fixture.reference }) }],
    });
    const first = cases[0];
    if (first === undefined) throw new Error("e2e: widened-range fixtures are empty");
    const uuid = await chartDoc(session, `Widened tick geometry ${layout}`, mappingFor(first));
    const replace = async (fixture: typeof cases[number]): Promise<void> => {
      await session.call("update_data", { uuid, operations: [{ collection: "measurements", schema: SCHEMA,
        replaceRecords: fixture.values.map((latency, index) => ({ id: `point-${index}`, value: {
          day: `2026-01-0${index + 1}`, latency,
        } })),
      }] });
    };
    await replace(first);
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: loading => installProbe(loading, uuid),
      contextOptions: { viewport: { width: 1366, height: 768 }, locale: "en-US" },
    });
    for (const [index, fixture] of cases.entries()) {
      await test.step(fixture.name, async () => {
        if (index > 0) {
          await editMapping(session, uuid, JSON.stringify(mappingFor(fixture)));
          await replace(fixture);
        }
        await waitForDocumentDraw(page, session, uuid);
        await expect(page.getByRole("img", { name: "Widened tick geometry", exact: true })).toBeVisible();
        await expectPanelTickGeometry(page, 0, fixture.values, "%", false, layout === "panels" ? 3 : 6);
        if (fixture.reference !== undefined) {
          expect(await referenceInk(page, 0, fixture.reference, "%")).toBeGreaterThan(0.75);
        }
      });
    }
    await page.close();
  });

  test(`declared ranges and neutral references preserve survey scale in ${layout} in both appearances`, async ({ browser }, info) => {
    const session = writer();
    const mapping = { ...MAPPING, title: "Monthly survey", layout, y: [
      { field: "score", label: "Survey score", unit: "points", range: [-100, 100], reference: 0 },
      { field: "comparison", label: "Comparison", unit: "points", range: [-80, 80], reference: 17 },
      { field: "uptime", label: "Uptime", unit: "%", range: [50, 100], reference: 73 },
    ] };
    const uuid = await chartDoc(session, `Survey ranges ${layout}`, mapping);
    await session.call("update_data", { uuid, operations: [{ collection: "measurements",
      schema: { version: 1, schema: { type: "object" } }, replaceRecords: [
        { id: "jan", value: { day: "2026-01-01", score: -39, comparison: -5, uptime: 60 } },
        { id: "feb", value: { day: "2026-02-01", score: -10, comparison: 40, uptime: 75 } },
        { id: "mar", value: { day: "2026-03-01", score: 15, comparison: 25, uptime: 90 } },
      ],
    }] });
    for (const appearance of ["light", "dark"] as const) {
      const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
        beforeNavigate: loading => installProbe(loading, uuid),
        contextOptions: { viewport: { width: 1366, height: 768 }, locale: "en-US", colorScheme: appearance },
      });
      await waitForDocumentDraw(page, session, uuid);
      const image = page.getByRole("img", { name: "Monthly survey", exact: true });
      await expect(image).toBeVisible();
      await expect(image).toHaveAccessibleDescription(/Survey score: 15 points/);
      await expect(image).toHaveAccessibleDescription(/Comparison: 25 points/);
      await expect(image).toHaveAccessibleDescription(/Uptime: 90 %/);
      await expect(image).not.toHaveAccessibleDescription(/reference|range|73|17/i);
      const geometry = await page.evaluate(() => {
        const probe = (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe;
        return { ink: probe.ink, points: probe.points };
      });
      const ends = (canvas: number, unit: string): number[] => geometry.ink
        .filter(entry => entry.canvas === canvas && entry.text.endsWith(unit))
        .map(entry => Number(entry.text.slice(0, -unit.length).trim().replaceAll(",", "")))
        .filter(Number.isFinite).sort((a, b) => a - b);
      for (const canvas of layout === "panels" ? [0, 1] : [0]) {
        const ticks = ends(canvas, "points");
        expect(ticks[0]).toBe(-100);
        expect(ticks.at(-1)).toBe(100);
      }
      const rightCanvas = layout === "panels" ? 2 : 0;
      const rightTicks = ends(rightCanvas, "%");
      expect(rightTicks[0]).toBe(50);
      expect(rightTicks.at(-1)).toBe(100);
      expect(rightTicks).not.toContain(73);
      expect(await referenceInk(page, 0, 0, "points")).toBeGreaterThan(0.75);
      expect(await referenceInk(page, layout === "panels" ? 1 : 0, 17, "points")).toBeGreaterThan(0.75);
      expect(await referenceInk(page, rightCanvas, 73, "%")).toBeGreaterThan(0.75);
      if (layout === "panels") {
        expect(await referenceInk(page, 0, 17, "points")).toBeLessThan(0.1);
        expect(await referenceInk(page, 1, 0, "points")).toBeLessThan(0.1);
        await expect(page.locator(".ub-chart-series-header")).toHaveText([
          "Survey score15 points", "Comparison25 points", "Uptime90 %",
        ]);
      } else {
        expect(geometry.ink.filter(entry => ["Survey score (points)", "Comparison (points)", "Uptime (%)"].includes(entry.text)))
          .toHaveLength(3);
      }
      const colours = await page.locator(".ub-chart-probe").evaluate(element => ({
        reference: getComputedStyle(element).color, grid: getComputedStyle(element).borderTopColor,
        background: getComputedStyle(document.body).backgroundColor,
        image: getComputedStyle(document.body).backgroundImage,
        tint: getComputedStyle(element.closest(".ub-chart") ?? element).backgroundColor,
      }));
      for (const backing of pageGrounds(colours.image, colours.background)) {
        const ground = composite(colours.tint, backing);
        expect(await strokeSeparation(page, colours.reference, ground))
          .toBeGreaterThan(await strokeSeparation(page, colours.grid, ground));
      }
      await canvasEvidence(page.locator(".ub-chart"), info, `chart-survey-${layout}-${appearance}`);
      const canvas = page.locator(".ub-chart canvas").nth(rightCanvas);
      const box = await canvas.boundingBox();
      const ticks = geometry.ink.filter(entry => entry.canvas === rightCanvas && entry.text.endsWith("%"));
      const low = ticks.find(entry => entry.text === "50%"), high = ticks.find(entry => entry.text === "100%");
      const firstX = Math.min(...geometry.points.filter(point => point.canvas === rightCanvas).map(point => point.x));
      if (box === null || low === undefined || high === undefined) throw new Error("e2e: reference hover geometry is missing");
      await page.evaluate(() => { (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts = []; });
      await page.mouse.move(box.x + firstX + 1, box.y + low.y + (73 - 50) / 50 * (high.y - low.y));
      await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts))
        .toContain("Uptime: 60 %");
      const hoverText = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts);
      expect(hoverText.some(text => /: (0 points|17 points|73 %)$/u.test(text))).toBe(false);
      if (layout === "panels" && appearance === "dark") {
        await page.mouse.move(0, 0);
        await session.call("update_data", { uuid, operations: [{ collection: "measurements", upsert: [
          { id: "jan", value: { day: "2026-01-01", score: -39, comparison: -5 } },
        ] }] });
        await waitForDocumentDraw(page, session, uuid);
        await page.evaluate(() => { (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts = []; });
        await page.mouse.move(box.x + firstX + 1, box.y + low.y + (73 - 50) / 50 * (high.y - low.y));
        await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts))
          .toContain("Uptime: 75 %");
      }
      if (appearance === "dark") {
        await page.mouse.move(0, 0);
        await editMapping(session, uuid, JSON.stringify({ ...mapping, y: [
          { ...mapping.y[0], reference: 130 }, mapping.y[1],
          { field: "uptime", label: "Uptime", unit: "%", reference: 120 },
        ] }));
        await session.call("update_data", { uuid, operations: [{ collection: "measurements", upsert: [
          { id: "jan", value: { day: "2026-01-01", score: -140, comparison: -5, uptime: 60 } },
        ] }] });
        await waitForDocumentDraw(page, session, uuid);
        const widened = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink);
        const groupTicks: string[][] = [];
        for (const panel of layout === "panels" ? [0, 1] : [0]) {
          const ticks = widened.filter(entry => entry.canvas === panel && entry.text.endsWith(" points"));
          const values = ticks.map(entry => Number(entry.text.slice(0, -7).replaceAll(",", "")));
          expect(Math.min(...values)).toBeLessThanOrEqual(-140);
          expect(Math.max(...values)).toBeGreaterThanOrEqual(130);
          groupTicks.push(ticks.map(entry => entry.text));
        }
        if (layout === "panels") expect(groupTicks[1]).toEqual(groupTicks[0]);
        const automatic = widened.filter(entry => entry.canvas === rightCanvas && entry.text.endsWith("%"))
          .map(entry => Number(entry.text.slice(0, -1).replaceAll(",", "")));
        expect(Math.min(...automatic)).toBe(0);
        expect(Math.max(...automatic)).toBeGreaterThanOrEqual(120);
        expect(await referenceInk(page, 0, 130, "points")).toBeGreaterThan(0.75);
        expect(await referenceInk(page, rightCanvas, 120, "%")).toBeGreaterThan(0.75);
      }
      await page.close();
    }
  });
}

test("narrow-band compact ticks preserve the step on both value axes in both appearances", async ({ browser }) => {
  const session = writer();
  const mapping = { ...MAPPING, title: "Service metrics", y: [
    { field: "latency", label: "Users", unit: "requests" },
    { field: "errors", label: "Uptime", unit: "%" },
  ] };
  const uuid = await chartDoc(session, "Narrow-band chart", mapping);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", schema: SCHEMA, replaceRecords: [
    { id: "first", value: { day: "2026-01-01", latency: -1_000, errors: -100 } },
    { id: "last", value: { day: "2026-01-02", latency: -1_200, errors: -99.9 } },
  ] }] });
  for (const appearance of ["light", "dark"] as const) {
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: (loading) => installProbe(loading, uuid),
      contextOptions: { locale: "en-US", colorScheme: appearance },
    });
    await waitForDocumentDraw(page, session, uuid);
    const canvas = page.getByRole("img", { name: "Service metrics", exact: true });
    await expect(canvas).toHaveAccessibleDescription(/Uptime: -99\.9 %/);
    const painted = () => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts);
    await expect.poll(painted).toContain("-1.05K requests");
    await expect.poll(painted).toContain("-99.92%");
    const ink = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink);
    const left = ink.filter(entry => /^-[\d.]+K requests$/.test(entry.text));
    const right = ink.filter(entry => /^-[\d.]+%$/.test(entry.text));
    expect(new Set(left.map(entry => entry.text))).toEqual(new Set(["-1K requests", "-1.05K requests", "-1.1K requests", "-1.15K requests", "-1.2K requests"]));
    expect(new Set(right.map(entry => entry.text))).toEqual(new Set(["-99.9%", "-99.92%", "-99.94%", "-99.96%", "-99.98%", "-100%"]));
    expect(Math.max(...left.map(entry => entry.x))).toBeLessThan(Math.min(...right.map(entry => entry.x)));
  }
});

const PANEL_MAPPING = { ...MAPPING, title: "Delivery trend", layout: "panels", y: [
  { field: "autonomous", label: "Autonomous deliveries", unit: "%" },
  { field: "wasted", label: "Wasted runs", unit: "%" },
  { field: "denials", label: "Runs with denials", unit: "%" },
] };

async function panelMeasurements(session: McpSession, uuid: string): Promise<void> {
  await session.call("update_data", { uuid, operations: [{ collection: "measurements",
    schema: { version: 1, schema: { type: "object", properties: {
      day: { type: "string" }, autonomous: { type: "number" }, wasted: { type: "number" }, denials: { type: "number" },
    } } },
    replaceRecords: Array.from({ length: 14 }, (_, index) => ({ id: `day-${index}`, value: {
      day: new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10),
      autonomous: 65 + index * 2, wasted: 24 - index, denials: 8 + index % 4,
    } })),
  }] });
}

for (const viewport of ["desktop"] as const) {
  test(`three-series panels at ${viewport} width share ranges and observation labels in both appearances`,
    async ({ browser }, info) => {
      const session = writer();
      const uuid = await chartDoc(session, `Panel chart ${viewport}`, PANEL_MAPPING);
      await panelMeasurements(session, uuid);
      for (const appearance of ["light", "dark"] as const) {
        const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
          beforeNavigate: (loading) => installProbe(loading, uuid),
          contextOptions: { viewport: { width: 1366, height: 768 },
            locale: "en-US", colorScheme: appearance },
        });
        await waitForDocumentDraw(page, session, uuid);
        const image = page.getByRole("img", { name: "Delivery trend", exact: true });
        await expect(image).toBeVisible();
        await expect(image).toHaveAccessibleDescription(/Autonomous deliveries: 91 %/);
        await expect(image).toHaveAccessibleDescription(/Wasted runs: 11 %/);
        await expect(image).toHaveAccessibleDescription(/Runs with denials: 9 %/);
        await expect(page.locator(".ub-chart").getByRole("img")).toHaveCount(1);
        await expectCornerControls(page);
        await expect(page.locator(".ub-chart-diagnostics")).toBeHidden();
        const panels = page.locator(".ub-chart-series-panel");
        await expect(panels).toHaveCount(3);
        const boxes = await panels.evaluateAll(elements => elements.map(element => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }));
        expect(boxes.every(box => box.width >= 149)).toBe(true);
        const firstRow = boxes.filter(box => box.y === boxes[0]?.y).length;
        expect(firstRow).toBe(3);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const observations = Array.from({ length: 14 }, (_, index) => ({
          value: Date.UTC(2026, 9, index + 1), label: `Oct ${index + 1}`,
        }));
        const labels: string[][] = [];
        const ticks: string[][] = [];
        for (const [index, series] of PANEL_MAPPING.y.entries()) {
          const panel = panels.nth(index);
          await expect(panel.locator(".ub-chart-series-header")).toContainText(series.label);
          await expect(panel.locator(".ub-chart-series-header")).toContainText(`${[91, 11, 9][index]} %`);
          const canvas = panel.locator("canvas");
          await expect(canvas).toHaveAttribute("aria-hidden", "true");
          const canvasIndex = await canvas.evaluate(element => [...document.querySelectorAll(".ub-chart canvas")].indexOf(element));
          const dates = await expectObservationGeometry(page, observations, /^Oct \d+$/, false, canvasIndex, 6);
          labels.push(dates.map(entry => entry.text));
          const ink = await page.evaluate(target => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink
            .filter(entry => entry.canvas === target), canvasIndex);
          const yTicks = ink.filter(entry => /^[\d.,]+%$/.test(entry.text));
          expect(yTicks.length).toBeGreaterThanOrEqual(2);
          expect(yTicks.length).toBeLessThanOrEqual(4);
          expect(yTicks.some(entry => entry.text === "0%")).toBe(true);
          ticks.push(yTicks.map(entry => entry.text));
          expect(ink.some(entry => entry.text === series.label || entry.text === `${series.label} (%)` || entry.text === "Day")).toBe(false);
          expect(ink.every(entry => entry.font.includes("Geist") && !entry.rotated)).toBe(true);
          if (index === 0) await expectPanelTickGeometry(page, canvasIndex,
            Array.from({ length: 14 }, (_, day) => 65 + day * 2), "%", true);
        }
        expect(labels[1]).toEqual(labels[0]);
        expect(labels[2]).toEqual(labels[0]);
        expect(ticks[1]).toEqual(ticks[0]);
        expect(ticks[2]).toEqual(ticks[0]);
        await proveMcpArrival(page, session, uuid, { path: "upstream" });
        // The later tag transaction is the only local update this reader sees.
        expect(await page.evaluate(() => (window as unknown as { chartProbe: { localUpdates: number } }).chartProbe.localUpdates)).toBe(1);
        await canvasEvidence(page.locator(".ub-chart"), info, `chart-panels-${viewport}-${appearance}`);
      }
    });
}

test("panel tick labels match their gridlines and retain extreme markers across unit ranges", async ({ browser }) => {
  const session = writer();
  const values = [[40, 105], [30, 87.5], [100, 1049], [-1049, -1001], [10, 25], [45, 99]];
  const mapping = { ...MAPPING, title: "Panel tick precision", layout: "panels", x: { field: "day", type: "number" }, y: [
    { field: "a", unit: "items" }, { field: "b", unit: "ms" }, { field: "c", unit: "requests" },
    { field: "d", unit: "rpm" }, { field: "e", unit: "items" }, { field: "f", unit: "%" },
  ] };
  const uuid = await chartDoc(session, "Panel tick precision", mapping);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements",
    schema: { version: 1, schema: { type: "object" } }, replaceRecords: [0, 1].map(index => ({
      id: `point-${index}`, value: { day: index + 1,
        ...Object.fromEntries(mapping.y.map((series, seriesIndex) => [series.field, values[seriesIndex]?.[index]])),
      },
    })),
  }] });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: loading => installProbe(loading, uuid), contextOptions: { viewport: { width: 1366, height: 768 }, locale: "en-US" },
  });
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.getByRole("img", { name: "Panel tick precision", exact: true })).toBeVisible();
  const canvases = page.locator(".ub-chart-series-panel canvas");
  await expect(canvases).toHaveCount(6);
  const ticks: { text: string; y: number }[][] = [];
  for (const [index, series] of mapping.y.entries()) {
    const canvasIndex = await canvases.nth(index).evaluate(element => [...document.querySelectorAll(".ub-chart canvas")].indexOf(element));
    ticks.push((await expectPanelTickGeometry(page, canvasIndex, values[index] ?? [], series.unit))
      .map(entry => ({ text: entry.text, y: entry.y })));
  }
  expect(ticks[4]).toEqual(ticks[0]);
});

test("panels compare units, retain empty series and switch layouts without rendering writes", async ({ browser }) => {
  const session = writer();
  const mapping = { version: 1, type: "line", layout: "panels", collection: "measurements", title: "Panel ranges",
    x: { field: "day", type: "number", label: "Sample" }, y: [
      { field: "a", label: "First", unit: "ms" }, { field: "b", label: "Second", unit: "ms" },
      { field: "c", label: "Percent", unit: "%" }, { field: "empty", label: "Empty" },
    ] };
  const uuid = await chartDoc(session, "Panel unit comparison", mapping);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements",
    schema: { version: 1, schema: { type: "object" } }, replaceRecords: [
      { id: "first", value: { day: 1, a: -20, b: 0, c: 50 } },
      { id: "middle", value: { day: 4, a: -10, b: 10, c: 70 } },
      { id: "last", value: { day: 10, a: 0, b: 20 } },
    ],
  }] });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: loading => installProbe(loading, uuid), contextOptions: { viewport: { width: 1366, height: 768 }, locale: "en-US" },
  });
  await waitForDocumentDraw(page, session, uuid);
  const image = page.getByRole("img", { name: "Panel ranges", exact: true });
  await expect(image).toBeVisible();
  await expect(page.locator(".ub-chart-series-panel")).toHaveCount(4);
  await expect(page.locator(".ub-chart-series-header").nth(2)).toContainText("70 %");
  await expect(page.locator(".ub-chart-series-header").nth(3)).toContainText("no plotted value");
  const geometry = await page.locator(".ub-chart-series-panel canvas").evaluateAll(elements => {
    const probe = (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe;
    return elements.map(element => {
      const canvas = [...document.querySelectorAll(".ub-chart canvas")].indexOf(element);
      return { points: probe.points.filter(entry => entry.canvas === canvas), ink: probe.ink.filter(entry => entry.canvas === canvas) };
    });
  });
  const first = geometry[0], second = geometry[1], percent = geometry[2], empty = geometry[3];
  if (first === undefined || second === undefined || percent === undefined || empty === undefined) throw new Error("e2e: panel geometry is missing");
  expect(first.ink.filter(entry => / ms$/.test(entry.text)).map(entry => entry.text))
    .toEqual(second.ink.filter(entry => / ms$/.test(entry.text)).map(entry => entry.text));
  expect(first.ink.some(entry => entry.text === "-20 ms")).toBe(true);
  expect(first.ink.some(entry => entry.text === "20 ms")).toBe(true);
  expect(first.points.at(-1)?.y).toBeCloseTo(second.points[0]?.y ?? NaN, 5);
  expect(percent.ink.some(entry => entry.text === "0%")).toBe(true);
  const percentLabels = percent.ink.filter(entry => ["1", "4", "10"].includes(entry.text));
  expect(percent.points[0]?.x).toBeCloseTo(percentLabels.find(entry => entry.text === "1")?.x ?? NaN, 5);
  expect((percent.points[1]?.x ?? NaN) - (percent.points[0]?.x ?? NaN))
    .toBeCloseTo(((percentLabels.find(entry => entry.text === "10")?.x ?? NaN)
      - (percentLabels.find(entry => entry.text === "1")?.x ?? NaN)) / 3, 5);
  expect(empty.points).toHaveLength(0);
  expect(geometry.every(panel => panel.ink.some(entry => entry.text === "Sample"))).toBe(true);
  const canvas = page.locator(".ub-chart-series-panel canvas").first();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("e2e: panel canvas has no box");
  await page.evaluate(() => { (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts = []; });
  await page.mouse.move(box.x + (first.points[0]?.x ?? 0), box.y + box.height / 3);
  await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts)).toContain("First: -20 ms");
  await test.step("later tooltip ink reaches the canvas reader after the first panel hover", async () => {
    const next = await page.locator(".ub-chart-series-panel canvas").nth(1).boundingBox();
    if (next === null) throw new Error("e2e: second panel canvas has no box");
    await page.mouse.move(next.x + (second.points[1]?.x ?? 0), next.y + next.height / 3);
    await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts)).toContain("Second: 10 ms");
    // Keep the first hover's ink: the later distinct tooltip proves this reader
    // has processed that hover before checking it never drew another panel.
    expect(await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.texts)).not.toContain("Second: 0 ms");
  });
  await editMapping(session, uuid, JSON.stringify({ ...mapping, layout: "overlay" }));
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.locator(".ub-chart-series-panel")).toHaveCount(0);
  await expect(image).toBeVisible();
  await expect(page.locator(".ub-chart-screen canvas")).toBeVisible();
  await editMapping(session, uuid, JSON.stringify({ ...mapping, y: mapping.y.slice(0, 2) }));
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.locator(".ub-chart-series-panel")).toHaveCount(2);
  await page.setViewportSize({ width: 810, height: 1080 });
  await editMapping(session, uuid, JSON.stringify({ ...mapping, title: "", y: [
    { ...mapping.y[0], unit: "milliseconds elapsed per completed request" }, ...mapping.y.slice(1),
  ] }));
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.locator(".ub-chart-series-panel")).toHaveCount(4);
  await expect(page.locator(".ub-chart-title")).toBeHidden();
  await expectCornerControls(page);
  const narrowPoints = await page.locator(".ub-chart-series-panel canvas").evaluateAll(elements => {
    const probe = (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe;
    return elements.slice(0, 3).map(element => {
      const canvas = [...document.querySelectorAll(".ub-chart canvas")].indexOf(element);
      return [...new Set(probe.points.filter(entry => entry.canvas === canvas).map(entry => entry.x))];
    });
  });
  for (const [index, points] of narrowPoints.entries()) {
    expect(points).toHaveLength(index === 2 ? 2 : 3);
    expect(points.at(-1)).toBeGreaterThan(points[0] ?? Infinity);
  }
  const header = await page.locator(".ub-chart-series-header").first().boundingBox();
  const source = await page.getByRole("button", { name: "Open chart source", exact: true }).boundingBox();
  if (header === null || source === null) throw new Error("e2e: titleless panel controls have no box");
  expect(source.y + source.height).toBeLessThanOrEqual(header.y);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", replaceRecords: [] }] });
  await waitForDocumentDraw(page, session, uuid, { outcome: "error" });
  await expect(page.locator(".ub-chart-message")).toContainText("No plottable records");
  await expect(page.locator(".ub-chart-screen")).toBeHidden();
  await proveMcpArrival(page, session, uuid, { path: "upstream" });
  expect(await page.evaluate(() => (window as unknown as { chartProbe: { localUpdates: number } }).chartProbe.localUpdates)).toBe(1);
});

interface Timings {
  first: number; redraws: number[]; availableEntries: number;
  bytes: number; records: number; series: number; cpuThrottle: number;
}

async function workload(session: McpSession, bounded: boolean, layout: "overlay" | "panels" = "overlay", bars = false): Promise<{ uuid: string; bytes: number }> {
  const series = bounded ? 8 : 3;
  const collection = "summaries";
  const mapping = {
    version: 1, type: "line", collection, title: bounded ? "Bound chart" : "API health year",
    ...(layout === "panels" ? { layout } : {}),
    x: { field: "day", type: "date", label: "Day" },
    y: Array.from({ length: series }, (_, index) => ({
      field: `value${index}`, label: `Metric ${index}`, unit: "ms", ...(bars ? { type: "bar" } : {}),
    })),
  };
  const uuid = await chartDoc(session, bounded ? "Bounded chart timing" : "Representative chart timing", mapping);
  const properties = Object.fromEntries([
    ["day", { type: "string" }],
    ...Array.from({ length: series }, (_, index) => [`value${index}`, { type: "number" }]),
  ]);
  const records = Array.from({ length: bounded ? 5001 : 365 }, (_, index) => ({
    id: `summary-${String(index).padStart(5, "0")}`,
    value: {
      day: new Date(Date.UTC(2012, 0, 1 + index)).toISOString().slice(0, 10),
      ...Object.fromEntries(Array.from({ length: series }, (_, column) => [`value${column}`, index + column])),
    },
  }));
  await session.call("update_data", {
    uuid, operations: [{ collection, schema: { version: 1, schema: { type: "object", properties, additionalProperties: false } }, replaceRecords: records }],
  });
  if (!bounded) {
    // The year's observations remain in a separate collection and are never
    // copied into chart content, but the shared reader still validates them.
    const observations = Array.from({ length: 4035 }, (_, index) => ({
      id: `observation-${String(index).padStart(5, "0")}`,
      value: { day: "2026-01-01", latency: index, detail: "x".repeat(570) },
    }));
    for (let offset = 0; offset < observations.length; offset += 1000) {
      await session.call("update_data", {
        uuid, operations: [{ collection: "observations",
          ...(offset === 0 ? { schema: { version: 1, schema: { type: "object" } } } : {}),
          upsert: observations.slice(offset, offset + 1000),
        }],
      });
    }
  }
  let bytes = 0;
  await expectMcp(async () => {
    const summary = await session.call<{ data: { bytes: number } }>("get_data", { uuid });
    bytes = summary.data.bytes;
    if (!bounded) expect(bytes).toBeGreaterThan(2_500_000);
  });
  return { uuid, bytes };
}

async function timingEvidence(page: Page, session: McpSession, uuid: string, bounded: boolean, bytes: number): Promise<Timings> {
  await waitForDocumentDraw(page, session, uuid);
  const title = bounded ? "Bound chart" : "API health year";
  const canvas = page.getByRole("img", { name: title, exact: true });
  await expect(canvas).toBeVisible();
  if (bounded) await expect(page.locator(".ub-chart-notice")).toContainText("Showing the latest 5,000 of 5001 records");
  const first = await page.evaluate(() => (window as unknown as { chartProbe: { first: number | null } }).chartProbe.first);
  const availableEntries = await page.evaluate(() => (window as unknown as { chartProbe: { availableEntries: number } }).chartProbe.availableEntries);
  expect(first).not.toBeNull();
  // One key per record and schema: first draw sees the full area, including
  // the representative workload's observations outside the plotted collection.
  expect(availableEntries).toBe(bounded ? 5002 : 4402);
  const series = bounded ? 8 : 3;
  const latest = bounded ? 5000 : 364;
  const day = new Date(Date.UTC(2012, 0, 1 + latest)).toISOString().slice(0, 10);
  const redraws: number[] = [];
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const value = 900 + iteration;
    const previous = await page.evaluate(() => (window as unknown as { chartProbe: { durations: number[] } }).chartProbe.durations.length);
    await session.call("update_data", {
      uuid, operations: [{ collection: "summaries", upsert: [{
        id: `summary-${String(latest).padStart(5, "0")}`,
        value: { day, ...Object.fromEntries(Array.from({ length: series }, (_, index) => [`value${index}`, value + index])) },
      }] }],
    });
    await waitForDocumentDraw(page, session, uuid);
    await expect(canvas).toHaveAccessibleDescription(new RegExp(`Metric 0: ${value} ms`));
    expect(await page.evaluate(() => (window as unknown as { chartProbe: { durations: number[] } }).chartProbe.durations.length)).toBe(previous + 1);
    const duration = await page.evaluate(() => (window as unknown as { chartProbe: { durations: number[] } }).chartProbe.durations.at(-1));
    if (duration === undefined) throw new Error("e2e: chart redraw had no browser-applied data timestamp");
    redraws.push(duration);
  }
  await proveMcpArrival(page, session, uuid, { path: "upstream" });
  expect(await page.evaluate(() => (window as unknown as { chartProbe: { localUpdates: number } }).chartProbe.localUpdates)).toBe(1);
  return { first: first ?? Infinity, redraws, availableEntries, bytes, records: bounded ? 5000 : 365, series, cpuThrottle: 2 };
}

async function publishTimings(info: TestInfo, result: Timings, label: string): Promise<void> {
  const ordered = [...result.redraws].sort((a, b) => a - b);
  const median = ((ordered[4] ?? Infinity) + (ordered[5] ?? Infinity)) / 2;
  const record = { ...result, median, min: ordered[0], max: ordered.at(-1) };
  console.log(`chart timing ${label}: ${JSON.stringify(record)}`);
  const evidence = info.outputPath(`chart-timing-${label}.json`);
  writeFileSync(evidence, `${JSON.stringify(record, null, 2)}\n`);
  await info.attach(`chart-timing-${label}`, { path: evidence, contentType: "application/json" });
  // Shared-host load is not a product failure. Keep measurements in the
  // required workload gate and reserve wall-clock budgets for an explicit benchmark.
  if (process.env.UB_CHART_TIMING_BUDGETS !== "1") return;
  expect.soft(result.first).toBeLessThanOrEqual(label === "representative" ? 500 : 1000);
  expect.soft(median).toBeLessThanOrEqual(label === "representative" ? 250 : 1000);
  if (label.startsWith("bound")) expect.soft(Math.max(...result.redraws)).toBeLessThanOrEqual(1000);
}

test("whole-area validation and Chart.js record representative and bounded Chromium redraw timings", { tag: "@workload" }, async ({ browser }, info) => {
  test.setTimeout(120_000);
  const session = writer();
  for (const { bounded, layout, bars } of [
    { bounded: false, layout: "overlay", bars: false },
    { bounded: true, layout: "overlay", bars: false },
    { bounded: true, layout: "panels", bars: false },
    { bounded: true, layout: "overlay", bars: true },
  ] as const) {
    const { uuid, bytes } = await workload(session, bounded, layout, bars);
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: async (loading) => {
        // A conservative CPU allowance on shared CI hardware, with the actual
        // host and throttle reported alongside measurements in the PR.
        const cdp = await loading.context().newCDPSession(loading);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 2 });
        await installProbe(loading, uuid);
      },
      contextOptions: { viewport: { width: 1366, height: 768 }, locale: "en-US" },
    });
    const result = await timingEvidence(page, session, uuid, bounded, bytes);
    await publishTimings(info, result, bars ? "bound-bars" : bounded ? layout === "panels" ? "bound-panels" : "bound" : "representative");
    await page.context().close();
  }
});
