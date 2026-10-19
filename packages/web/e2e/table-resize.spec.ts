/** Native column resizing keeps shared content and ordinary table controls. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import {
  appendBlock, createAnnotation, directoryRoom, getBlocks, getBlocksFragment,
  initDoc, restoreDirectoryEntry, roomForDoc, tableRows,
  tombstoneDirectoryEntry, upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { waitForAcknowledged } from "./settle.js";

const { harness, openApp, ws } = setupHarness();
const SOURCE = "| **A** | B | C |\n| --- | --- | --- |\n| alpha | [one](https://example.com) | first |\n| beta | two | second |\n| gamma | three | third |";

async function publishTable(options: { widths?: Array<number | null>; archived?: boolean } = {}): Promise<{
  uuid: string; id: string; doc: Y.Doc; directory: Y.Doc; close: () => void;
}> {
  const uuid = randomUUID();
  const doc = new Y.Doc();
  const title = "Shared column resize";
  initDoc(doc, { uuid, title });
  const id = appendBlock(doc, { type: "table", text: SOURCE });
  createAnnotation(doc, id, 0, 5, "Resize fixture", "Keep this highlight", { row: 1, column: 0 });
  if (options.widths !== undefined) {
    for (const row of tableRows(sharedTable(doc))) {
      for (const [index, width] of options.widths.entries()) {
        if (width === null) continue;
        const cell = row[index];
        if (cell === undefined) throw new Error("e2e: missing width fixture cell");
        (cell as unknown as { setAttribute(name: string, value: unknown): void }).setAttribute("colwidth", [width]);
      }
    }
  }
  const peers: Array<{ provider: HocuspocusProvider; ydoc: Y.Doc }> = [];
  const close = (): void => {
    for (const { provider, ydoc } of peers) { provider.destroy(); ydoc.destroy(); }
    if (!peers.some((peer) => peer.ydoc === doc)) doc.destroy();
  };
  try {
    const secret = await importRootSecret(harness().authSecret);
    const connect = async (room: string, ydoc = new Y.Doc()): Promise<Y.Doc> => {
      const provider = new HocuspocusProvider({
        url: harness().hubUrl, name: room, document: ydoc,
        token: async () => wrapToken(await mintToken(secret, {
          typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
          scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
        })),
      });
      peers.push({ provider, ydoc });
      await new Promise<void>((resolve) => provider.on("synced", resolve));
      return ydoc;
    };
    const directory = await connect(directoryRoom(harness().workspaceUuid));
    upsertDirectoryEntry(directory, { uuid, title });
    if (options.archived) tombstoneDirectoryEntry(directory, uuid);
    await connect(roomForDoc(harness().workspaceUuid, uuid), doc);
    return { uuid, id, doc, directory, close };
  } catch (error) { close(); throw error; }
}

function sharedTable(doc: Y.Doc): Y.XmlElement {
  const table = getBlocksFragment(doc).get(0);
  if (!(table instanceof Y.XmlElement)) throw new Error("e2e: shared table missing");
  return table;
}

function widths(doc: Y.Doc): unknown[][] {
  return tableRows(sharedTable(doc)).map(row => row.map(cell => cell.getAttribute("colwidth") ?? null));
}

async function openTable(page: Page, uuid: string): Promise<Locator> {
  await page.goto(new URL(`/${ws()}/${uuid}`, harness().appUrl).href);
  const table = page.locator(".ub-table");
  await expect(table.locator("tr")).toHaveCount(4);
  return table;
}

async function geometry(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const bounds = await target.boundingBox();
  if (bounds === null) throw new Error("e2e: table target has no geometry");
  return bounds;
}

async function columnWidths(table: Locator): Promise<number[]> {
  return table.locator("th").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
}

async function content(table: Locator): Promise<string[]> {
  return table.locator("th p, td p").evaluateAll(paragraphs => paragraphs.map(paragraph => paragraph.innerHTML));
}

async function boundary(table: Locator, column = 0): Promise<{ x: number; y: number }> {
  const cell = table.locator("tr").nth(1).locator("td").nth(column);
  await cell.scrollIntoViewIfNeeded();
  const bounds = await geometry(cell);
  return { x: bounds.x + bounds.width - 2, y: bounds.y + bounds.height / 2 };
}

async function startResize(page: Page, table: Locator, delta: number): Promise<void> {
  const point = await boundary(table);
  await page.mouse.move(point.x, point.y);
  await expect(editor(page)).toHaveClass(/resize-cursor/);
  await expect(table.locator(".column-resize-handle").first()).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(point.x + delta, point.y, { steps: 8 });
}

async function resize(page: Page, table: Locator, delta: number): Promise<void> {
  await startResize(page, table, delta);
  await page.mouse.up();
}

test("mouse resizing shares one column, contains overflow and undoes separately from typing", { tag: "@webkit" }, async ({ page, browser }) => {
  const fixture = await publishTable();
  try {
    const table = await openTable(page, fixture.uuid);
    const peer = await openApp(browser, `/${ws()}/${fixture.uuid}`, { upstream: true });
    const peerTable = peer.locator(".ub-table");
    await expect(peerTable.locator("tr")).toHaveCount(4);
    await expect(table).toHaveAttribute("id", fixture.id);
    await expect(table).toHaveAttribute("data-block-type", "table");
    await expect(table.locator("strong")).toHaveText("A");
    await expect(table.locator("a")).toHaveAttribute("href", "https://example.com");
    await expect(table.locator("[data-comment-thread]")).toHaveText("alpha");

    const editable = table.locator("tr").nth(2).locator("td").first();
    await placeCaretIn(editable);
    await page.keyboard.press("End");
    await page.keyboard.insertText(" before resize");
    await expect(editable).toHaveText("beta before resize");
    const beforeContent = await content(table);
    const beforeWidths = await columnWidths(table);
    expect(Math.abs((await geometry(table)).width - (await geometry(table.locator(".."))).width)).toBeLessThanOrEqual(1);
    await startResize(page, table, 600);
    // The framework previews in the DOM and persists only on mouseup.
    expect(widths(fixture.doc)).toEqual(Array.from({ length: 4 }, () => [null, null, null]));
    await page.mouse.up();
    await expect.poll(() => widths(fixture.doc)[0]?.[0]).not.toBeNull();
    const stored = widths(fixture.doc);
    const chosen = stored[0]?.[0];
    for (const row of stored) expect(row).toEqual([chosen, null, null]);
    const afterWidths = await columnWidths(table);
    expect(afterWidths[0] ?? 0).toBeGreaterThan((beforeWidths[0] ?? 0) + 590);
    // Unsized columns share the remaining space, down to the framework minimum.
    for (const column of [1, 2]) expect(Math.abs((afterWidths[column] ?? 0) - 120)).toBeLessThanOrEqual(1);
    expect(await content(table)).toEqual(beforeContent);
    const wrapper = table.locator("..");
    await expect.poll(() => wrapper.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect.poll(() => columnWidths(peerTable)).toEqual(afterWidths);

    await editor(page).focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => widths(fixture.doc)).toEqual(Array.from({ length: 4 }, () => [null, null, null]));
    await expect.poll(() => columnWidths(table)).toEqual(beforeWidths);
    await expect.poll(() => columnWidths(peerTable)).toEqual(beforeWidths);
    await expect(editable).toHaveText("beta before resize");
    expect(await content(table)).toEqual(beforeContent);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => widths(fixture.doc)).toEqual(stored);
    await expect.poll(() => columnWidths(table)).toEqual(afterWidths);
    await waitForAcknowledged(page, { path: "upstream" });
    await page.reload();
    await expect(table.locator("tr")).toHaveCount(4);
    await expect.poll(() => columnWidths(table)).toEqual(afterWidths);
    expect(await content(table)).toEqual(beforeContent);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  } finally { fixture.close(); }
});

test("resized boundaries keep pluses, column moves and row dragging aligned", { tag: "@webkit" }, async ({ page }) => {
  const fixture = await publishTable({ widths: [180, 200, 120] });
  try {
    const table = await openTable(page, fixture.uuid);
    await resize(page, table, 40);
    await expect.poll(() => widths(fixture.doc)[0]?.[0]).toEqual([220]);
    const plus = page.getByRole("button", { name: "Insert column after 1", exact: true });
    const menu = page.getByRole("button", { name: "Column 1 actions", exact: true });
    await table.locator("th").first().hover();
    await expect.poll(async () => {
      const cell = await geometry(table.locator("th").first());
      const insert = await geometry(plus);
      const actions = await geometry(menu);
      return Math.max(Math.abs(insert.x + insert.width / 2 - cell.x - cell.width),
        Math.abs(actions.x + actions.width / 2 - cell.x - cell.width / 2));
    }).toBeLessThanOrEqual(1);
    await menu.click();
    await page.getByRole("menuitem", { name: "Move column right", exact: true }).click();
    await expect(table.locator("th")).toHaveText(["B", "A", "C"]);
    await expect.poll(() => widths(fixture.doc)[0]).toEqual([[200], [220], [120]]);
    await page.getByRole("button", { name: "Insert column after 2", exact: true }).click();
    await expect(table.locator("th")).toHaveText(["B", "A", "", "C"]);
    await expect.poll(() => widths(fixture.doc)[0]).toEqual([[200], [220], null, [120]]);

    await table.locator("tr").nth(1).hover();
    const handle = page.getByRole("button", { name: "Row 2 actions", exact: true });
    await handle.hover();
    const source = await geometry(handle);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 - 8, source.y + source.height / 2);
    await expect(page.locator(".ub-table-row-drop")).toHaveCount(1);
    const last = await geometry(table.locator("tr").last());
    await page.mouse.move(last.x + last.width / 2, last.y + last.height - 1, { steps: 8 });
    await expect(page.locator(".ub-table-row-drop")).toHaveAttribute("data-gap", "4");
    await page.mouse.up();
    await expect(table.locator("tr:has(td) > td:nth-child(2)")).toHaveText(["beta", "gamma", "alpha"]);
    await expect.poll(() => widths(fixture.doc)[0]).toEqual([[200], [220], null, [120]]);
    await page.getByRole("button", { name: "Insert row after 4", exact: true }).click();
    await expect(table.locator("tr")).toHaveCount(5);
    await expect(table.locator("th")).toHaveText(["B", "A", "", "C"]);
  } finally { fixture.close(); }
});

test("moving and deleting a sized column clears its previous rendered width on both clients", { tag: "@webkit" }, async ({ page, browser }) => {
  const fixture = await publishTable({ widths: [300, null, null] });
  try {
    const table = await openTable(page, fixture.uuid);
    const peer = await openApp(browser, `/${ws()}/${fixture.uuid}`, { upstream: true });
    const peerTable = peer.locator(".ub-table");
    await expect(peerTable.locator("tr")).toHaveCount(4);
    const before = await columnWidths(table);
    await table.locator("th").first().hover();
    await page.getByRole("button", { name: "Column 1 actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move column right", exact: true }).click();
    await expect(table.locator("th")).toHaveText(["B", "A", "C"]);
    await expect.poll(() => widths(fixture.doc)[0]).toEqual([null, [300], null]);
    await expect.poll(() => columnWidths(table)).toEqual([before[1], before[0], before[2]]);
    await expect.poll(() => columnWidths(peerTable)).toEqual([before[1], before[0], before[2]]);

    await page.getByRole("button", { name: "Column 2 actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete column", exact: true }).click();
    await expect(table.locator("th")).toHaveText(["B", "C"]);
    await expect.poll(() => widths(fixture.doc)[0]).toEqual([null, null]);
    const expected = (await geometry(table.locator(".."))).width / 2;
    for (const target of [table, peerTable]) {
      await expect.poll(async () => Math.max(...(await columnWidths(target)).map(width => Math.abs(width - expected))))
        .toBeLessThanOrEqual(1);
    }
  } finally { fixture.close(); }
});

test("unsized archived tables fill the content width and cancelled previews restore that layout", { tag: "@webkit" }, async ({ page }) => {
  const fixture = await publishTable({ archived: true });
  try {
    const table = await openTable(page, fixture.uuid);
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    const before = await columnWidths(table);
    expect(Math.abs((await geometry(table)).width - (await geometry(table.locator(".."))).width)).toBeLessThanOrEqual(1);
    restoreDirectoryEntry(fixture.directory, fixture.uuid);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await startResize(page, table, 80);
    tombstoneDirectoryEntry(fixture.directory, fixture.uuid);
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await page.mouse.up();
    await expect.poll(() => columnWidths(table)).toEqual(before);
    expect(widths(fixture.doc)).toEqual(Array.from({ length: 4 }, () => [null, null, null]));
  } finally { fixture.close(); }
});

test("stored widths render archived and restoring then archiving cancels an active resize", { tag: "@webkit" }, async ({ page }) => {
  const fixture = await publishTable({ widths: [180, 200, 120], archived: true });
  try {
    const table = await openTable(page, fixture.uuid);
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    const beforeWidths = await columnWidths(table);
    for (const [column, width] of [180, 200, 120].entries()) {
      expect(Math.abs((beforeWidths[column] ?? 0) - width)).toBeLessThanOrEqual(1);
    }
    const stored = widths(fixture.doc);
    const point = await boundary(table);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 50, point.y, { steps: 8 });
    await page.mouse.up();
    await expect(table.locator(".column-resize-handle")).toHaveCount(0);
    await expect(editor(page)).not.toHaveClass(/resize-cursor/);
    expect(await columnWidths(table)).toEqual(beforeWidths);
    expect(widths(fixture.doc)).toEqual(stored);

    restoreDirectoryEntry(fixture.directory, fixture.uuid);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await startResize(page, table, 50);
    tombstoneDirectoryEntry(fixture.directory, fixture.uuid);
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(table.locator(".column-resize-handle")).toHaveCount(0);
    await page.mouse.up();
    await expect.poll(() => columnWidths(table)).toEqual(beforeWidths);
    expect(widths(fixture.doc)).toEqual(stored);
    await expect(table.locator("[data-comment-thread]")).toHaveText("alpha");
    expect(getBlocks(fixture.doc).find(block => block.id === fixture.id)?.text).toBe(SOURCE);

    restoreDirectoryEntry(fixture.directory, fixture.uuid);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await resize(page, table, 40);
    await expect.poll(() => widths(fixture.doc)[0]?.[0]).toEqual([220]);
  } finally { fixture.close(); }
});
