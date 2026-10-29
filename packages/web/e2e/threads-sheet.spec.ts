/**
 * The document's threads column and narrow-screen threads sheet in a real
 * browser: the always-present column, drawer breakpoints, the sheet's close
 * target, and touch dismissal over covered prose.
 */

import { chromium, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { authorizeBrowser, placeCaret } from "./harness.js";

const { harness } = setupHarness();

async function openDocument(page: Page): Promise<void> {
  await page.goto(harness().appUrl);
  if (await page.evaluate(() => matchMedia("(width < 80rem)").matches)) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await expect(page.locator(".ub-document-sidebar")).toBeVisible();
  await createDoc(page, "Thread interactions");
  await placeCaret(page);
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

test("a document keeps its threads column before and after the first comment", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1400, height: 800 });
  await openDocument(page);
  await page.keyboard.insertText("annotated paragraph");
  const column = page.locator(".ub-document-rail");
  const prose = page.locator(".ub-editor .ub-paragraph").first();
  await expect(column).toHaveCount(1);
  await expect(page.locator(".ub-thread")).toHaveCount(0);
  const columnBefore = await column.boundingBox();
  const proseBefore = await prose.boundingBox();
  expect(columnBefore?.width).toBeGreaterThan(0);
  await selectParagraph(prose);
  await page.getByRole("button", { name: "Comment", exact: true }).and(page.locator("[data-selection-tool], .ub-composer button")).click();
  await page.getByPlaceholder(/Comment as/).fill("first conversation");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ub-thread")).toHaveCount(1);
  expect(await column.boundingBox()).toEqual(columnBefore);
  expect(await prose.boundingBox()).toEqual(proseBefore);
});

test("Escape cancels only the edit in the drawer and closing preserves an unsent edit", { tag: "@webkit" }, async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: false, isMobile: false, viewport: { width: 1400, height: 800 }, reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.route("**/api/account", (route) => route.fulfill({
      json: { state: "signed-in", handle: "browser-person" },
    }));
    await openDocument(page);
    await page.keyboard.insertText("own comment anchor");
    await selectParagraph(page.locator(".ub-editor .ub-paragraph").first());
    await page.getByRole("button", { name: "Comment", exact: true }).and(page.locator("[data-selection-tool], .ub-composer button")).click();
    await page.getByPlaceholder(/Comment as/).fill("My original comment");
    await page.keyboard.press("Enter");
    await expect(page.locator(".ub-thread")).toHaveCount(1);
    await expect(editor(page)).toBeFocused();
    await page.setViewportSize({ width: 820, height: 1180 });
    const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
    await expect(sheet).toBeVisible();
    const card = sheet.locator(".ub-thread");
    const edit = card.getByRole("button", { name: "Edit", exact: true });
    await card.locator(".ub-thread-select").focus();
    await page.keyboard.press("Tab");
    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    const field = card.getByPlaceholder("Edit comment…");
    await expect(field).toBeFocused();
    await field.fill("Cancel without closing the drawer");
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(card).toHaveAttribute("aria-current", "true");
    await expect(card.locator(".ub-thread-text")).toHaveText("My original comment");
    await edit.focus();
    await page.keyboard.press("Enter");
    await field.fill("Keep this unsent edit");
    const close = sheet.getByRole("button", { name: "Close comments", exact: true });
    await close.click();
    await expect(sheet).toBeHidden();
    const toggle = page.locator(".ub-threads-toggle");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sheet).toBeVisible();
    await expect(field).toHaveValue("Keep this unsent edit");
    await field.press("Escape");
    await expect(sheet).toBeVisible();
    await expect(field).toHaveCount(0);
    await expect(card.locator(".ub-thread-text")).toHaveText("My original comment");
    await close.focus();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sheet).toBeVisible();
    await card.locator(".ub-thread-select").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(edit).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await expect(sheet).toBeHidden();
    await expect(editor(page)).toBeFocused();
  } finally {
    await context.close();
  }
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
      await authorizeBrowser(browser);
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      expect(await page.evaluate(() =>
        matchMedia("(width > 1279px)").matches && matchMedia("(width < 1280px)").matches,
      )).toBe(true);
      await openDocument(page);
      await page.keyboard.type("fractional layout");
      await page.keyboard.press("Shift+Home");
      await page.getByRole("button", { name: "Comment", exact: true }).and(page.locator("[data-selection-tool], .ub-composer button")).click();
      await page.getByPlaceholder(/Comment as/).fill("fractional conversation");
      await page.keyboard.press("Enter");
      const toggle = page.locator(".ub-threads-toggle");
      await expect(toggle).toBeVisible();
      await expect(page.locator("aside.ub-rail")).toHaveCount(0);
      const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
      // Creation reveals the new card. Dismiss its modal before testing the
      // background sidebar handle and the explicit rail toggle.
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("fractional conversation");
      await sheet.getByRole("button", { name: "Close comments" }).click();
      await expect(page.getByRole("button", { name: "Show document list", exact: true })).toBeVisible();
      await toggle.click();
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("fractional conversation");
      await expect(page.locator('[data-slot="sheet-overlay"]')).toBeVisible();
      await sheet.getByRole("button", { name: "Close comments" }).click();
      await page.getByRole("button", { name: "Show document list", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

for (const hasTouch of [false, true]) {
  test(`threads close target preserves its glyph and clears the first card — ${hasTouch ? "coarse" : "fine"} pointer`, { tag: "@webkit" }, async ({ browser }, info) => {
    const context = await browser.newContext({ hasTouch, viewport: { width: 1400, height: 800 } });
    const page = await context.newPage();
    try {
      await openDocument(page);
      await page.keyboard.insertText("thread target");
      await selectParagraph(page.locator(".ub-editor .ub-paragraph").first());
      await page.getByRole("button", { name: "Comment", exact: true }).and(page.locator("[data-selection-tool], .ub-composer button")).click();
      await page.getByPlaceholder(/Comment as/).fill("first conversation");
      await page.keyboard.press("Enter");
      await expect(page.locator(".ub-thread")).toHaveCount(1);
      await page.setViewportSize({ width: 820, height: 1180 });
      const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
      const close = sheet.getByRole("button", { name: "Close comments", exact: true });
      await expect(sheet).toBeVisible();
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        const surfaces = await sheet.evaluate((node) => {
          const probe = document.createElement("div");
          probe.style.borderRadius = "var(--radius-sm)";
          probe.className = "shadow-(--shadow-float)";
          document.body.append(probe);
          const shared = getComputedStyle(probe);
          const close = node.querySelector('[data-slot="sheet-close"]');
          const card = node.querySelector(".ub-thread");
          if (close === null || card === null) throw new Error("e2e: missing thread sheet controls");
          const result = {
            floating: getComputedStyle(node).boxShadow === shared.boxShadow,
            closeRadius: getComputedStyle(close).borderRadius === shared.borderRadius,
            threadAccent: getComputedStyle(card).borderLeftWidth,
          };
          probe.remove();
          return result;
        });
        expect(surfaces).toEqual({ floating: true, closeRadius: true, threadAccent: "1px" });
      }
      const geometry = await sheet.evaluate((node) => {
        const button = node.querySelector<HTMLElement>('[data-slot="sheet-close"]');
        const glyph = button?.querySelector("svg");
        const card = node.querySelector<HTMLElement>(".ub-thread");
        const scroll = node.querySelector(".ub-threads")?.parentElement;
        if (button === null || glyph === undefined || glyph === null || card === null || scroll === undefined || scroll === null) {
          throw new Error("e2e: thread target fixture needs a close glyph, card and scroll container");
        }
        return {
          coarse: matchMedia("(any-pointer: coarse)").matches,
          sheet: node.getBoundingClientRect().toJSON(),
          close: button.getBoundingClientRect().toJSON(),
          glyph: glyph.getBoundingClientRect().toJSON(),
          card: card.getBoundingClientRect().toJSON(),
          scrollTop: scroll.scrollTop,
          otherControls: Array.from(node.querySelectorAll<HTMLElement>("button:not([data-slot=sheet-close]), textarea")).map((control) => control.getBoundingClientRect().toJSON()),
        };
      });
      await info.attach("threads close geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
      expect(geometry.coarse).toBe(hasTouch);
      const minimum = hasTouch ? 44 : 24;
      expect(geometry.close.width).toBeGreaterThanOrEqual(minimum);
      expect(geometry.close.height).toBeGreaterThanOrEqual(minimum);
      expect(geometry.glyph.width).toBe(16);
      expect(geometry.glyph.height).toBe(16);
      expect(geometry.glyph.top - geometry.sheet.top).toBe(17);
      expect(geometry.sheet.right - geometry.glyph.right).toBe(22);
      expect(geometry.scrollTop).toBe(0);
      expect(geometry.close.bottom).toBeLessThanOrEqual(geometry.card.top);
      for (const control of geometry.otherControls) {
        expect(geometry.close.right <= control.left || geometry.close.left >= control.right
          || geometry.close.bottom <= control.top || geometry.close.top >= control.bottom).toBe(true);
      }

      // The first card's top-right chips remain reachable beside the target.
      if (hasTouch) {
        await page.touchscreen.tap(geometry.card.right - 4, geometry.card.top + 4);
        await expect(sheet).toBeVisible();
        // Tap the outer hit area, well away from the visible glyph.
        await page.touchscreen.tap(geometry.close.left + 2, geometry.close.bottom - 2);
      } else {
        await close.click();
      }
      await expect(sheet).toBeHidden();
      const toggle = page.locator(".ub-threads-toggle");
      await expect(toggle).toBeFocused();
      for (const key of ["Enter", "Space", "Escape"]) {
        await toggle.click();
        await expect(sheet).toBeVisible();
        await close.focus();
        await expect(close).toBeFocused();
        expect(await close.evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe("none");
        await close.press(key);
        await expect(sheet).toBeHidden();
        await expect(toggle).toBeFocused();
      }
    } finally {
      await context.close();
    }
  });
}

for (const width of [810]) {
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
      await page.getByRole("button", { name: "Comment", exact: true }).and(page.locator("[data-selection-tool], .ub-composer button")).click();
      await page.getByPlaceholder(/Comment as/).fill("first conversation");
      await page.keyboard.press("Enter");

      // Wait for Tiptap's deferred focus before setting the next range.
      await expect(editor(page)).toBeFocused();
      await page.locator(".ub-editor .ub-paragraph").last().click();
      await selectParagraph(page.locator(".ub-editor .ub-paragraph").last());
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("second");
      await page.getByRole("button", { name: "Comment", exact: true }).and(page.locator("[data-selection-tool], .ub-composer button")).click();
      await page.getByPlaceholder(/Comment as/).fill("second conversation");
      await page.keyboard.press("Enter");
      await expect(page.locator(".ub-thread")).toHaveCount(2);
      await page.locator('[data-comment-thread]', { hasText: "second" }).tap();
      await page.getByRole("button", { name: "Hide document list" }).tap();
      await page.setViewportSize({ width, height: 800 });

      const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
      const toggle = page.locator(".ub-threads-toggle");
      // The thread selected while wide is retained when its column becomes a
      // sheet. Its close control remains reachable on the touch viewport.
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('.ub-thread[aria-current="true"]')).toContainText("second conversation");
      await sheet.getByRole("button", { name: "Close comments" }).tap();
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
      await sheet.getByRole("button", { name: "Close comments" }).tap();
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
      await page.getByRole("button", { name: "Comment", exact: true }).and(page.locator("[data-selection-tool], .ub-composer button")).click();
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

    const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
    const close = sheet.getByRole("button", { name: "Close comments" });
    const commentsToggle = page.locator(".ub-threads-toggle");
    if (await commentsToggle.getAttribute("aria-expanded") !== "true") await commentsToggle.tap();
    await expect(sheet).toBeVisible();
    await close.tap();
    await expect(sheet).toBeHidden();

    for (const number of [9, 10]) {
      const anchor = anchors[number - 1];
      if (anchor === undefined) throw new Error("e2e: missing thread anchor fixture");
      if (number === 10) {
        await page.locator(".ub-threads-toggle").tap();
        await sheet.getByRole("button", { name: "1 resolved", exact: true }).tap();
        await sheet.locator(".ub-thread-resolved .ub-thread-select").tap();
      } else {
        await page.locator("[data-comment-thread]", { hasText: anchor }).tap();
      }
      await expect(sheet).toBeVisible();
      const selected = sheet.locator('.ub-thread[aria-current="true"]');
      await expect(selected).toContainText(`conversation ${number}`);
      if (number === 10) await expect(selected).toHaveAttribute("data-expanded", "true");
      await expect(selected).toBeInViewport({ ratio: 0.99 });
      const cardBounds = await selected.boundingBox();
      if (cardBounds === null) throw new Error("e2e: selected comment card needs a layout box");
      expect(cardBounds.y).toBeGreaterThanOrEqual(-1);
      expect(cardBounds.y + cardBounds.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);
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
