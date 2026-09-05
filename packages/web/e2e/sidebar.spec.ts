/**
 * The sidebar's browser-only claims: its real top-edge layout and collapse
 * focus hand-off (#611), plus a real drag seen by a *second* browser (#115).
 *
 * `test/sidebar.test.tsx` pins the data mechanics — stored order, where a drop
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

/** A fresh context: its own awareness identity and its own tab. */
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

test("the sidebar and pane share the top edge, and collapse transfers focus", async ({
  browser,
}) => {
  const page = await openApp(browser);
  await expect(page).toHaveURL(new RegExp(`/${harness().workspace}$`));
  const path = new URL(page.url()).pathname;

  await expect(page.getByRole("button", { name: "You" })).toBeVisible();
  const origins = async (): Promise<[number, number]> => {
    const sidebar = await page.locator(".ub-list").boundingBox();
    const pane = await page.locator(".ub-pane").boundingBox();
    if (sidebar === null || pane === null) throw new Error("e2e: shell is not laid out");
    return [sidebar.y, pane.y];
  };

  const geometry = () =>
    page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".ub-body");
      const sidebar = document.querySelector<HTMLElement>(".ub-list");
      const pane = document.querySelector<HTMLElement>(".ub-pane");
      if (body === null || sidebar === null || pane === null) {
        throw new Error("e2e: shell is not laid out");
      }
      const bodyBox = body.getBoundingClientRect();
      const sidebarBox = sidebar.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      return {
        position: getComputedStyle(sidebar).position,
        body: { left: bodyBox.left, right: bodyBox.right, width: bodyBox.width },
        sidebar: { left: sidebarBox.left, right: sidebarBox.right },
        pane: { left: paneBox.left, right: paneBox.right, width: paneBox.width },
      };
    });

  expect(await origins()).toEqual([0, 0]);
  await page.setViewportSize({ width: 420, height: 720 });
  expect(await origins()).toEqual([0, 0]);
  const narrow = await geometry();
  expect(narrow.position).toBe("absolute");
  expect(narrow.sidebar.left).toBeCloseTo(narrow.body.left, 1);
  expect(narrow.sidebar.right).toBeLessThan(narrow.body.right);
  expect(narrow.pane.left).toBeCloseTo(narrow.body.left, 1);
  expect(narrow.pane.right).toBeCloseTo(narrow.body.right, 1);
  expect(narrow.pane.width).toBeCloseTo(narrow.body.width, 1);

  await page.getByRole("button", { name: "Hide document list" }).click();
  await expect(page.locator(".ub-list")).toHaveCount(0);
  const restore = page.getByRole("button", { name: "Show document list" });
  await expect(restore).toBeFocused();
  const collapsedPane = await page.locator(".ub-pane").boundingBox();
  if (collapsedPane === null) throw new Error("e2e: collapsed pane is not laid out");
  expect(collapsedPane.y).toBe(0);
  expect(new URL(page.url()).pathname).toBe(path);

  await restore.click();
  await expect(page.getByRole("button", { name: "Hide document list" })).toBeFocused();
  await expect(page.getByRole("button", { name: "You" })).toBeVisible();
  expect(await origins()).toEqual([0, 0]);
  expect(new URL(page.url()).pathname).toBe(path);

  // The breakpoint changes presentation, not state: the open sidebar becomes a
  // fixed column at 768px and the same open state becomes an overlay again when
  // the window narrows, without a reload or a second gesture.
  await page.setViewportSize({ width: 768, height: 720 });
  const wide = await geometry();
  expect(wide.position).toBe("relative");
  expect(wide.pane.left).toBeCloseTo(wide.sidebar.right, 1);
  await page.setViewportSize({ width: 420, height: 720 });
  expect((await geometry()).position).toBe("absolute");

  // Settings is the other mode of this same sidebar shell. It must overlay the
  // settings pane too rather than quietly returning to a narrow fixed column.
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await expect(page.locator('.ub-list[data-mode="settings"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  const settings = await geometry();
  expect(settings.position).toBe("absolute");
  expect(settings.pane.left).toBeCloseTo(settings.body.left, 1);
  expect(settings.pane.width).toBeCloseTo(settings.body.width, 1);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${harness().workspace}$`));
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeVisible();

  // A stored preference is not a collapse gesture. Loading into it leaves
  // focus where the browser put it instead of stealing it for the restore UI.
  await page.evaluate(() =>
    localStorage.setItem("uberblick.sidebar.collapsed", "true"),
  );
  await page.reload();
  const storedRestore = page.getByRole("button", { name: "Show document list" });
  await expect(storedRestore).toBeVisible();
  await expect(storedRestore).not.toBeFocused();
  expect(new URL(page.url()).pathname).toBe(path);
});

/** Make a document and pin it — the sidebar lists what is pinned, and only that. */
async function createPinnedDoc(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  await page.locator(".ub-title").fill(title);
  const actions = page.getByRole("button", { name: "Document actions" });
  await actions.click();
  await page.getByRole("menuitem", { name: "Pin to sidebar" }).click();
  await actions.click();
  await expect(
    page.getByRole("menuitem", { name: "Unpin from sidebar" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
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
