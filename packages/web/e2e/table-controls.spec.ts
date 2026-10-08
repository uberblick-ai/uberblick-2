/** Table shape controls use real pointer, keyboard and touch delivery. */
import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import { join } from "node:path";
import { createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, trackContext } = setupHarness();

function controls(page: Page): Locator {
  return page.locator(".ub-table-controls");
}

function button(page: Page, name: string): Locator {
  return page.getByRole("button", { name, exact: true, includeHidden: true });
}

async function activate(control: Locator, info: TestInfo): Promise<void> {
  if (info.project.use.hasTouch === true) await control.tap();
  else await control.click();
}

async function caretIn(cell: Locator, info: TestInfo): Promise<void> {
  if (info.project.use.hasTouch === true && await cell.evaluate((element) => element.matches("th, td"))) {
    // Border targets may cover the neighbouring cell's edge on touch. Use
    // the cell interior, away from the visible right-edge row controls.
    const box = await cell.boundingBox();
    if (box === null) throw new Error("e2e: caret cell has no geometry");
    await cell.tap({ position: { x: box.width / 4, y: box.height / 2 } });
  } else await activate(cell, info);
  await expect.poll(() => cell.evaluate((element) => {
    const anchor = document.getSelection()?.anchorNode;
    return anchor !== null && anchor !== undefined && element.contains(anchor);
  })).toBe(true);
  await cell.page().evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function touchPage(browser: Browser, info: TestInfo): Promise<Page> {
  const context = trackContext(await browser.newContext(info.project.name === "chromium"
    ? { hasTouch: true, viewport: { width: 390, height: 844 } }
    : {}));
  return context.newPage();
}

async function openTable(page: Page, headerOnly = false): Promise<Locator> {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, docTitle("Table controls"));
  await placeCaret(page);
  await page.keyboard.insertText("Neighbor paragraph");
  await page.keyboard.press("Enter");
  // WebKit can paint the new paragraph before its native caret follows it.
  const empty = editor(page).locator(":scope > p").last();
  await expect(empty).toHaveText("");
  await empty.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await expect.poll(() => empty.evaluate((element) => {
    const anchor = document.getSelection()?.anchorNode;
    return anchor !== null && anchor !== undefined && element.contains(anchor);
  })).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  if (headerOnly) {
    await page.keyboard.type("| First | Second | Third | Fourth | Fifth | Sixth | Seventh | Last |");
    await page.keyboard.press("Enter");
    await page.keyboard.type("| --- | --- | --- | --- | --- | --- | --- | --- |");
  } else {
    await page.keyboard.type("/table");
    await page.keyboard.press("Enter");
  }
  const table = page.locator(".ub-table");
  await expect(table).toBeVisible();
  await expect(table.locator("tr")).toHaveCount(headerOnly ? 1 : 3);
  return table;
}

async function minimumTargets(targets: Locator): Promise<void> {
  // evaluateAll reads one snapshot without waiting, and controls re-render
  // as the caret and geometry settle; retry until a target is present.
  let dimensions: Array<{ width: number; height: number }> = [];
  await expect.poll(async () => {
    dimensions = await targets.evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }));
    return dimensions.length;
  }).toBeGreaterThan(0);
  // WebKit reports a 44px menu item as 43.999969px at fractional portal offsets.
  // Allow only coordinate precision loss, well below a layout pixel fraction.
  for (const size of dimensions) {
    expect(size.width + 0.001).toBeGreaterThanOrEqual(44);
    expect(size.height + 0.001).toBeGreaterThanOrEqual(44);
  }
}

async function tableControls(table: Locator): Promise<Locator> {
  const id = await table.getAttribute("id");
  if (id === null) throw new Error("e2e: table has no block identity");
  return table.page().locator(`.ub-table-controls[data-table-id="${id}"]`);
}

/** Opacity-hidden controls remain in native Tab order, so visibility alone is insufficient. */
async function revealedRows(table: Locator, rows: number[]): Promise<void> {
  const overlay = await tableControls(table);
  await expect.poll(() => overlay.locator("button").evaluateAll((elements) => elements.flatMap((element) => {
    const name = element.getAttribute("aria-label") ?? "";
    if (!/^(?:Row \d+ actions|Insert row after \d+)$/.test(name)) return [];
    const style = getComputedStyle(element);
    return style.opacity !== "0" && style.visibility !== "hidden" && style.display !== "none" ? [name] : [];
  }))).toEqual([
    ...rows.map((row) => `Insert row after ${row}`),
    ...rows.map((row) => `Row ${row} actions`),
  ]);
}

async function compactTable(table: Locator): Promise<void> {
  const geometry = await table.evaluate((element) => {
    const wrapper = element.parentElement;
    const paragraph = wrapper?.parentElement?.querySelector(":scope > p");
    if (wrapper === null || paragraph === null || paragraph === undefined) throw new Error("e2e: table or paragraph is absent");
    const table = element.getBoundingClientRect();
    const frame = wrapper.getBoundingClientRect();
    return { right: Math.min(table.right, frame.right), frameRight: frame.right, paragraphRight: paragraph.getBoundingClientRect().right, top: table.top, frameTop: frame.top };
  });
  expect(Math.abs(geometry.right - geometry.paragraphRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.frameRight - geometry.paragraphRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.top - geometry.frameTop)).toBeLessThanOrEqual(1);
}

async function columnBorders(table: Locator): Promise<void> {
  const geometry = await table.evaluate((element) => {
    const header = element.querySelector("tr");
    const cells = Array.from(header?.children ?? []);
    const first = cells[0];
    const overlay = Array.from(document.querySelectorAll<HTMLElement>(".ub-table-controls"))
      .find((candidate) => candidate.dataset.tableId === element.id);
    if (first === undefined || overlay === undefined) throw new Error("e2e: column controls are absent");
    const top = element.getBoundingClientRect().top;
    const edges = [first.getBoundingClientRect().left, ...cells.map((cell) => cell.getBoundingClientRect().right)];
    return Array.from(overlay.querySelectorAll("button[aria-label^='Insert column']")).map((control, index) => {
      const bounds = control.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, left: bounds.left, right: bounds.right,
        edge: edges[index], outer: index === 0 || index === cells.length, touch: overlay.dataset.touch === "true",
        top, opacity: getComputedStyle(control).opacity };
    });
  });
  expect(geometry.length).toBeGreaterThan(1);
  for (const boundary of geometry) {
    expect(boundary.opacity).toBe("1");
    if (boundary.touch && boundary.outer) {
      // Touch edge targets move inward only to fit the document pane, while
      // still crossing their column border. Mouse targets stay centred.
      expect(boundary.left).toBeLessThan(boundary.edge ?? Number.NaN);
      expect(boundary.right).toBeGreaterThan(boundary.edge ?? Number.NaN);
    } else expect(Math.abs(boundary.x - (boundary.edge ?? Number.NaN))).toBeLessThanOrEqual(1);
    expect(Math.abs(boundary.y - boundary.top)).toBeLessThanOrEqual(1);
  }
}

async function rowBorder(table: Locator, row: number): Promise<void> {
  const target = button(table.page(), `Insert row after ${row}`);
  const expected = await table.evaluate((element, index) => {
    const wrapper = element.parentElement;
    const row = element.querySelectorAll("tr")[index - 1];
    if (wrapper === null || row === undefined) throw new Error("e2e: row border is absent");
    return { right: Math.min(element.getBoundingClientRect().right, wrapper.getBoundingClientRect().right), bottom: row.getBoundingClientRect().bottom };
  }, row);
  const bounds = await target.boundingBox();
  if (bounds === null) throw new Error("e2e: row insertion control has no geometry");
  if (await (await tableControls(table)).getAttribute("data-touch") === "true") {
    expect(bounds.x).toBeLessThan(expected.right);
    expect(bounds.x + bounds.width).toBeGreaterThan(expected.right);
  } else expect(Math.abs(bounds.x + bounds.width / 2 - expected.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.y + bounds.height / 2 - expected.bottom)).toBeLessThanOrEqual(1);
}

async function controlsDoNotOverlap(table: Locator): Promise<void> {
  const overlay = await tableControls(table);
  const collisions = await overlay.evaluate((element) => {
    const buttons = [...element.querySelectorAll("button"), ...document.querySelectorAll("button[aria-label='Insert block below']")]
      .filter((control) => {
        const style = getComputedStyle(control);
        return style.opacity !== "0" && style.visibility !== "hidden" && style.display !== "none";
      });
    return buttons.flatMap((control, index) => {
      const box = control.getBoundingClientRect();
      const name = control.getAttribute("aria-label") ?? "";
      const overlaps = buttons.slice(index + 1).flatMap((other) => {
        const bounds = other.getBoundingClientRect();
        return Math.min(box.right, bounds.right) - Math.max(box.left, bounds.left) > 1 &&
          Math.min(box.bottom, bounds.bottom) - Math.max(box.top, bounds.top) > 1
          ? [`${name} / ${other.getAttribute("aria-label") ?? ""}`] : [];
      });
      return overlaps;
    });
  });
  expect(collisions).toEqual([]);
}

async function hitTarget(target: Locator): Promise<void> {
  expect(await target.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
}

/** The whole touch target fits the pane, with input delivered at each edge. */
async function fullyTappable(target: Locator): Promise<void> {
  // Native scrolling reaches the sibling strip through a geometry refresh.
  await expect.poll(() => target.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const pane = element.closest(".ub-document-pane")?.getBoundingClientRect();
    if (pane === undefined) throw new Error("e2e: touch target has no document pane");
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    // Use the first interior CSS pixel: subpixel hit tests can round across
    // the viewport edge or a neighbouring collapsed-border target.
    const points: [number, number][] = [[bounds.left + 1, centerY], [bounds.right - 1, centerY],
      [centerX, bounds.top + 1], [centerX, bounds.bottom - 1]];
    const targets = points.map(([x, y]) => document.elementFromPoint(x, y));
    return { name: element.getAttribute("aria-label"), left: bounds.left, right: bounds.right,
      top: bounds.top, bottom: bounds.bottom, paneLeft: pane.left, paneRight: pane.right,
      targets: targets.map((target) => target?.outerHTML.slice(0, 160)),
      withinPane: bounds.left + 0.001 >= pane.left && bounds.right - 0.001 <= pane.right,
      edges: targets.map((target) => element.contains(target)) };
  })).toMatchObject({ withinPane: true, edges: [true, true, true, true] });
}

async function pageFits(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const panes = await page.locator(".ub-document-pane").evaluateAll((elements) => elements.map((element) => ({
    width: element.clientWidth, scrollWidth: element.scrollWidth,
  })));
  expect(panes.length).toBeGreaterThan(0);
  for (const pane of panes) expect(pane.scrollWidth).toBeLessThanOrEqual(pane.width);
}

async function capture(page: Page, info: TestInfo, label: string, colorScheme: "light" | "dark"): Promise<void> {
  if (info.project.name !== "chromium" || process.env.UB_AGENTS_SCRATCH === undefined) return;
  await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `${label}-${colorScheme}.png`) });
}

/**
 * Native Tab from the insertion shortcut must reach the named button. Like
 * Safari, WebKit on macOS tabs only to text fields; Option+Tab reaches buttons.
 */
async function tabTo(page: Page, name: string): Promise<void> {
  const target = button(page, name);
  const webkitMac = process.platform === "darwin" && page.context().browser()?.browserType().name() === "webkit";
  for (let index = 0; index < 40; index += 1) {
    const focusedName = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
    expect(await target.count(), `Tab reached ${focusedName ?? "no element"} and lost the table controls`).toBe(1);
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(webkitMac ? "Alt+Tab" : "Tab");
  }
  await expect(target).toBeFocused();
}

test("a caret table and another hovered table reveal their own controls together", async ({ page }) => {
  const initial = await openTable(page);
  const originalId = await initial.getAttribute("id");
  if (originalId === null) throw new Error("e2e: table has no block identity");
  await editor(page).locator(":scope > p").first().click();
  await placeCaret(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ub-table")).toHaveCount(2);
  const original = page.locator(`.ub-table[id="${originalId}"]`);
  const hovered = page.locator(".ub-table").first();
  const hoveredId = await hovered.getAttribute("id");
  if (hoveredId === null || hoveredId === originalId) throw new Error("e2e: second table was not inserted before the first");
  await original.locator("th").first().click();
  await hovered.locator("tr").last().hover();
  await expect(controls(page)).toHaveCount(2);
  await expect(page.locator(`.ub-table-controls[data-table-id="${originalId}"]`)).toBeVisible();
  await expect(page.locator(`.ub-table-controls[data-table-id="${hoveredId}"]`)).toBeVisible();
  await revealedRows(original, [1]);
  await revealedRows(hovered, [3]);
  await pageFits(page);
});

for (const colorScheme of ["light", "dark"] as const) {
test(`hover reveals quiet controls without moving the table and the pointer reaches them — ${colorScheme}`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme });
  const table = await openTable(page);
  await editor(page).locator(":scope > p").first().click();
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
  await compactTable(table);
  const before = await table.locator("th, td").evaluateAll((cells) => cells.map((cell) => {
    const box = cell.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  await table.locator("tr").nth(1).hover();
  await expect(controls(page)).toBeVisible();
  await revealedRows(table, [2]);
  await columnBorders(table);
  await rowBorder(table, 2);
  await controlsDoNotOverlap(table);
  await capture(page, info, "table-insertion-controls", colorScheme);
  expect(await table.locator("th, td").evaluateAll((cells) => cells.map((cell) => {
    const box = cell.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }))).toEqual(before);

  const target = button(page, "Insert column after 1");
  const box = await target.boundingBox();
  if (box === null) throw new Error("e2e: column insertion control has no geometry");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 30 });
  await expect(controls(page)).toBeVisible();
  await hitTarget(target);
  await page.mouse.down();
  await page.mouse.up();
  await expect(table.locator("th")).toHaveCount(4);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveCount(4);
  await expect(table.locator("tr").nth(2).locator("td")).toHaveCount(4);
  await pageFits(page);
});
}

test("caret and pointer reveal their own rows while hidden controls pass input to cells", { tag: "@webkit" }, async ({ page }, info) => {
  test.skip(info.project.use.hasTouch === true, "Hover requires a pointer device");
  const table = await openTable(page);
  await caretIn(table.locator("tr").nth(1).locator("td").first(), info);
  await page.mouse.move(0, 0);
  await revealedRows(table, [2]);
  await columnBorders(table);
  for (const name of ["Insert row after 1", "Row 1 actions"]) {
    const hidden = button(page, name);
    expect(await hidden.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 4, bounds.y + bounds.height / 4);
      return getComputedStyle(element).pointerEvents === "none" && hit !== null && hit.closest("th, td") !== null && hit.closest(".ub-table") !== null;
    })).toBe(true);
  }
  await table.locator("tr").last().locator("td").first().hover();
  await revealedRows(table, [2, 3]);
  await table.locator("tr").first().locator("th").first().hover();
  await revealedRows(table, [1, 2]);
  await page.mouse.move(0, 0);
  await revealedRows(table, [2]);
  await caretIn(editor(page).locator(":scope > p").first(), info);
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
  // A hidden table can move before the next single pointer event reaches it.
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Moves the table");
  await table.locator("tr").last().locator("td").first().hover();
  await revealedRows(table, [3]);
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
});

for (const colorScheme of ["light", "dark"] as const) {
test(`hover alone reveals one row and reaches its border insertion and adjacent menu — ${colorScheme}`, { tag: "@webkit" }, async ({ page }, info) => {
  test.skip(info.project.use.hasTouch === true, "Hover requires a pointer device");
  await page.emulateMedia({ colorScheme });
  const table = await openTable(page);
  const paragraph = editor(page).locator(":scope > p").first();
  await caretIn(table.locator("tr").nth(1).locator("td").first(), info);
  await page.keyboard.insertText("Target row");
  await caretIn(table.locator("tr").last().locator("td").first(), info);
  await page.keyboard.insertText("Keep last row");

  await caretIn(paragraph, info);
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
  await table.locator("tr").nth(1).locator("td").first().hover();
  await expect(controls(page)).toBeVisible();
  await revealedRows(table, [2]);
  await rowBorder(table, 2);
  await controlsDoNotOverlap(table);
  const insertion = button(page, "Insert row after 2");
  const insertionBox = await insertion.boundingBox();
  if (insertionBox === null) throw new Error("e2e: row insertion control has no geometry");
  await page.mouse.move(insertionBox.x + insertionBox.width / 2, insertionBox.y + insertionBox.height / 2, { steps: 30 });
  await expect(insertion).toBeVisible();
  await revealedRows(table, [2]);
  await hitTarget(insertion);
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
  await table.locator("tr").nth(1).locator("td").first().hover();
  await page.mouse.move(insertionBox.x + insertionBox.width / 2, insertionBox.y + insertionBox.height / 2, { steps: 30 });
  await expect(insertion).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(table.locator("tr").nth(1)).toContainText("Target row");
  await expect(table.locator("tr").nth(2).locator("td")).toHaveText(["", "", ""]);
  await expect(table.locator("tr").last()).toContainText("Keep last row");

  await caretIn(paragraph, info);
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
  await table.locator("tr").nth(1).locator("td").first().hover();
  await expect(controls(page)).toBeVisible();
  const rowMenu = button(page, "Row 2 actions");
  const menuBox = await rowMenu.boundingBox();
  if (menuBox === null) throw new Error("e2e: row menu control has no geometry");
  await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2, { steps: 30 });
  await expect(rowMenu).toBeVisible();
  await revealedRows(table, [2]);
  await hitTarget(rowMenu);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menu").hover();
  await revealedRows(table, [2]);
  await page.mouse.move(0, 0);
  await revealedRows(table, [2]);
  await page.getByRole("menuitem", { name: "Delete row", exact: true }).click();
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table).not.toContainText("Target row");
  await expect(table.locator("tr").nth(1).locator("td")).toHaveText(["", "", ""]);
  await expect(table.locator("tr").last()).toContainText("Keep last row");

  await caretIn(table.locator("tr").last().locator("td").first(), info);
  await page.keyboard.insertText("Still editable");
  await expect(table.locator("tr").last()).toContainText("Still editable");
  await caretIn(paragraph, info);
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
  await pageFits(page);
});
}

for (const colorScheme of ["light", "dark"] as const) {
test(`row menus target their row by trigger, right click and keyboard and protect the header — ${colorScheme}`, { tag: "@webkit" }, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme });
  const table = await openTable(page);
  await activate(table.locator("td").first(), info);
  await page.keyboard.insertText("Target row");
  await activate(table.locator("tr").last().locator("td").first(), info);
  await page.keyboard.insertText("Keep last row");

  await activate(table.locator("tr").nth(1).locator("td").first(), info);
  await activate(button(page, "Row 2 actions"), info);
  await capture(page, info, "table-row-menu", colorScheme);
  await activate(page.getByRole("menuitem", { name: "Insert row above", exact: true }), info);
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveText(["", "", ""]);
  await expect(table.locator("tr").nth(2)).toContainText("Target row");

  await table.locator("tr").nth(2).locator("td").first().click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await activate(page.getByRole("menuitem", { name: "Insert row below", exact: true }), info);
  await expect(table.locator("tr")).toHaveCount(5);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(table.locator("tr").nth(3).locator("td")).toHaveText(["", "", ""]);
  await expect(table.locator("tr").last()).toContainText("Keep last row");

  await activate(table.locator("tr").nth(2).locator("td").first(), info);
  // Control+Option+R exists on a MacBook without a context-menu key.
  await page.keyboard.press("Control+Alt+r");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(table).not.toContainText("Target row");
  await expect(table.locator("tr").last()).toContainText("Keep last row");

  await caretIn(table.locator("th").first(), info);
  await page.keyboard.press("Control+Alt+r");
  await expect(page.getByRole("menuitem", { name: "Insert row above", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Insert row below", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(button(page, "Row 1 actions")).toBeFocused();
  await pageFits(page);
});
}

test("keyboard reaches insertion buttons from a table caret and each button inserts once", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page);
  await caretIn(table.locator("td").first(), info);
  await page.keyboard.insertText("Keyboard row");
  await page.mouse.move(0, 0);
  await page.keyboard.press("Control+Alt+t");
  await expect(button(page, "Insert column before 1")).toBeFocused();
  if (info.project.name !== "webkit-iphone") {
    const order = ["Insert column before 1", "Insert column after 1", "Insert column after 2", "Insert column after 3",
      "Insert row after 1", "Insert row after 2", "Insert row after 3", "Row 1 actions", "Row 2 actions", "Row 3 actions"];
    for (const [index, name] of order.entries()) {
      const control = button(page, name);
      await expect(control).toBeFocused();
      await expect.poll(() => control.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      const focusedRow = /^(?:Insert row after |Row )(\d+)/.exec(name)?.[1];
      await revealedRows(table, focusedRow === undefined ? [2] : [...new Set([2, Number(focusedRow)])].sort());
      if (index < order.length - 1) await page.keyboard.press("Tab");
    }
    await activate(table.locator("td").first(), info);
    await page.mouse.move(0, 0);
    await page.keyboard.press("Control+Alt+t");
    await expect(button(page, "Insert column before 1")).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(table.locator("th")).toHaveCount(4);
  if (info.project.name === "webkit-iphone") {
    // iOS's native Tab leaves the button set; caret shortcuts keep every
    // insertion available to an attached keyboard there.
    await caretIn(table.locator("tr").nth(1).locator("td").last(), info);
    await page.keyboard.press("Control+Alt+ArrowRight");
  } else {
    await activate(table.locator("td").first(), info);
    await page.keyboard.press("Control+Alt+t");
    await tabTo(page, "Insert column after 4");
    await page.keyboard.press("Space");
  }
  await expect(table.locator("th")).toHaveCount(5);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveCount(5);

  if (info.project.name === "webkit-iphone") {
    await caretIn(table.locator("tr").last().locator("td").first(), info);
    await page.keyboard.press("Control+Alt+ArrowDown");
  } else {
    await activate(table.locator("td").first(), info);
    await page.keyboard.press("Control+Alt+t");
    await tabTo(page, "Insert row after 3");
    await page.keyboard.press("Enter");
  }
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(table.locator("tr").last().locator("td")).toHaveCount(5);
  await caretIn(table.locator("tr").last().locator("td").first(), info);
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(button(page, "Row 4 actions")).toBeFocused();
  await pageFits(page);
});

test("caret shortcuts insert on each side of the current cell and preserve the header", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page);
  await caretIn(table.locator("th").nth(1), info);
  await page.keyboard.insertText("Target header");
  await caretIn(table.locator("tr").nth(1).locator("td").nth(1), info);
  await page.keyboard.insertText("Target body");
  await caretIn(table.locator("tr").last().locator("td").nth(1), info);
  await page.keyboard.insertText("Last body");

  await caretIn(table.locator("th").nth(1), info);
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await expect(table.locator("th")).toHaveCount(4);
  await expect(table.locator("th").nth(2)).toHaveText("Target header");
  await caretIn(table.locator("th").nth(2), info);
  await page.keyboard.press("Control+Alt+ArrowRight");
  await expect(table.locator("th")).toHaveCount(5);
  await expect(table.locator("th").nth(2)).toHaveText("Target header");
  await expect(table.locator("tr").nth(1).locator("td")).toHaveCount(5);
  await expect(table.locator("tr").last().locator("td")).toHaveCount(5);

  await caretIn(table.locator("tr").nth(1).locator("td").nth(2), info);
  await page.keyboard.press("Control+Alt+ArrowUp");
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveText(["", "", "", "", ""]);
  await expect(table.locator("tr").nth(2)).toContainText("Target body");
  await caretIn(table.locator("tr").nth(2).locator("td").nth(2), info);
  await page.keyboard.press("Control+Alt+ArrowDown");
  await expect(table.locator("tr")).toHaveCount(5);
  await expect(table.locator("tr").nth(3).locator("td")).toHaveText(["", "", "", "", ""]);
  await expect(table.locator("tr").last()).toContainText("Last body");

  await caretIn(table.locator("th").nth(2), info);
  await page.keyboard.press("Control+Alt+ArrowUp");
  await expect(table.locator("tr")).toHaveCount(5);
  await expect(table.locator("tr").first().locator("td")).toHaveCount(0);
  await expect(table.locator("th").nth(2)).toHaveText("Target header");
  await pageFits(page);
});

test("header-only edge controls follow wide-table scrolling and retain the only header row", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page, true);
  const wrapper = table.locator("..");
  await expect.poll(() => wrapper.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await activate(table.locator("th").first(), info);
  await activate(button(page, "Insert column before 1"), info);
  await expect(table.locator("th")).toHaveCount(9);
  await expect(table.locator("td")).toHaveCount(0);
  await expect(table.locator("th").nth(1)).toHaveText("First");

  // Put an inner column boundary close to the visible right edge. The header
  // handle must stay separate from top-border column targets at partial scroll.
  const targetSize = (await button(page, "Row 1 actions").boundingBox())?.width;
  if (targetSize === undefined) throw new Error("e2e: header handle has no geometry");
  await wrapper.evaluate((element, size) => {
    const cell = element.querySelector("tr > th:last-child");
    if (cell === null) throw new Error("e2e: last column is absent");
    element.scrollLeft += cell.getBoundingClientRect().left - element.getBoundingClientRect().right + size;
  }, targetSize);
  const penultimate = button(page, "Insert column after 8");
  await expect.poll(async () => {
    const control = await penultimate.boundingBox();
    const cell = await table.locator("th").last().boundingBox();
    return control === null || cell === null ? Number.POSITIVE_INFINITY : Math.abs(control.x + control.width / 2 - cell.x);
  }).toBeLessThanOrEqual(1);
  await revealedRows(table, [1]);
  await controlsDoNotOverlap(table);
  await hitTarget(button(page, "Row 1 actions"));
  await rowBorder(table, 1);
  await hitTarget(penultimate);
  await pageFits(page);

  await wrapper.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await activate(table.locator("th").last(), info);
  await rowBorder(table, 1);
  const lastColumn = button(page, "Insert column after 9");
  await expect(lastColumn).toBeVisible();
  const lastColumnBox = await lastColumn.boundingBox();
  const lastCellBox = await table.locator("th").last().boundingBox();
  if (lastColumnBox === null || lastCellBox === null) throw new Error("e2e: scrolled column boundary has no geometry");
  if (info.project.use.hasTouch === true) {
    expect(lastColumnBox.x).toBeLessThan(lastCellBox.x + lastCellBox.width);
    expect(lastColumnBox.x + lastColumnBox.width).toBeGreaterThan(lastCellBox.x + lastCellBox.width);
    await fullyTappable(lastColumn);
  } else expect(Math.abs(lastColumnBox.x + lastColumnBox.width / 2 - lastCellBox.x - lastCellBox.width)).toBeLessThanOrEqual(1);
  await hitTarget(lastColumn);
  await activate(lastColumn, info);
  await expect(table.locator("th")).toHaveCount(10);
  await expect(table.locator("td")).toHaveCount(0);
  await expect(table.locator("th").nth(8)).toHaveText("Last");
  await activate(table.locator("th").last(), info);
  await activate(button(page, "Insert row after 1"), info);
  await expect(table.locator("tr")).toHaveCount(2);
  await expect(table.locator("tr").last().locator("td")).toHaveCount(10);
  await expect(table.locator("th")).toHaveCount(10);
  await pageFits(page);
});

test("touch exposes 44px controls for the caret table and row without hover", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await touchPage(browser, info);
  const table = await openTable(page);
  await table.locator("tr").nth(1).locator("td").first().tap();
  await expect(controls(page)).toBeVisible();
  await revealedRows(table, [2]);
  await minimumTargets(controls(page).getByRole("button", { name: /^Insert (?:column|row)/ }));
  await minimumTargets(button(page, "Row 2 actions"));
  await compactTable(table);
  await columnBorders(table);
  await rowBorder(table, 2);
  await controlsDoNotOverlap(table);
  await fullyTappable(button(page, "Insert row after 2"));
  await fullyTappable(button(page, "Row 2 actions"));
  await fullyTappable(button(page, "Insert column before 1"));
  await pageFits(page);
  await table.locator("..").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await rowBorder(table, 2);
  await fullyTappable(button(page, "Insert column after 3"));
  await pageFits(page);
  await table.locator("..").evaluate((element) => { element.scrollLeft = 0; });
  await button(page, "Insert row after 2").tap({ position: { x: 43, y: 22 } });
  await expect(table.locator("tr")).toHaveCount(4);
  await table.locator("tr").nth(1).locator("td").first().tap();
  await button(page, "Row 2 actions").tap();
  const deletion = page.getByRole("menuitem", { name: "Delete row", exact: true });
  await expect(deletion).toBeVisible();
  await minimumTargets(page.getByRole("menuitem"));
  await deletion.tap();
  await expect(table.locator("tr")).toHaveCount(3);
  await table.locator("th").first().tap();
  await revealedRows(table, [1]);
  await controlsDoNotOverlap(table);
  await button(page, "Insert column after 1").tap();
  await expect(table.locator("th")).toHaveCount(4);
  await expect(table.locator("tr").last().locator("td")).toHaveCount(4);
  await pageFits(page);
});

test("archiving hides structural controls and keyboard and right-click paths cannot write", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page);
  await activate(table.locator("td").first(), info);
  await page.keyboard.insertText("Retained cell");
  await activate(page.getByRole("button", { name: "Document actions", exact: true }), info);
  await activate(page.getByRole("menuitem", { name: "Archive document", exact: true }), info);
  await activate(page.getByRole("alertdialog").getByRole("button", { name: "Archive document", exact: true }), info);
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await activate(table.locator("td").first(), info);
  await page.keyboard.press("Control+Alt+r");
  await page.keyboard.press("Control+Alt+t");
  await table.locator("td").first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toHaveCount(0);
  await expect(controls(page)).toHaveCount(0);
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table.locator("th")).toHaveCount(3);
  await expect(table.locator("td").first()).toHaveText("Retained cell");
});
