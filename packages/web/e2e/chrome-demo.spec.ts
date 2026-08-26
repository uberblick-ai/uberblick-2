/**
 * The vendored shadcn chrome, in a real browser (#27).
 *
 * Two things are worth a browser here, and nothing else in this file is:
 *
 * - **The primitives open.** A Radix menu portals itself out of the app's
 *   subtree, traps focus and closes on Escape. jsdom will happily let all of
 *   that be broken.
 * - **The bridge resolves.** The whole adoption rests on one claim: shadcn
 *   surfaces read the same custom properties the plain-CSS surfaces do, so
 *   there is no second palette to drift. That claim is testable — the popover's
 *   painted background and its font have to *equal* the sidebar's, in both
 *   colour schemes, and they only can if `@theme` resolved to the product's
 *   tokens rather than to Tailwind's defaults.
 *
 * The page under test is `/chrome-demo.html`, a dev-server-only entry (see
 * src/dev/chrome-demo.tsx) — #74 is the first shipping consumer.
 */

import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

let started: Harness | null = null;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  started = await startHarness();
});

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

test.afterAll(async () => {
  const running = started;
  started = null;
  await running?.stop();
});

async function openDemo(
  browser: import("@playwright/test").Browser,
  colorScheme: "light" | "dark",
): Promise<Page> {
  if (started === null) throw new Error("e2e: the harness is not running");
  const context = await browser.newContext({ colorScheme });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(new URL("/chrome-demo.html", started.appUrl).href);
  await expect(page.getByRole("button", { name: "Popover" })).toBeVisible();
  return page;
}

/** What a browser actually paints for one property of one element. */
function painted(page: Page, selector: string, property: string): Promise<string> {
  return page.evaluate(
    ([sel, prop]) => {
      const element = document.querySelector(sel as string);
      if (element === null) throw new Error(`no element for ${sel}`);
      return getComputedStyle(element).getPropertyValue(prop as string);
    },
    [selector, property] as const,
  );
}

for (const scheme of ["light", "dark"] as const) {
  test(`the vendored chrome opens and matches the product's tokens — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openDemo(browser, scheme);

    // Popover: opens, and is the same surface the sidebar is.
    await page.getByRole("button", { name: "Popover" }).click();
    const popover = page.locator("[data-slot=popover-content]");
    await expect(popover).toBeVisible();
    expect(await painted(page, "[data-slot=popover-content]", "background-color")).toBe(
      await painted(page, ".ub-list", "background-color"),
    );
    expect(await painted(page, "[data-slot=popover-content]", "font-family")).toBe(
      await painted(page, ".ub-list", "font-family"),
    );
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();

    // Dropdown menu: opens, and selecting an item runs the item's action.
    await page.getByRole("button", { name: "uberblick ▾" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.getByRole("menuitem", { name: "ablauf" }).click();
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(page.getByRole("button", { name: "ablauf ▾" })).toBeVisible();

    // Dialog: opens modally over everything, and closes.
    await page.getByRole("button", { name: "Dialog" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("A modal, the same one")).toBeVisible();
    await page.getByRole("button", { name: "Close the demo dialog" }).click();
    await expect(dialog).toBeHidden();
  });
}
