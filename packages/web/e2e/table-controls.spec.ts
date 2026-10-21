/** Table shape controls use real pointer, keyboard and touch delivery. */
import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import { join } from "node:path";
import { activateControl, createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaret, placeCaretIn } from "./harness.js";

const { harness, trackContext } = setupHarness();

function controls(page: Page): Locator {
  return page.locator(".ub-table-controls");
}

function button(page: Page, name: string): Locator {
  return page.getByRole("button", { name, exact: true, includeHidden: true });
}

async function activate(control: Locator, info: TestInfo): Promise<void> {
  await activateControl(control, { touch: info.project.use.hasTouch === true });
}

async function caretIn(cell: Locator, info: TestInfo): Promise<void> {
  await placeCaretIn(cell, { touch: info.project.use.hasTouch === true });
}

async function touchPage(browser: Browser, info: TestInfo, width = 810): Promise<Page> {
  const context = trackContext(await browser.newContext(info.project.name === "chromium"
    ? { hasTouch: true, viewport: { width, height: 1080 } }
    : {}));
  return context.newPage();
}

async function openTable(page: Page, headerOnly = false): Promise<Locator> {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
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
  await expect.poll(() => overlay.getByRole("button", { name: /^Row \d+ actions$/ }).evaluateAll((elements) =>
    elements.filter((element) => getComputedStyle(element).opacity !== "0").map((element) => element.getAttribute("aria-label"))))
    .toEqual(rows.map((row) => `Row ${row} actions`));
}

async function revealedColumns(table: Locator, columns: number[]): Promise<void> {
  const overlay = await tableControls(table);
  await expect.poll(() => overlay.getByRole("button", { name: /^Column \d+ actions$/ }).evaluateAll((elements) =>
    elements.filter((element) => getComputedStyle(element).opacity !== "0").map((element) => element.getAttribute("aria-label"))))
    .toEqual(columns.map((column) => `Column ${column} actions`));
}

/** Only the two pills exist: no insertion buttons and no other table controls. */
async function onlyPills(table: Locator): Promise<void> {
  const overlay = await tableControls(table);
  expect(await overlay.locator("button").evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? "")
    .filter((name) => !/^(?:Row|Column) \d+ actions$/.test(name)))).toEqual([]);
}

/** A column pill sits centred on its column's top border. */
async function columnMenuBorder(table: Locator, column: number): Promise<void> {
  const target = button(table.page(), `Column ${column} actions`);
  await expect.poll(async () => {
    const bounds = await target.boundingBox();
    const cell = await table.locator("th").nth(column - 1).boundingBox();
    return bounds === null || cell === null ? Number.POSITIVE_INFINITY :
      Math.max(Math.abs(bounds.x + bounds.width / 2 - cell.x - cell.width / 2), Math.abs(bounds.y + bounds.height / 2 - cell.y));
  }).toBeLessThanOrEqual(1);
}

/** A mouse row pill is centred on the row's left border; a touch target straddles its right border. */
async function rowBorder(table: Locator, row: number): Promise<void> {
  const target = button(table.page(), `Row ${row} actions`);
  const touch = await (await tableControls(table)).getAttribute("data-touch") === "true";
  await expect.poll(async () => {
    const expected = await table.evaluate((element, index) => {
      const wrapper = element.parentElement;
      const row = element.querySelectorAll("tr")[index - 1];
      if (wrapper === null || row === undefined) throw new Error("e2e: row border is absent");
      const box = row.getBoundingClientRect();
      return { left: wrapper.getBoundingClientRect().left, middle: (box.top + box.bottom) / 2,
        right: Math.min(element.getBoundingClientRect().right, wrapper.getBoundingClientRect().right) };
    }, row);
    const pill = await target.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const mark = element.querySelector("span")?.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, centre: mark === undefined ? Number.NaN : (mark.left + mark.right) / 2,
        middle: (bounds.top + bounds.bottom) / 2 };
    });
    const across = touch
      ? (pill.left < expected.right && pill.right > expected.right ? 0 : Number.POSITIVE_INFINITY)
      : Math.abs(pill.centre - expected.left);
    return Math.max(across, Math.abs(pill.middle - expected.middle));
  }).toBeLessThanOrEqual(1);
}

async function compactTable(table: Locator): Promise<void> {
  const geometry = await table.evaluate((element) => {
    const wrapper = element.parentElement;
    const paragraph = wrapper?.parentElement?.querySelector(":scope > p");
    if (wrapper === null || paragraph === null || paragraph === undefined) throw new Error("e2e: table or paragraph is absent");
    const table = element.getBoundingClientRect();
    const frame = wrapper.getBoundingClientRect();
    const text = paragraph.getBoundingClientRect();
    return { left: table.left, right: table.right, frameLeft: frame.left, frameRight: frame.right,
      paragraphLeft: text.left, paragraphRight: text.right, top: table.top, frameTop: frame.top };
  });
  expect(Math.abs(geometry.left - geometry.paragraphLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.frameLeft - geometry.paragraphLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.right - geometry.paragraphRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.frameRight - geometry.paragraphRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.top - geometry.frameTop)).toBeLessThanOrEqual(1);
}

/** Pointer devices reveal by hover; touch reveals the caret's row and column. */
async function reveal(cell: Locator, info: TestInfo): Promise<void> {
  if (info.project.use.hasTouch === true) await caretIn(cell, info);
  else await cell.hover();
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
  for (const appearance of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: appearance });
    await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `${label}-${appearance}.png`) });
  }
  await page.emulateMedia({ colorScheme });
}

test("only the hovered table reveals its own row and column pills", async ({ page }, info) => {
  test.skip(info.project.use.hasTouch === true, "Hover requires a pointer device");
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
  await hovered.locator("tr").last().locator("td").nth(1).hover();
  await expect(page.locator(`.ub-table-controls[data-table-id="${hoveredId}"]`)).toBeVisible();
  await revealedRows(hovered, [3]);
  await revealedColumns(hovered, [2]);
  // A pointer device reveals by hover alone, never by the caret.
  await revealedRows(original, []);
  await revealedColumns(original, []);
  await pageFits(page);
});

test("hover reveals two quiet pills without moving the table and the pointer reaches them", async ({ page }, info) => {
  const colorScheme = "light";
  test.skip(info.project.use.hasTouch === true, "Hover requires a pointer device");
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
  await table.locator("tr").nth(1).locator("td").nth(1).hover();
  await expect(controls(page)).toBeVisible();
  await revealedRows(table, [2]);
  await revealedColumns(table, [2]);
  await onlyPills(table);
  await rowBorder(table, 2);
  await columnMenuBorder(table, 2);
  await controlsDoNotOverlap(table);
  await capture(page, info, "table-pills", colorScheme);
  expect(await table.locator("th, td").evaluateAll((cells) => cells.map((cell) => {
    const box = cell.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }))).toEqual(before);

  const target = button(page, "Row 2 actions");
  const box = await target.boundingBox();
  if (box === null) throw new Error("e2e: row pill has no geometry");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 30 });
  await revealedRows(table, [2]);
  await hitTarget(target);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole("menuitem")).toHaveText(["Insert row above", "Insert row below", "Move row up", "Move row down", "Delete row"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(target).toBeFocused();
  await pageFits(page);
});

test("column hover reaches its top pill and focus and open menus keep it revealed", { tag: "@webkit" }, async ({ page }, info) => {
  const colorScheme = "light";
  test.skip(info.project.use.hasTouch === true, "Hover requires a pointer device");
  await page.emulateMedia({ colorScheme });
  const table = await openTable(page);
  await caretIn(table.locator("tr").nth(1).locator("td").first(), info);
  await page.mouse.move(0, 0);
  await revealedColumns(table, []);
  await table.locator("tr").last().locator("td").nth(1).hover();
  await revealedColumns(table, [2]);
  await caretIn(editor(page).locator(":scope > p").first(), info);
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
  const before = await table.locator("th, td").evaluateAll((cells) => cells.map((cell) => {
    const box = cell.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  await table.locator("tr").nth(1).locator("td").nth(1).hover();
  await revealedColumns(table, [2]);
  await columnMenuBorder(table, 2);
  await controlsDoNotOverlap(table);
  expect(await table.locator("th, td").evaluateAll((cells) => cells.map((cell) => {
    const box = cell.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }))).toEqual(before);
  const trigger = button(page, "Column 2 actions");
  const bounds = await trigger.boundingBox();
  if (bounds === null) throw new Error("e2e: column pill has no geometry");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 30 });
  await revealedColumns(table, [2]);
  await hitTarget(trigger);
  await trigger.click();
  await expect(page.getByRole("menuitem")).toHaveText(["Insert column left", "Insert column right", "Move column left", "Move column right", "Delete column"]);
  await page.getByRole("menu").hover();
  await page.mouse.move(0, 0);
  await revealedColumns(table, [2]);
  await capture(page, info, "table-column-menu", colorScheme);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await revealedColumns(table, [2]);
  await expect(table.locator("th")).toHaveCount(3);
  await pageFits(page);
});

test("touch reveals column menus without moving cells and reaches both wide-table edges", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const colorScheme = "light";
  const page = await touchPage(browser, info, 820);
  await page.emulateMedia({ colorScheme });
  const table = await openTable(page, true);
  await activateControl(editor(page).locator(":scope > p").first(), { touch: true });
  const before = await table.locator("th").evaluateAll((cells) => cells.map((cell) => {
    const box = cell.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  await activateControl(table.locator("th").first(), { touch: true });
  await revealedColumns(table, [1]);
  await minimumTargets(button(page, "Column 1 actions"));
  await columnMenuBorder(table, 1);
  await controlsDoNotOverlap(table);
  await fullyTappable(button(page, "Column 1 actions"));
  expect(await table.locator("th").evaluateAll((cells) => cells.map((cell) => {
    const box = cell.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }))).toEqual(before);
  await button(page, "Column 1 actions").tap();
  await minimumTargets(page.getByRole("menuitem"));
  await expect(page.getByRole("menuitem")).toHaveText(["Insert column left", "Insert column right", "Move column left", "Move column right", "Delete column"]);
  await expect(page.getByRole("menuitem", { name: "Move column left", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Move column right", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  const wrapper = table.locator("..");
  await wrapper.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await activateControl(table.locator("th").last(), { touch: true });
  await revealedColumns(table, [8]);
  await columnMenuBorder(table, 8);
  await controlsDoNotOverlap(table);
  await fullyTappable(button(page, "Column 8 actions"));
  await capture(page, info, "table-column-touch", colorScheme);
  await button(page, "Column 8 actions").tap();
  await page.getByRole("menuitem", { name: "Delete column", exact: true }).tap();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(table.locator("th")).toHaveText(["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh"]);
  await expect(table.locator("td")).toHaveCount(0);
  await pageFits(page);
});

test("column moves swap every row, focus the moved column and each undo separately", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page);
  const headers = ["First", "Middle", "Last"];
  const cells = ["left one", "target one", "right one", "left two", "target two", "right two"];
  for (const [index, text] of [...headers, ...cells].entries()) {
    await caretIn(table.locator("th, td").nth(index), info);
    await page.keyboard.insertText(text);
  }
  await caretIn(table.locator("td").nth(1), info);
  await activate(button(page, "Column 2 actions"), info);
  await expect(page.getByRole("menuitem")).toHaveText(["Insert column left", "Insert column right", "Move column left", "Move column right", "Delete column"]);
  await expect(page.getByRole("menuitem", { name: "Move column left", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Move column right", exact: true })).toBeEnabled();
  await activate(page.getByRole("menuitem", { name: "Move column left", exact: true }), info);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(table.locator("th")).toHaveText(["Middle", "First", "Last"]);
  await expect(table.locator("td")).toHaveText(["target one", "left one", "right one", "target two", "left two", "right two"]);
  await expect(table.locator("tr").first().locator("td")).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => table.locator("th").first().evaluate((cell) => cell.contains(document.getSelection()?.anchorNode ?? null))).toBe(true);

  await reveal(table.locator("th").first(), info);
  await activate(button(page, "Column 1 actions"), info);
  await expect(page.getByRole("menuitem", { name: "Move column left", exact: true })).toBeDisabled();
  await expect.poll(() => page.getByRole("menu").evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
  await page.keyboard.press("Home");
  for (let step = 0; step < 5; step += 1) {
    if (await page.getByRole("menuitem", { name: "Move column right", exact: true }).evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(page.getByRole("menuitem", { name: "Move column right", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(table.locator("th")).toHaveText(headers);
  await expect(table.locator("td")).toHaveText(cells);
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => table.locator("th").nth(1).evaluate((cell) => cell.contains(document.getSelection()?.anchorNode ?? null))).toBe(true);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(table.locator("th")).toHaveText(["Middle", "First", "Last"]);
  await expect(table.locator("td")).toHaveText(["target one", "left one", "right one", "target two", "left two", "right two"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(table.locator("th")).toHaveText(headers);
  await expect(table.locator("td")).toHaveText(cells);
  await caretIn(table.locator("td").nth(2), info);
  await activate(button(page, "Column 3 actions"), info);
  await expect(page.getByRole("menuitem", { name: "Move column left", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Move column right", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await pageFits(page);
});

test("column menus insert columns beside their own column", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page);
  for (const [index, text] of ["A", "B", "C"].entries()) {
    await caretIn(table.locator("th").nth(index), info);
    await page.keyboard.insertText(text);
  }
  await caretIn(table.locator("td").nth(1), info);
  await activate(button(page, "Column 2 actions"), info);
  await activate(page.getByRole("menuitem", { name: "Insert column left", exact: true }), info);
  await expect(table.locator("th")).toHaveText(["A", "", "B", "C"]);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveCount(4);
  await reveal(table.locator("th").nth(2), info);
  await activate(button(page, "Column 3 actions"), info);
  await activate(page.getByRole("menuitem", { name: "Insert column right", exact: true }), info);
  await expect(table.locator("th")).toHaveText(["A", "", "B", "", "C"]);
  await expect(table.locator("tr").last().locator("td")).toHaveCount(5);
  await expect(table.locator("tr").first().locator("td")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(table.locator("th")).toHaveText(["A", "", "B", "C"]);
});

test("pointer hover alone reveals rows while hidden pills pass input to cells", { tag: "@webkit" }, async ({ page }, info) => {
  test.skip(info.project.use.hasTouch === true, "Hover requires a pointer device");
  const table = await openTable(page);
  await caretIn(table.locator("tr").nth(1).locator("td").first(), info);
  await page.mouse.move(0, 0);
  await revealedRows(table, []);
  await revealedColumns(table, []);
  for (const name of ["Row 1 actions", "Row 2 actions", "Column 1 actions"]) {
    const hidden = button(page, name);
    expect(await hidden.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      // The part of the hidden target inside the table, past its border.
      const hit = document.elementFromPoint(bounds.x + bounds.width * 3 / 4, bounds.y + bounds.height * 3 / 4);
      return getComputedStyle(element).pointerEvents === "none" && hit !== null && hit.closest("th, td") !== null && hit.closest(".ub-table") !== null;
    })).toBe(true);
  }
  await table.locator("tr").last().locator("td").first().hover();
  await revealedRows(table, [3]);
  await table.locator("tr").first().locator("th").first().hover();
  await revealedRows(table, [1]);
  await page.mouse.move(0, 0);
  await revealedRows(table, []);
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

test("hover reaches the row pill, whose menu inserts and deletes its own row", { tag: "@webkit" }, async ({ page }, info) => {
  const colorScheme = "light";
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
  const rowMenu = button(page, "Row 2 actions");
  const menuBox = await rowMenu.boundingBox();
  if (menuBox === null) throw new Error("e2e: row pill has no geometry");
  await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2, { steps: 30 });
  await revealedRows(table, [2]);
  await hitTarget(rowMenu);
  await page.mouse.down();
  await page.mouse.up();
  await page.getByRole("menuitem", { name: "Insert row below", exact: true }).click();
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(table.locator("tr").nth(1)).toContainText("Target row");
  await expect(table.locator("tr").nth(2).locator("td")).toHaveText(["", "", ""]);
  await expect(table.locator("tr").last()).toContainText("Keep last row");

  await caretIn(paragraph, info);
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
  await table.locator("tr").nth(1).locator("td").first().hover();
  await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2, { steps: 30 });
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

test("row menus target their row by pill and right click and protect the header", { tag: "@webkit" }, async ({ page }, info) => {
  const colorScheme = "light";
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

  await caretIn(table.locator("tr").nth(2).locator("td").first(), info);
  await activate(button(page, "Row 3 actions"), info);
  await expect.poll(() => page.getByRole("menu").evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(table).not.toContainText("Target row");
  await expect(table.locator("tr").last()).toContainText("Keep last row");

  await caretIn(table.locator("th").first(), info);
  await activate(button(page, "Row 1 actions"), info);
  await expect(page.getByRole("menuitem", { name: "Insert row above", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Insert row below", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(button(page, "Row 1 actions")).toBeFocused();
  await pageFits(page);
});

test("right click opens one menu for its cell's row and column", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page);
  for (const [index, text] of ["A", "B", "C", "a1", "b1", "c1", "a2", "b2", "c2"].entries()) {
    await caretIn(table.locator("th, td").nth(index), info);
    await page.keyboard.insertText(text);
  }
  await table.locator("tr").nth(1).locator("td").nth(1).click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText([
    "Insert row above", "Insert row below", "Insert column left", "Insert column right",
    "Move row up", "Move row down", "Move column left", "Move column right", "Delete row", "Delete column",
  ]);
  await expect(page.getByRole("menuitem", { name: "Move row up", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Move row down", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Move column left", exact: true })).toBeEnabled();
  await activate(page.getByRole("menuitem", { name: "Move column right", exact: true }), info);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(table.locator("th")).toHaveText(["A", "C", "B"]);
  await expect(table.locator("tr").nth(2).locator("td")).toHaveText(["a2", "c2", "b2"]);
  await expect(editor(page)).toBeFocused();

  await table.locator("tr").nth(2).locator("td").nth(2).click({ button: "right" });
  await activate(page.getByRole("menuitem", { name: "Delete column", exact: true }), info);
  await expect(table.locator("th")).toHaveText(["A", "C"]);
  await table.locator("th").first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Insert row above", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Move column left", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await expect(table.locator("tr")).toHaveCount(3);

  // The keyboard's menu key targets the editor and opens the caret cell's menu.
  await caretIn(table.locator("tr").nth(1).locator("td").first(), info);
  await editor(page).evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await activate(page.getByRole("menuitem", { name: "Delete row", exact: true }), info);
  await expect(table.locator("tr")).toHaveCount(2);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveText(["a2", "c2"]);
});

test("header-only wide tables keep pills on their borders through scrolling and retain the only header row", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page, true);
  const wrapper = table.locator("..");
  await expect.poll(() => wrapper.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await activate(table.locator("th").first(), info);
  await activate(button(page, "Column 1 actions"), info);
  await activate(page.getByRole("menuitem", { name: "Insert column left", exact: true }), info);
  await expect(table.locator("th")).toHaveCount(9);
  await expect(table.locator("td")).toHaveCount(0);
  await expect(table.locator("th").nth(1)).toHaveText("First");

  await wrapper.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await reveal(table.locator("th").last(), info);
  await revealedRows(table, [1]);
  await revealedColumns(table, [9]);
  await rowBorder(table, 1);
  await columnMenuBorder(table, 9);
  await controlsDoNotOverlap(table);
  await hitTarget(button(page, "Row 1 actions"));
  if (info.project.use.hasTouch === true) await fullyTappable(button(page, "Column 9 actions"));
  await hitTarget(button(page, "Column 9 actions"));
  await pageFits(page);
  await activate(button(page, "Column 9 actions"), info);
  await activate(page.getByRole("menuitem", { name: "Insert column right", exact: true }), info);
  await expect(table.locator("th")).toHaveCount(10);
  await expect(table.locator("td")).toHaveCount(0);
  await expect(table.locator("th").nth(8)).toHaveText("Last");
  await reveal(table.locator("th").last(), info);
  await activate(button(page, "Row 1 actions"), info);
  await activate(page.getByRole("menuitem", { name: "Insert row below", exact: true }), info);
  await expect(table.locator("tr")).toHaveCount(2);
  await expect(table.locator("tr").last().locator("td")).toHaveCount(10);
  await expect(table.locator("th")).toHaveCount(10);
  await pageFits(page);
});

test("touch exposes 44px pills for the caret row and column without hover", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await touchPage(browser, info);
  const table = await openTable(page);
  await table.locator("tr").nth(1).locator("td").first().tap({ position: { x: 60, y: 22 } });
  await expect(controls(page)).toBeVisible();
  await revealedRows(table, [2]);
  await revealedColumns(table, [1]);
  await onlyPills(table);
  await minimumTargets(button(page, "Row 2 actions"));
  await minimumTargets(button(page, "Column 1 actions"));
  await compactTable(table);
  await rowBorder(table, 2);
  await columnMenuBorder(table, 1);
  await controlsDoNotOverlap(table);
  await fullyTappable(button(page, "Row 2 actions"));
  await fullyTappable(button(page, "Column 1 actions"));
  await pageFits(page);
  await table.locator("..").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await rowBorder(table, 2);
  await fullyTappable(button(page, "Row 2 actions"));
  await pageFits(page);
  await table.locator("..").evaluate((element) => { element.scrollLeft = 0; });
  await button(page, "Row 2 actions").tap();
  await minimumTargets(page.getByRole("menuitem"));
  await page.getByRole("menuitem", { name: "Insert row below", exact: true }).tap();
  await expect(table.locator("tr")).toHaveCount(4);
  await table.locator("tr").nth(1).locator("td").first().tap({ position: { x: 60, y: 22 } });
  await button(page, "Row 2 actions").tap();
  const deletion = page.getByRole("menuitem", { name: "Delete row", exact: true });
  await expect(deletion).toBeVisible();
  await deletion.tap();
  await expect(table.locator("tr")).toHaveCount(3);
  // The 44px top-border target covers the top of a short touch header.
  await table.locator("th").first().tap({ position: { x: 30, y: 30 } });
  await revealedRows(table, [1]);
  await controlsDoNotOverlap(table);
  await button(page, "Column 1 actions").tap();
  await page.getByRole("menuitem", { name: "Insert column right", exact: true }).tap();
  await expect(table.locator("th")).toHaveCount(4);
  await expect(table.locator("tr").last().locator("td")).toHaveCount(4);
  await pageFits(page);
});

test("touch sizing survives stationary compatibility hover but real mouse movement changes mode", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await touchPage(browser, info);
  const table = await openTable(page);
  const point = await table.locator("tr").nth(1).locator("td").first().evaluate(element => {
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 4), y: Math.round(box.top + box.height / 2) };
  });
  await page.touchscreen.tap(point.x, point.y);
  const row = button(page, "Row 2 actions");
  await expect(row).toHaveCSS("width", "44px");
  await page.evaluate(({ x, y }) => {
    document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerType: "mouse", clientX: x, clientY: y, movementX: 0, movementY: 0,
    }));
  }, point);
  await expect(controls(page)).toHaveAttribute("data-touch", "true");
  await expect(row).toHaveCSS("width", "44px");
  await page.mouse.move(point.x + 10, point.y);
  await expect(controls(page)).toHaveAttribute("data-touch", "false");
  await expect(row).toHaveCSS("width", "12px");
});

test("archiving hides structural controls and right-click paths cannot write", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page);
  await activate(table.locator("td").first(), info);
  await page.keyboard.insertText("Retained cell");
  await activate(page.getByRole("button", { name: "Document actions", exact: true }), info);
  await activate(page.getByRole("menuitem", { name: "Archive document", exact: true }), info);
  await activate(page.getByRole("alertdialog").getByRole("button", { name: "Archive", exact: true }), info);
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await activate(table.locator("td").first(), info);
  await table.locator("td").first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete column", exact: true })).toHaveCount(0);
  await expect(button(page, "Column 1 actions")).toHaveCount(0);
  await expect(controls(page)).toHaveCount(0);
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table.locator("th")).toHaveCount(3);
  await expect(table.locator("td").first()).toHaveText("Retained cell");
});
