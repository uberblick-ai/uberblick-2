/**
 * Charts consume document data through the production serving replica.
 * The writer is a different `ub mcp serve` process with its own SQLite state;
 * none of these browsers bypasses `ub open` by dialing the upstream hub.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

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
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: chart MCP agent is not configured");
  return agent.open({ name: "chart-data-e2e" });
}

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

interface PaintedText { text: string; x: number; y: number; font: string; rotated: boolean }
interface PaintedPoint { x: number; y: number; radius: number }
interface ChartPaintProbe { texts: string[]; ink: PaintedText[]; points: PaintedPoint[] }

/** Controls share the title's line and stay inside the panel in every state. */
async function expectCornerControls(page: Page, sourceName = "Open chart source"): Promise<void> {
  const root = page.locator(".ub-chart");
  const panel = page.locator(".ub-chart-panel");
  const source = page.getByRole("button", { name: sourceName, exact: true });
  const copy = root.locator(".ub-copy");
  await expect(source).toHaveText("source");
  await expect(source).toBeVisible();
  await expect(copy).toBeVisible();
  const frame = await root.evaluate((element) => ({
    label: getComputedStyle(element, "::before").content,
    labelDisplay: getComputedStyle(element, "::before").display,
    padding: Number.parseFloat(getComputedStyle(element).paddingTop),
  }));
  expect(frame.labelDisplay === "none" || ["none", '""'].includes(frame.label)).toBe(true);
  expect(frame.padding).toBe(0);
  const panelBox = await panel.boundingBox();
  const sourceBox = await source.boundingBox();
  const copyBox = await copy.boundingBox();
  if (panelBox === null || sourceBox === null || copyBox === null) throw new Error("e2e: chart corner controls have no box");
  expect(sourceBox.x).toBeGreaterThan(panelBox.x + panelBox.width / 2);
  expect(copyBox.x).toBeGreaterThanOrEqual(sourceBox.x + sourceBox.width);
  expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  expect(sourceBox.y).toBeGreaterThanOrEqual(panelBox.y);
  expect(copyBox.y).toBeGreaterThanOrEqual(panelBox.y);
  // A hidden title contributes no line; the controls still occupy the corner.
  const title = panel.locator(".ub-chart-title");
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

async function chartDoc(session: McpSession, title: string, mapping: unknown = MAPPING, decision = false): Promise<string> {
  const result = await session.call<{ uuid: string }>("create_doc", {
    title, description: "Live line-chart browser proof from document-owned measurements.",
    ...(decision ? { kind: "decision", status: "open", tldr: "Keep these approved measurements visible." } : {}),
    blocks: [
      { type: "paragraph", text: "Read the live measurements below." },
      { type: "chart", text: JSON.stringify(mapping) },
    ],
  });
  return result.uuid;
}

async function editMapping(session: McpSession, uuid: string, text: string): Promise<void> {
  const doc = await session.call<DocPayload>("get_doc", { uuid });
  const block = doc.blocks.find((entry) => entry.type === "chart");
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

async function expectReady(page: Page): Promise<void> {
  await expect(page.locator(".ub-chart-panel")).toHaveAttribute("data-state", "ready");
  await expect(page.getByRole("img", { name: "API latency", exact: true })).toBeVisible();
}

/**
 * Read Tiptap's existing editor reference and y-sync plugin, never a product
 * test hook. A data-map observation marks when the browser has applied an
 * update; a description mutation marks the completion of the synchronous
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
      durations: [] as number[], texts: [] as string[], paints: [] as string[], lastDescription: "",
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
      const text = document.querySelector(".ub-chart-description")?.textContent ?? "";
      if (text !== "" && text !== probe.lastDescription) {
        probe.lastDescription = text;
        if (probe.appliedAt !== 0) {
          const duration = performance.now() - probe.appliedAt;
          if (probe.first === null && probe.availableAt !== 0) {
            probe.first = performance.now() - probe.availableAt;
          }
          else probe.durations.push(duration);
        }
      }
    });
    mutations.observe(document, { childList: true, subtree: true, characterData: true });
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof fillText>): void {
      if (this.canvas.closest(".ub-chart") !== null) {
        probe.texts.push(args[0]);
        if (typeof this.fillStyle === "string") probe.paints.push(this.fillStyle);
        const transform = this.getTransform();
        const position = transform.transformPoint({ x: args[1], y: args[2] });
        const box = this.canvas.getBoundingClientRect();
        probe.ink.push({ text: args[0], x: position.x * box.width / this.canvas.width,
          y: position.y * box.height / this.canvas.height, font: this.font,
          rotated: Math.abs(transform.b) > 0.000001 || Math.abs(transform.c) > 0.000001 });
      }
      fillText.apply(this, args);
    };
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function (...args: Parameters<typeof arc>): void {
      if (this.canvas.closest(".ub-chart") !== null && args[2] > 0) {
        const position = this.getTransform().transformPoint({ x: args[0], y: args[1] });
        const box = this.canvas.getBoundingClientRect();
        probe.points.push({ x: position.x * box.width / this.canvas.width,
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
      CanvasRenderingContext2D.prototype.fillText = fillText;
      CanvasRenderingContext2D.prototype.arc = arc;
    });
  }, uuid);
}

test("editor insertion and the source control work by pointer and keyboard in both appearances", async ({ browser }, info) => {
  const session = writer();
  for (const appearance of ["light", "dark"] as const) {
    const page = await openApp(browser, "/", { contextOptions: { colorScheme: appearance } });
    await expect(page.locator(".ub-list-head")).toBeVisible();
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
    await source.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.insertText(JSON.stringify(MAPPING));
    await expect(source).toHaveText(JSON.stringify(MAPPING));
    // A newly created browser document may be known to the agent directory
    // before its room is hydrated; the writer waits for the authored source.
    await expect.poll(async () => {
      try {
        const doc = await session.call<DocPayload>("get_doc", { uuid });
        return doc.blocks.find((entry) => entry.type === "chart")?.text;
      } catch (error) {
        if (error instanceof Error && /doc_not_hydrated|doc_not_found/.test(error.message)) return null;
        throw error;
      }
    }).toBe(JSON.stringify(MAPPING));
    await measurements(session, uuid);
    await editor(page).locator(":scope > p").first().click();
    await expectReady(page);
    await expectCornerControls(page);
    await expect(source).toBeHidden();
    await page.locator(".ub-chart-screen").click();
    await expect(source).toBeVisible();
    await expect(page.locator(".ub-chart .ub-copy")).toBeVisible();
    await editor(page).locator(":scope > p").first().click();
    await expectReady(page);
    const openSource = page.getByRole("button", { name: "Open chart source", exact: true });
    // Native Tab order, rather than focusing the button by script.
    for (let count = 0; count < 20; count += 1) {
      if (await openSource.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(openSource).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(source).toBeVisible();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" ");
    await expect(source).toHaveText(`${JSON.stringify(MAPPING)} `);
    await editor(page).locator(":scope > p").first().click();
    await page.keyboard.press("ArrowLeft");
    await expectReady(page);
    await expectCornerControls(page);
    await canvasEvidence(page.locator(".ub-chart"), info, `chart-${appearance}`);
    const stored = await session.call<DocPayload>("get_doc", { uuid });
    expect(stored.blocks.find((entry) => entry.type === "chart")?.text).toBe(`${JSON.stringify(MAPPING)} `);
  }
});

test("MCP updates and remote mapping edits redraw through ub open, preserve data and survive reopen", async ({ browser }) => {
  const session = writer();
  const uuid = await chartDoc(session, "Live line chart");
  await measurements(session, uuid);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { beforeNavigate: (loading) => installProbe(loading, uuid) });
  await expectReady(page);
  const canvas = page.getByRole("img", { name: "API latency", exact: true });
  await expect(canvas).toHaveAccessibleDescription(/Latency.*125.*ms/);
  await expect(canvas).toHaveAccessibleDescription(/Errors.*4.*requests/);
  await expect(page.locator(".ub-chart-diagnostics")).toContainText(/1.*(?:date|x)/i);
  await expect(page.locator(".ub-chart-description")).not.toHaveAttribute("aria-live", /.*/);
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await session.call("update_data", {
    uuid, operations: [{ collection: "measurements", upsert: [{ id: "latest", value: { day: "2026-01-02", latency: 250, errors: 9 } }] }],
  });
  await expect(canvas).toHaveAccessibleDescription(/Latency.*250.*ms/);
  await expect(canvas).toHaveAccessibleDescription(/Errors.*9.*requests/);
  const beforeMapping = await session.call("get_data", { uuid, collection: "measurements" });
  const updatedMapping = { ...MAPPING, title: "Live API health", y: [{ field: "latency", label: "Response time", unit: "ms" }] };
  await editMapping(session, uuid, JSON.stringify(updatedMapping));
  const renamed = page.getByRole("img", { name: "Live API health", exact: true });
  await expect(renamed).toBeVisible();
  await expect(renamed).toHaveAccessibleDescription(/Response time.*250.*ms/);
  expect(await session.call("get_data", { uuid, collection: "measurements" })).toEqual(beforeMapping);
  await session.call("update_data", {
    uuid, operations: [{ collection: "measurements", upsert: [{ id: "latest", value: { day: "2026-01-02", latency: 375, errors: 11 } }] }],
  });
  await expect(renamed).toHaveAccessibleDescription(/Response time.*375.*ms/);
  expect(await page.evaluate(() => (window as unknown as { chartProbe: { localUpdates: number } }).chartProbe.localUpdates)).toBe(0);
  const lightCanvas = await renamed.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const lightInk = await page.evaluate(() => (window as unknown as { chartProbe: { paints: string[] } }).chartProbe.paints.at(-1));
  await page.getByTestId("account-menu").click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => renamed.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(lightCanvas);
  expect(await page.evaluate(() => (window as unknown as { chartProbe: { paints: string[] } }).chartProbe.paints.at(-1))).not.toBe(lightInk);
  const paintedText = await page.evaluate(() => (window as unknown as { chartProbe: { texts: string[] } }).chartProbe.texts);
  expect(paintedText).toContain("Latency (ms)");
  expect(paintedText).toContain("Errors (requests)");
  expect(paintedText).toContain("2026");
  expect(paintedText.some((text) => /^Jan [12]$/.test(text))).toBe(true);
  expect(paintedText.some((text) => /Jan [12], 2026/.test(text))).toBe(false);
  expect(navigations).toBe(0);
  await page.reload();
  await expect(renamed).toHaveAccessibleDescription(/Response time.*375.*ms/);
  const reopened = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expect(reopened.getByRole("img", { name: "Live API health", exact: true })).toHaveAccessibleDescription(/Response time.*375.*ms/);
  const stored = await session.call<DocPayload>("get_doc", { uuid });
  expect(stored.blocks.find((entry) => entry.type === "chart")?.text).toBe(JSON.stringify(updatedMapping));
  const data = await session.call<{ records: { id: string; value: unknown }[] }>("get_data", { uuid, collection: "measurements" });
  expect(data.records.find((entry) => entry.id === "latest")?.value).toEqual({ day: "2026-01-02", latency: 375, errors: 11 });
});

test("calendar ink, independent unit axes and nearest-x tooltips keep sparse and single-x charts readable", async ({ browser }) => {
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
  await expectReady(page);
  await expectCornerControls(page);
  await expect(page.locator(".ub-chart-diagnostics")).toBeHidden();
  const canvas = page.getByRole("img", { name: "API latency", exact: true });
  const ink = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink);
  const leftTicks = ink.filter((entry) => /^[\d.,]+(?:[KM])? ms$/.test(entry.text));
  const rightTicks = ink.filter((entry) => /^[\d.,]+(?:[KM])? requests$/.test(entry.text));
  expect(leftTicks.length).toBeGreaterThan(0);
  expect(rightTicks.length).toBeGreaterThan(0);
  expect(Math.max(...leftTicks.map((entry) => entry.x))).toBeLessThan(Math.min(...rightTicks.map((entry) => entry.x)));
  const calendar = ink.filter((entry) => /^Jan [123]$|^2026$|^\d{2}:\d{2}$|^UTC$/.test(entry.text));
  expect(calendar.length).toBeGreaterThan(0);
  expect(calendar.every((entry) => !entry.rotated && entry.font.includes("Geist"))).toBe(true);
  const legends = ink.filter((entry) => entry.text === "Latency (ms)" || entry.text === "Errors (requests)");
  expect(new Set(legends.map((entry) => entry.text))).toEqual(new Set(["Latency (ms)", "Errors (requests)"]));
  expect(Math.min(...legends.map((entry) => entry.y))).toBeGreaterThan(Math.max(...calendar.map((entry) => entry.y)));
  expect(ink.some((entry) => entry.text === "Day" || entry.text.includes("Latency (ms), Errors"))).toBe(false);

  await session.call("update_data", { uuid, operations: [{ collection: "measurements", upsert: [
    { id: "middle", value: { day: "2026-01-02", latency: null, errors: 9 } },
  ] }] });
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
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator(".ub-chart-title")).toBeHidden();
  await expectCornerControls(page, "Open table source");
  await editMapping(session, uuid, JSON.stringify({ ...MAPPING, title: "" }));
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", replaceRecords: [] }] });
  await expect(page.locator(".ub-chart-message")).toContainText("No plottable records");
  await expect(page.locator(".ub-chart-diagnostics")).toBeHidden();
  await expectCornerControls(page);
});

test("a 360px three-series chart keeps compact ticks and a readable capped canvas", { tag: "@webkit-iphone" }, async ({ browser }, info) => {
  const session = writer();
  const mapping = { ...MAPPING, title: "Delivery trend", y: [
    { field: "autonomous", label: "Autonomous deliveries", unit: "%" },
    { field: "wasted", label: "Wasted runs", unit: "%" },
    { field: "held", label: "Runs with decisions", unit: "%" },
  ] };
  const uuid = await chartDoc(session, "Phone chart", mapping);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements",
    schema: { version: 1, schema: { type: "object", properties: {
      day: { type: "string" }, autonomous: { type: "number" }, wasted: { type: "number" }, held: { type: "number" },
    } } },
    replaceRecords: Array.from({ length: 14 }, (_, index) => ({ id: `day-${index}`, value: {
      day: new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10),
      autonomous: 65 + index * 2, wasted: 24 - index, held: 8 + index % 4,
    } })),
  }] });
  for (const appearance of ["light", "dark"] as const) {
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: (loading) => installProbe(loading, uuid),
      contextOptions: { viewport: { width: 360, height: 844 }, locale: "en-US", colorScheme: appearance },
    });
    const canvas = page.getByRole("img", { name: "Delivery trend", exact: true });
    await expect(canvas).toBeVisible();
    await expectCornerControls(page);
    await expect(page.locator(".ub-chart-diagnostics")).toBeHidden();
    const screen = await page.locator(".ub-chart-screen").boundingBox();
    if (screen === null) throw new Error("e2e: phone chart has no screen");
    expect(screen.height).toBeGreaterThanOrEqual(199);
    expect(screen.height).toBeLessThanOrEqual(301);
    expect(screen.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => window.innerWidth)).toBe(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const ink = await page.evaluate(() => (window as unknown as { chartProbe: ChartPaintProbe }).chartProbe.ink);
    for (const series of mapping.y) {
      expect(ink.some((entry) => entry.text === series.label)).toBe(true);
      expect(ink.some((entry) => entry.text === `${series.label} (%)`)).toBe(false);
    }
    expect(ink.some((entry) => /^[\d.,]+%$/.test(entry.text))).toBe(true);
    expect(ink.some((entry) => /^\d+ %$/.test(entry.text))).toBe(false);
    const dates = ink.filter((entry) => /^Oct \d+$|^2026$/.test(entry.text));
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((entry) => !entry.rotated)).toBe(true);
    await canvasEvidence(page.locator(".ub-chart"), info, `chart-phone-${appearance}`);
  }
});

test("problem states clear automatically and locked content still renders without changing stored source", async ({ browser }) => {
  const session = writer();
  const uuid = await chartDoc(session, "Chart problems", MAPPING, true);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expect(page.locator(".ub-chart-message")).toContainText(/collection.*(?:absent|not found|missing)/i);
  await editMapping(session, uuid, "{invalid JSON");
  await expect(page.locator(".ub-chart-message")).toContainText(/invalid.*(?:configuration|JSON)/i);
  await editMapping(session, uuid, JSON.stringify(MAPPING));
  await measurements(session, uuid);
  await expectReady(page);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", replaceRecords: [] }] });
  await expect(page.locator(".ub-chart-message")).toContainText(/no plottable records/i);
  await measurements(session, uuid);
  await expectReady(page);
  const data = await session.call("get_data", { uuid, collection: "measurements" });
  const stored = await session.call<DocPayload>("get_doc", { uuid });
  await session.call("set_status", { uuid, status: "decided" });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expectReady(page);
  await expect(session.call("update_data", { uuid, operations: [{ collection: "measurements", replaceRecords: [] }] })).rejects.toThrow(/decision_read_only/);
  await expect(editMapping(session, uuid, "{}")).rejects.toThrow(/decision_read_only/);
  expect(await session.call("get_data", { uuid, collection: "measurements" })).toEqual(data);
  expect((await session.call<DocPayload>("get_doc", { uuid })).blocks).toEqual(stored.blocks);
  await session.call("archive_doc", { uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expectReady(page);
  await expect(editMapping(session, uuid, "{}")).rejects.toThrow(/doc_archived/);
  expect((await session.call<DocPayload>("get_doc", { uuid })).blocks).toEqual(stored.blocks);
});

interface Timings {
  first: number; redraws: number[]; availableEntries: number;
  bytes: number; records: number; series: number; cpuThrottle: number;
}

async function workload(session: McpSession, bounded: boolean): Promise<{ uuid: string; bytes: number }> {
  const series = bounded ? 8 : 3;
  const collection = "summaries";
  const mapping = {
    version: 1, type: "line", collection, title: bounded ? "Bound chart" : "API health year",
    x: { field: "day", type: "date", label: "Day" },
    y: Array.from({ length: series }, (_, index) => ({ field: `value${index}`, label: `Metric ${index}`, unit: "ms" })),
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
  const summary = await session.call<{ data: { bytes: number } }>("get_data", { uuid });
  return { uuid, bytes: summary.data.bytes };
}

async function timingEvidence(page: Page, session: McpSession, uuid: string, bounded: boolean, bytes: number): Promise<Timings> {
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
    await expect(canvas).toHaveAccessibleDescription(new RegExp(`Metric 0: ${value} ms`));
    await expect.poll(() => page.evaluate(() => (window as unknown as { chartProbe: { durations: number[] } }).chartProbe.durations.length)).toBe(previous + 1);
    const duration = await page.evaluate(() => (window as unknown as { chartProbe: { durations: number[] } }).chartProbe.durations.at(-1));
    if (duration === undefined) throw new Error("e2e: chart redraw had no browser-applied data timestamp");
    redraws.push(duration);
  }
  expect(await page.evaluate(() => (window as unknown as { chartProbe: { localUpdates: number } }).chartProbe.localUpdates)).toBe(0);
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
  // ordinary gate and reserve wall-clock budgets for an explicit benchmark.
  if (process.env.UB_CHART_TIMING_BUDGETS !== "1") return;
  expect(result.first).toBeLessThanOrEqual(label === "representative" ? 500 : 1000);
  expect(median).toBeLessThanOrEqual(label === "representative" ? 250 : 1000);
  if (label === "bound") expect(Math.max(...result.redraws)).toBeLessThanOrEqual(1000);
}

test("whole-area validation and Chart.js record representative and bounded Chromium redraw timings", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const session = writer();
  for (const bounded of [false, true]) {
    const { uuid, bytes } = await workload(session, bounded);
    if (!bounded) expect(bytes).toBeGreaterThan(2_500_000);
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
    await publishTimings(info, result, bounded ? "bound" : "representative");
  }
});
