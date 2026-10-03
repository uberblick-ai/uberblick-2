/** Browser-only menu wiring: pane collisions, moving anchors and touch input. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { placeCaret, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });
let started: Harness | null = null;

test.beforeAll(async () => { started = await startHarness(); });
test.afterAll(async () => {
  const running = started;
  started = null;
  await running?.stop();
});

function prose(page: Page): Locator {
  return page.locator(".ub-editor .ProseMirror");
}
function menu(page: Page, name = "Block types"): Locator {
  return page.getByRole("listbox", { name });
}
function card(page: Page, name = "Block types"): Locator {
  return page.locator('[data-slot="popover-content"]').filter({ has: menu(page, name) });
}

async function createDoc(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(prose(page)).toBeVisible();
  await page.locator(".ub-title").fill(title);
  await placeCaret(page);
}

async function openDoc(page: Page): Promise<void> {
  if (started === null) throw new Error("e2e: menu harness did not start");
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Create before switching to a drawer width; its closed state is not part of
  // this proof and must not hide the document-creation control during setup.
  await page.setViewportSize({ width: 1470, height: 720 });
  await page.goto(started.appUrl);
  await createDoc(page, "menu layout");
}

/** Native selection is setup; menu state still receives the browser's input. */
async function focusBlock(block: Locator, edge: "start" | "end" = "start"): Promise<void> {
  await block.evaluate((element, at) => {
    const root = element.closest(".ProseMirror");
    if (!(root instanceof HTMLElement)) throw new Error("e2e: no prose root");
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(at === "start");
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, edge);
  await block.page().evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function longDocument(page: Page): Promise<Locator> {
  for (let row = 0; row < 35; row += 1) {
    if (row !== 15) await page.keyboard.insertText(`context ${row}`);
    await page.keyboard.press("Enter");
  }
  return prose(page).locator(":scope > p").nth(15);
}

async function alignBlock(block: Locator, fromBottom: number): Promise<void> {
  await block.evaluate((element, gap) => {
    const pane = element.closest(".ub-document-pane");
    if (!(pane instanceof HTMLElement)) throw new Error("e2e: no document pane");
    const target = element.getBoundingClientRect();
    const bounds = pane.getBoundingClientRect();
    pane.scrollTop += target.top - (bounds.bottom - gap);
  }, fromBottom);
}

async function staysInsidePane(page: Page, name = "Block types"): Promise<void> {
  await expect(card(page, name)).toBeVisible();
  await expect.poll(async () => {
    const box = await card(page, name).boundingBox();
    const pane = await page.locator(".ub-document-pane").boundingBox();
    if (box === null || pane === null) return false;
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("e2e: viewport missing");
    return box.x >= Math.max(0, pane.x) - 1 &&
      box.y >= Math.max(0, pane.y) - 1 &&
      box.x + box.width <= Math.min(viewport.width, pane.x + pane.width) + 1 &&
      box.y + box.height <= Math.min(viewport.height, pane.y + pane.height) + 1;
  }).toBe(true);
}

/** A real caret range lets the test compare attachment without pinning an offset. */
async function caretBox(page: Page): Promise<{ x: number; y: number; bottom: number }> {
  return page.evaluate(() => {
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0) throw new Error("e2e: no caret");
    const range = selection.getRangeAt(0).cloneRange();
    const box = range.getBoundingClientRect();
    return { x: box.x, y: box.y, bottom: box.bottom };
  });
}

for (const width of [375, 744, 932, 1280, 1366, 1470]) {
  test(`the slash, gutter and @ cards fit the pane at ${width}px`, async ({ page }) => {
    await openDoc(page);
    await createDoc(page, "collisiontarget1067");
    await createDoc(page, "menu writing");
    const target = await longDocument(page);
    await page.setViewportSize({ width, height: 620 });
    // The narrow drawer starts closed. Wait for resizing to replace the
    // docked sidebar rather than clicking its disappearing toggle.
    await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
    await focusBlock(target);
    await page.keyboard.type("/");
    await alignBlock(target, 42);
    await staysInsidePane(page);
    await expect(card(page)).toHaveAttribute("data-side", "top");

    // Typing keeps the anchor live rather than retaining the trigger's box.
    const before = await caretBox(page);
    const beforeCard = await card(page).boundingBox();
    await page.keyboard.type("he");
    await staysInsidePane(page);
    const after = await caretBox(page);
    const afterCard = await card(page).boundingBox();
    expect(after.x).toBeGreaterThan(before.x);
    await expect.poll(async () => (await card(page).boundingBox())?.x ?? 0)
      .toBeGreaterThan(beforeCard?.x ?? 0);

    // Scroll changes the live anchor's page coordinate without a transaction.
    await alignBlock(target, 100);
    await staysInsidePane(page);
    await expect.poll(async () => (await card(page).boundingBox())?.y ?? 0)
      .not.toBe(afterCard?.y ?? 0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");

    await target.hover();
    await page.getByRole("button", { name: "Insert block below" }).click();
    await alignBlock(target, 42);
    await staysInsidePane(page);
    await expect(card(page)).toHaveAttribute("data-side", "top");
    await page.keyboard.press("Escape");

    // Fill a single line up to its right edge, then type the @ trigger there.
    await focusBlock(target);
    await page.keyboard.insertText("context ");
    await page.keyboard.type("@collisiontarget1067");
    await alignBlock(target, 42);
    await staysInsidePane(page, "Documents");
    await expect(card(page, "Documents")).toHaveAttribute("data-side", "top");
    const anchor = await caretBox(page);
    const rect = await card(page, "Documents").boundingBox();
    // At least the smallest pane has a caret close enough to the edge to need
    // shifting. Wider panes still prove that their own boundary is respected.
    if (width === 375) expect(rect?.x ?? 0).toBeLessThan(anchor.x);
  });
}

test("an outside touch scroll keeps the menu open; a tap dismisses slash and @ until a fresh trigger", async ({
  browser, browserName,
}) => {
  test.skip(browserName !== "chromium", "native touch-move automation requires Chromium's input protocol");
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 375, height: 667 } });
  try {
    const page = await context.newPage();
    await openDoc(page);
    await createDoc(page, "touch-target1067");
    await createDoc(page, "touch writing");
    const target = await longDocument(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
    await focusBlock(target);
    await page.keyboard.type("/");
    await alignBlock(target, 100);
    await staysInsidePane(page);
    const pane = page.locator(".ub-document-pane");
    const bounds = await pane.boundingBox();
    if (bounds === null) throw new Error("e2e: pane missing");
    const session = await context.newCDPSession(page);
    const point = { x: bounds.x + 4, y: bounds.y + bounds.height - 60 };
    const initialScroll = await pane.evaluate((element) => element.scrollTop);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    for (let step = 1; step <= 6; step += 1) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y - 15 * step }] });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(150);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScroll);
    await expect(menu(page)).toBeVisible();
    await page.touchscreen.tap(point.x, point.y);
    await expect(menu(page)).toHaveCount(0);
    await focusBlock(target, "end");
    await page.keyboard.type("he");
    await expect(menu(page)).toHaveCount(0);
    await expect(target).toHaveText("/he");
    for (let count = 0; count < 3; count += 1) await page.keyboard.press("Backspace");
    await page.keyboard.type("/he");
    await expect(menu(page)).toBeVisible();
    await menu(page).getByRole("option", { name: "Heading 2", exact: true }).tap();
    await expect(menu(page)).toHaveCount(0);
    const heading = prose(page).locator(":scope > h2");
    await expect(heading).toHaveCount(1);

    await focusBlock(heading);
    await page.keyboard.type("@touch-target1067");
    await staysInsidePane(page, "Documents");
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await page.touchscreen.tap(point.x, point.y);
    await expect(menu(page, "Documents")).toHaveCount(0);
    await focusBlock(heading, "end");
    await page.keyboard.type("x");
    await expect(menu(page, "Documents")).toHaveCount(0);
    await expect(heading).toHaveText("@touch-target1067x");
    for (let count = 0; count < "@touch-target1067x".length; count += 1) {
      await page.keyboard.press("Backspace");
    }
    await page.keyboard.type("@touch-target1067");
    await expect(menu(page, "Documents")).toBeVisible();
    await menu(page, "Documents").getByRole("option", { name: "touch-target1067", exact: true }).tap();
    await expect(menu(page, "Documents")).toHaveCount(0);
    await expect(heading.getByRole("link", { name: "touch-target1067" })).toBeVisible();
    await session.detach();
  } finally {
    await context.close();
  }
});

/**
 * iOS lets Return mutate the DOM, then ProseMirror replays it through its keys.
 * Dispatch that observed input sequence explicitly: hardware Enter alone also
 * takes a 200ms fallback and would miss a stray paragraph left by the mutation.
 * A real iPhone's keyboard remains a separate manual device check.
 */
test("iOS Return replays through the slash and @ handlers without a stray paragraph", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "the iPhone WebKit project supplies ProseMirror's iOS platform");
  await openDoc(page);
  await createDoc(page, "iOS-target1067");
  await createDoc(page, "iOS writing");
  await page.keyboard.type("/he");
  await expect(menu(page)).toBeVisible();

  async function returnWithDOMSplit(): Promise<void> {
    const unclaimed = await prose(page).evaluate((root) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
      });
      const unclaimed = root.dispatchEvent(event);
      const paragraph = root.firstElementChild;
      if (paragraph === null) throw new Error("e2e: prose has no paragraph");
      const next = document.createElement("p");
      next.append(document.createElement("br"));
      paragraph.after(next);
      const range = document.createRange();
      range.setStart(next, 0);
      range.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return unclaimed;
    });
    expect(unclaimed).toBe(true);
  }

  await returnWithDOMSplit();
  await expect(menu(page)).toHaveCount(0);
  await expect(prose(page).locator(":scope > *")).toHaveCount(1);
  await expect(prose(page).locator(":scope > h1")).toHaveText("");

  await createDoc(page, "iOS mentions");
  await page.keyboard.type("@iOS-target1067");
  await expect(menu(page, "Documents")).toBeVisible();
  await returnWithDOMSplit();
  await expect(menu(page, "Documents")).toHaveCount(0);
  await expect(prose(page).locator(":scope > *")).toHaveCount(1);
  await expect(prose(page).getByRole("link", { name: "iOS-target1067" })).toBeVisible();
});
