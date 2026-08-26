/**
 * The sidebar's one claim jsdom cannot host (#115): a real drag, in a real
 * browser, seen by a *second* browser.
 *
 * `test/sidebar.test.tsx` pins everything else — stored order, where a drop
 * lands, an agent's pin arriving live, the keyboard path — over shared Y.Docs
 * and dispatched drag events. What it cannot prove is that a pointer gesture on
 * a real page starts a native drag at all, and that the result travels the hub
 * to somebody else's screen. That is this file, and nothing else belongs in it.
 */

import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

let started: Harness | null = null;
const contexts: BrowserContext[] = [];

function harness(): Harness {
  if (started === null) {
    throw new Error("e2e: the harness is not running — its bootstrap failed");
  }
  return started;
}

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

/** A fresh context: its own IndexedDB, its own awareness identity, its own tab. */
async function openApp(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  return page;
}

/** Unique per run: every test in the file shares one workspace. */
function docTitle(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The titles the sidebar lists, top to bottom. */
function pinnedTitles(page: Page): Locator {
  return page.locator(".ub-group-body li button");
}

/** Make a document and pin it — the sidebar lists what is pinned, and only that. */
async function createPinnedDoc(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  await page.locator(".ub-title").fill(title);
  await page.locator(".ub-pin-toggle").click();
  await expect(page.locator(".ub-pin-toggle")).toHaveAttribute("aria-pressed", "true");
}

/**
 * Drag `source` onto `target` with the real mouse.
 *
 * Steps rather than `dragTo`, for one reason: the drop slots take the pointer
 * only while a drag is in flight, so an actionability check on the target
 * *before* the drag has started would find it unhittable. The nudge inside the
 * source is what makes Chromium synthesise a drag at all — a press followed by
 * a jump straight to the target is swallowed as a click.
 */
async function dragOnto(page: Page, source: Locator, target: Locator): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error("e2e: nothing to drag");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 5);
  const x = to.x + to.width / 2;
  const y = to.y + to.height / 2;
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.move(x, y);
  await page.mouse.up();
}

test("a drag reorders the sidebar, and the other browser sees the new order", async ({
  browser,
}) => {
  const first = docTitle("first");
  const second = docTitle("second");

  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await createPinnedDoc(a, first);
  await createPinnedDoc(a, second);
  await expect(pinnedTitles(a)).toHaveText([first, second]);

  // The sidebar is a synced document like any other, so the second browser is
  // already looking at it — nobody told it anything.
  await expect(pinnedTitles(b)).toHaveText([first, second]);

  // The pointer gesture: the second document, onto the insertion point above
  // the first. The slots are the sidebar's first and last children of the
  // group's list, one per position.
  const slots = a.locator(".ub-group-body .ub-drop-slot");
  await dragOnto(a, pinnedTitles(a).nth(1), slots.nth(0));

  await expect(pinnedTitles(a)).toHaveText([second, first]);
  await expect(pinnedTitles(b)).toHaveText([second, first]);
});
