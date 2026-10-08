/** Cell selection input and placement in the real editor. Native handles and
 * real IME candidate menus remain in device-input.md. */
import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { createDoc, docTitle, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, trackContext } = setupHarness();

function popup(page: Page): Locator {
  return page.locator('[data-slot="selection-composer"]');
}

function toolbar(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Text formatting and comment", exact: true });
}

async function openTable(page: Page, wide = false): Promise<Locator> {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, docTitle("Cell formatting"));
  await placeCaret(page);
  await page.keyboard.type("Above the table");
  await page.keyboard.press("Enter");
  // WebKit can paint the new paragraph before its native caret catches up.
  // Start the table fixture in that empty paragraph explicitly.
  const empty = page.locator(".ub-editor .ProseMirror > p").last();
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
  if (wide) {
    await page.keyboard.type("| First column | Second column | Alpha words suffix | Fourth column | Fifth column | Sixth column | Seventh column | Eighth column |");
    await page.keyboard.press("Enter");
    await page.keyboard.type("| --- | --- | --- | --- | --- | --- | --- | --- |");
  } else {
    await page.keyboard.type("/table");
    await page.keyboard.press("Enter");
  }
  const table = page.locator(".ub-table");
  await expect(table).toBeVisible();
  if (!wide) {
    await table.locator("th").first().click();
    await page.keyboard.insertText("Alpha words suffix");
    await page.keyboard.press("Tab");
    await page.keyboard.insertText("Beta words suffix");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.insertText("Body words suffix");
    await expect(table.locator("td").first()).toHaveText("Body words suffix");
  }
  await expect(popup(page)).toHaveCount(0);
  return table;
}

/** Native range setup is also how the existing touch proofs stand in for
 * selection handles. Browser selectionchange and painted geometry stay real. */
async function selectCell(
  cell: Locator,
  start: number,
  end: number,
  input?: "mouse" | "touch",
  endCell?: Locator,
): Promise<void> {
  const endIndex = endCell === undefined ? null : await endCell.evaluate((element) => {
    const table = element.closest("table");
    return Array.from(table?.querySelectorAll("th, td") ?? []).indexOf(element);
  });
  await cell.locator("..").evaluate((element) => {
    const root = element.closest(".ProseMirror");
    if (!(root instanceof HTMLElement)) throw new Error("e2e: missing editor");
    root.focus();
  });
  // Let ProseMirror's scheduled focus-to-DOM sync finish before setting the
  // native range; otherwise it can replace the test's selection on WebKit.
  await cell.page().evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  await cell.evaluate((element, { start, end, input, endIndex }) => {
    if (input !== undefined) element.dispatchEvent(new PointerEvent("pointerdown", {
      pointerType: input, bubbles: true, pointerId: 1,
    }));
    const position = (block: Element, offset: number): [Node, number] => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (offset <= length) return [node, offset];
        offset -= length;
      }
      throw new Error("e2e: selection outside cell text");
    };
    const last = endIndex === null ? element : element.closest("table")?.querySelectorAll("th, td")[endIndex];
    if (last === undefined) throw new Error("e2e: missing selection end cell");
    const range = document.createRange();
    range.setStart(...position(element, start));
    range.setEnd(...position(last, end));
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, input, endIndex });
  await cell.page().evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function activate(control: Locator, info: TestInfo): Promise<void> {
  if (info.project.use.hasTouch === true) await control.tap();
  else await control.click();
}

test("header and body selections offer formatting then Comment and keep the selected range through controls", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page);
  const first = table.locator("th").first();
  await selectCell(first, 0, 0);
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Shift+ArrowRight");
    // Native selectionchange imports the range into ProseMirror separately
    // from keydown. Let it paint, and check each actual keyboard step before
    // another key can read the preceding range.
    await expect.poll(() => page.evaluate(() => new Promise<string>((resolve) => {
      requestAnimationFrame(() => resolve(document.getSelection()?.toString() ?? ""));
    }))).toBe("Alpha".slice(0, index + 1));
  }
  await expect(toolbar(page)).toBeVisible();
  await expect(toolbar(page).getByRole("button")).toHaveCount(6);
  await expect(toolbar(page).getByRole("button").last()).toHaveText("Comment");

  // Each shortcut uses the editor's real keymap and updates the same popup.
  for (const [key, label, mark] of [
    ["ControlOrMeta+b", "Bold", "strong"],
    ["ControlOrMeta+i", "Italic", "em"],
    ["ControlOrMeta+Shift+s", "Strikethrough", "s"],
    ["ControlOrMeta+e", "Inline code", "code"],
  ] as const) {
    await page.keyboard.press(key);
    await expect(toolbar(page).getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(first.locator(mark)).toHaveText("Alpha");
  }
  await activate(toolbar(page).getByRole("button", { name: "Bold", exact: true }), info);
  await expect(first.locator("strong")).toHaveCount(0);
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Alpha");

  const strike = toolbar(page).getByRole("button", { name: "Strikethrough", exact: true });
  await strike.focus();
  await strike.press("Enter");
  await expect(first.locator("s")).toHaveCount(0);
  await activate(toolbar(page).getByRole("button", { name: "External link", exact: true }), info);
  await page.getByLabel("External link URL").fill("https://example.com/cell");
  await activate(popup(page).getByRole("button", { name: "Cancel", exact: true }), info);
  await expect(toolbar(page)).toBeVisible();
  await expect(first.locator("a.ub-link")).toHaveCount(0);
  await activate(toolbar(page).getByRole("button", { name: "External link", exact: true }), info);
  await page.getByLabel("External link URL").fill("https://example.com/cell");
  await activate(popup(page).getByRole("button", { name: "Apply", exact: true }), info);
  await expect(first.locator("a.ub-link")).toHaveText("Alpha");
  await expect(first.locator("a.ub-link")).toHaveAttribute("href", "https://example.com/cell");
  await expect(first).toHaveText("Alpha words suffix");
  await expect(table.locator("th").nth(1)).toHaveText("Beta words suffix");

  await selectCell(first, 0, 11, "mouse");
  await expect(toolbar(page).getByRole("button", { name: "Italic", exact: true })).toHaveAttribute("aria-pressed", "mixed");
  const body = table.locator("td").first();
  await selectCell(body, 0, 4, "mouse");
  await activate(toolbar(page).getByRole("button", { name: "Bold", exact: true }), info);
  await expect(body.locator("strong")).toHaveText("Body");
  await expect(body).toHaveText("Body words suffix");

  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive document", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await selectCell(body, 0, 4, "mouse");
  await expect(popup(page)).toHaveCount(0);
});

test("Tab selection is navigation, triple click selects one cell, and cross-cell gestures offer clamped Comment", { tag: "@webkit" }, async ({ page }, info) => {
  const table = await openTable(page);
  const first = table.locator("th").first();
  const second = table.locator("th").nth(1);
  await selectCell(first, 0, 0);
  await expect(popup(page)).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(popup(page)).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Beta words suffix");
  await expect(popup(page)).toHaveCount(0);
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Alpha words suffix");
  await expect(popup(page)).toHaveCount(0);
  await page.keyboard.insertText("Alpha words suffix");
  await expect(popup(page)).toHaveCount(0);

  if (info.project.use.hasTouch !== true) {
    const paragraph = first.locator("p");
    const bounds = await paragraph.boundingBox();
    if (bounds === null) throw new Error("e2e: missing cell paragraph geometry");
    const lineHeight = await paragraph.evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
    const y = bounds.y + Math.min(bounds.height, lineHeight) / 2;
    await page.mouse.move(bounds.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + Math.min(90, bounds.width - 1), y, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
    await expect(toolbar(page)).toBeVisible();
    await selectCell(first, 0, 0);
    await paragraph.dblclick({ position: { x: 20, y: Math.min(bounds.height, lineHeight) / 2 } });
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Alpha");
    await expect(toolbar(page)).toBeVisible();

    await selectCell(first, "Alpha words suffix".length, "Alpha words suffix".length);
    await page.keyboard.press("Shift+Home");
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Alpha words suffix");
    await expect(toolbar(page)).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(popup(page)).toHaveCount(0);
    await selectCell(first, 0, 0);
    await page.keyboard.press("Shift+End");
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Alpha words suffix");
    await expect(toolbar(page)).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(popup(page)).toHaveCount(0);
  }

  // ProseMirror groups nearby mouse downs within 500 ms, even across the
  // keyboard setup above. A caret click in another row starts a fresh gesture.
  await table.locator("td").first().click();
  await expect(popup(page)).toHaveCount(0);
  await first.locator("p").click({ clickCount: 3 });
  await expect(table.locator(".selectedCell")).toHaveCount(1);
  await expect(toolbar(page)).toBeVisible();
  await toolbar(page).getByRole("button", { name: "Bold", exact: true }).click();
  await expect(first.locator("strong")).toHaveText("Alpha words suffix");
  await selectCell(first, "Alpha words suffix".length, "Alpha words suffix".length);
  await page.keyboard.press("Shift+ArrowRight");
  await expect(table.locator(".selectedCell")).toHaveCount(2);
  await expect(toolbar(page)).toHaveCount(0);
  await expect(popup(page).getByRole("button", { name: "Comment", exact: true })).toBeVisible();
  await activate(popup(page).getByRole("button", { name: "Comment", exact: true }), info);
  await expect(popup(page).locator('[data-slot="selection-clamp"]')).toHaveText("first cell only");
  await expect(popup(page).locator('[data-slot="selection-excerpt"]')).toHaveText("Alpha words suffix");
  await page.keyboard.press("Escape");

  // Native touch handles can leave a TextSelection spanning two cells because
  // the table repair appendTransaction is intentionally disabled.
  await selectCell(first, 2, 4, "touch", second);
  await expect(toolbar(page)).toHaveCount(0);
  await activate(popup(page).getByRole("button", { name: "Comment", exact: true }), info);
  await expect(popup(page).locator('[data-slot="selection-clamp"]')).toHaveText("first cell only");
  await expect(popup(page).locator('[data-slot="selection-excerpt"]')).toHaveText("pha words suffix");
  await popup(page).locator("textarea").fill("Clamped cell discussion");
  await activate(popup(page).getByRole("button", { name: "Comment", exact: true }), info);
  await expect(first.locator('[data-comment-thread]')).toHaveText("pha words suffix");
  await expect(second.locator('[data-comment-thread]')).toHaveCount(0);
  await expect(page.locator(".ub-thread-card")).toContainText("pha words suffix");
  await expect(page.locator(".ub-thread-card")).toContainText("Clamped cell discussion");
  await expect(page.locator(".ub-thread-card .ub-thread")).toHaveAttribute("aria-current", "true");
  const closeThreads = page.getByRole("button", { name: "Close threads", exact: true });
  if (await closeThreads.isVisible()) await activate(closeThreads, info);
  await selectCell(first, 0, 5, "mouse");
  await expect(toolbar(page)).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(popup(page)).toHaveCount(0);
});

test("touch cell ranges keep their text when tapped, suspend during IME and dismiss independently per cell", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const context = trackContext(await browser.newContext(info.project.name === "chromium"
    ? { hasTouch: true, viewport: { width: 390, height: 844 } }
    : {}));
  const page = await context.newPage();
  const table = await openTable(page);
  const first = table.locator("th").first();
  await selectCell(first, 0, 5, "touch");
  await expect(toolbar(page)).toBeVisible();
  await expect(popup(page)).toHaveAttribute("data-input", "touch");
  const rangeBottom = await page.evaluate(() => document.getSelection()?.getRangeAt(0).getBoundingClientRect().bottom);
  const bounds = await popup(page).boundingBox();
  if (rangeBottom === undefined || bounds === null) throw new Error("e2e: touch range has no geometry");
  expect(bounds.y).toBeGreaterThanOrEqual(rangeBottom);
  await toolbar(page).getByRole("button", { name: "Bold", exact: true }).tap();
  await expect(first.locator("strong")).toHaveText("Alpha");
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Alpha");

  const editor = page.locator(".ub-editor .ProseMirror");
  await editor.dispatchEvent("compositionstart", { data: "へ" });
  await expect(popup(page)).toHaveCount(0);
  await editor.dispatchEvent("compositionend", { data: "へ" });
  await expect(toolbar(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Alpha");
  await selectCell(table.locator("th").nth(1), 0, 5, "touch");
  await expect(toolbar(page)).toBeVisible();
  await expect(toolbar(page).getByRole("button", { name: "Bold", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("a wide table moves the popup with the text and hides it beyond its own clip", { tag: "@webkit" }, async ({ page }) => {
  const table = await openTable(page, true);
  const cell = table.locator("th").nth(2);
  const wrapper = table.locator("..");
  await expect.poll(() => wrapper.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await wrapper.evaluate((element) => {
    const cell = element.querySelectorAll("th")[2];
    if (cell === undefined) throw new Error("e2e: missing wide-table cell");
    const bounds = element.getBoundingClientRect();
    element.scrollLeft += cell.getBoundingClientRect().left - (bounds.left + bounds.width / 2);
  });
  await selectCell(cell, 0, 5, "mouse");
  await expect(toolbar(page)).toBeVisible();
  const before = await popup(page).boundingBox();
  if (before === null) throw new Error("e2e: missing wide-table popup");
  await wrapper.evaluate((element) => { element.scrollLeft += 24; });
  await expect.poll(async () => (await popup(page).boundingBox())?.x ?? 0).toBeCloseTo(before.x - 24, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Use the first column for the clipping proof: on a desktop an eight-column
  // table can overflow by less than the selected third column's offset.
  await wrapper.evaluate((element) => { element.scrollLeft = 0; });
  await selectCell(table.locator("th").first(), 0, 5, "mouse");
  await toolbar(page).getByRole("button", { name: "External link", exact: true }).click();
  await expect(page.getByLabel("External link URL")).toBeFocused();
  await wrapper.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(popup(page)).toBeHidden();
  await wrapper.evaluate((element) => { element.scrollLeft = 0; });
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(toolbar(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
