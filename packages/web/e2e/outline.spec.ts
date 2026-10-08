/**
 * The floating document outline in a real browser.
 *
 * Its derived H1/H2 data stays in the unit suite. This file owns the behavior
 * only a layout and input model can prove: stable geometry, activation-only
 * opening, keyboard operation, touch toggling, long-list containment, and the
 * smooth scroll call into the rendered block.
 */

import { chromium, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness } = setupHarness();

async function openDocument(page: Page): Promise<void> {
  await page.goto(harness().appUrl);
  if (await page.evaluate(() => matchMedia("(width < 80rem)").matches)) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await createDoc(page, "Outline interactions");
  await placeCaret(page);
}

async function typeHeading(page: Page, level: 1 | 2 | 3, text: string): Promise<void> {
  await page.keyboard.type(`${"#".repeat(level)} ${text}`);
  await page.keyboard.press("Enter");
}

/** Notify the editor in the same task, before deferred focus can restore its old range. */
async function selectParagraph(paragraph: ReturnType<Page["locator"]>): Promise<void> {
  await paragraph.evaluate((node) => {
    const doc = node.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(node);
    const selection = doc.getSelection();
    if (selection === null) throw new Error("e2e: paragraph selection is unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new Event("selectionchange"));
  });
}

/** Reach a control through the browser's real sequential focus order. */
async function tabTo(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  // Drain the prior menu's deferred close cleanup before starting new input.
  await page.clock.runFor(1);
  for (let attempts = 0; attempts < 30; attempts += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((node) => node === document.activeElement)) return;
  }
  throw new Error("e2e: target was not reachable within 30 real Tab presses");
}

/** Add enough eligible headings to make the panel itself scroll. */
async function typeLongOutline(page: Page): Promise<string[]> {
  const shown = ["Overview", "Install"];
  await typeHeading(page, 1, "Overview");
  await typeHeading(page, 2, "Install");
  for (let number = 3; number <= 12; number += 1) {
    const text = `Section ${number}`;
    shown.push(text);
    await typeHeading(page, 2, text);
  }
  return shown;
}

test("pointer and keyboard share one contained, stable outline", async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1400, height: 360 });
  await openDocument(page);

  const expected = await typeLongOutline(page);
  const trigger = page.getByRole("button", { name: `Contents ${expected.length}` });
  await expect(trigger).toBeVisible();

  const pane = page.locator(".ub-document-pane");
  await pane.evaluate((element) => {
    element.scrollTop = 0;
  });
  const firstHeading = page.locator(".ub-editor h1", { hasText: "Overview" });
  const top = (await trigger.boundingBox())?.y;
  const headingTop = (await firstHeading.boundingBox())?.y;
  expect(top).toBeDefined();
  expect(headingTop).toBeDefined();
  await pane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect
    .poll(async () => (await firstHeading.boundingBox())?.y ?? 0)
    .toBeLessThan(headingTop ?? 0);
  await expect
    .poll(async () => (await trigger.boundingBox())?.y)
    .toBeCloseTo(top ?? 0, 1);

  // Contents stays closed on hover and opens when the control is activated.
  const panel = page.getByRole("menu", { name: `Contents ${expected.length}` });
  await trigger.hover();
  await page.clock.runFor(180);
  await expect(panel).toBeHidden();
  await trigger.click();
  await expect(panel).toBeVisible();
  const rows = panel.getByRole("menuitem");
  await expect(panel.getByRole("list")).toHaveCount(0);

  const [panelBox, listMetrics] = await Promise.all([
    panel.boundingBox(),
    panel.locator("ul").evaluate((list) => ({
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
    })),
  ]);
  expect(panelBox).not.toBeNull();
  expect((panelBox?.y ?? 0) + (panelBox?.height ?? 0)).toBeLessThanOrEqual(360);
  expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight);

  const first = rows.first();
  const second = rows.nth(1);
  expect(
    await second.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft)),
  ).toBeGreaterThan(
    await first.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft)),
  );
  const rowGround = await first.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  await first.hover();
  expect(await first.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
    rowGround,
  );
  await first.click();
  await expect(panel).toBeHidden();

  // A real Tab reaches the trigger without opening the menu. Enter opens it,
  // and Uberblick's Tab override closes at the trigger so the browser owns
  // subsequent page traversal in the shipped, threadless DOM.
  await tabTo(page, trigger);
  await expect(panel).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await expect(panel).toBeHidden();

  const target = page.locator(".ub-editor h2", { hasText: "Install" });
  const targetId = await target.getAttribute("id");
  expect(targetId).not.toBeNull();
  await page.evaluate(() => {
    const original = Element.prototype.scrollIntoView;
    (window as unknown as { outlineScroll?: unknown[] }).outlineScroll = [];
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
      (window as unknown as { outlineScroll: unknown[] }).outlineScroll.push({
        id: this.id,
        options,
      });
      original.call(this, options);
    };
  });
  for (const key of ["Enter", "Space"]) {
    await tabTo(page, trigger);
    await page.keyboard.press("Enter");
    await second.press(key);
    await expect(panel).toBeHidden();
  }
  expect(
    await page.evaluate(
      () => (window as unknown as { outlineScroll: unknown[] }).outlineScroll,
    ),
  ).toEqual(
    ["Enter", "Space"].map(() => ({
      id: targetId,
      options: { behavior: "smooth", block: "start" },
    })),
  );
});

test.describe("fractional layout", () => {
  // Let the native window supply its device scale instead of fixture emulation.
  test.use({ deviceScaleFactor: async ({ browserName: _browserName }, use) => { await use(undefined); } });

  test("both panes use drawers at a fractional width just below xl", async () => {
    // A native window scaled to device pixels has a fractional CSS layout width.
    // Playwright's viewport emulation accepts only integer CSS dimensions.
    const browser = await chromium.launch({
      args: ["--force-device-scale-factor=1.25", "--window-size=1279,1000"],
    });
    try {
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      expect(await page.evaluate(() =>
        matchMedia("(width > 1279px)").matches && matchMedia("(width < 1280px)").matches,
      )).toBe(true);
      await openDocument(page);
      await page.keyboard.type("fractional layout");
      await page.keyboard.press("Shift+Home");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.getByPlaceholder(/Comment as/).fill("fractional conversation");
      await page.keyboard.press("Enter");
      const toggle = page.locator(".ub-threads-toggle");
      await expect(toggle).toBeVisible();
      await expect(page.locator("aside.ub-rail")).toHaveCount(0);
      const sheet = page.getByRole("dialog", { name: "Threads", exact: true });
      // Creation reveals the new card. Dismiss its modal before testing the
      // background sidebar handle and the explicit rail toggle.
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("fractional conversation");
      await sheet.getByRole("button", { name: "Close threads" }).click();
      await expect(page.getByRole("button", { name: "Show document list", exact: true })).toBeVisible();
      await toggle.click();
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("fractional conversation");
      await expect(page.locator('[data-slot="sheet-overlay"]')).toBeVisible();
      await sheet.getByRole("button", { name: "Close threads" }).click();
      await page.getByRole("button", { name: "Show document list", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

for (const width of [390]) {
  test(`the threads sheet closes by touch without selecting covered prose at ${width}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 1400, height: 800 });
      await openDocument(page);
      await page.keyboard.insertText("first");
      await page.keyboard.press("Enter");
      await page.keyboard.insertText("second");
      // Prepare both unmarked ranges before annotating either: typing at an
      // existing comment's edge would extend its mark into the new fixture.
      await page.locator(".ub-editor .ub-paragraph").first().click();
      await selectParagraph(page.locator(".ub-editor .ub-paragraph").first());
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("first");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.getByPlaceholder(/Comment as/).fill("first conversation");
      await page.keyboard.press("Enter");

      // Wait for Tiptap's deferred focus before setting the next range.
      await expect(editor(page)).toBeFocused();
      await page.locator(".ub-editor .ub-paragraph").last().click();
      await selectParagraph(page.locator(".ub-editor .ub-paragraph").last());
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("second");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.getByPlaceholder(/Comment as/).fill("second conversation");
      await page.keyboard.press("Enter");
      await expect(page.locator(".ub-thread")).toHaveCount(2);
      await page.locator('[data-comment-thread]', { hasText: "second" }).tap();
      await page.getByRole("button", { name: "Hide document list" }).tap();
      await page.setViewportSize({ width, height: 800 });

      const sheet = page.getByRole("dialog", { name: "Threads", exact: true });
      const toggle = page.locator(".ub-threads-toggle");
      // The thread selected while wide is retained when its column becomes a
      // sheet. Its close control remains reachable on the touch viewport.
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('.ub-thread[aria-current="true"]')).toContainText("second conversation");
      await sheet.getByRole("button", { name: "Close threads" }).tap();
      await expect(sheet).toBeHidden();

      const opener = page.locator('[data-comment-thread]', { hasText: "second" });
      const other = page.locator('[data-comment-thread]', { hasText: "first" });
      await opener.tap();
      await expect(sheet).toBeVisible();
      const selected = sheet.locator('.ub-thread[aria-current="true"]');
      await expect(selected).toContainText("second conversation");

      const [otherBox, sheetBox] = await Promise.all([
        other.boundingBox(),
        sheet.boundingBox(),
      ]);
      if (otherBox === null || sheetBox === null) {
        throw new Error("e2e: the thread sheet and covered highlight need layout boxes");
      }
      const outside = { x: otherBox.x + 3, y: otherBox.y + otherBox.height / 2 };
      expect(outside.x).toBeLessThan(sheetBox.x);
      // A real tap at another highlight's coordinates hits the modal overlay.
      // It closes the sheet without forwarding the gesture to that highlight.
      await page.touchscreen.tap(outside.x, outside.y);
      await expect(sheet).toBeHidden();
      await toggle.tap();
      await expect(sheet).toBeVisible();
      await expect(selected).toContainText("second conversation");
      await sheet.getByRole("button", { name: "Close threads" }).tap();
      await expect(sheet).toBeHidden();
    } finally {
      await context.close();
    }
  });
}

test("touch reveals a low thread in the sheet while its close control stays in view", async ({
  browser,
}) => {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1400, height: 800 });
    await openDocument(page);
    const anchors = Array.from({ length: 10 }, (_, index) =>
      `anchor ${String(index + 1).padStart(2, "0")}`,
    );
    // All ranges exist before the first annotation, so typing cannot extend
    // an existing highlight into the next fixture paragraph.
    for (const [index, anchor] of anchors.entries()) {
      if (index > 0) await page.keyboard.press("Enter");
      await page.keyboard.insertText(anchor);
    }
    for (const [index, anchor] of anchors.entries()) {
      await page.locator(".ub-editor .ub-paragraph").nth(index).click();
      await selectParagraph(page.locator(".ub-editor .ub-paragraph").nth(index));
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(anchor);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.getByPlaceholder(/Comment as/).fill(`conversation ${index + 1}`);
      await page.keyboard.press("Enter");
      // Creating a comment returns focus through Tiptap's next animation frame.
      // Let that finish before another selection can be overwritten by it.
      await expect(page.locator(".ub-thread")).toHaveCount(index + 1);
      await expect(editor(page)).toBeFocused();
    }
    await expect(page.locator(".ub-thread")).toHaveCount(10);
    await page
      .locator(".ub-thread-card", { hasText: "conversation 10" })
      .getByRole("button", { name: "Resolve", exact: true })
      .tap();
    await page.getByRole("button", { name: "Hide document list" }).tap();
    await page.setViewportSize({ width: 820, height: 600 });

    const sheet = page.getByRole("dialog", { name: "Threads", exact: true });
    const close = sheet.getByRole("button", { name: "Close threads" });
    await expect(sheet).toBeVisible();
    await close.tap();
    await expect(sheet).toBeHidden();

    for (const number of [9, 10]) {
      const anchor = anchors[number - 1];
      if (anchor === undefined) throw new Error("e2e: missing thread anchor fixture");
      await page.locator("[data-comment-thread]", { hasText: anchor }).tap();
      await expect(sheet).toBeVisible();
      const selected = sheet.locator('.ub-thread[aria-current="true"]');
      await expect(selected).toContainText(`conversation ${number}`);
      if (number === 10) await expect(selected).toHaveAttribute("aria-expanded", "true");
      await expect(selected).toBeInViewport({ ratio: 1 });
      await expect(sheet.locator(".ub-thread").first()).not.toBeInViewport();
      // Assert before tapping: Playwright's automatic scroll into view must
      // not conceal a close control that scrolls away with the conversations.
      await expect(close).toBeInViewport({ ratio: 1 });
      await close.tap();
      await expect(sheet).toBeHidden();
    }
  } finally {
    await context.close();
  }
});
