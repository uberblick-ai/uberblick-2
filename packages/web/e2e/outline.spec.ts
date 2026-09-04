/**
 * The floating document outline in a real browser.
 *
 * Its derived H1/H2 data stays in the unit suite. This file owns the behavior
 * only a layout and input model can prove: stable geometry, the pointer path
 * across a portalled popover, keyboard focus and restoration, touch toggling,
 * long-list containment, and the smooth scroll call into the rendered block.
 */

import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { placeCaret, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

let started: Harness | null = null;

function harness(): Harness {
  if (started === null) {
    throw new Error("e2e: the harness is not running — its bootstrap failed");
  }
  return started;
}

test.beforeAll(async () => {
  started = await startHarness();
});

test.afterAll(async () => {
  const running = started;
  started = null;
  await running?.stop();
});

async function openDocument(page: Page): Promise<void> {
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  await page.locator(".ub-title").fill("Outline interactions");
  await placeCaret(page);
}

async function typeHeading(page: Page, level: 1 | 2 | 3, text: string): Promise<void> {
  await page.keyboard.type(`${"#".repeat(level)} ${text}`);
  await page.keyboard.press("Enter");
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
  await typeHeading(page, 2, "Install");
  await typeHeading(page, 3, "Hidden detail");
  for (let number = 3; number <= 12; number += 1) {
    const text = `Section ${number}`;
    shown.push(text);
    await typeHeading(page, 2, text);
  }
  return shown;
}

test("pointer and keyboard share one contained, stable outline", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 360 });
  await openDocument(page);

  // No eligible heading means no empty lane, trigger or popover.
  await expect(page.locator(".ub-outline")).toHaveCount(0);

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

  // Hover opens without stealing the editor's focus. The portal is a short
  // pointer crossing away; entering it before the grace expires keeps it open.
  await trigger.hover();
  const panel = page.getByRole("menu", { name: `Contents ${expected.length}` });
  await expect(panel).toBeVisible();
  expect(
    await panel.evaluate((node) => !node.contains(document.activeElement)),
  ).toBe(true);
  const rows = panel.getByRole("menuitem");
  await expect(rows).toHaveText(expected);
  await expect(panel.getByRole("menuitem", { name: "Hidden detail" })).toHaveCount(0);

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
  await panel.hover();
  await page.waitForTimeout(180);
  await expect(panel).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(panel).toBeHidden();

  // A real Tab reaches the trigger without opening the menu. Enter opens it,
  // arrow keys visit every heading in order, and Tab closes and moves onward.
  await page.locator(".ub-body").evaluate((body) => {
    const afterOutline = document.createElement("button");
    afterOutline.id = "outline-after";
    afterOutline.textContent = "After outline";
    body.append(afterOutline);
  });
  const afterOutline = page.locator("#outline-after");
  await tabTo(page, trigger);
  await expect(panel).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(rows.first()).toBeFocused();
  for (let index = 0; index < expected.length; index += 1) {
    await expect(rows.nth(index)).toBeFocused();
    if (index === 0) await expect(first).toHaveCSS("outline-width", "2px");
    if (index < expected.length - 1) await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Tab");
  await expect(afterOutline).toBeFocused();
  await expect(panel).toBeHidden();

  await page.keyboard.press("Shift+Tab");
  await expect(trigger).toBeFocused();
  await expect(panel).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();

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
    await page.keyboard.press("ArrowDown");
    await expect(second).toBeFocused();
    await page.keyboard.press(key);
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
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

test("a non-hover pointer toggles the panel and dismisses it outside", async ({
  browser,
}: {
  browser: Browser;
}) => {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 720, height: 540 });
    await openDocument(page);
    await typeHeading(page, 1, "Touch target");
    await page.getByRole("button", { name: "Hide document list" }).tap();

    const trigger = page.getByRole("button", { name: "Contents 1" });
    const panel = page.getByRole("menu", { name: "Contents 1" });
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
    await page.keyboard.press("Shift+Home");
    await page.locator(".ub-composer-open").click();
    await page.getByPlaceholder(/Comment as/).fill("a thread");
    await page.keyboard.press("Enter");
    const threads = page.locator(".ub-threads-toggle");
    await expect(threads).toBeVisible();
    await trigger.tap();
    await expect(panel).toBeVisible();
    await threads.tap();
    await expect(page.locator(".ub-rail-open")).toBeVisible();
    await expect(trigger).toBeHidden();
    await expect(panel).toBeHidden();

    // The drawer stays open across the breakpoint. If Contents opens while
    // wide, narrowing again must close its portal when CSS hides the trigger.
    await page.setViewportSize({ width: 1400, height: 540 });
    await expect(trigger).toBeVisible();
    await trigger.tap();
    await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 720, height: 540 });
    await expect(trigger).toBeHidden();
    await expect(panel).toBeHidden();
  } finally {
    await context.close();
  }
});
