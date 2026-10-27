/** Chart heights are source edits; real pointer geometry and touch fields own the gestures. */
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { createAnnotation, getBlocks, getBlocksFragment, getMeta, roomForDoc } from "@uberblick/schema";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import * as Y from "yjs";
import { composite, contrast, pageGrounds } from "../test/colour.js";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp, proveBrowserTitleArrival, proveMcpArrival, waitForDocumentDraw } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const MAPPING = {
  version: 1, type: "line", collection: "measurements", title: "Chart height",
  x: { field: "day", type: "date" }, y: [{ field: "count", label: "Count" }],
};
const SOURCE = JSON.stringify({ ...MAPPING, height: 300 }, null, 2).replace('"height": 300', '"height" : 300');
interface StoredDoc { uuid: string; blocks: { id: string; type: string; text: string; rev: string }[] }

test.beforeAll(() => {
  agent = new McpAgent({ workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-chart-height-" });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

async function fixture(browser: Browser, source = SOURCE, touch = false): Promise<{
  page: Page; writer: McpSession; uuid: string; block: Locator;
}> {
  if (agent === null) throw new Error("e2e: chart-height MCP agent unavailable");
  const writer = agent.open({ name: "chart-height-e2e" });
  const created = await writer.call<StoredDoc>("create_doc", {
    title: docTitle("Chart height"), description: "Chart height browser acceptance.",
    blocks: [{ type: "paragraph", text: "Before resize." }, { type: "chart", text: source }],
  });
  await writer.call("update_data", { uuid: created.uuid, operations: [{ collection: "measurements",
    schema: { version: 1, schema: { type: "object", properties: { day: { type: "string" }, count: { type: "number" } } } },
    replaceRecords: [
      { id: "first", value: { day: "2026-01-01", count: 3 } },
      { id: "latest", value: { day: "2026-01-02", count: 9 } },
      { id: "invalid", value: { day: "bad-date", count: 5 } },
    ],
  }] });
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    contextOptions: { viewport: { width: touch ? 810 : 1440, height: 1400 },
      ...(touch ? { hasTouch: true, isMobile: false } : {}) },
  });
  await expect(editor(page)).toBeVisible();
  await waitForDocumentDraw(page, writer, created.uuid);
  return { page, writer, uuid: created.uuid, block: page.locator(".ub-chart") };
}

async function stored(writer: McpSession, uuid: string): Promise<StoredDoc> {
  return writer.call<StoredDoc>("get_doc", { uuid });
}

async function editMapping(writer: McpSession, uuid: string, text: string): Promise<void> {
  const block = (await stored(writer, uuid)).blocks.find(entry => entry.type === "chart");
  if (block === undefined) throw new Error("e2e: chart mapping missing");
  await writer.call("edit_block", { uuid, block_id: block.id, old_text: block.text, new_text: text, rev: block.rev });
}

async function geometry(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const bounds = await target.boundingBox();
  if (bounds === null) throw new Error("e2e: chart-height target has no geometry");
  return bounds;
}

async function startDrag(page: Page, handle: Locator, delta: number): Promise<{ x: number; y: number }> {
  await handle.scrollIntoViewIfNeeded();
  const box = await geometry(handle);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y + delta, { steps: 10 });
  return point;
}

async function drag(page: Page, handle: Locator, delta: number, cancel = false): Promise<void> {
  await startDrag(page, handle, delta);
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}

async function watchSource(uuid: string): Promise<{
  changes: string[]; readTitle: () => string; annotate: () => string; close: () => void;
}> {
  const doc = new Y.Doc();
  const secret = await importRootSecret(harness().authSecret);
  const provider = new HocuspocusProvider({
    url: harness().hubUrl, name: roomForDoc(harness().workspaceUuid, uuid), document: doc,
    token: async () => wrapToken(await mintToken(secret, {
      typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
      scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    })),
  });
  try {
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    const block = getBlocksFragment(doc).get(1);
    const storedBlock = getBlocks(doc)[1];
    if (!(block instanceof Y.XmlElement) || storedBlock === undefined) throw new Error("e2e: chart-height block missing");
    const changes: string[] = [];
    let previous = storedBlock.text;
    block.observeDeep(() => {
      const next = getBlocks(doc)[1]?.text ?? "";
      if (next !== previous) changes.push(next);
      previous = next;
    });
    return { changes, readTitle: () => getMeta(doc).title,
      annotate: () => createAnnotation(doc, storedBlock.id, previous.indexOf("measurements"),
        previous.indexOf("measurements") + "measurements".length, "Height fixture", "Keep this collection anchor").id,
      close: () => { provider.destroy(); doc.destroy(); } };
  } catch (error) { provider.destroy(); doc.destroy(); throw error; }
}

test("explicit overlay height includes its canvas and excludes caption and notices at narrow and wide columns", async ({ browser }) => {
  const { page, writer, uuid, block } = await fixture(browser, JSON.stringify(MAPPING));
  const screen = block.locator(".ub-chart-screen");
  for (const width of [1440, 600]) {
    await page.setViewportSize({ width, height: 1400 });
    await expect.poll(async () => {
      const box = await geometry(screen);
      return Math.abs(box.height - Math.max(200, Math.min(300, box.width / 2)));
    }).toBeLessThanOrEqual(1);
  }
  for (const height of [100, 600]) {
    await editMapping(writer, uuid, JSON.stringify({ ...MAPPING, height }));
    await waitForDocumentDraw(page, writer, uuid);
    for (const width of [600, 1440]) {
      await page.setViewportSize({ width, height: 1400 });
      await expect(screen).toHaveCSS("height", `${height}px`);
      await expect.poll(() => block.locator("canvas").evaluate(element => element.getBoundingClientRect().height)).toBe(height);
      const drawing = await geometry(screen);
      const caption = await geometry(block.locator(".ub-block-caption"));
      const notices = await geometry(block.locator(".ub-chart-diagnostics"));
      expect(caption.y + caption.height).toBeLessThanOrEqual(drawing.y + 1);
      expect(notices.y).toBeGreaterThanOrEqual(drawing.y + drawing.height - 1);
    }
  }
  const handle = block.locator(".ub-chart-resize");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.mouse.move(0, 0);
    await page.locator(".ub-title").focus();
    await expect(handle).toHaveCSS("opacity", "0");
    await block.getByRole("button", { name: "Open chart source", exact: true }).focus();
    await expect(handle).toHaveCSS("opacity", "1");
    await handle.hover();
    const bounds = await geometry(handle);
    const drawing = await geometry(screen);
    expect(Math.abs(bounds.y + bounds.height - drawing.y - drawing.height)).toBeLessThanOrEqual(1);
    expect(bounds.width).toBeGreaterThanOrEqual(drawing.width - 1);
    const paint = await handle.evaluate(element => ({
      ink: getComputedStyle(element, "::after").backgroundColor,
      tint: getComputedStyle(element.closest(".ub-chart") as Element).backgroundColor,
      background: getComputedStyle(document.body).backgroundColor,
      image: getComputedStyle(document.body).backgroundImage,
    }));
    for (const ground of pageGrounds(paint.image, paint.background)) {
      expect(contrast(paint.ink, composite(paint.tint, ground)), colorScheme).toBeGreaterThanOrEqual(3);
    }
  }
});

test("mouse preview survives a peer source edit, saves once, undoes separately, clamps and cancels with Escape", async ({ browser }) => {
  const { page, writer, uuid, block } = await fixture(browser);
  const watch = await watchSource(uuid);
  try {
    const paragraph = editor(page).locator(":scope > p");
    await placeCaretIn(paragraph);
    await page.keyboard.press("End");
    await page.keyboard.insertText(" Own edit.");
    const handle = block.locator(".ub-chart-resize");
    const screen = block.locator(".ub-chart-screen");
    await startDrag(page, handle, 80);
    await expect(screen).toHaveCSS("height", "380px");
    const peerSource = SOURCE.replace("Chart height", "Peer title");
    await editMapping(writer, uuid, peerSource);
    await expect(block.locator(".ub-chart-title")).toHaveText("Peer title");
    await expect(screen).toHaveCSS("height", "380px");
    await proveBrowserTitleArrival(page, { path: "upstream", readTitle: watch.readTitle });
    expect(watch.changes).toEqual([peerSource]);
    await page.mouse.up();
    const resized = peerSource.replace('"height" : 300', '"height" : 380');
    await expect.poll(() => watch.changes).toEqual([peerSource, resized]);
    await expectMcp(() => stored(writer, uuid), doc => {
      expect(doc.blocks[1]?.text).toBe(resized);
    });
    await editor(page).focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(screen).toHaveCSS("height", "300px");
    await expect(paragraph).toHaveText("Before resize. Own edit.");
    await expectMcp(() => stored(writer, uuid), doc => { expect(doc.blocks[1]?.text).toBe(peerSource); });
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(screen).toHaveCSS("height", "380px");
    await proveMcpArrival(page, writer, uuid, { path: "upstream" });
    watch.changes.length = 0;
    await drag(page, handle, 50, true);
    await expect(screen).toHaveCSS("height", "380px");
    await proveBrowserTitleArrival(page, { path: "upstream", readTitle: watch.readTitle });
    expect(watch.changes).toEqual([]);
    await drag(page, handle, 1000);
    await expect(screen).toHaveCSS("height", "600px");
    await expect.poll(() => watch.changes).toEqual([peerSource.replace('"height" : 300', '"height" : 600')]);
    await drag(page, handle, -1000);
    await expect(screen).toHaveCSS("height", "100px");
    await expect.poll(() => watch.changes).toHaveLength(2);
    await expectMcp(() => stored(writer, uuid), doc => {
      expect(doc.blocks[1]?.text).toBe(peerSource.replace('"height" : 300', '"height" : 100'));
    });
  } finally { watch.close(); }
});

test("panel plots keep the default and explicit heights and a multirow bottom edge follows its pointer", async ({ browser }) => {
  const mapping = { ...MAPPING, layout: "panels", y: Array.from({ length: 4 }, (_, index) => ({ field: "count", label: `Count ${index + 1}` })) };
  const { page, writer, uuid, block } = await fixture(browser, JSON.stringify(mapping));
  await page.setViewportSize({ width: 600, height: 1400 });
  const plots = block.locator(".ub-chart-series-plot");
  await expect(plots).toHaveCount(4);
  await expect.poll(() => plots.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height)))
    .toEqual([150, 150, 150, 150]);
  await editMapping(writer, uuid, JSON.stringify({ ...mapping, height: 200 }));
  await waitForDocumentDraw(page, writer, uuid);
  const rows = await plots.evaluateAll(elements => new Set(elements.map(element => Math.round(element.getBoundingClientRect().top))).size);
  expect(rows).toBeGreaterThan(1);
  const handle = block.locator(".ub-chart-resize");
  const point = await startDrag(page, handle, 80 * rows);
  await expect.poll(() => plots.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height)))
    .toEqual([280, 280, 280, 280]);
  const after = await geometry(handle);
  expect(Math.abs(after.y + after.height / 2 - point.y - 80 * rows)).toBeLessThanOrEqual(1);
  await page.mouse.up();
  await expectMcp(() => stored(writer, uuid), doc => {
    expect(JSON.parse(doc.blocks[1]?.text ?? "{}")).toEqual({ ...mapping, height: 280 });
  });
  for (const plot of await plots.all()) {
    const plotBox = await geometry(plot);
    const label = await geometry(plot.locator("..").locator(".ub-chart-series-header"));
    expect(label.y + label.height).toBeLessThanOrEqual(plotBox.y);
  }
});

test("iPad source Height validates, preserves formatting and comment anchors, and clears to the default", { tag: "@webkit" }, async ({ browser }) => {
  const { page, writer, uuid, block } = await fixture(browser, JSON.stringify(MAPPING, null, 2), true);
  const watch = await watchSource(uuid);
  try {
    await expect(block.locator(".ub-chart-resize")).toBeHidden();
    await expect(block.getByRole("textbox", { name: "Height", exact: true })).toBeHidden();
    await activateControl(block.getByRole("button", { name: "Open chart source", exact: true }));
    const height = block.getByRole("textbox", { name: "Height", exact: true });
    await expect(height).toBeVisible();
    await expect(height).toHaveValue("");
    const thread = watch.annotate();
    await expect(block.locator(`[data-comment-thread="${thread}"]`)).toHaveText("measurements");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await height.scrollIntoViewIfNeeded();
      const box = await geometry(height);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await height.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      const readings = await renderedText(page, ".ub-chart-height-fields");
      expect(readings.length).toBeGreaterThan(0);
      for (const reading of readings) expect(reading.ratio, `${colorScheme} ${reading.where}`).toBeGreaterThanOrEqual(4.5);
    }
    await height.fill("99");
    await height.press("Enter");
    await expect(block.getByRole("alert")).toContainText("100");
    await proveMcpArrival(page, writer, uuid, { path: "upstream" });
    expect(watch.changes).toEqual([]);
    await height.fill("160");
    await height.press("Enter");
    await expect(block.getByRole("alert")).toBeHidden();
    await expectMcp(() => stored(writer, uuid), doc => {
      const text = doc.blocks[1]?.text ?? "";
      expect(JSON.parse(text)).toEqual({ ...MAPPING, height: 160 });
      expect(text.replace(/,\n {2}"height": 160/, "")).toBe(JSON.stringify(MAPPING, null, 2));
    });
    await expect(block.locator(`[data-comment-thread="${thread}"]`)).toHaveText("measurements");
    await height.fill("");
    await activateControl(page.locator(".ub-title"));
    await expectMcp(() => stored(writer, uuid), doc => {
      const text = doc.blocks[1]?.text ?? "";
      expect(JSON.parse(text)).toEqual(MAPPING);
      expect(text).toBe(JSON.stringify(MAPPING, null, 2).replace(/\n}$/, "\n  \n}"));
    });
    await expect(block.locator(`[data-comment-thread="${thread}"]`)).toHaveText("measurements");
    await expect(block.locator(".ub-chart-resize")).toBeHidden();
    await writer.call("archive_doc", { uuid });
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(height).toBeHidden();
  } finally { watch.close(); }
});

test("archiving during a pointer resize cancels its preview without storing height", async ({ browser }) => {
  const { page, writer, uuid, block } = await fixture(browser);
  const watch = await watchSource(uuid);
  try {
    await startDrag(page, block.locator(".ub-chart-resize"), 80);
    await expect(block.locator(".ub-chart-screen")).toHaveCSS("height", "380px");
    await writer.call("archive_doc", { uuid });
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(block.locator(".ub-chart-resize")).toBeHidden();
    await page.mouse.up();
    await expect(block.locator(".ub-chart-screen")).toHaveCSS("height", "300px");
    await expectMcp(() => stored(writer, uuid), doc => { expect(doc.blocks[1]?.text).toBe(SOURCE); });
    expect(watch.changes).toEqual([]);
  } finally { watch.close(); }
});
