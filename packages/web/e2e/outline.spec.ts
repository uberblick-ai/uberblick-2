/**
 * The floating document outline in a real browser.
 *
 * Its derived H1/H2 data stays in the unit suite. This file owns the behavior
 * only a layout and input model can prove: sticky geometry, the pointer path
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

test("pointer and keyboard share one contained, sticky outline", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 360 });
  await openDocument(page);

  // No eligible heading means no empty lane, trigger or popover.
  await expect(page.locator(".ub-outline")).toHaveCount(0);

  const expected = await typeLongOutline(page);
  const trigger = page.getByRole("button", { name: `Contents ${expected.length}` });
  await expect(trigger).toBeVisible();

  const top = (await trigger.boundingBox())?.y;
  expect(top).toBeDefined();
  await page.locator(".ub-document-pane").evaluate((pane) => {
    pane.scrollTop = pane.scrollHeight;
  });
  await expect
    .poll(async () => (await trigger.boundingBox())?.y)
    .toBeCloseTo(top ?? 0, 1);

  // Hover opens without stealing the editor's focus. The portal is a short
  // pointer crossing away; entering it before the grace expires keeps it open.
  await trigger.hover();
  const panel = page.getByRole("dialog", { name: "On this page" });
  await expect(panel).toBeVisible();
  expect(
    await panel.evaluate((node) => !node.contains(document.activeElement)),
  ).toBe(true);
  const rows = panel.getByRole("button");
  await expect(rows).toHaveText(expected);
  await expect(panel.getByRole("button", { name: "Hidden detail" })).toHaveCount(0);

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

  // Establish keyboard modality, then focus the trigger. It opens in place;
  // Tab enters the rows in document order and Escape returns home.
  await page.keyboard.press("Tab");
  await trigger.focus();
  await expect(panel).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Tab");
  await expect(second).toBeFocused();
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
  await trigger.click();
  await panel.getByRole("button", { name: "Install" }).click();
  await expect(panel).toBeHidden();
  expect(
    await page.evaluate(
      () => (window as unknown as { outlineScroll: unknown[] }).outlineScroll,
    ),
  ).toEqual([
    { id: targetId, options: { behavior: "smooth", block: "start" } },
  ]);
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
    const panel = page.getByRole("dialog", { name: "On this page" });
    await trigger.tap();
    await expect(panel).toBeVisible();
    await trigger.tap();
    await expect(panel).toBeHidden();

    await trigger.tap();
    await expect(panel).toBeVisible();
    await page.locator(".ub-title").tap();
    await expect(panel).toBeHidden();
    await expect(page.locator(".ub-title")).toBeFocused();
  } finally {
    await context.close();
  }
});
