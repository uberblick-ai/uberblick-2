/**
 * The prose selection toolbar in a real browser.
 *
 * Component tests own document outcomes and undo. This file keeps only what
 * needs layout or native event plumbing: a dragged selection, viewport-aware
 * placement and scrolling, pointer/keyboard/touch activation, IME suspension,
 * and the two fields returning to the same range on cancel.
 */

import { expect, test } from "@playwright/test";
import { createDoc, setupHarness } from "./app-helpers.js";
import type { Locator, Page } from "@playwright/test";
import { placeCaret } from "./harness.js";

const { harness, trackContext } = setupHarness();

async function openDoc(page: Page, text: string): Promise<void> {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await createDoc(page, "Selection toolbar");
  await placeCaret(page);
  await page.keyboard.insertText(text);
}

/** Drag across one painted line, through the pointer path a reader uses. */
async function dragSelection(
  page: Page,
  block: Locator,
  y?: number,
): Promise<string> {
  const box = await block.boundingBox();
  if (box === null) throw new Error("e2e: prose block has no box");
  const lineHeight = await block.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).lineHeight),
  );
  const baseline = y ?? box.y + Math.min(box.height, lineHeight) / 2;
  await page.mouse.move(box.x + 8, baseline);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(170, box.width - 8), baseline, {
    steps: 12,
  });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.length).toBeGreaterThan(0);
  return selected;
}

async function selectionRect(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    };
  });
}

test("a human selection keeps its range through pointer, keyboard, link and comment actions", async ({
  page,
}) => {
  await openDoc(page, "format this sentence without losing the selected words");
  const paragraph = page.locator(".ub-paragraph").first();
  const selected = await dragSelection(page, paragraph);
  const toolbar = page.getByRole("toolbar", {
    name: "Text formatting and comment",
  });
  await expect(toolbar).toBeVisible();

  const selection = await selectionRect(page);
  const toolbarBox = await toolbar.boundingBox();
  if (selection === null || toolbarBox === null) {
    throw new Error("e2e: selection toolbar has no measurable geometry");
  }
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(selection.top);
  expect(toolbarBox.x).toBeGreaterThanOrEqual(0);
  expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );

  // Pointer activation is selection-preserving because its down event never
  // moves focus into the chrome.
  await page.getByRole("button", { name: "Bold" }).click();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(
    selected,
  );
  await expect(paragraph.locator("strong")).toContainText(selected);

  // The keyboard is allowed to focus a control; the editor's stored range is
  // still the command target.
  const italic = page.getByRole("button", { name: "Italic" });
  await italic.focus();
  await italic.press("Enter");
  await expect(paragraph.locator("em")).toContainText(selected);

  await page.getByRole("button", { name: "External link" }).click();
  await page.getByLabel("External link URL").fill("https://example.com/cancelled");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(toolbar).toBeVisible();
  await expect(paragraph.locator("a.ub-link")).toHaveCount(0);

  await page.getByRole("button", { name: "Comment" }).click();
  await page.getByPlaceholder(/Comment as/).fill("cancel this too");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(toolbar).toBeVisible();
  await expect(page.locator(".ub-thread-card")).toHaveCount(0);

  // The range survived both focused fields: another command still lands on
  // exactly those words.
  await page.getByRole("button", { name: "Strikethrough" }).click();
  await expect(paragraph.locator("s")).toContainText(selected);

  // Read-only is a live transition, not merely an initial condition.
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page.getByRole("alertdialog").getByRole("button", {
    name: "Archive document",
  }).click();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(toolbar).toHaveCount(0);
});

test("the measured toolbar flips below at the viewport edge and follows scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 360 });
  await openDoc(page, "scrolling prose ".repeat(350));
  await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
  const pane = page.locator(".ub-pane");
  const paragraph = page.locator(".ub-paragraph").first();
  await pane.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 3);
  });
  const paneBox = await pane.boundingBox();
  if (paneBox === null) throw new Error("e2e: editor pane has no box");
  await dragSelection(page, paragraph, paneBox.y + 18);

  const card = page.locator(".ub-selection-menu");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-placement", "below");
  const selected = await selectionRect(page);
  const before = await card.boundingBox();
  if (selected === null || before === null) {
    throw new Error("e2e: below-placement geometry is unavailable");
  }
  expect(before.y).toBeGreaterThanOrEqual(selected.bottom);
  expect(before.x).toBeGreaterThanOrEqual(paneBox.x);
  expect(before.x + before.width).toBeLessThanOrEqual(paneBox.x + paneBox.width);
  expect(before.y + before.height).toBeLessThanOrEqual(paneBox.y + paneBox.height);

  await pane.evaluate((element) => {
    element.scrollTop += 8;
  });
  await expect
    .poll(async () => (await card.boundingBox())?.y ?? before.y)
    .toBeLessThan(before.y);
});

test("touch activation preserves the range and IME composition suspends the chrome", async ({
  browser,
}) => {
  const context = await browser.newContext({ hasTouch: true });
  trackContext(context);
  const page = await context.newPage();
  await openDoc(page, "touch keeps this range");
  const editor = page.locator(".ub-editor .ProseMirror");
  await placeCaret(page);
  for (let character = 0; character < 10; character += 1) {
    await page.keyboard.press("Shift+ArrowLeft");
  }
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).not.toBe("");

  await page.getByRole("button", { name: "Bold" }).tap();
  await expect(page.locator(".ub-paragraph strong")).toContainText(selected);

  await editor.dispatchEvent("compositionstart", { data: "へ" });
  await expect(page.locator(".ub-selection-menu")).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(
    selected,
  );
  await editor.dispatchEvent("compositionend", { data: "へ" });
  await expect(page.locator(".ub-selection-menu")).toBeVisible();
});
