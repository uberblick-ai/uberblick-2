/**
 * Editor-owned touch wiring and layout. Native range setup stands in for iOS's
 * selection handles; real device checks still owe the keyboard and edit menu.
 */
import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import { createDoc, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, trackContext } = setupHarness();

function editor(page: Page): Locator {
  return page.locator(".ub-editor .ProseMirror");
}
function card(page: Page): Locator {
  return page.locator('[data-slot="selection-composer"]');
}
function gutter(page: Page): Locator {
  return page.getByRole("button", { name: "Insert block below", includeHidden: true });
}

async function touchPage(browser: Browser, info: TestInfo): Promise<Page> {
  // Playwright's browser fixture supplies the project's context options. Keep
  // Chromium's existing synthetic touch proof; WebKit uses its actual device.
  const context = trackContext(await browser.newContext(info.project.name === "chromium"
    ? { hasTouch: true, viewport: { width: 390, height: 844 } }
    : {}));
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  return page;
}

async function openDoc(page: Page, paragraphs: string[]): Promise<void> {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, "touch editor");
  await placeCaret(page);
  for (const [index, text] of paragraphs.entries()) {
    if (index > 0) {
      await page.keyboard.press("Enter");
      if (page.context().browser()?.browserType().name() === "webkit") {
        await expect(editor(page).locator(":scope > p")).toHaveCount(index + 1);
      }
    }
    await page.keyboard.insertText(text);
  }
  await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
}

/** The real browser reports range geometry and selectionchange to ProseMirror. */
async function selectBlock(
  block: Locator,
  input: "touch" | "mouse" = "touch",
  offsets?: { start: number; end: number; endBlock?: number },
): Promise<void> {
  await block.evaluate((element, { pointerType, offsets }) => {
    const root = element.closest(".ProseMirror");
    if (!(root instanceof HTMLElement)) throw new Error("e2e: missing editor");
    root.focus();
    element.dispatchEvent(new PointerEvent("pointerdown", {
      pointerType, bubbles: true, pointerId: 1,
    }));
    const range = document.createRange();
    range.selectNodeContents(element);
    if (offsets !== undefined) {
      // Prose marks and source colouring can split text into nested nodes.
      const position = (block: Element, offset: number): [Node, number] => {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const length = node.textContent?.length ?? 0;
          if (offset <= length) return [node, offset];
          offset -= length;
        }
        throw new Error("e2e: selection offset outside block");
      };
      const endBlock = offsets.endBlock === undefined ? element : root.children[offsets.endBlock];
      if (endBlock === undefined) throw new Error("e2e: missing selection end block");
      range.setStart(...position(element, offsets.start));
      range.setEnd(...position(endBlock, offsets.end));
    }
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { pointerType: input, offsets });
  await selectionChanged(block.page());
}

/** WebKit delivers the native range's selectionchange after the setup task. */
async function selectionChanged(page: Page): Promise<void> {
  if (page.context().browser()?.browserType().name() === "webkit") {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

async function collapseToCaret(block: Locator): Promise<void> {
  await block.evaluate((element) => {
    const root = element.closest(".ProseMirror");
    if (!(root instanceof HTMLElement)) throw new Error("e2e: missing editor");
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await selectionChanged(block.page());
}

async function selectionBox(page: Page) {
  return page.evaluate(() => {
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0) throw new Error("e2e: missing selection");
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
}

async function insideVisibleArea(page: Page): Promise<void> {
  await expect(card(page)).toBeVisible();
  await expect.poll(async () => card(page).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    return rect.left >= left - 1 && rect.top >= top - 1 &&
      rect.right <= left + (viewport?.width ?? window.innerWidth) + 1 &&
      rect.bottom <= top + (viewport?.height ?? window.innerHeight) + 1;
  })).toBe(true);
}

async function minimumTargets(controls: Locator, size: number, square = false): Promise<void> {
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const bounds = await controls.nth(index).boundingBox();
    if (bounds === null) throw new Error("e2e: control has no box");
    expect(bounds.height).toBeGreaterThanOrEqual(size);
    if (square) expect(bounds.width).toBeGreaterThanOrEqual(size);
  }
}

test("a touch caret exposes a 44px gutter without moving prose, follows edits, and inserts by tap", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await touchPage(browser, info);
  await openDoc(page, ["first block", "second block"]);
  const first = editor(page).locator(":scope > p").first();
  const second = editor(page).locator(":scope > p").nth(1);
  const pane = page.locator(".ub-document-pane");
  await page.mouse.move(0, 0);
  // The first sync reading reveals the timestamp and can wrap the narrow
  // status row. Settle that chrome before measuring gutter-induced movement.
  await expect(page.locator(".ub-status .ub-last-updated")).toBeVisible();
  const proseBefore = await first.boundingBox();
  const scrollBefore = await pane.evaluate((element) => element.scrollWidth);

  await first.tap();
  await expect(gutter(page)).toHaveCSS("opacity", "1");
  // Touch press can reveal the previous caret before selectionchange arrives.
  // Verify this tap's block target before measuring the next tap's movement.
  await expect.poll(async () => (await gutter(page).boundingBox())?.y).toBe(proseBefore?.y);
  await minimumTargets(gutter(page), 44, true);
  expect(await first.boundingBox()).toEqual(proseBefore);
  const button = await gutter(page).boundingBox();
  if (button === null || proseBefore === null) throw new Error("e2e: missing gutter geometry");
  expect(button.x).toBeGreaterThanOrEqual(0);
  expect(button.x + button.width).toBeLessThanOrEqual(proseBefore.x);
  expect(await pane.evaluate((element) => element.scrollWidth)).toBe(scrollBefore);
  expect(await pane.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await second.tap();
  await expect.poll(async () => (await gutter(page).boundingBox())?.y ?? 0).toBeGreaterThan(button.y);
  const beforeEdit = await gutter(page).boundingBox();
  if (beforeEdit === null) throw new Error("e2e: missing caret gutter");

  // A peer edit moves the block while the local caret stays in it. No pointer
  // motion is available to reveal or repair a stale gutter anchor.
  const peer = await touchPage(browser, info);
  await peer.goto(page.url());
  const peerFirst = editor(peer).locator(":scope > p").first();
  await collapseToCaret(peerFirst);
  await peer.keyboard.insertText(" preceding prose".repeat(25));
  await expect(first).toContainText("preceding prose");
  await expect(gutter(page)).toHaveCSS("opacity", "1");
  await expect.poll(async () => (await gutter(page).boundingBox())?.y ?? 0).toBeGreaterThan(beforeEdit.y);
  const moved = await gutter(page).boundingBox();
  const active = await second.boundingBox();
  if (moved === null || active === null) throw new Error("e2e: missing moved caret block");
  expect(moved.y).toBeGreaterThanOrEqual(active.y - moved.height);
  expect(moved.y).toBeLessThan(active.y + active.height);

  await selectBlock(second);
  await expect(gutter(page)).toHaveCSS("opacity", "0");
  await second.tap();
  // A touch inside selected words can preserve the native range. The native
  // selection setup explicitly returns to a caret; the control still taps.
  await collapseToCaret(second);
  await expect(gutter(page)).toHaveCSS("opacity", "1");
  await gutter(page).tap();
  await expect(page.getByRole("listbox", { name: "Block types" })).toBeVisible();
  await page.getByRole("option", { name: "Quote", exact: true }).tap();
  await page.keyboard.insertText("inserted by touch");
  const blocks = editor(page).locator(":scope > *");
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(1)).toHaveText("second block");
  await expect(blocks.nth(2)).toHaveText("inserted by touch");

  // One iPad can alternate touch and trackpad. Compatibility mouse events
  // from a tap did not hide the touch +; a real pointer move restores hover.
  await first.hover();
  await expect(gutter(page)).toHaveCSS("opacity", "1");
  await minimumTargets(gutter(page), 24, true);
  await page.mouse.move(0, 0);
  await expect(gutter(page)).toHaveCSS("opacity", "0");
});

test("touch link Cancel and Apply and Comment keep the selected words as their write range", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await touchPage(browser, info);
  const text = "before selected words after";
  const selected = "selected words";
  await openDoc(page, [text]);
  const paragraph = editor(page).locator(":scope > p").first();
  await paragraph.tap();
  await selectBlock(paragraph, "touch", { start: 7, end: 21 });
  const link = page.getByRole("form", { name: "External link", exact: true });
  const url = page.getByRole("textbox", { name: "External link URL" });
  await page.getByRole("button", { name: "External link", exact: true }).tap();
  await expect(url).toBeFocused();
  await url.fill("https://example.com/cancelled");
  await link.getByRole("button", { name: "Cancel", exact: true }).tap();
  await expect(link).toHaveCount(0);
  await expect(paragraph.locator("a")).toHaveCount(0);

  // No reselection: both fields must still write the reader's original range.
  await page.getByRole("button", { name: "External link", exact: true }).tap();
  await expect(url).toBeFocused();
  await url.fill("https://example.com/applied");
  await link.getByRole("button", { name: "Apply", exact: true }).tap();
  await expect(link).toHaveCount(0);
  await expect(paragraph.locator("a")).toHaveText(selected);
  await expect(paragraph.locator("a")).toHaveAttribute("href", "https://example.com/applied");
  await expect(paragraph).toHaveText(text);

  await page.getByRole("button", { name: "Comment", exact: true }).tap();
  const comment = page.getByPlaceholder(/Comment as/);
  await expect(comment).toBeFocused();
  await expect(card(page).locator('[data-slot="selection-excerpt"]')).toHaveText(selected);
  await comment.fill("touch comment on selected words");
  await card(page).getByRole("button", { name: "Comment", exact: true }).tap();
  await expect(paragraph.locator("[data-comment-thread]")).toHaveText(selected);
  await expect(paragraph).toHaveText(text);
});

test("focused link and comment fields follow visual viewport resize and scroll without a window resize", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await touchPage(browser, info);
  await openDoc(page, ["first context", "second context", "keep fields beside this selection"]);
  const paragraph = editor(page).locator(":scope > p").last();
  await paragraph.tap();
  await selectBlock(paragraph);
  await expect(card(page)).toHaveAttribute("data-placement", "below");
  await page.getByRole("button", { name: "External link", exact: true }).tap();
  const link = page.getByRole("form", { name: "External link", exact: true });
  const url = page.getByRole("textbox", { name: "External link URL" });
  await expect(url).toBeFocused();
  await minimumTargets(link.getByRole("button"), 44);
  await minimumTargets(url, 44);
  expect(await url.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await url.fill("https://example.com/touch");

  // Safari reports the keyboard through visualViewport, without changing the
  // layout viewport. This only proves our observer/clipping wiring; a physical
  // device must still prove native keyboard and focus-scroll behavior.
  const fullHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
  const original = await card(page).boundingBox();
  if (original === null) throw new Error("e2e: missing link form");
  const keyboardHeight = Math.max(320, original.y + original.height - 20);
  await page.evaluate((height) => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error("e2e: missing visual viewport");
    Object.defineProperty(viewport, "height", { configurable: true, value: height });
    viewport.dispatchEvent(new Event("resize"));
  }, keyboardHeight);
  await insideVisibleArea(page);
  await expect(url).toBeFocused();
  await expect(url).toHaveValue("https://example.com/touch");
  await expect(card(page)).toHaveAttribute("data-placement", "above");

  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error("e2e: missing visual viewport");
    Object.defineProperty(viewport, "offsetTop", { configurable: true, value: 12 });
    viewport.dispatchEvent(new Event("scroll"));
  });
  await insideVisibleArea(page);
  await expect(url).toBeFocused();
  await page.evaluate((height) => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error("e2e: missing visual viewport");
    Object.defineProperty(viewport, "height", { configurable: true, value: height });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, value: 0 });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  }, fullHeight);
  await insideVisibleArea(page);
  await expect(card(page)).toHaveAttribute("data-placement", "below");

  await link.getByRole("button", { name: "Cancel", exact: true }).tap();
  await selectBlock(paragraph);
  await page.getByRole("button", { name: "Comment", exact: true }).tap();
  const comment = page.getByPlaceholder(/Comment as/);
  await expect(comment).toBeFocused();
  await comment.fill("a draft kept in view");
  await page.evaluate((height) => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error("e2e: missing visual viewport");
    Object.defineProperty(viewport, "height", { configurable: true, value: height });
    viewport.dispatchEvent(new Event("resize"));
  }, keyboardHeight);
  await insideVisibleArea(page);
  await expect(comment).toBeFocused();
  await expect(comment).toHaveValue("a draft kept in view");
  const field = await comment.boundingBox();
  if (field === null) throw new Error("e2e: missing comment field");
  expect(field.y + field.height).toBeLessThanOrEqual(keyboardHeight + 1);
});

test("a code selection has a 44px Comment-only affordance below it on touch", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await touchPage(browser, info);
  await openDoc(page, [""]);
  await page.keyboard.type("/co");
  await page.getByRole("option", { name: "Code", exact: true }).click();
  await page.keyboard.insertText("const selected = true;");
  const code = editor(page).locator(":scope > pre > code").first();
  await code.tap();
  await selectBlock(code, "touch", { start: 6, end: 14 });
  const comment = card(page).getByRole("button", { name: /^Comment on Code block/ });
  await expect(comment).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-placement", "below");
  await minimumTargets(comment, 44);
  await insideVisibleArea(page);
  const bounds = await card(page).boundingBox();
  if (bounds === null) throw new Error("e2e: missing Comment-only affordance");
  expect(bounds.y).toBeGreaterThan((await selectionBox(page)).bottom);
  await comment.tap();
  const field = page.getByPlaceholder(/Comment as/);
  await expect(field).toBeFocused();
  await expect(card(page).locator('[data-slot="selection-excerpt"]')).toHaveText("selected");
  await field.fill("touch comment on source");
  await card(page).getByRole("button", { name: "Comment", exact: true }).tap();
  await expect(code.locator("[data-comment-thread]")).toHaveText("selected");
});

test("touch Comment-only on a cross-block selection writes its first-block excerpt", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await touchPage(browser, info);
  await openDoc(page, ["before selected tail", "second block"]);
  const paragraphs = editor(page).locator(":scope > p");
  await paragraphs.first().tap();
  await selectBlock(paragraphs.first(), "touch", { start: 7, end: 6, endBlock: 1 });
  await card(page).getByRole("button", { name: /^Comment on Paragraph 1/ }).tap();
  const field = page.getByPlaceholder(/Comment as/);
  await expect(field).toBeFocused();
  await expect(card(page)).toContainText("first block only");
  await expect(card(page).locator('[data-slot="selection-excerpt"]')).toHaveText("selected tail");
  await field.fill("touch comment on first block");
  await card(page).getByRole("button", { name: "Comment", exact: true }).tap();
  await expect(paragraphs.first().locator("[data-comment-thread]")).toHaveText("selected tail");
  await expect(paragraphs.nth(1).locator("[data-comment-thread]")).toHaveCount(0);
});


test("an overflowing comment excerpt keeps its focused field visible in a short visual viewport", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await touchPage(browser, info);
  await openDoc(page, ["A long excerpt remains attached to the draft. ".repeat(35)]);
  const paragraph = editor(page).locator(":scope > p").first();
  await paragraph.tap();
  await selectBlock(paragraph);
  await page.getByRole("button", { name: "Comment", exact: true }).tap();
  const field = page.getByPlaceholder(/Comment as/);
  await expect(field).toBeFocused();
  await field.fill("keep this focused draft visible");
  for (const height of [220, 180]) {
    await page.evaluate((visibleHeight) => {
      const viewport = window.visualViewport;
      if (viewport === null) throw new Error("e2e: missing visual viewport");
      Object.defineProperty(viewport, "height", { configurable: true, value: visibleHeight });
      viewport.dispatchEvent(new Event("resize"));
    }, height);
    await insideVisibleArea(page);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("keep this focused draft visible");
    await expect.poll(async () => {
      const control = await field.boundingBox();
      const bounds = await card(page).boundingBox();
      return control !== null && bounds !== null && control.y >= bounds.y - 1 &&
        control.y + control.height <= bounds.y + bounds.height + 1 &&
        control.y >= 0 && control.y + control.height <= height + 1;
    }).toBe(true);
  }
});
