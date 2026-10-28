/** Scatter input and paint use the production editor and its serving replica. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { legacyDecisionPeer } from "./legacy-decision-peer.js";
import { expectMcp, proveMcpArrival, waitForDocumentDraw } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const peers: Array<{ close: () => void }> = [];
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-scatter-${process.env.UB_AGENTS_RUN ?? "local"}-`,
  });
});
test.afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await agent?.closeSessions();
});
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: scatter MCP agent is not configured");
  return agent.open({ name: "scatter-e2e" });
}

const TARGET = "https://example.invalid/scatter-evidence";
const MAPPING = {
  version: 1, type: "scatter", collection: "options", title: "Quality versus cost", height: 300,
  x: { field: "cost", label: "Weekly cost", unit: "EUR", lower: "cost_low", upper: "cost_high", range: [0, 100] },
  y: { field: "quality", label: "Quality", unit: "%", lower: "quality_low", upper: "quality_high", range: [0, 100] },
  label: "name", group: "tier",
  details: [
    { field: "sample_size", label: "Sample size", format: "number", decimals: 0 },
    { field: "source", label: "Source", format: "link" },
    { field: "absent", label: "Missing detail" },
    { field: "null_detail", label: "Null detail" },
    { field: "invalid_number", label: "Invalid number", format: "number" },
  ],
};
const RECORDS = [
  { id: "a", value: { name: "Alpha", tier: "Standard", cost: 20, quality: 82,
    cost_low: -20, cost_high: 35, quality_low: 76, quality_high: 120,
    sample_size: 120, source: TARGET, null_detail: null, invalid_number: "twelve" } },
  { id: "b", value: { name: "Beta", tier: "Plus", cost: 50, quality: 50 } },
  { id: "c", value: { name: "Gamma", tier: "Premium", cost: 80, quality: 20 } },
  { id: "d", value: { name: "Beta twin", cost: 50, quality: 50 } },
];
interface DocPayload { blocks: { id: string; type: string; text: string; rev: string }[] }
interface PaintPoint { x: number; y: number; radius: number; colour: string }
interface PaintText { text: string; x: number; y: number; left: number; right: number; top: number; bottom: number; colour: string }
interface PaintLine { from: { x: number; y: number }; to: { x: number; y: number }; colour: string }
interface PaintProbe { points: PaintPoint[]; texts: PaintText[]; lines: PaintLine[]; fills: string[] }

async function scatterDoc(session: McpSession): Promise<string> {
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Scatter comparison", description: "Synthetic observations with stored uncertainty.",
    blocks: [{ type: "paragraph", text: "Read the observations below." }, { type: "chart", text: JSON.stringify(MAPPING) }],
  });
  await records(session, uuid, RECORDS);
  return uuid;
}

async function records(session: McpSession, uuid: string, values: unknown[]): Promise<void> {
  await session.call("update_data", { uuid, operations: [{
    collection: "options", schema: { version: 1, schema: { type: "object" } }, replaceRecords: values,
  }] });
}

async function editMapping(session: McpSession, uuid: string, mapping: unknown): Promise<void> {
  const doc = await session.call<DocPayload>("get_doc", { uuid });
  const block = doc.blocks.find(entry => entry.type === "chart");
  if (block === undefined) throw new Error("e2e: scatter source is absent");
  await session.call("edit_block", { uuid, block_id: block.id, old_text: block.text, new_text: JSON.stringify(mapping), rev: block.rev });
}

/** Native canvas calls expose painted geometry without reading Chart.js state. */
async function installPaintProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: PaintProbe = { points: [], texts: [], lines: [], fills: [] };
    (window as unknown as { scatterPaint: PaintProbe }).scatterPaint = probe;
    const prototype = CanvasRenderingContext2D.prototype;
    const { clearRect, arc, fillText, beginPath, moveTo, lineTo, stroke, fill } = prototype;
    const paths = new WeakMap<CanvasRenderingContext2D, { current: { x: number; y: number } | null; lines: PaintLine[] }>();
    const active = (context: CanvasRenderingContext2D): boolean => context.canvas.closest('.ub-chart[data-view="scatter"]') !== null;
    const position = (context: CanvasRenderingContext2D, x: number, y: number): { x: number; y: number } => {
      const point = context.getTransform().transformPoint({ x, y });
      const box = context.canvas.getBoundingClientRect();
      return { x: point.x * box.width / context.canvas.width, y: point.y * box.height / context.canvas.height };
    };
    prototype.clearRect = function (...args: Parameters<typeof clearRect>): void {
      if (active(this) && args[0] === 0 && args[1] === 0 && args[2] === this.canvas.width && args[3] === this.canvas.height) {
        probe.points = []; probe.texts = []; probe.lines = []; probe.fills = [];
      }
      clearRect.apply(this, args);
    };
    prototype.arc = function (...args: Parameters<typeof arc>): void {
      if (active(this) && args[2] > 0) probe.points.push({ ...position(this, args[0], args[1]), radius: args[2], colour: String(this.fillStyle) });
      arc.apply(this, args);
    };
    prototype.fillText = function (...args: Parameters<typeof fillText>): void {
      if (active(this)) {
        const metrics = this.measureText(args[0]);
        probe.texts.push({ text: args[0], colour: String(this.fillStyle), ...position(this, args[1], args[2]),
          left: position(this, args[1] - metrics.actualBoundingBoxLeft, args[2]).x,
          right: position(this, args[1] + metrics.actualBoundingBoxRight, args[2]).x,
          top: position(this, args[1], args[2] - metrics.actualBoundingBoxAscent).y,
          bottom: position(this, args[1], args[2] + metrics.actualBoundingBoxDescent).y });
      }
      fillText.apply(this, args);
    };
    prototype.beginPath = function (): void { paths.set(this, { current: null, lines: [] }); beginPath.call(this); };
    prototype.moveTo = function (...args: Parameters<typeof moveTo>): void {
      const path = paths.get(this);
      if (path !== undefined) path.current = position(this, args[0], args[1]);
      moveTo.apply(this, args);
    };
    prototype.lineTo = function (...args: Parameters<typeof lineTo>): void {
      const path = paths.get(this), to = position(this, args[0], args[1]);
      if (path !== undefined) {
        if (path.current !== null) path.lines.push({ from: path.current, to, colour: String(this.strokeStyle) });
        path.current = to;
      }
      lineTo.apply(this, args);
    };
    prototype.stroke = function (path?: Path2D): void {
      if (active(this)) probe.lines.push(...paths.get(this)?.lines ?? []);
      Reflect.apply(stroke, this, path === undefined ? [] : [path]);
    };
    prototype.fill = function (path?: CanvasFillRule | Path2D, fillRule?: CanvasFillRule): void {
      if (active(this)) probe.fills.push(String(this.fillStyle));
      Reflect.apply(fill, this, path === undefined ? [] : [path, fillRule]);
    };
    addEventListener("pagehide", () => Object.assign(prototype, { clearRect, arc, fillText, beginPath, moveTo, lineTo, stroke, fill }));
  });
}

async function paint(page: Page): Promise<PaintProbe> {
  await page.evaluate(async () => { await document.fonts.ready; });
  return page.evaluate(() => (window as unknown as { scatterPaint: PaintProbe }).scatterPaint);
}

function besideLabel(point: { x: number; y: number }, label: PaintText): boolean {
  return point.x < label.left && label.left - point.x < 30
    && point.y > label.top - 20 && point.y < label.bottom + 20;
}

function alphaPoint(probe: PaintProbe): PaintPoint {
  const label = probe.texts.find(entry => entry.text === "Alpha");
  if (label === undefined) throw new Error("e2e: scatter Alpha label was not painted");
  const point = probe.points.find(entry => besideLabel(entry, label));
  if (point !== undefined) return point;
  const whisker = probe.lines.find(line => besideLabel(line.from, label)
    && Math.abs(line.from.y - line.to.y) < 0.1 && Math.abs(line.from.x - line.to.x) > 20);
  if (whisker === undefined) throw new Error("e2e: scatter Alpha has no nearby painted point or whisker");
  return { ...whisker.from, radius: 4, colour: whisker.colour };
}

function expectAlphaLabelClear(probe: PaintProbe): void {
  const alpha = alphaPoint(probe);
  const label = probe.texts.find(entry => entry.text === "Alpha");
  if (label === undefined) throw new Error("e2e: scatter Alpha label was not painted");
  const stem = probe.lines.find(line => Math.abs(line.from.x - alpha.x) < 1 && Math.abs(line.from.y - alpha.y) < 1);
  if (stem === undefined) throw new Error("e2e: scatter Alpha whiskers were not painted");
  const whiskers = probe.lines.filter(line => line.colour === stem.colour);
  expect(whiskers.length).toBeGreaterThan(0);
  for (const line of whiskers) {
    expect(Math.max(line.from.x, line.to.x) < label.left || Math.min(line.from.x, line.to.x) > label.right
      || Math.max(line.from.y, line.to.y) < label.top || Math.min(line.from.y, line.to.y) > label.bottom).toBe(true);
  }
  const ring = probe.points.find(point => point.radius === 9 && Math.abs(point.x - alpha.x) < 1 && Math.abs(point.y - alpha.y) < 1);
  if (ring === undefined) throw new Error("e2e: selected Alpha ring was not painted");
  expect(label.left).toBeGreaterThan(alpha.x + ring.radius + 1);
}

async function selectAlpha(page: Page, touch: boolean): Promise<void> {
  const point = alphaPoint(await paint(page));
  const box = await page.locator(".ub-chart-screen canvas").boundingBox();
  if (box === null) throw new Error("e2e: scatter canvas has no box");
  if (touch) await page.touchscreen.tap(box.x + point.x, box.y + point.y);
  else await page.mouse.click(box.x + point.x, box.y + point.y);
  await expect(page.getByRole("combobox", { name: "Select point", exact: true })).toHaveValue("a");
  await expect(page.locator(".ub-chart-source")).toBeHidden();
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  const webkitMac = process.platform === "darwin" && page.context().browser()?.browserType().name() === "webkit";
  for (let count = 0; count < 40; count += 1) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press(webkitMac ? "Alt+Tab" : "Tab");
  }
  await expect(target).toBeFocused();
}

async function evidence(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.locator(".ub-chart").screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("scatter bounds, groups, collision hiding and selected details paint in both appearances", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer(), uuid = await scatterDoc(session);
  const touch = info.project.use.hasTouch === true;
  for (const appearance of ["light", "dark"] as const) {
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: installPaintProbe,
      contextOptions: { ...(touch ? devices["iPad Pro 11"] : { viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false }),
        locale: "en-US", colorScheme: appearance },
    });
    await waitForDocumentDraw(page, session, uuid);
    await expect(page.getByRole("img", { name: MAPPING.title, exact: true })).toBeVisible();
    const selector = page.getByRole("combobox", { name: "Select point", exact: true });
    await expect(selector.locator("option[value]:not([value=''])")).toHaveCount(4);
    const probe = await paint(page);
    expect(probe.texts.filter(entry => entry.text === "Beta" || entry.text === "Beta twin")).toHaveLength(1);
    expect(probe.texts.map(entry => entry.text)).toEqual(expect.arrayContaining(["Alpha", "Gamma", "Standard", "Plus", "Premium"]));
    const neutralInk = await page.locator(".ub-chart-probe").evaluate(element => {
      const context = document.createElement("canvas").getContext("2d");
      if (context === null) throw new Error("e2e: no canvas colour normalizer");
      context.fillStyle = getComputedStyle(element).color;
      return String(context.fillStyle);
    });
    for (const legend of probe.texts.filter(entry => ["Standard", "Plus", "Premium"].includes(entry.text))) {
      expect(legend.colour).toBe(neutralInk);
    }
    const alpha = alphaPoint(probe);
    const twinLabel = probe.texts.find(entry => entry.text === "Beta" || entry.text === "Beta twin");
    const twin = probe.points.find(entry => twinLabel !== undefined && besideLabel(entry, twinLabel));
    if (twin === undefined) throw new Error("e2e: equal-valued neutral point was not painted");
    const boundX = alpha.x + (-20 - 20) / (50 - 20) * (twin.x - alpha.x);
    const boundY = alpha.y + (120 - 82) / (50 - 82) * (twin.y - alpha.y);
    expect(probe.lines.some(line => Math.abs(line.from.x - boundX) < 1 && Math.abs(line.from.y - alpha.y) < 1
      || Math.abs(line.to.x - boundX) < 1 && Math.abs(line.to.y - alpha.y) < 1)).toBe(true);
    expect(probe.lines.some(line => Math.abs(line.from.y - boundY) < 1 && Math.abs(line.from.x - alpha.x) < 1
      || Math.abs(line.to.y - boundY) < 1 && Math.abs(line.to.x - alpha.x) < 1)).toBe(true);
    expect(boundX).toBeGreaterThanOrEqual(0);
    expect(boundY).toBeGreaterThanOrEqual(0);
    if (appearance === "light") {
      const box = await page.locator(".ub-chart-screen canvas").boundingBox();
      if (box === null) throw new Error("e2e: scatter canvas has no box");
      for (const id of ["b", "d"]) {
        if (touch) await page.touchscreen.tap(box.x + twin.x, box.y + twin.y);
        else await page.mouse.click(box.x + twin.x, box.y + twin.y);
        await expect(selector).toHaveValue(id);
        await expect(page.locator(".ub-chart-source")).toBeHidden();
      }
    }
    await selectAlpha(page, touch);
    expectAlphaLabelClear(await paint(page));
    const details = page.locator(".ub-scatter-details");
    await expect(details).toContainText("Alpha");
    await expect(details).toContainText("Standard");
    await expect(details).toContainText("20 EUR (-20–35 EUR)");
    await expect(details).toContainText("82 % (76–120 %)");
    await expect(details.locator("dt")).toHaveText(["Label", "Group", "Weekly cost", "Quality", "Sample size", "Source", "Missing detail", "Null detail", "Invalid number"]);
    await expect(details).toContainText("Absent");
    await expect(details).toContainText("Null");
    await expect(details).toContainText("Invalid: twelve");
    await expect(details.getByRole("link", { name: TARGET, exact: true })).toHaveAttribute("href", TARGET);
    const screenBox = await page.locator(".ub-chart-screen").boundingBox(), detailsBox = await details.boundingBox();
    if (screenBox === null || detailsBox === null) throw new Error("e2e: scatter layout boxes are absent");
    expect(detailsBox.y).toBeGreaterThanOrEqual(screenBox.y + screenBox.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await evidence(page, info, `chart-scatter-${touch ? "ipad" : "desktop"}-${appearance}`);
    await page.context().close();
  }
});

test("scatter keyboard selection follows record identity and stays out of stored content", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer(), uuid = await scatterDoc(session);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await waitForDocumentDraw(page, session, uuid);
  const source = JSON.stringify(MAPPING);
  const selector = page.getByRole("combobox", { name: "Select point", exact: true });
  await editor(page).locator(":scope > p").first().click();
  await tabTo(page, selector);
  await page.keyboard.press("Home");
  for (const record of RECORDS) {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(selector).toHaveValue(record.id);
    await expect(page.locator(".ub-scatter-details")).toContainText(record.value.name);
    await expect(page.locator(".ub-chart-source")).toBeHidden();
  }
  await page.keyboard.press("Tab");
  await expect(selector).not.toBeFocused();
  // A later browser metadata write proves the preceding local selections have
  // crossed the upstream reader before checking that chart and data stayed put.
  await proveMcpArrival(page, session, uuid, { path: "upstream", restore: true });
  await expectMcp(() => session.call<DocPayload>("get_doc", { uuid }), doc => {
    expect(doc.blocks.find(block => block.type === "chart")?.text).toBe(source);
  });
  await expectMcp(() => session.call<{ records: unknown[] }>("get_data", { uuid, collection: "options" }), data => {
    expect(data.records.map(record => { const entry = record as { id: string; value: unknown }; return { id: entry.id, value: entry.value }; })).toEqual(RECORDS);
  });
  const changed = RECORDS.map(record => record.id === "d" ? { ...record, value: { ...record.value, quality: 63 } } : record);
  await records(session, uuid, changed);
  await waitForDocumentDraw(page, session, uuid);
  await expect(selector).toHaveValue("d");
  await expect(page.locator(".ub-scatter-details")).toContainText("63 %");
  await records(session, uuid, changed.filter(record => record.id !== "d"));
  await waitForDocumentDraw(page, session, uuid);
  await expect(selector).toHaveValue("");
  await selector.selectOption("b");
  await editMapping(session, uuid, { ...MAPPING, title: "Edited scatter mapping" });
  await waitForDocumentDraw(page, session, uuid);
  await expect(selector).toHaveValue("");
  await selector.selectOption("b");
  await page.reload();
  await waitForDocumentDraw(page, session, uuid);
  await expect(page.getByRole("combobox", { name: "Select point", exact: true })).toHaveValue("");
});

test("eight scatter groups paint separate colours and overflow returns every point to neutral", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer(), uuid = await scatterDoc(session);
  const grouped = Array.from({ length: 8 }, (_, index) => ({ id: `group-${index}`, value: {
    name: `Observation ${index + 1}`, tier: `Group ${index + 1}`, cost: 10 + index * 10, quality: 20 + index % 4 * 20,
  } }));
  const touch = info.project.use.hasTouch === true;
  for (const appearance of ["light", "dark"] as const) {
    await records(session, uuid, grouped);
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: installPaintProbe,
      contextOptions: { ...(touch ? devices["iPad Pro 11"] : { viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false }), colorScheme: appearance },
    });
    await waitForDocumentDraw(page, session, uuid);
    const groups = await paint(page);
    expect(new Set(groups.fills).size).toBe(8);
    expect(groups.texts.filter(entry => /^Group \d$/.test(entry.text))).toHaveLength(8);
    await records(session, uuid, [...grouped, { id: "group-8", value: { name: "Overflow", tier: "Group 9", cost: 90, quality: 50 } }]);
    await waitForDocumentDraw(page, session, uuid);
    const neutral = await paint(page);
    expect(new Set(neutral.fills).size).toBe(1);
    expect(neutral.points).toHaveLength(9);
    expect(neutral.texts.filter(entry => /^Group \d$/.test(entry.text))).toHaveLength(0);
    await expect(page.locator(".ub-chart-diagnostics")).toContainText("tier");
    await expect(page.locator(".ub-chart-diagnostics")).toContainText(/8|eight/);
    await page.context().close();
  }
});

test("scatter pointer or touch selection, height and locked source inspection use native input", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer(), uuid = await scatterDoc(session);
  const touch = info.project.use.hasTouch === true;
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: installPaintProbe,
    contextOptions: touch ? devices["iPad Pro 11"] : { viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false },
  });
  await waitForDocumentDraw(page, session, uuid);
  await selectAlpha(page, touch);
  const popup = page.waitForEvent("popup");
  const link = page.locator(".ub-scatter-details").getByRole("link", { name: TARGET, exact: true });
  if (touch) await link.tap(); else await link.click();
  await (await popup).close();
  if (touch) {
    await expect(page.getByRole("button", { name: "Resize chart", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Open chart source", exact: true }).tap();
    await expect(page.locator(".ub-chart-source")).toBeVisible();
    const height = page.getByRole("textbox", { name: "Height", exact: true });
    await height.fill("340");
    await height.press("Enter");
    await editor(page).locator(":scope > p").first().tap();
    await expect(page.locator(".ub-chart-source")).toBeHidden();
  } else {
    const handle = page.getByRole("button", { name: "Resize chart", exact: true });
    await page.locator(".ub-chart").hover();
    const box = await handle.boundingBox();
    if (box === null) throw new Error("e2e: scatter resize handle has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 4 });
    await page.mouse.up();
  }
  await expectMcp(() => session.call<DocPayload>("get_doc", { uuid }), doc => {
    expect(JSON.parse(doc.blocks.find(block => block.type === "chart")?.text ?? "{}").height).toBe(340);
  });
  await waitForDocumentDraw(page, session, uuid);
  await expect.poll(() => page.locator(".ub-chart-screen").evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(340);
  const peer = await legacyDecisionPeer(harness(), uuid);
  peers.push(peer);
  peer.decide("decided");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await selectAlpha(page, touch);
  // The bottom corner lies away from every point; it remains a source target.
  const canvas = page.locator(".ub-chart-screen canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("e2e: scatter canvas has no box");
  if (touch) await page.touchscreen.tap(box.x + box.width - 4, box.y + box.height - 4);
  else await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4);
  await expect(page.locator(".ub-chart-source")).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await editor(page).locator(":scope > p").first().click();
  await expect(page.locator(".ub-chart-source")).toBeHidden();
  await page.locator(".ub-chart").hover();
  await page.getByRole("button", { name: "Open chart source", exact: true }).click();
  await expect(page.locator(".ub-chart-source")).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
});
