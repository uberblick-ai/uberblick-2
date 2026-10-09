/** Data tables consume the document's data through the production ub open replica. */
import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-data-table-${process.env.UB_AGENTS_RUN ?? "local"}-`,
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: data-table MCP agent is not configured");
  return agent.open({ name: "data-table-e2e" });
}

interface DocPayload {
  uuid: string;
  blocks: { id: string; type: string; text: string; rev: string }[];
}
const TARGET = "https://example.invalid/table-evidence";
const MAPPING = {
  version: 1, type: "table", collection: "measurements", title: "Delivery evidence", pageSize: 2,
  columns: [
    { field: "name", label: "Name" },
    { field: "value", label: "Autonomous", format: "number", unit: "%", decimals: 2 },
    { field: "day", label: "Day", format: "date" },
    { field: "url", label: "Evidence", format: "link" },
  ],
};
const SCHEMA = { version: 1, schema: { type: "object" } };
const RECORDS = [
  { id: "a", value: { name: "<strong>kept as text</strong>", value: 12.5, day: "2026-01-01", url: TARGET } },
  { id: "b", value: {} },
  { id: "c", value: { name: null, value: null, day: null, url: null } },
  { id: "d", value: { name: "Invalid values", value: "12", day: "2026-02-31", url: "javascript:alert(1)" } },
  { id: "e", value: { name: { compact: true }, value: 20, day: "2026-01-02T12:30:00Z", url: "data:text/html,<script>alert(1)</script>" } },
  { id: "f", value: { name: "Relative link", value: 0, day: "2026-01-03", url: "/relative" } },
];

async function tableDoc(session: McpSession, title: string, mapping: unknown = MAPPING, decision = false): Promise<string> {
  const result = await session.call<{ uuid: string }>("create_doc", {
    title, description: "Read-only evidence projected from document-owned measurements.",
    ...(decision ? { kind: "decision", status: "open", tldr: "Keep these observations visible." } : {}),
    blocks: [{ type: "paragraph", text: "Read the live evidence below." }, { type: "chart", text: JSON.stringify(mapping) }],
  });
  return result.uuid;
}

async function editMapping(session: McpSession, uuid: string, text: string): Promise<void> {
  const doc = await session.call<DocPayload>("get_doc", { uuid });
  const block = doc.blocks.find((entry) => entry.type === "chart");
  if (block === undefined) throw new Error("e2e: no data-table chart block in get_doc");
  await session.call("edit_block", { uuid, block_id: block.id, old_text: block.text, new_text: text, rev: block.rev });
}

async function measurements(session: McpSession, uuid: string): Promise<void> {
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", schema: SCHEMA, replaceRecords: RECORDS }] });
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let count = 0; count < 40; count += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function expectPopup(page: Page, activate: () => Promise<unknown>): Promise<void> {
  const [popup] = await Promise.all([page.context().waitForEvent("page", { timeout: 5_000 }), activate()]);
  try {
    await popup.waitForLoadState();
    await expect(popup).toHaveURL(TARGET);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await popup.evaluate(() => document.referrer)).toBe("");
  } finally { await popup.close(); await page.bringToFront(); }
}

async function cellStyle(cell: Locator): Promise<Record<string, string>> {
  return cell.evaluate((element) => {
    const style = getComputedStyle(element);
    return Object.fromEntries([
      "border-top", "border-right", "border-bottom", "border-left", "padding",
      "font-size", "font-weight", "color", "background-color",
    ].map((property) => [property, style.getPropertyValue(property)]));
  });
}

/**
 * Instrument the existing y-sync document, never a production test hook. The
 * data reader enumerates the complete map once through entries(); its wrapper
 * counts reads without inspecting values. Native map integration lets that
 * wrapper attach before the first editor render. DOM completion waits for all
 * mounted views to show the current stored revision, after synchronous drawing.
 */
async function installProbe(page: Page, uuid: string, tables = 0, charts = 0): Promise<void> {
  await page.addInitScript(({ targetUuid, tableCount, chartCount }) => {
    type DataMap = {
      size: number; _map?: Map<string, unknown>; doc?: SharedDoc;
      entries(): IterableIterator<unknown>;
      get(key: string): unknown;
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
      localUpdates: 0, reads: 0, appliedAt: 0, availableAt: 0, availableEntries: 0,
      first: null as number | null, durations: [] as number[], readsPerUpdate: [] as number[],
    };
    (window as unknown as { tableProbe: typeof probe }).tableProbe = probe;
    let doc: SharedDoc | undefined;
    let data: DataMap | undefined;
    let restoreEntries: (() => void) | undefined;
    let readsBeforeUpdate = 0;
    let completedAt = 0;
    const applied = (): void => { probe.appliedAt = performance.now(); readsBeforeUpdate = probe.reads; };
    const updated = (...args: unknown[]): void => {
      if ((args[3] as { local?: boolean } | undefined)?.local === true) probe.localUpdates += 1;
    };
    const attach = (owning: SharedDoc): void => {
      if (!owning.share.has("meta") || owning.getMap("meta").get("uuid") !== targetUuid) return;
      const root = owning.share.get("data");
      if (root === undefined || typeof root.entries !== "function") return;
      if (doc !== owning) { doc?.off("update", updated); doc = owning; doc.on("update", updated); }
      if (data !== root) {
        data?.unobserve(applied);
        restoreEntries?.();
        data = root;
        const descriptor = Object.getOwnPropertyDescriptor(root, "entries");
        const entries = root.entries;
        root.entries = function (): IterableIterator<unknown> { probe.reads += 1; return entries.call(this); };
        restoreEntries = (): void => {
          if (descriptor === undefined) delete (root as Partial<DataMap>).entries;
          else Object.defineProperty(root, "entries", descriptor);
        };
        root.observe(applied);
        if (root.size > 0 && probe.appliedAt === 0) applied();
      }
      if (probe.availableAt === 0 && root.size > 0) {
        probe.availableAt = performance.now();
        probe.availableEntries = root.size;
      }
    };
    const nativeSet = Map.prototype.set;
    const initialDocs = new Map<SharedDoc, (...args: unknown[]) => void>();
    Map.prototype.set = function (key: unknown, value: unknown): Map<unknown, unknown> {
      const result = nativeSet.call(this, key, value) as Map<unknown, unknown>;
      if (key === "data" && typeof value === "object" && value !== null) {
        const owning = (value as DataMap).doc;
        if (owning?.share === this && !initialDocs.has(owning)) {
          const after = (): void => { attach(owning); };
          initialDocs.set(owning, after);
          owning.on("afterTransaction", after);
        }
      }
      return result;
    };
    const mutations = new MutationObserver(() => {
      const state = document.querySelector<MountedEditor>(".ub-editor .ProseMirror")?.editor?.state;
      const mounted = state?.plugins.find((plugin) => plugin.key.startsWith("y-sync"))?.getState(state).doc;
      if (mounted !== undefined) attach(mounted);
      if (tableCount === 0 || data === undefined || probe.availableAt === 0 || probe.appliedAt === completedAt) return;
      const latest = data.get(JSON.stringify(["record", "observations", "observation-04034"])) as { value0?: number } | undefined;
      if (latest?.value0 === undefined) return;
      const expected = new Intl.NumberFormat(navigator.language, { maximumSignificantDigits: 12 }).format(latest.value0);
      const summary = data.get(JSON.stringify(["record", "summaries", "summary-00364"])) as { value0?: number } | undefined;
      const chartExpected = summary?.value0 === undefined ? "" : new Intl.NumberFormat(navigator.language, { maximumSignificantDigits: 12 }).format(summary.value0);
      const renderedTables = [...document.querySelectorAll<HTMLTableElement>(".ub-data-table")];
      const descriptions = [...document.querySelectorAll(".ub-chart-description")].filter((entry) => entry.textContent !== "");
      if (renderedTables.length !== tableCount || descriptions.length !== chartCount ||
          !renderedTables.every((table) => table.querySelector("tbody tr td:nth-child(2)")?.textContent === expected) ||
          !descriptions.every((entry) => entry.textContent?.includes(`Metric 0: ${chartExpected} ms`))) return;
      completedAt = probe.appliedAt;
      if (probe.first === null) probe.first = performance.now() - probe.availableAt;
      else {
        probe.durations.push(performance.now() - probe.appliedAt);
        probe.readsPerUpdate.push(probe.reads - readsBeforeUpdate);
      }
    });
    mutations.observe(document, { childList: true, subtree: true, characterData: true });
    addEventListener("pagehide", () => {
      mutations.disconnect(); doc?.off("update", updated); data?.unobserve(applied); restoreEntries?.();
      for (const [initial, listener] of initialDocs) initial.off("afterTransaction", listener);
      initialDocs.clear(); Map.prototype.set = nativeSet;
    });
  }, { targetUuid: uuid, tableCount: tables, chartCount: charts });
}

async function expectClearTableActions(block: Locator): Promise<void> {
  const geometry = await block.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const table = element.querySelector(".ub-data-table")?.getBoundingClientRect();
    const notice = element.querySelector(".ub-chart-notice");
    const range = document.createRange();
    if (notice !== null) range.selectNodeContents(notice);
    const text = Array.from(range.getClientRects());
    return Array.from(element.querySelectorAll(".ub-chart-open, .ub-copy")).map((action) => {
      const rect = action.getBoundingClientRect();
      return {
        belowTable: table !== undefined && rect.top >= table.bottom,
        withinBlock: rect.left >= bounds.left && rect.right <= bounds.right,
        overlapsFootnote: text.some(line => rect.left < line.right && rect.right > line.left && rect.top < line.bottom && rect.bottom > line.top),
      };
    });
  });
  expect(geometry).toEqual(Array.from({ length: 2 }, () => ({ belowTable: true, withinBlock: true, overlapsFootnote: false })));
}

test("all rows read like an ordinary table with secondary source and isolated links in both appearances", async ({ browser }, info) => {
  const session = writer();
  for (const appearance of ["light", "dark"] as const) {
    const page = await openApp(browser, "/", {
      contextOptions: { colorScheme: appearance, locale: "en-US", viewport: { width: 1280, height: 1000 } },
    });
    await page.context().route("https://example.invalid/**", (route) => route.fulfill({ contentType: "text/html", body: "<p>Evidence</p>" }));
    await expect(page.locator(".ub-list-head")).toBeVisible();
    const uuid = await createDoc(page, `Data table source ${appearance}`);
    await editor(page).locator(":scope > p").first().click();
    await page.keyboard.insertText("A source-editable table follows.");
    await editor(page).locator(":scope > *").last().hover();
    await page.getByRole("button", { name: "Insert block below" }).click();
    await expect(page.getByRole("option", { name: "Table", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "Data table", exact: true }).click();
    const source = page.locator(".ub-chart-source");
    await expect(source).toBeVisible();
    expect(await source.textContent()).not.toContain("pageSize");
    await source.click();
    await source.evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    });
    await page.keyboard.insertText(JSON.stringify(MAPPING));
    await expect.poll(async () => {
      try { return (await session.call<DocPayload>("get_doc", { uuid })).blocks.find((block) => block.type === "chart")?.text; }
      catch (error) { if (error instanceof Error && /doc_not_hydrated|doc_not_found/.test(error.message)) return null; throw error; }
    }).toBe(JSON.stringify(MAPPING));
    const doc = await session.call<DocPayload>("get_doc", { uuid });
    const paragraph = doc.blocks.find((block) => block.type === "paragraph");
    const chart = doc.blocks.find((block) => block.type === "chart");
    if (paragraph === undefined || chart === undefined) throw new Error("e2e: table comparison blocks are missing");
    await session.call("insert_block", { uuid, after_block_id: paragraph.id, type: "heading", level: 2, text: "Changelog" });
    await session.call("insert_block", {
      uuid, after_block_id: chart.id, type: "table",
      text: "| Name | Autonomous | Day | Evidence |\n| --- | --- | --- | --- |\n| Ordinary table | 12.50 % | Jan 1, 2026 | Evidence |",
    });
    await measurements(session, uuid);
    await editor(page).locator(":scope > p").first().click();
    const table = page.getByRole("table", { name: "Delivery evidence", exact: true });
    await expect(table).toBeVisible();
    await expect(source).toBeHidden();
    await expect(table.getByRole("columnheader")).toHaveText(["Name", "Autonomous", "Day", "Evidence"]);
    await expect(table.getByRole("cell", { name: "<strong>kept as text</strong>", exact: true })).toBeVisible();
    await expect(table.locator("strong, script, style")).toHaveCount(0);
    await expect(table.locator("tbody tr")).toHaveCount(RECORDS.length);
    await expect(table.locator("tbody tr").first()).toContainText("12.50 %");
    await expect(table.locator("tbody tr").first()).toContainText("Jan 1, 2026");
    await expect(table.locator("tbody tr").nth(1)).toContainText(/absent/i);
    await expect(page.locator(".ub-table-range, .ub-table-pager")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Previous|Next) page$/ })).toHaveCount(0);
    expect(await table.ariaSnapshot()).toContain('table "Delivery evidence"');
    const block = page.locator(".ub-chart[data-view='table']");
    const panel = block.locator(".ub-chart-panel");
    const ordinary = page.locator(".ub-table");
    await expect(ordinary).toBeVisible();
    await expect(page.getByRole("heading", { name: "Changelog", exact: true })).toBeVisible();
    await expect(block.locator(".ub-chart-title")).toBeHidden();
    expect(await block.evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none");
    await expect(panel).toHaveCSS("padding", "0px");
    await expect(panel).toHaveCSS("border-width", "0px");
    await expect(panel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(await cellStyle(table.locator("th").first())).toEqual(await cellStyle(ordinary.locator("th").first()));
    expect(await cellStyle(table.locator("td").first())).toEqual(await cellStyle(ordinary.locator("td").first()));
    const headerLines = await table.getByRole("columnheader", { name: "Autonomous", exact: true }).evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).length;
    });
    expect(headerLines).toBe(1);
    const generatedWidth = await table.evaluate((element) => element.getBoundingClientRect().width);
    const contentWidth = await editor(page).evaluate((element) => element.clientWidth);
    expect(Math.abs(generatedWidth - contentWidth)).toBeLessThanOrEqual(2);
    await expect(block.locator(".ub-table-controls, .ub-table-control, [contenteditable='true']")).toHaveCount(0);
    const notice = block.locator(".ub-chart-notice");
    await expect(notice).toHaveText("Generated from document data · read-only");
    const tableBounds = await table.boundingBox();
    const noticeBounds = await notice.boundingBox();
    expect(tableBounds).not.toBeNull();
    expect(noticeBounds).not.toBeNull();
    if (tableBounds !== null && noticeBounds !== null) {
      expect(noticeBounds.y - tableBounds.y - tableBounds.height).toBeGreaterThanOrEqual(0);
      expect(noticeBounds.y - tableBounds.y - tableBounds.height).toBeLessThanOrEqual(12);
    }
    const markers = table.locator("td[data-state='absent'], td[data-state='null'], td[data-state='invalid']");
    expect(await markers.count()).toBeGreaterThan(0);
    const muted = await notice.evaluate((element) => getComputedStyle(element).color);
    for (const marker of await markers.all()) await expect(marker).toHaveCSS("color", muted);
    const before = await session.call("get_data", { uuid });
    const link = table.getByRole("link", { name: TARGET, exact: true });
    await expectPopup(page, () => link.click());
    await editor(page).locator(":scope > p").first().click();
    await tabTo(page, link);
    await expectPopup(page, () => page.keyboard.press("Enter"));
    await expect(table.locator("tbody tr").nth(2)).toContainText(/null/i);
    await expect(table.locator("tbody tr").nth(3)).toContainText(/invalid/i);
    await expect(table).toContainText("2026-02-31");
    await expect(table).toContainText("javascript:alert(1)");
    await expect(table).toContainText('{"compact":true}');
    await expect(table).toContainText("data:text/html,<script>alert(1)</script>");
    await expect(table).toContainText("/relative");
    await expect(table.getByRole("link")).toHaveCount(1);
    const openSource = page.getByRole("button", { name: "Open table source", exact: true });
    const copy = block.getByRole("button", { name: "copy", exact: true });
    await editor(page).locator(":scope > p").first().click();
    await expect(openSource).toHaveCSS("opacity", "0");
    await expect(copy).toHaveCSS("opacity", "0");
    const restingBounds = await table.boundingBox();
    await block.hover();
    await expect(openSource).toHaveCSS("opacity", "1");
    await expect(copy).toHaveCSS("opacity", "1");
    expect(await table.boundingBox()).toEqual(restingBounds);
    await expectClearTableActions(block);
    await openSource.click();
    await expect(source).toBeVisible();
    await expect(copy).toBeVisible();
    await editor(page).locator(":scope > p").first().click();
    await tabTo(page, openSource);
    await expect(openSource).toHaveCSS("opacity", "1");
    await expect(copy).toHaveCSS("opacity", "1");
    expect(await table.boundingBox()).toEqual(restingBounds);
    await expectClearTableActions(block);
    await tabTo(page, copy);
    await expect(copy).toBeFocused();
    await expect(copy).toHaveCSS("opacity", "1");
    await editor(page).locator(":scope > p").first().click();
    await tabTo(page, openSource);
    await page.keyboard.press("Enter");
    await expect(source).toBeVisible();
    await editor(page).locator(":scope > p").first().click();
    await expect(table).toBeVisible();
    await expect(openSource).toHaveCSS("opacity", "0");
    await expect(copy).toHaveCSS("opacity", "0");
    const footnoteReadings = await renderedText(page, ".ub-chart-notice");
    expect(footnoteReadings.length).toBeGreaterThan(0);
    for (const reading of footnoteReadings) expect(reading.ratio, reading.where).toBeGreaterThanOrEqual(4.5);
    for (const state of await page.locator(".ub-chart-message, .ub-chart-diagnostics, .ub-chart-notice").all()) {
      await expect(state).not.toHaveAttribute("aria-live", /.*/);
    }
    const screenshot = info.outputPath(`data-table-${appearance}.png`);
    await page.keyboard.press("ArrowRight");
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach(`data-table-${appearance}`, { path: screenshot, contentType: "image/png" });
    expect(await session.call("get_data", { uuid })).toEqual(before);
    expect((await session.call<DocPayload>("get_doc", { uuid })).blocks.find((block) => block.type === "chart")?.text).toBe(JSON.stringify(MAPPING));
  }
});

test("MCP data and mapping updates keep all rows and sort across reload and reopen", async ({ browser }) => {
  const session = writer();
  const uuid = await tableDoc(session, "Live data table");
  await measurements(session, uuid);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { beforeNavigate: (loading) => installProbe(loading, uuid) });
  const table = page.getByRole("table", { name: "Delivery evidence", exact: true });
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(RECORDS.length);
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", upsert: [{ id: "d", value: { name: "Arriving update", value: 42, day: "2026-01-04", url: TARGET } }] }] });
  await expect(table).toContainText("Arriving update");
  await expect(table.locator("tbody tr")).toHaveCount(RECORDS.length);
  const beforeMapping = await session.call("get_data", { uuid });
  const updated = { ...MAPPING, title: "Live evidence", pageSize: 5, sort: { field: "value", direction: "desc" },
    columns: MAPPING.columns.map((column) => column.field === "name" ? { ...column, label: "Observation" } : column) };
  await editMapping(session, uuid, JSON.stringify(updated));
  const renamed = page.getByRole("table", { name: "Live evidence", exact: true });
  await expect(renamed.getByRole("columnheader", { name: "Observation", exact: true })).toBeVisible();
  await expect(renamed.locator("tbody tr")).toHaveCount(RECORDS.length);
  await expect(renamed.locator("tbody tr").first()).toContainText("Arriving update");
  expect(await session.call("get_data", { uuid })).toEqual(beforeMapping);
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", upsert: [{ id: "d", value: { name: "Later update", value: 43, day: "2026-01-04", url: TARGET } }] }] });
  await expect(renamed).toContainText("Later update");
  await expect(renamed.locator("tbody tr").first()).toContainText("Later update");
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", deleteRecords: ["e", "f"] }] });
  await expect(renamed.locator("tbody tr")).toHaveCount(4);
  await expect(renamed).toContainText("Later update");
  expect(navigations).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { tableProbe: { localUpdates: number } }).tableProbe.localUpdates)).toBe(0);
  const lightInk = await renamed.evaluate((element) => getComputedStyle(element.querySelector("td") ?? element).color);
  await page.getByTestId("account-menu").click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => renamed.evaluate((element) => getComputedStyle(element.querySelector("td") ?? element).color)).not.toBe(lightInk);
  await page.reload();
  await expect(renamed).toBeVisible();
  await expect(renamed.locator("tbody tr")).toHaveCount(4);
  await expect(renamed.locator("tbody tr").first()).toContainText("Later update");
  const reopened = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expect(reopened.getByRole("table", { name: "Live evidence", exact: true })).toBeVisible();
  await expect(reopened.locator(".ub-data-table tbody tr")).toHaveCount(4);
  await expect(reopened.getByRole("table", { name: "Live evidence", exact: true })).toContainText("Later update");
  expect((await session.call<DocPayload>("get_doc", { uuid })).blocks.find((block) => block.type === "chart")?.text).toBe(JSON.stringify(updated));
});

test("problem states recover without editing stored values and decided or archived tables keep every row", async ({ browser }) => {
  const session = writer();
  const uuid = await tableDoc(session, "Table states", MAPPING, true);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expect(page.locator(".ub-chart-panel")).toHaveAttribute("data-state", "collection-absent");
  await editMapping(session, uuid, "{invalid JSON");
  await expect(page.locator(".ub-chart-panel")).toHaveAttribute("data-state", "invalid-configuration");
  await editMapping(session, uuid, JSON.stringify(MAPPING));
  await measurements(session, uuid);
  await expect(page.getByRole("table", { name: "Delivery evidence", exact: true })).toBeVisible();
  await session.call("update_data", { uuid, operations: [{ collection: "measurements", replaceRecords: [] }] });
  await expect(page.locator(".ub-chart-panel")).toHaveAttribute("data-state", "no-records");
  await measurements(session, uuid);
  const table = page.getByRole("table", { name: "Delivery evidence", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(RECORDS.length);
  const stored = await session.call<DocPayload>("get_doc", { uuid });
  const data = await session.call("get_data", { uuid });
  await session.call("set_status", { uuid, status: "decided" });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(table.locator("tbody tr")).toHaveCount(RECORDS.length);
  const openSource = page.getByRole("button", { name: "Open table source", exact: true });
  await page.locator(".ub-chart").hover();
  await openSource.click();
  await expect(page.locator(".ub-chart-source")).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await editor(page).locator(":scope > p").first().click();
  await expect(editMapping(session, uuid, "{}")).rejects.toThrow(/decision_read_only/);
  await session.call("archive_doc", { uuid });
  // Read-only selection is not an editing caret; reopen the reading view before
  // proving the archived document's secondary keyboard source action.
  await page.reload();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(table.locator("tbody tr")).toHaveCount(RECORDS.length);
  await tabTo(page, openSource);
  await page.keyboard.press("Enter");
  await expect(page.locator(".ub-chart-source")).toBeVisible();
  await expect(editMapping(session, uuid, "{}")).rejects.toThrow(/doc_archived/);
  expect((await session.call<DocPayload>("get_doc", { uuid })).blocks).toEqual(stored.blocks);
  expect(await session.call("get_data", { uuid })).toEqual(data);
});

test("a generated table wider than the document keeps horizontal scrolling inside its block", async ({ browser }) => {
  const session = writer();
  const uuid = await tableDoc(session, "Wide generated table", {
    version: 1, type: "table", collection: "measurements", title: "Wide observations",
    columns: Array.from({ length: 30 }, (_, index) => ({ field: "name", label: `Column ${index}` })),
  });
  await measurements(session, uuid);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { viewport: { width: 800, height: 900 } },
  });
  const table = page.getByRole("table", { name: "Wide observations", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(RECORDS.length);
  const scroll = page.locator(".ub-table-scroll");
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await scroll.hover();
  await page.mouse.wheel(500, 0);
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(page.locator(".ub-table-controls, .ub-table-control")).toHaveCount(0);
});

test("legacy page sizes keep all rows and source remains reachable without hover", async ({ browser }) => {
  const session = writer();
  const { title: _title, ...withoutTitle } = MAPPING;
  const uuid = await tableDoc(session, "No-hover generated table", { ...withoutTitle, pageSize: 7 });
  await measurements(session, uuid);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { hasTouch: true, viewport: { width: 1280, height: 900 } },
  });
  expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
  const table = page.getByRole("table", { name: "Data table of measurements", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(RECORDS.length);
  await editMapping(session, uuid, JSON.stringify({ ...withoutTitle, pageSize: 5 }));
  await expect(table.locator("tbody tr")).toHaveCount(RECORDS.length);
  const openSource = page.getByRole("button", { name: "Open table source", exact: true });
  await expect(openSource).toBeVisible();
  expect(Number(await openSource.evaluate((element) => getComputedStyle(element).opacity))).toBeGreaterThan(0);
  const block = page.locator(".ub-chart[data-view='table']");
  await expectClearTableActions(block);
  await page.setViewportSize({ width: 390, height: 900 });
  await expectClearTableActions(block);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await openSource.tap();
  await expect(page.locator(".ub-chart-source")).toBeVisible();
  await editor(page).locator(":scope > p").first().tap();
  await expect(table).toBeVisible();
  await expect(page.locator(".ub-chart-title")).toBeHidden();
  await expect(page.locator(".ub-table-controls, .ub-table-control, .ub-table-range, .ub-table-pager")).toHaveCount(0);
});

interface Timings {
  first: number; updates: number[]; readsPerUpdate: number[]; availableEntries: number;
  bytes: number; records: number; tables: number; charts: number; cpuThrottle: number;
}

async function workload(session: McpSession, mixed: boolean): Promise<{ uuid: string; bytes: number }> {
  const table = {
    version: 1, type: "table", collection: "observations", pageSize: 25,
    sort: { field: "day", direction: "desc" },
    columns: [
      { field: "day", label: "Day", format: "date" },
      ...Array.from({ length: 3 }, (_, index) => ({ field: `value${index}`, label: `Metric ${index}`, format: "number" })),
      { field: "endpoint", label: "Endpoint" }, { field: "source", label: "Source" },
      { field: "status", label: "Status" }, { field: "revision", label: "Revision", format: "number" },
      { field: "url", label: "Evidence", format: "link" }, { field: "detail", label: "Detail" },
    ],
  };
  const chart = {
    version: 1, type: "line", collection: "summaries", x: { field: "day", type: "date", label: "Day" },
    y: Array.from({ length: 3 }, (_, index) => ({ field: `value${index}`, label: `Metric ${index}`, unit: "ms" })),
  };
  const result = await session.call<{ uuid: string }>("create_doc", {
    title: mixed ? "Twenty shared views timing" : "Data table timing",
    description: "Synthetic one-year API-health workload for Chromium timing.",
    blocks: [
      { type: "paragraph", text: "One-year API-health observations and summaries." },
      ...(mixed ? Array.from({ length: 10 }, (_, index) => ({ type: "chart", text: JSON.stringify({ ...chart, title: `Timing chart ${index}` }) })) : []),
      ...Array.from({ length: mixed ? 10 : 1 }, (_, index) => ({ type: "chart", text: JSON.stringify({ ...table, title: `Timing table ${index}` }) })),
    ],
  });
  const summaries = Array.from({ length: 365 }, (_, index) => ({
    id: `summary-${String(index).padStart(5, "0")}`,
    value: { day: new Date(Date.UTC(2012, 0, 1 + index)).toISOString().slice(0, 10), value0: index, value1: index + 1, value2: index + 2 },
  }));
  await session.call("update_data", { uuid: result.uuid, operations: [{ collection: "summaries", schema: SCHEMA, replaceRecords: summaries }] });
  const observations = Array.from({ length: 4035 }, (_, index) => ({
    id: `observation-${String(index).padStart(5, "0")}`,
    value: {
      day: new Date(Date.UTC(2012, 0, 1 + index)).toISOString().slice(0, 10),
      value0: index, value1: index + 1, value2: index + 2,
      endpoint: `/synthetic/endpoint-${index % 10}`, source: "api-health", status: "ok", revision: 0,
      url: TARGET, detail: "x".repeat(400),
    },
  }));
  for (let offset = 0; offset < observations.length; offset += 1000) {
    await session.call("update_data", { uuid: result.uuid, operations: [{ collection: "observations", ...(offset === 0 ? { schema: SCHEMA } : {}), upsert: observations.slice(offset, offset + 1000) }] });
  }
  const summary = await session.call<{ data: { bytes: number } }>("get_data", { uuid: result.uuid });
  return { uuid: result.uuid, bytes: summary.data.bytes };
}

async function timingEvidence(page: Page, session: McpSession, uuid: string, mixed: boolean, bytes: number): Promise<Timings> {
  await expect(page.locator(".ub-data-table")).toHaveCount(mixed ? 10 : 1, { timeout: mixed ? 60_000 : 20_000 });
  await expect(page.locator(".ub-chart-panel[data-state='ready']")).toHaveCount(mixed ? 20 : 1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { tableProbe: { first: number | null } }).tableProbe.first)).not.toBeNull();
  const initial = await page.evaluate(() => (window as unknown as { tableProbe: { first: number; availableEntries: number } }).tableProbe);
  expect(initial.availableEntries).toBe(4402);
  for (const table of await page.locator(".ub-data-table").all()) await expect(table.locator("tbody tr")).toHaveCount(4035);
  await expect(page.locator(".ub-data-table").first().getByRole("columnheader")).toHaveCount(10);
  expect(await page.locator(".ub-table-scroll").first().evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const value = 900 + iteration;
    const previous = await page.evaluate(() => (window as unknown as { tableProbe: { durations: number[] } }).tableProbe.durations.length);
    await session.call("update_data", {
      uuid, operations: [
        { collection: "observations", upsert: [{ id: "observation-04034", value: {
          day: new Date(Date.UTC(2012, 0, 4035)).toISOString().slice(0, 10), value0: value, value1: value + 1, value2: value + 2,
          endpoint: "/synthetic/endpoint-4", source: "api-health", status: "ok", revision: iteration + 1, url: TARGET, detail: "x".repeat(400),
        } }] },
        ...(mixed ? [{ collection: "summaries", upsert: [{ id: "summary-00364", value: { day: new Date(Date.UTC(2012, 0, 365)).toISOString().slice(0, 10), value0: value, value1: value + 1, value2: value + 2 } }] }] : []),
      ],
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { tableProbe: { durations: number[] } }).tableProbe.durations.length)).toBe(previous + 1);
  }
  const probe = await page.evaluate(() => (window as unknown as { tableProbe: { durations: number[]; readsPerUpdate: number[]; localUpdates: number } }).tableProbe);
  expect(probe.localUpdates).toBe(0);
  expect(probe.readsPerUpdate).toEqual(Array.from({ length: 10 }, () => 1));
  return { first: initial.first, updates: probe.durations, readsPerUpdate: probe.readsPerUpdate, availableEntries: initial.availableEntries,
    bytes, records: 4400, tables: mixed ? 10 : 1, charts: mixed ? 10 : 0, cpuThrottle: 2 };
}

async function publishTimings(info: TestInfo, result: Timings, label: string): Promise<void> {
  const ordered = [...result.updates].sort((a, b) => a - b);
  const median = ((ordered[4] ?? Infinity) + (ordered[5] ?? Infinity)) / 2;
  const record = { ...result, median, min: ordered[0], max: ordered.at(-1) };
  console.log(`data table timing ${label}: ${JSON.stringify(record)}`);
  const evidence = info.outputPath(`data-table-timing-${label}.json`);
  writeFileSync(evidence, `${JSON.stringify(record, null, 2)}\n`);
  await info.attach(`data-table-timing-${label}`, { path: evidence, contentType: "application/json" });
  if (process.env.UB_CHART_TIMING_BUDGETS !== "1") return;
  // The measured full 4,035-row table still fits the existing first-render budget.
  if (label === "single") expect(result.first).toBeLessThanOrEqual(500);
  expect(median).toBeLessThanOrEqual(label === "single" ? 250 : 500);
}

test("one table and twenty shared views record bounded Chromium live-update timings", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const session = writer();
  for (const mixed of [false, true]) {
    const { uuid, bytes } = await workload(session, mixed);
    expect(bytes).toBeGreaterThan(2_500_000);
    expect(bytes).toBeLessThan(3_000_000);
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: async (loading) => {
        const cdp = await loading.context().newCDPSession(loading);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 2 });
        await installProbe(loading, uuid, mixed ? 10 : 1, mixed ? 10 : 0);
      },
      contextOptions: { viewport: { width: 1366, height: 768 }, locale: "en-US" },
    });
    await publishTimings(info, await timingEvidence(page, session, uuid, mixed, bytes), mixed ? "mixed" : "single");
    await page.context().close();
  }
});
