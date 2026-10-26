/** Browser-only menu wiring: pane collisions, moving anchors and touch input. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createDoc as createAppDoc } from "./app-helpers.js";
import { authorizeBrowser, placeCaret, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

let started: Harness | null = null;

test.beforeAll(async ({ browser }) => {
  started = await startHarness();
  await authorizeBrowser(browser);
});
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
  return page.locator('[data-slot="caret-menu-content"]').filter({ has: menu(page, name) });
}

async function createDoc(page: Page, title: string): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) < 1280 &&
    await page.getByRole("dialog", { name: "Sidebar", exact: true }).count() === 0) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createAppDoc(page, title);
  await placeCaret(page);
}

async function openDoc(page: Page, browserName: string): Promise<void> {
  if (started === null) throw new Error("e2e: menu harness did not start");
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Preserve the Chromium setup size; WebKit keeps its project's device.
  if (browserName === "chromium") await page.setViewportSize({ width: 1470, height: 720 });
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

async function longDocument(page: Page, targetRow = 15, trailingRows = 20): Promise<Locator> {
  const webkit = page.context().browser()?.browserType().name() === "webkit";
  for (let row = 0; row < targetRow + trailingRows; row += 1) {
    if (row !== targetRow) await page.keyboard.insertText(`context ${row}`);
    await page.keyboard.press("Enter");
    // iOS ProseMirror waits for the native DOM split before replaying Return.
    // Wait for that result before the next input; Chromium retains its setup.
    if (webkit) await expect(prose(page).locator(":scope > p")).toHaveCount(row + 2);
  }
  return prose(page).locator(":scope > p").nth(targetRow);
}

async function alignBlock(block: Locator, fromBottom: number, visible = false): Promise<void> {
  await block.evaluate((element, { gap, visible }) => {
    const pane = element.closest(".ub-document-pane");
    if (!(pane instanceof HTMLElement)) throw new Error("e2e: no document pane");
    const target = element.getBoundingClientRect();
    const bounds = pane.getBoundingClientRect();
    const viewport = window.visualViewport;
    const bottom = visible && viewport !== null
      ? Math.min(bounds.bottom, viewport.offsetTop + viewport.height)
      : bounds.bottom;
    pane.scrollTop += target.top - (bottom - gap);
  }, { gap: fromBottom, visible });
}

async function staysInsidePane(page: Page, name = "Block types"): Promise<void> {
  await expect(card(page, name)).toBeVisible();
  await expect.poll(() => card(page, name).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const pane = document.querySelector(".ub-document-pane")?.getBoundingClientRect();
    if (pane === undefined) throw new Error("e2e: pane missing");
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    return box.left >= Math.max(left, pane.left) - 1 &&
      box.top >= Math.max(top, pane.top) - 1 &&
      box.right <= Math.min(left + (viewport?.width ?? window.innerWidth), pane.right) + 1 &&
      box.bottom <= Math.min(top + (viewport?.height ?? window.innerHeight), pane.bottom) + 1;
  })).toBe(true);
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

async function paneCards(page: Page, browserName: string, width?: number): Promise<void> {
  await openDoc(page, browserName);
  await createDoc(page, "collisiontarget1067");
  await createDoc(page, "menu writing");
  // Taller supported devices need more context above the target so both
  // anchor positions can be reached by scrolling without resizing the page.
  const target = await longDocument(page, browserName === "webkit" ? 30 : 15);
  if (width !== undefined) await page.setViewportSize({ width, height: 620 });
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
  const prefix = await target.evaluate((element) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("e2e: missing caret text measurement");
    const style = getComputedStyle(element);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const remaining = element.clientWidth - context.measureText("@collisiontarget1067").width - context.measureText(" ").width - 16;
    return `${"x".repeat(Math.max(1, Math.floor(remaining / context.measureText("x").width)))} `;
  });
  await page.keyboard.insertText(prefix);
  await page.keyboard.type("@collisiontarget1067");
  await alignBlock(target, 42);
  await staysInsidePane(page, "People and documents");
  await expect(card(page, "People and documents")).toHaveAttribute("data-side", "top");
  const anchor = await caretBox(page);
  const rect = await card(page, "People and documents").boundingBox();
  const rightEdge = await target.evaluate((element) => {
    const pane = element.closest(".ub-document-pane")?.getBoundingClientRect();
    if (pane === undefined) throw new Error("e2e: no document pane");
    const viewport = window.visualViewport;
    return Math.min(pane.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth));
  });
  expect(anchor.x + (rect?.width ?? 0)).toBeGreaterThan(rightEdge);
  expect(rect?.x ?? 0).toBeLessThan(anchor.x);
}

for (const width of [1280]) {
  test(`the slash, gutter and @ cards fit the pane at ${width}px`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium covers the docked pane");
    await paneCards(page, browserName, width);
  });
}

test("the slash, gutter and @ cards fit the supported device pane", { tag: "@webkit" }, async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "Chromium has a separate docked case");
  await paneCards(page, browserName);
});

test.describe("touch menus in a short pane", () => {
test.use({ hasTouch: true });

test("a short pane bounds all three cards and scrolls their lists internally", { tag: "@webkit-touch" }, async ({ page, browserName }) => {
  await openDoc(page, browserName);
  for (let index = 0; index < 8; index += 1) {
    await createDoc(page, `height-target1067 ${index}`);
  }
  await createDoc(page, "short pane writing");
  // Leave enough document below the caret to scroll it above a simulated
  // keyboard while the taller iPad layout viewport stays unchanged.
  const target = await longDocument(page, 15, 30);
  if (browserName === "chromium") {
    await page.setViewportSize({ width: 810, height: 320 });
  } else {
    // An on-screen keyboard shortens the visual viewport while the device's
    // layout viewport stays fixed. This proves clipping, not the native keyboard.
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (viewport === null) throw new Error("e2e: missing visual viewport");
      Object.defineProperty(viewport, "height", { configurable: true, value: 320 });
      viewport.dispatchEvent(new Event("resize"));
    });
  }
  await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);

  for (const surface of ["slash", "gutter", "mention"] as const) {
    const name = surface === "mention" ? "People and documents" : "Block types";
    await focusBlock(target);
    if (surface === "gutter") {
      await target.hover();
      await page.getByRole("button", { name: "Insert block below" }).click();
    } else {
      await page.keyboard.type(surface === "slash" ? "/" : "@height-target1067");
    }
    await alignBlock(target, 42, true);
    await staysInsidePane(page, name);
    await expect.poll(() => menu(page, name).evaluate((element) =>
      element.clientHeight > 0 && element.scrollHeight > element.clientHeight,
    )).toBe(true);
    if (browserName === "webkit") {
      // Playwright cannot send wheel input to mobile WebKit. Real scroll
      // geometry still proves the list's internal overflow at this device.
      await menu(page, name).evaluate((element) => element.scrollBy(0, 200));
    } else {
      await menu(page, name).hover();
      await page.mouse.wheel(0, 200);
    }
    await expect.poll(() => menu(page, name).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await staysInsidePane(page, name);
    await page.keyboard.press("Escape");
    await expect(menu(page, name)).toHaveCount(0);
    if (surface === "slash") await page.keyboard.press("Backspace");
  }
});

});

test("composing Escape stays native on slash, gutter search and @; ordinary Escape closes and focuses prose", { tag: "@webkit" }, async ({ page, browserName }) => {
  await openDoc(page, browserName);
  await createDoc(page, "escape-target1067");
  for (const surface of ["slash", "gutter", "mention"] as const) {
    await createDoc(page, `Escape ${surface}`);
    const name = surface === "mention" ? "People and documents" : "Block types";
    const control = surface === "gutter"
      ? page.getByRole("combobox", { name: "Search blocks" })
      : prose(page);
    if (surface === "gutter") {
      await prose(page).locator(":scope > p").first().hover();
      await page.getByRole("button", { name: "Insert block below" }).click();
      await control.fill("he");
    } else {
      await page.keyboard.type(surface === "slash" ? "/he" : "@escape-target1067");
    }
    await expect(menu(page, name)).toBeVisible();
    await expect(control).toBeFocused();

    // Cancelable events traverse the browser's real key listeners. This proves
    // our wiring leaves both composition signals untouched, not native IME behavior.
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const result = await control.evaluate((element, signal) => {
        const focus = document.activeElement;
        const event = new KeyboardEvent("keydown", {
          key: "Escape", code: "Escape", bubbles: true, cancelable: true, ...signal,
        });
        const unprevented = element.dispatchEvent(event);
        return {
          unprevented,
          defaultPrevented: event.defaultPrevented,
          focusRetained: document.activeElement === focus,
        };
      }, composition);
      expect(result).toEqual({ unprevented: true, defaultPrevented: false, focusRetained: true });
      await expect(menu(page, name)).toBeVisible();
      await expect(control).toBeFocused();
    }

    await page.keyboard.press("Escape");
    await expect(menu(page, name)).toHaveCount(0);
    await expect(prose(page)).toBeFocused();
  }
});

test("outside touch scroll preserves menus; taps and clicks dismiss, and fresh triggers restore slash and @", async ({
  browser, browserName,
}) => {
  test.skip(browserName !== "chromium", "native touch-move automation requires Chromium's input protocol");
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 810, height: 1080 } });
  try {
    const page = await context.newPage();
    await openDoc(page, browserName);
    await createDoc(page, "touch-target1067");
    await createDoc(page, "touch writing");
    const target = await longDocument(page);
    await page.setViewportSize({ width: 810, height: 1080 });
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
    await pane.evaluate((element) => {
      element.addEventListener("scrollend", () => element.setAttribute("data-swipe-ended", "true"), { once: true });
    });
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    for (let step = 1; step <= 6; step += 1) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y - 15 * step }] });
      // Pace the native swipe so the browser processes distinct touch moves.
      await page.waitForTimeout(20);
    }
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScroll);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScroll);
    await expect(menu(page)).toBeVisible();
    // Chromium consumes taps during momentum scrolling; wait for the native scroll end.
    await expect(pane).toHaveAttribute("data-swipe-ended", "true");
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
    await staysInsidePane(page, "People and documents");
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await page.touchscreen.tap(point.x, point.y);
    await expect(menu(page, "People and documents")).toHaveCount(0);
    await focusBlock(heading, "end");
    await page.keyboard.type("x");
    await expect(menu(page, "People and documents")).toHaveCount(0);
    await expect(heading).toHaveText("@touch-target1067x");
    for (let count = 0; count < "@touch-target1067x".length; count += 1) {
      await page.keyboard.press("Backspace");
    }
    await page.keyboard.type("@touch-target1067");
    await expect(menu(page, "People and documents")).toBeVisible();
    await menu(page, "People and documents").getByRole("option", { name: "touch-target1067", exact: true }).tap();
    await expect(menu(page, "People and documents")).toHaveCount(0);
    await expect(heading.getByRole("link", { name: "touch-target1067" })).toBeVisible();

    // The click opening the gutter must retain its focused search. Both a
    // subsequent outside tap and an outside mouse click then dismiss it.
    for (const outside of ["tap", "click"] as const) {
      await heading.hover();
      await page.getByRole("button", { name: "Insert block below" }).click();
      await expect(menu(page)).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Search blocks" })).toBeFocused();
      if (outside === "tap") await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      await expect(menu(page)).toHaveCount(0);
    }
    await session.detach();
  } finally {
    await context.close();
  }
});

/**
 * iOS lets Return mutate the DOM, then ProseMirror replays it through its keys.
 * Dispatch that observed input sequence explicitly: hardware Enter alone also
 * takes a 200ms fallback and would miss a stray paragraph left by the mutation.
 * A real iPad's keyboard remains a separate manual device check.
 */
test("iOS Return replays through the slash and @ handlers without a stray paragraph", { tag: "@webkit-touch" }, async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "the iPad WebKit project supplies ProseMirror's iOS platform");
  await openDoc(page, browserName);
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
  await expect(menu(page, "People and documents")).toBeVisible();
  await returnWithDOMSplit();
  await expect(menu(page, "People and documents")).toHaveCount(0);
  await expect(prose(page).locator(":scope > *")).toHaveCount(1);
  await expect(prose(page).getByRole("link", { name: "iOS-target1067" })).toBeVisible();
});
