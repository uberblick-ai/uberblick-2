/**
 * The document's collapsible navigation in a real browser.
 *
 * Its derived H1/H2 data stays in the unit suite. This file owns the behavior
 * only a layout and input model can prove: column placement, scroll tracking,
 * hover focus preservation, keyboard operation, touch toggling and containment.
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
  await expect(page.locator(".ub-document-sidebar")).toBeVisible();
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
  await page.keyboard.insertText("A section has enough text to read while scrolling. ".repeat(12));
  await page.keyboard.press("Enter");
  await typeHeading(page, 2, "Install");
  await page.keyboard.insertText("Installation has enough text to read while scrolling. ".repeat(12));
  await page.keyboard.press("Enter");
  for (let number = 3; number <= 12; number += 1) {
    const text = number === 12
      ? "Section 12 with a long heading that describes the final section in enough detail to exceed the available column width"
      : `Section ${number}`;
    shown.push(text);
    await typeHeading(page, 2, text);
    if (number < 12) {
      await page.keyboard.insertText("This section continues with more document text. ".repeat(12));
      await page.keyboard.press("Enter");
    }
  }
  return shown;
}

test("a threadless page has a full-column row that follows document scrolling", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.setViewportSize({ width: 1400, height: 600 });
  await openDocument(page);
  await expect(page.locator(".ub-outline-trigger")).toHaveCount(0);
  await expect(page.locator(".ub-document-rail")).toHaveCount(0);
  const expected = await typeLongOutline(page);
  const trigger = page.getByRole("button", { name: /^On this page/ });
  const panel = page.getByRole("navigation", { name: "On this page" });
  const rail = page.locator(".ub-document-rail");
  await expect(trigger).toBeVisible();
  await expect(page.locator(".ub-thread")).toHaveCount(0);
  await expect(rail).toBeVisible();
  const pane = page.locator(".ub-document-pane");
  await pane.evaluate((element) => { element.scrollTop = 0; });
  await expect(trigger).toHaveText("On this page");
  await expect.poll(async () => (await trigger.boundingBox())?.y).toBeCloseTo((await page.locator(".ub-title").boundingBox())?.y ?? 0, 0);
  const [triggerBox, railBox, railWidth] = await Promise.all([trigger.boundingBox(), rail.boundingBox(), rail.evaluate((element) => element.clientWidth)]);
  expect(triggerBox?.width).toBeCloseTo(railWidth, 0);
  await page.locator(".ub-editor h1").evaluate((heading) => heading.scrollIntoView({ behavior: "instant", block: "start" }));
  await expect(trigger).toContainText("Overview");
  await page.locator(".ub-editor h2", { hasText: "Install" }).evaluate((heading) => heading.scrollIntoView({ behavior: "instant", block: "start" }));
  await expect(trigger).toContainText("Install");
  await pane.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(trigger).toBeInViewport({ ratio: 1 });
  await expect(trigger).toContainText(expected.at(-1) ?? "");
  await expect.poll(async () => (await trigger.boundingBox())?.y).toBeCloseTo((await pane.boundingBox())?.y ?? 0, 0);
  // A short final section cannot reach the scroll container's top.
  const finalHeading = page.locator(".ub-editor h2", { hasText: expected.at(-1) ?? "" });
  expect((await finalHeading.boundingBox())?.y).toBeGreaterThan((await pane.boundingBox())?.y ?? 0);
  await pane.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(async () => (await trigger.boundingBox())?.y).toBeCloseTo((await page.locator(".ub-title").boundingBox())?.y ?? 0, 0);
  const titleBefore = await page.locator(".ub-title").boundingBox();
  await trigger.focus();
  await trigger.press("Enter");
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
  const rows = panel.getByRole("button");
  await expect(rows).toHaveText(expected);
  expect(await page.locator(".ub-title").boundingBox()).toEqual(titleBefore);
  const [panelBox, listMetrics] = await Promise.all([
    panel.boundingBox(),
    panel.locator("ul").evaluate((list) => ({
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
    })),
  ]);
  expect(panelBox).not.toBeNull();
  expect(panelBox?.height).toBeLessThanOrEqual(600 * 0.6 + 1);
  expect(panelBox?.x).toBeGreaterThanOrEqual(railBox?.x ?? 0);
  expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual((railBox?.x ?? 0) + (railBox?.width ?? 0) + 1);
  expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight);

  await pane.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => (await panel.boundingBox())?.y)
    .toBeCloseTo(((await trigger.boundingBox())?.y ?? 0) + ((await trigger.boundingBox())?.height ?? 0), 0);

  const first = rows.first();
  const second = rows.nth(1);
  expect(
    await second.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft)),
  ).toBeGreaterThan(
    await first.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft)),
  );
  await rows.last().click();
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText(expected.at(-1) ?? "");
  expect(await trigger.locator("span").nth(1).evaluate((section) => ({
    truncated: section.scrollWidth > section.clientWidth,
    overflow: getComputedStyle(section).textOverflow,
  }))).toEqual({ truncated: true, overflow: "ellipsis" });
  await trigger.press("Enter");
  const current = panel.locator('[aria-current="location"]');
  await expect(current).toHaveText(expected.at(-1) ?? "");
  const colours = await current.evaluate((entry) => {
    const style = getComputedStyle(entry);
    const probe = document.createElement("span");
    probe.style.color = "var(--brand)";
    document.body.append(probe);
    const amber = getComputedStyle(probe).color;
    probe.remove();
    return { barWidth: style.borderInlineStartWidth, bar: style.borderInlineStartColor, amber, ink: style.color };
  });
  expect(colours.barWidth).toBe("2px");
  expect(colours.bar).toBe(colours.amber);
  expect(colours.ink).toBe(await page.locator(".ub-title").evaluate((title) => getComputedStyle(title).color));
  expect(await first.evaluate((entry) => getComputedStyle(entry).color)).toBe(await trigger.locator("span").first().evaluate((caption) => getComputedStyle(caption).color));
  await page.keyboard.press("Escape");
});

test("keyboard reaches every navigation entry and restores the row on dismissal", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await openDocument(page);
  const expected = await typeLongOutline(page);
  const trigger = page.getByRole("button", { name: /^On this page/ });
  const panel = page.getByRole("navigation", { name: "On this page" });
  const rows = panel.getByRole("button");
  await page.mouse.move(0, 0);
  await tabTo(page, trigger);
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  for (const key of ["Enter", "Space"]) {
    await trigger.press(key);
    await expect(panel).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(rows.first()).toBeFocused();
    for (let index = 1; index < expected.length; index += 1) {
      await page.keyboard.press("Tab");
      await expect(rows.nth(index)).toBeFocused();
    }
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.press(key);
    await rows.nth(1).press(key);
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("Install");
  }
});

test("comments scroll beneath the pinned row without moving it or the document", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1400, height: 600 });
  await openDocument(page);
  await typeHeading(page, 1, "Commented section");
  await page.keyboard.insertText("annotated paragraph");
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("The document has its own scrolling content. ".repeat(12));
  }
  await page.locator(".ub-editor .ub-paragraph").first().click();
  await selectParagraph(page.locator(".ub-editor .ub-paragraph").first());
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByPlaceholder(/Comment as/).fill("A comment line that occupies the scrolling comments column.\n".repeat(45));
  await page.keyboard.press("Enter");
  await expect(page.locator(".ub-thread")).toHaveCount(1);
  await expect(editor(page)).toBeFocused();
  const trigger = page.getByRole("button", { name: /^On this page/ });
  const panel = page.getByRole("navigation", { name: "On this page" });
  const pane = page.locator(".ub-document-pane");
  const comments = page.locator("aside.ub-rail");
  await pane.evaluate((element) => { element.scrollTop = 0; });
  await comments.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(async () => (await trigger.boundingBox())?.y).toBeCloseTo((await page.locator(".ub-title").boundingBox())?.y ?? 0, 0);
  const cardBefore = await page.locator(".ub-thread").boundingBox();
  const titleBefore = await page.locator(".ub-title").boundingBox();
  await trigger.focus();
  await trigger.press("Enter");
  await expect(panel).toBeVisible();
  expect(await page.locator(".ub-thread").boundingBox()).toEqual(cardBefore);
  expect(await page.locator(".ub-title").boundingBox()).toEqual(titleBefore);
  await page.keyboard.press("Escape");
  await pane.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => (await trigger.boundingBox())?.y).toBeCloseTo((await pane.boundingBox())?.y ?? 0, 0);
  const documentScroll = await pane.evaluate((element) => element.scrollTop);
  const pinned = await trigger.boundingBox();
  await comments.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => comments.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await pane.evaluate((element) => element.scrollTop)).toBe(documentScroll);
  expect(await trigger.boundingBox()).toEqual(pinned);
  await pane.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(async () => (await trigger.boundingBox())?.y).toBeCloseTo((await page.locator(".ub-title").boundingBox())?.y ?? 0, 0);
});

test("hover preserves editor focus and selection, and a click makes it persistent", async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1400, height: 800 });
  await openDocument(page);
  await typeHeading(page, 1, "Overview");
  await typeHeading(page, 2, "Install");
  await page.keyboard.insertText("keep this selection");
  await selectParagraph(page.locator(".ub-editor .ub-paragraph").last());
  const trigger = page.getByRole("button", { name: /^On this page/ });
  const panel = page.getByRole("navigation", { name: "On this page" });
  await expect(editor(page)).toBeFocused();
  await trigger.hover();
  await expect(panel).toBeHidden();
  await page.clock.runFor(600);
  await expect(panel).toBeVisible();
  await expect(editor(page)).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("keep this selection");
  await panel.hover();
  await page.clock.runFor(600);
  await expect(panel).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(600);
  await expect(panel).toBeHidden();
  await expect(editor(page)).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("keep this selection");

  await trigger.hover();
  await page.clock.runFor(600);
  await panel.getByRole("button", { name: "Install", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(trigger).toContainText("Install");
  await expect(panel.locator('[aria-current="location"]')).toHaveText("Install");
  await trigger.click();
  await page.mouse.move(0, 0);
  await page.clock.runFor(600);
  await expect(panel).toBeVisible();
  await trigger.click();
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.mouse.move(0, 0);
  await trigger.hover();
  await page.clock.runFor(600);
  await expect(panel).toBeVisible();
  await page.locator(".ub-title").click();
  await expect(panel).toBeHidden();
  await expect(page.locator(".ub-title")).toBeFocused();
  await trigger.hover();
  await page.clock.runFor(600);
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("a non-hover pointer toggles the panel and dismisses it outside @webkit", async ({
  browser,
}) => {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1194, height: 540 });
    await openDocument(page);
    await typeHeading(page, 1, "Touch target");
    const trigger = page.locator(".ub-outline-trigger");
    const panel = page.getByRole("navigation", { name: "On this page" });
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox?.height).toBeGreaterThanOrEqual(44);
    const paneBox = await page.locator(".ub-document-pane").boundingBox();
    expect((triggerBox?.y ?? 0) + (triggerBox?.height ?? 0)).toBeLessThanOrEqual((paneBox?.y ?? 0) + 1);
    const openerBox = await page.getByRole("button", { name: "Show document list", exact: true }).boundingBox();
    expect(triggerBox?.x).toBeGreaterThanOrEqual((openerBox?.x ?? 0) + (openerBox?.width ?? 0));
    await trigger.tap();
    await expect(panel).toBeVisible();
    await trigger.tap();
    await expect(panel).toBeHidden();

    await trigger.tap();
    await expect(panel).toBeVisible();
    await page.locator(".ub-title").tap();
    await expect(panel).toBeHidden();
    await expect(page.locator(".ub-title")).toBeFocused();

    // An open threads drawer owns this edge: the covered outline is removed
    // from both rendering and keyboard navigation, and its portal closes.
    await page.locator(".ub-editor .ub-paragraph").last().click();
    await page.keyboard.type("annotate me");
    await selectParagraph(page.locator(".ub-editor .ub-paragraph").last());
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("annotate me");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByPlaceholder(/Comment as/).fill("a thread");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    const threads = page.locator(".ub-threads-toggle");
    await expect(threads).toBeVisible();
    const [rowBox, commentsBox] = await Promise.all([trigger.boundingBox(), threads.boundingBox()]);
    expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(commentsBox?.x ?? 0);
    await trigger.tap();
    await expect(panel).toBeVisible();
    await threads.tap();
    const sheet = page.getByRole("dialog", { name: "Threads", exact: true });
    await expect(sheet).toBeVisible();
    await expect(page.locator('[data-slot="sheet-overlay"]')).toBeVisible();
    await expect(trigger).toBeHidden();
    await expect(panel).toBeHidden();
    expect(await trigger.evaluate((node) => {
      node.focus();
      return node === document.activeElement;
    })).toBe(false);

    // The drawer stays open across the breakpoint. If the outline opens while
    // wide, narrowing again must close its portal when CSS hides the trigger.
    await page.setViewportSize({ width: 1280, height: 540 });
    await expect(sheet).toHaveCount(0);
    await expect(page.locator("aside.ub-rail")).toBeVisible();
    await expect(threads).toBeHidden();
    await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hide document list" })).toBeVisible();
    await expect(trigger).toBeVisible();
    await trigger.tap();
    await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 1279, height: 540 });
    await expect(sheet).toBeVisible();
    await expect(trigger).toBeHidden();
    await expect(panel).toBeHidden();
    await sheet.getByRole("button", { name: "Close threads" }).tap();
    await expect(page.getByRole("button", { name: "Show document list", exact: true })).toBeVisible();
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

for (const hasTouch of [false, true]) {
  test(`threads close target preserves its glyph and clears the first card — ${hasTouch ? "coarse" : "fine"} pointer`, async ({ browser }, info) => {
    const context = await browser.newContext({ hasTouch, viewport: { width: 1400, height: 800 } });
    const page = await context.newPage();
    try {
      await openDocument(page);
      await page.keyboard.insertText("thread target");
      await selectParagraph(page.locator(".ub-editor .ub-paragraph").first());
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.getByPlaceholder(/Comment as/).fill("first conversation");
      await page.keyboard.press("Enter");
      await expect(page.locator(".ub-thread")).toHaveCount(1);
      await page.setViewportSize({ width: 820, height: 1180 });
      const sheet = page.getByRole("dialog", { name: "Threads", exact: true });
      const close = sheet.getByRole("button", { name: "Close threads", exact: true });
      await expect(sheet).toBeVisible();
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
