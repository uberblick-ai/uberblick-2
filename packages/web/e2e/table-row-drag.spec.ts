/** Row moves use native input while shared table changes arrive. */
import { expect, test } from "@playwright/test";
import type { Browser, CDPSession, Locator, Page, TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import {
  appendBlock, decisionDirectoryFields, deleteBlock, directoryRoom, editBlock,
  getBlocks, getBlocksFragment, initDoc, roomForDoc, setKind, setStatus,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { editor, openKeyboardMenu, setupHarness } from "./app-helpers.js";
import { caretAtEdge, placeCaretIn } from "./harness.js";

const { harness, trackContext, ws } = setupHarness();
const SOURCE = "| A | B |\n| --- | --- |\n| alpha | one |\n| beta | two |\n| gamma | three |";
const INITIAL = ["alpha", "beta", "gamma"];

async function publishTable(source = SOURCE, decision = false): Promise<{
  uuid: string; id: string; doc: Y.Doc; directory: Y.Doc; close: () => void;
}> {
  const uuid = randomUUID();
  const doc = new Y.Doc();
  const title = "Shared row move";
  initDoc(doc, { uuid, title });
  const id = appendBlock(doc, { type: "table", text: source });
  if (decision) { setKind(doc, "decision"); setStatus(doc, "open"); }
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
    upsertDirectoryEntry(directory, {
      uuid, title,
      ...(decision ? { kind: "decision", status: "open", ...decisionDirectoryFields(doc) } : {}),
    });
    await connect(roomForDoc(harness().workspaceUuid, uuid), doc);
    return { uuid, id, doc, directory, close };
  } catch (error) { close(); throw error; }
}

async function openTable(page: Page, uuid: string, rows = 4): Promise<Locator> {
  await page.goto(new URL(`/${ws()}/${uuid}`, harness().appUrl).href);
  const table = page.locator(".ub-table");
  await expect(table.locator("tr")).toHaveCount(rows);
  return table;
}

function handle(page: Page, row: number): Locator {
  return page.getByRole("button", { name: `Row ${row + 1} actions`, exact: true });
}

function indicator(page: Page): Locator { return page.locator(".ub-table-row-drop"); }

function bodyNames(table: Locator): Locator {
  return table.locator("tr:has(td) > td:first-child");
}

async function box(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const bounds = await target.boundingBox();
  if (bounds === null) throw new Error("e2e: row move target has no geometry");
  return bounds;
}

async function gap(table: Locator, boundary: number): Promise<{ x: number; y: number }> {
  const tableBox = await box(table);
  const row = await box(table.locator("tr").nth(boundary - 1));
  // The first body gap is below the header; a point inside it must be rejected.
  return { x: tableBox.x + tableBox.width / 2, y: row.y + row.height + (boundary === 1 ? 1 : -1) };
}

async function startMouse(page: Page, table: Locator, row = 1): Promise<void> {
  await table.locator("tr").nth(row).hover();
  const source = handle(page, row);
  // The overlay follows the table as fonts and scrolling settle. Wait for
  // the handle's stable, hit-tested position before issuing a raw press.
  await source.hover();
  const bounds = await box(source);
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.mouse.move(x - 8, y);
  await expect(indicator(page)).toHaveCount(1);
  const destination = await gap(table, row + 1);
  await page.mouse.move(destination.x, destination.y);
  await expect(indicator(page)).toHaveCount(1);
}

async function overGap(page: Page, table: Locator, boundary: number): Promise<void> {
  // Auto-scroll can move the gap after its coordinates were read. Steer the
  // held pointer at the current gap; these moves cannot restart a canceled drag.
  await expect.poll(async () => {
    const destination = await gap(table, boundary);
    await page.mouse.move(destination.x, destination.y);
    return indicator(page).evaluateAll(elements => elements.map(element => element.getAttribute("data-gap")));
  }).toEqual([String(boundary)]);
}

async function caretIn(cell: Locator, info: TestInfo): Promise<void> {
  await placeCaretIn(cell, { touch: info.project.use.hasTouch === true });
}

async function keyboardMove(page: Page, name: "Move row up" | "Move row down"): Promise<void> {
  const item = page.getByRole("menuitem", { name, exact: true });
  await page.keyboard.press("Home");
  for (let step = 0; step < 5; step += 1) {
    if (await item.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
}

async function nativeTouchPage(browser: Browser): Promise<Page> {
  const context = trackContext(await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } }));
  return context.newPage();
}

async function touch(session: CDPSession, type: "touchStart" | "touchMove", point: { x: number; y: number }): Promise<void> {
  await session.send("Input.dispatchTouchEvent", { type, touchPoints: [{ ...point, id: 1 }] });
}

test("mouse pickup leaves every row readable and drops only at a body gap", { tag: "@webkit" }, async ({ page }, info) => {
  test.skip(info.project.use.hasTouch === true, "Mouse pickup requires a pointer device");
  await page.emulateMedia({ colorScheme: "light" });
  const fixture = await publishTable();
  try {
    const table = await openTable(page, fixture.uuid);
    const identity = await table.getAttribute("id");
    await table.locator("tr").nth(1).hover();
    const handleBox = await box(handle(page, 1));
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.mouse.up();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");

    const before = await table.locator("tr").evaluateAll((rows) => rows.map((row) => {
      const bounds = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        text: row.textContent, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        opacity: style.opacity, visibility: style.visibility, display: style.display,
      };
    }));
    await startMouse(page, table);
    await overGap(page, table, 4);
    await expect(indicator(page)).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const painted = await indicator(page).evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.backgroundColor, opacity: Number(style.opacity) };
      });
      expect(painted.color).not.toBe("transparent");
      expect(painted.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(painted.opacity).toBeGreaterThan(0);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await expect(bodyNames(table)).toHaveText(INITIAL);
    expect(await table.locator("tr").evaluateAll((rows) => rows.map((row) => {
      const bounds = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        text: row.textContent, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        opacity: style.opacity, visibility: style.visibility, display: style.display,
      };
    }))).toEqual(before);
    await expect(table.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
    await page.mouse.up();
    await expect(bodyNames(table)).toHaveText(["beta", "gamma", "alpha"]);
    await expect(indicator(page)).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await table.getAttribute("id")).toBe(identity);
    await expect(table.locator("tr").first().locator("th")).toHaveText(["A", "B"]);
    await expect(table.locator("tr:has(td)")).toHaveCount(3);
    await expect.poll(() => getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text)
      .toBe("| A | B |\n| --- | --- |\n| beta | two |\n| gamma | three |\n| alpha | one |");

    // A later drag can target a gap between body rows, including moving up.
    await startMouse(page, table, 3);
    await overGap(page, table, 2);
    await page.mouse.up();
    await expect(bodyNames(table)).toHaveText(["beta", "alpha", "gamma"]);
    await expect(page.getByRole("menu")).toHaveCount(0);
  } finally { fixture.close(); }
});

test("own gaps, outside release and Escape preserve the caret and focus without writing", { tag: "@webkit" }, async ({ page }, info) => {
  test.skip(info.project.use.hasTouch === true, "Mouse cancellation requires a pointer device");
  const fixture = await publishTable();
  try {
    const afterId = appendBlock(fixture.doc, { type: "paragraph", text: "after" });
    const table = await openTable(page, fixture.uuid);
    const after = editor(page).locator(":scope > p").last();
    const secondCell = table.locator("tr").nth(1).locator("td").nth(1);
    for (const caret of [after, secondCell]) {
      for (const ending of ["own", "outside", "escape"] as const) {
        await caretIn(caret, info);
        // Commit the native selection to PM before the drag begins.
        await page.keyboard.insertText("1");
        let text = await caret.textContent() ?? "";
        await expect.poll(() => getBlocks(fixture.doc).find((block) => block.id === (caret === after ? afterId : fixture.id))?.text)
          .toContain(text);
        let before = Y.encodeStateVector(fixture.doc);
        await startMouse(page, table);
        if (caret === after && ending === "own") {
          // Received edits before the saved caret must keep it mapped in PM.
          editBlock(fixture.doc, afterId, text, `remote ${text}`);
          text = `remote ${text}`;
          await expect(caret).toHaveText(text);
          before = Y.encodeStateVector(fixture.doc);
        }
        if (ending === "own") await overGap(page, table, 2);
        else if (ending === "outside") await page.mouse.move(2, 2);
        else { await overGap(page, table, 4); await page.keyboard.press("Escape"); }
        await page.mouse.up();
        await expect(indicator(page)).toHaveCount(0);
        await expect(page.getByRole("menu")).toHaveCount(0);
        await expect(editor(page)).toBeFocused();
        // Native selections can end at a text offset or an element's child
        // boundary. Both are a caret at the end when no target text follows.
        await expect.poll(() => caret.evaluate(caretAtEdge)).toBe(true);
        await expect(bodyNames(table)).toHaveText(INITIAL);
        expect(Y.encodeStateVector(fixture.doc)).toEqual(before);
        await page.keyboard.insertText(` ${ending}`);
        await expect(caret).toHaveText(`${text} ${ending}`);
      }
    }
    // A handle gesture must also leave focus outside the editor alone.
    const title = page.locator(".ub-title");
    await title.focus();
    await startMouse(page, table);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(indicator(page)).toHaveCount(0);
    await expect(title).toBeFocused();
    // The suppression guard must clear for a deliberate later click.
    await handle(page, 1).click();
    await expect(page.getByRole("menu")).toBeVisible();
  } finally { fixture.close(); }
});

test("the header cannot be picked up and drops above it are rejected", async ({ page }) => {
  const fixture = await publishTable();
  try {
    const table = await openTable(page, fixture.uuid);
    await table.locator("tr").first().hover();
    const bounds = await box(handle(page, 0));
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    const last = await gap(table, 4);
    await page.mouse.move(last.x, last.y, { steps: 12 });
    await expect(indicator(page)).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await startMouse(page, table);
    const header = await box(table.locator("tr").first());
    await page.mouse.move(header.x + header.width / 2, header.y - 2);
    await expect(indicator(page)).toHaveCount(0);
    await page.mouse.up();
    await expect(bodyNames(table)).toHaveText(INITIAL);
    expect(getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text).toBe(SOURCE);
  } finally { fixture.close(); }
});

test("Move entries repeat from the moved caret and keep typing in separate undo steps", { tag: "@webkit" }, async ({ page }, info) => {
  const fixture = await publishTable();
  try {
    const table = await openTable(page, fixture.uuid);
    await caretIn(table.locator("tr").nth(1).locator("td").first(), info);
    await page.keyboard.press("End");
    await page.keyboard.insertText(" before");
    await openKeyboardMenu(page, "Control+Alt+r");
    await expect(page.getByRole("menuitem", { name: "Move row up", exact: true })).toBeDisabled();
    await keyboardMove(page, "Move row down");
    await expect(bodyNames(table)).toHaveText(["beta", "alpha before", "gamma"]);
    await expect.poll(() => table.locator("tr").nth(2).evaluate((element) => {
      const anchor = document.getSelection()?.anchorNode;
      return anchor !== null && anchor !== undefined && element.contains(anchor);
    })).toBe(true);
    await openKeyboardMenu(page, "Shift+F10");
    await keyboardMove(page, "Move row down");
    await expect(bodyNames(table)).toHaveText(["beta", "gamma", "alpha before"]);
    await openKeyboardMenu(page, "Control+Alt+r");
    await expect(page.getByRole("menuitem", { name: "Move row down", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    // Escape returns trigger focus; re-enter the moved row before typing.
    await caretIn(table.locator("tr").last().locator("td").first(), info);
    await page.keyboard.press("End");
    await page.keyboard.insertText(" after");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(bodyNames(table)).toHaveText(["beta", "gamma", "alpha before"]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(bodyNames(table)).toHaveText(["beta", "alpha before", "gamma"]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(bodyNames(table)).toHaveText(["alpha before", "beta", "gamma"]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(bodyNames(table)).toHaveText(INITIAL);
    await caretIn(table.locator("th").first(), info);
    await openKeyboardMenu(page, "Control+Alt+r");
    await expect(page.getByRole("menuitem", { name: "Move row up", exact: true })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "Move row down", exact: true })).toBeDisabled();
  } finally { fixture.close(); }
});

test("a drag keeps edits and inserted rows that arrive before the drop", async ({ page }) => {
  const fixture = await publishTable();
  try {
    const table = await openTable(page, fixture.uuid);
    await startMouse(page, table);
    await overGap(page, table, 4);
    const edited = SOURCE.replace("alpha", "edited alpha").replace("beta", "edited beta");
    editBlock(fixture.doc, fixture.id, SOURCE, edited, {
      tableMapping: { rows: [0, 1, 2, 3], columns: [0, 1] },
    });
    await expect(bodyNames(table)).toHaveText(["edited alpha", "edited beta", "gamma"]);
    const inserted = edited.replace("| edited alpha | one |", "| new | row |\n| edited alpha | one |");
    editBlock(fixture.doc, fixture.id, edited, inserted, {
      tableMapping: { rows: [0, null, 1, 2, 3], columns: [0, 1] },
    });
    await expect(bodyNames(table)).toHaveText(["new", "edited alpha", "edited beta", "gamma"]);
    await expect(indicator(page)).toHaveCount(1);
    await overGap(page, table, 5);
    await page.mouse.up();
    await expect(bodyNames(table)).toHaveText(["new", "edited beta", "gamma", "edited alpha"]);
    await expect.poll(() => getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text)
      .toBe("| A | B |\n| --- | --- |\n| new | row |\n| edited beta | two |\n| gamma | three |\n| edited alpha | one |");
  } finally { fixture.close(); }
});

for (const changed of ["row deletion", "table deletion", "row move", "ragged shape", "read-only"] as const) {
  test(`a received ${changed} cancels an active drag without another write`, async ({ page }) => {
    const fixture = await publishTable(SOURCE, changed === "read-only");
    try {
      const table = await openTable(page, fixture.uuid);
      await startMouse(page, table);
      await overGap(page, table, 4);
      if (changed === "row deletion") {
        editBlock(fixture.doc, fixture.id, SOURCE, SOURCE.replace("| alpha | one |\n", ""), {
          tableMapping: { rows: [0, 2, 3], columns: [0, 1] },
        });
        await expect(bodyNames(table)).toHaveText(["beta", "gamma"]);
      } else if (changed === "table deletion") {
        deleteBlock(fixture.doc, fixture.id);
        await expect(table).toHaveCount(0);
      } else if (changed === "row move") {
        const shared = getBlocksFragment(fixture.doc).get(0);
        if (!(shared instanceof Y.XmlElement)) throw new Error("e2e: shared table missing");
        const row = shared.get(1);
        if (!(row instanceof Y.XmlElement)) throw new Error("e2e: shared row missing");
        fixture.doc.transact(() => { const copy = row.clone(); shared.delete(1, 1); shared.insert(3, [copy]); });
        await expect(bodyNames(table)).toHaveText(["beta", "gamma", "alpha"]);
      } else if (changed === "ragged shape") {
        const shared = getBlocksFragment(fixture.doc).get(0);
        if (!(shared instanceof Y.XmlElement)) throw new Error("e2e: shared table missing");
        const row = shared.get(2);
        if (!(row instanceof Y.XmlElement)) throw new Error("e2e: shared row missing");
        row.delete(1, 1);
        await expect(table.locator("tr").nth(2).locator("td")).toHaveCount(1);
        await expect(page.locator(".ub-table-controls")).toHaveCount(0);
      } else {
        setStatus(fixture.doc, "decided");
        upsertDirectoryEntry(fixture.directory, {
          uuid: fixture.uuid, title: "Shared row move", kind: "decision", status: "decided",
          ...decisionDirectoryFields(fixture.doc),
        });
        await expect(editor(page)).toHaveAttribute("contenteditable", "false");
        await expect(page.locator(".ub-table-controls")).toHaveCount(0);
      }
      await expect(indicator(page)).toHaveCount(0);
      const afterRemote = Y.encodeStateVector(fixture.doc);
      await page.mouse.up();
      await expect(page.getByRole("menu")).toHaveCount(0);
      expect(Y.encodeStateVector(fixture.doc)).toEqual(afterRemote);
    } finally { fixture.close(); }
  });
}

test("pane edge scrolling reaches the gap after a tall table's last row", async ({ page }) => {
  const names = Array.from({ length: 35 }, (_, index) => `body ${index + 1}`);
  const source = `| A | B |\n| --- | --- |\n${names.map((name) => `| ${name} | value |`).join("\n")}`;
  const fixture = await publishTable(source);
  try {
    const table = await openTable(page, fixture.uuid, 36);
    const pane = page.locator(".ub-document-pane");
    const paneBox = await box(pane);
    await table.locator("tr").nth(1).scrollIntoViewIfNeeded();
    await startMouse(page, table);
    const initialScroll = await pane.evaluate((element) => element.scrollTop);
    const tableBox = await box(table);
    await page.mouse.move(tableBox.x + tableBox.width / 2, paneBox.y + paneBox.height - 8, { steps: 12 });
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScroll + 80);
    await expect.poll(async () => (await box(table.locator("tr").last())).y).toBeLessThan(paneBox.y + paneBox.height - 15);
    await expect(bodyNames(table)).toHaveText(names);
    await overGap(page, table, 36);
    await page.mouse.up();
    await expect(bodyNames(table)).toHaveText([...names.slice(1), names[0] ?? ""]);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    await expect.poll(() => table.locator("tr").last().evaluate((element) => {
      const anchor = document.getSelection()?.anchorNode;
      return anchor !== null && anchor !== undefined && element.contains(anchor);
    })).toBe(true);

    // The opposite edge must also reach the first permitted body gap.
    await startMouse(page, table, 35);
    const bottomScroll = await pane.evaluate((element) => element.scrollTop);
    await page.mouse.move(tableBox.x + tableBox.width / 2, paneBox.y + 8, { steps: 12 });
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeLessThan(bottomScroll - 80);
    await expect.poll(async () => (await box(table.locator("tr").first())).y).toBeGreaterThan(paneBox.y + 1);
    // Measure the header gap after edge scrolling stops moving its position.
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
    await overGap(page, table, 1);
    await page.mouse.up();
    await expect(bodyNames(table)).toHaveText(names);
    await expect(page.getByRole("menu")).toHaveCount(0);
  } finally { fixture.close(); }
});

test("touch tap exposes Move entries and reopens the moved caret row", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const context = trackContext(await browser.newContext(info.project.name === "chromium"
    ? { hasTouch: true, viewport: { width: 390, height: 844 } } : {}));
  const page = await context.newPage();
  const fixture = await publishTable();
  try {
    const table = await openTable(page, fixture.uuid);
    await table.locator("tr").nth(1).locator("td").first().tap();
    await expect.poll(() => page.getByRole("button", { name: /^Row \d+ actions$/ }).evaluateAll((elements) => elements
      .filter((element) => getComputedStyle(element).opacity !== "0")
      .map((element) => element.getAttribute("aria-label")))).toEqual(["Row 2 actions"]);
    const bounds = await box(handle(page, 1));
    expect(bounds.width + 0.001).toBeGreaterThanOrEqual(44);
    expect(bounds.height + 0.001).toBeGreaterThanOrEqual(44);
    await handle(page, 1).tap();
    await page.getByRole("menuitem", { name: "Move row down", exact: true }).tap();
    await expect(bodyNames(table)).toHaveText(["beta", "alpha", "gamma"]);
    await expect(handle(page, 2)).toBeVisible();
    await handle(page, 2).tap();
    await page.getByRole("menuitem", { name: "Move row down", exact: true }).tap();
    await expect(bodyNames(table)).toHaveText(["beta", "gamma", "alpha"]);
    await handle(page, 3).tap();
    await expect(page.getByRole("menuitem", { name: "Move row down", exact: true })).toBeDisabled();
  } finally { fixture.close(); }
});

test("native touch holds pick up rows and swallow release clicks, including cancellation", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Native hold/move automation requires Chromium's input protocol");
  const page = await nativeTouchPage(browser);
  const fixture = await publishTable();
  const session = await page.context().newCDPSession(page);
  try {
    const table = await openTable(page, fixture.uuid);
    for (const ending of ["own", "escape", "cancel", "move"] as const) {
      const cell = table.locator("tr").nth(1).locator("td").nth(1);
      await placeCaretIn(cell, { touch: true });
      const bounds = await box(handle(page, 1));
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const before = Y.encodeStateVector(fixture.doc);
      await touch(session, "touchStart", point);
      await expect(indicator(page)).toHaveCount(1);
      await expect(page.getByRole("menu")).toHaveCount(0);
      if (ending === "move") await touch(session, "touchMove", await gap(table, 4));
      else if (ending === "escape") await page.keyboard.press("Escape");
      await session.send("Input.dispatchTouchEvent", {
        type: ending === "cancel" ? "touchCancel" : "touchEnd", touchPoints: [],
      });
      await expect(indicator(page)).toHaveCount(0);
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(bodyNames(table)).toHaveText(ending === "move" ? ["beta", "gamma", "alpha"] : INITIAL);
      if (ending !== "move") {
        expect(Y.encodeStateVector(fixture.doc)).toEqual(before);
        await expect.poll(() => cell.evaluate(caretAtEdge)).toBe(true);
      }
      const current = ending === "move" ? 3 : 1;
      // A stationary hold generates a native click after release; a later
      // deliberate tap or keyboard action still has to open this handle.
      await handle(page, current).tap();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
  } finally {
    try { await session.detach(); } finally { fixture.close(); }
  }
});

test("an immediate touch swipe from a row handle scrolls without picking up a row", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Native swipe automation requires Chromium's input protocol");
  const source = `| A | B |\n| --- | --- |\n${Array.from({ length: 30 }, (_, index) => `| row ${index + 1} | value |`).join("\n")}`;
  const page = await nativeTouchPage(browser);
  const fixture = await publishTable(source);
  const session = await page.context().newCDPSession(page);
  try {
    const table = await openTable(page, fixture.uuid, 31);
    await table.locator("tr").nth(3).locator("td").first().tap();
    const bounds = await box(handle(page, 3));
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const pane = page.locator(".ub-document-pane");
    const before = await pane.evaluate((element) => element.scrollTop);
    const sharedBefore = Y.encodeStateVector(fixture.doc);
    await touch(session, "touchStart", point);
    for (let step = 1; step <= 6; step += 1) {
      await touch(session, "touchMove", { x: point.x, y: point.y - step * 15 });
      await page.waitForTimeout(20);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
    await expect(indicator(page)).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(Y.encodeStateVector(fixture.doc)).toEqual(sharedBefore);
  } finally {
    try { await session.detach(); } finally { fixture.close(); }
  }
});
