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
  await activate(cell, info);
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
  const dimensions = await targets.evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  }));
  expect(dimensions.length).toBeGreaterThan(0);
  // WebKit reports a 44px menu item as 43.999969px at fractional portal offsets.
  // Allow only coordinate precision loss, well below a layout pixel fraction.
  for (const size of dimensions) {
    expect(size.width + 0.001).toBeGreaterThanOrEqual(44);
    expect(size.height + 0.001).toBeGreaterThanOrEqual(44);
  }
}

async function rowControlsAvoidCells(table: Locator): Promise<void> {
  const collisions = await table.evaluate((element) => {
    const wrapper = element.parentElement;
    const overlay = Array.from(document.querySelectorAll<HTMLElement>(".ub-table-controls"))
      .find((candidate) => candidate.dataset.tableId === element.id);
    if (wrapper === null || overlay === undefined) throw new Error("e2e: table controls are absent");
    const clip = wrapper.getBoundingClientRect();
    const cells = Array.from(element.querySelectorAll("th, td")).map((cell) => {
      const bounds = cell.getBoundingClientRect();
      return {
        left: Math.max(bounds.left, clip.left), right: Math.min(bounds.right, clip.right),
        top: Math.max(bounds.top, clip.top), bottom: Math.min(bounds.bottom, clip.bottom),
      };
    });
    return Array.from(overlay.querySelectorAll("button")).flatMap((control) => {
      const name = control.getAttribute("aria-label") ?? "";
      if (!/^(?:Row \d+ actions|Insert row after \d+)$/.test(name)) return [];
      const bounds = control.getBoundingClientRect();
      return cells.some((cell) => cell.right > cell.left && cell.bottom > cell.top &&
        Math.min(bounds.right, cell.right) - Math.max(bounds.left, cell.left) > 1 &&
        Math.min(bounds.bottom, cell.bottom) - Math.max(bounds.top, cell.top) > 1)
        ? [name] : [];
    });
  });
  expect(collisions).toEqual([]);
}

async function pageFits(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function capture(page: Page, info: TestInfo, label: string, colorScheme: "light" | "dark"): Promise<void> {
  if (info.project.name !== "chromium" || process.env.UB_AGENTS_SCRATCH === undefined) return;
  await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `${label}-${colorScheme}.png`) });
}

/** Native Tab from the insertion shortcut must reach the named button. */
async function tabTo(page: Page, name: string): Promise<void> {
  const target = button(page, name);
  for (let index = 0; index < 40; index += 1) {
    const focusedName = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
    expect(await target.count(), `Tab reached ${focusedName ?? "no element"} and lost the table controls`).toBe(1);
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
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
  await hovered.hover();
  await expect(controls(page)).toHaveCount(2);
  await expect(page.locator(`.ub-table-controls[data-table-id="${originalId}"]`)).toBeVisible();
  await expect(page.locator(`.ub-table-controls[data-table-id="${hoveredId}"]`)).toBeVisible();
  await pageFits(page);
});

for (const colorScheme of ["light", "dark"] as const) {
test(`hover reveals quiet controls without moving the table and the pointer reaches them — ${colorScheme}`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme });
  const table = await openTable(page);
  await editor(page).locator(":scope > p").first().click();
  await page.mouse.move(0, 0);
  await expect(controls(page)).toHaveCount(0);
  const before = await table.locator("th, td").evaluateAll((cells) => cells.map((cell) => {
    const box = cell.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  await table.hover();
  await expect(controls(page)).toBeVisible();
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
  expect(await target.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
  await page.mouse.down();
  await page.mouse.up();
  await expect(table.locator("th")).toHaveCount(4);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveCount(4);
  await expect(table.locator("tr").nth(2).locator("td")).toHaveCount(4);
  await pageFits(page);
});
}

for (const colorScheme of ["light", "dark"] as const) {
test(`hover alone reaches row insertion and row menus across their lanes — ${colorScheme}`, { tag: "@webkit" }, async ({ page }, info) => {
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
  const insertion = button(page, "Insert row after 2");
  const insertionBox = await insertion.boundingBox();
  if (insertionBox === null) throw new Error("e2e: row insertion control has no geometry");
  await page.mouse.move(insertionBox.x + insertionBox.width / 2, insertionBox.y + insertionBox.height / 2, { steps: 30 });
  await expect(insertion).toBeVisible();
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
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole("menu")).toBeVisible();
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
  await activate(table.locator("td").first(), info);
  await page.keyboard.press("Control+Alt+t");
  await expect(button(page, "Insert column before 1")).toBeFocused();
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

  await wrapper.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await activate(table.locator("th").last(), info);
  const lastColumn = button(page, "Insert column after 9");
  await expect(lastColumn).toBeVisible();
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
  await minimumTargets(controls(page).getByRole("button", { name: /^Insert (?:column|row)/ }));
  await minimumTargets(button(page, "Row 2 actions"));
  await rowControlsAvoidCells(table);
  await table.locator("..").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await rowControlsAvoidCells(table);
  await table.locator("..").evaluate((element) => { element.scrollLeft = 0; });
  await button(page, "Insert row after 2").tap();
  await expect(table.locator("tr")).toHaveCount(4);
  await table.locator("tr").nth(1).locator("td").first().tap();
  await button(page, "Row 2 actions").tap();
  const deletion = page.getByRole("menuitem", { name: "Delete row", exact: true });
  await expect(deletion).toBeVisible();
  await minimumTargets(page.getByRole("menuitem"));
  await deletion.tap();
  await expect(table.locator("tr")).toHaveCount(3);
  await table.locator("th").first().tap();
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
