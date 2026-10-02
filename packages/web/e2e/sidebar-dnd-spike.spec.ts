/**
 * The sidebar's browser-only claims: its real top-edge layout and collapse
 * focus hand-off (#611), plus a real drag seen by a *second* browser (#115).
 *
 * `test/sidebar.test.tsx` pins the data mechanics — stored order, where a drop
 * lands, an agent's pin arriving live, the keyboard path — over shared Y.Docs
 * and the drop adapter. What it cannot prove is that a pointer gesture on
 * a real page starts a dnd-kit drag, and that the result travels the hub
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
  const context = await browser.newContext({ hasTouch: true, recordVideo: { dir: "/private/tmp/sidebar-dnd-video" } });
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
  return page.locator(".ub-group-body li > button:first-child");
}

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

/** Drag from the dedicated handle with real pointer events. */
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


async function addGroup(page: Page, name: string): Promise<Locator> {
  await page.getByRole("button", { name: "+ group", exact: true }).click();
  await page.getByRole("textbox", { name: "Group name" }).fill(name);
  await page.getByRole("textbox", { name: "Group name" }).press("Enter");
  const group = page.locator(".ub-group").filter({ has: page.getByRole("button", { name, exact: true }) });
  await expect(group).toBeVisible();
  return group;
}

async function keyboardMove(page: Page, handle: Locator, key: string): Promise<void> {
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press(key);
  await page.waitForTimeout(200);
  await page.keyboard.press("Space");
}

test("keyboard sorting, group sorting, collapsed and empty destinations, and Escape", async ({ browser }) => {
  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  const first = docTitle("alpha");
  const second = docTitle("beta");
  await createPinnedDoc(a, first);
  await createPinnedDoc(a, second);
  await keyboardMove(a, a.getByRole("button", { name: `Move document ${second}`, exact: true }), "ArrowUp");
  await expect(pinnedTitles(a)).toHaveText([second, first]);
  await expect(pinnedTitles(b)).toHaveText([second, first]);
  const empty = await addGroup(a, "Empty");
  await empty.getByRole("button", { name: "Empty", exact: true }).click();
  await expect(empty.locator(".ub-group-body")).toHaveAttribute("inert", "");
  await dragOnto(a, a.getByRole("button", { name: `Move document ${first}`, exact: true }), empty.locator(".ub-group-head"));
  await empty.getByRole("button", { name: "Empty", exact: true }).click();
  await expect(empty.locator("li > button:first-child")).toHaveText([first]);
  await expect(b.locator(".ub-group").last().locator("li > button:first-child")).toHaveText([first]);
  await keyboardMove(a, a.getByRole("button", { name: "Move group Empty", exact: true }), "ArrowUp");
  await expect(a.locator(".ub-group-label")).toHaveText(["Empty", "Pinned"]);
  await expect(b.locator(".ub-group-label")).toHaveText(["Empty", "Pinned"]);
  const handle = a.getByRole("button", { name: "Move group Empty", exact: true });
  await handle.focus();
  await a.keyboard.press("Space");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await a.keyboard.press("ArrowDown");
  await a.waitForTimeout(200);
  await a.keyboard.press("Escape");
  await expect(a.locator(".ub-group-label")).toHaveText(["Empty", "Pinned"]);
  await expect(b.locator(".ub-group-label")).toHaveText(["Empty", "Pinned"]);
  await expect(handle).toBeFocused();
  await a.screenshot({ path: "/private/tmp/sidebar-dnd-after.png" });
});

test("a collaborator ordering update cancels a drag without rolling back their update", async ({ browser }) => {
  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await expect(a.locator(".ub-group-label")).toHaveText(["Empty", "Pinned"]);
  const before = await a.locator(".ub-group-label").allTextContents();
  const handle = a.getByRole("button", { name: "Move group Empty", exact: true });
  await handle.focus();
  await a.keyboard.press("Space");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await a.keyboard.press("ArrowDown");
  await expect(a.locator(".ub-group:not([inert]) .ub-group-label")).toHaveText(["Pinned", "Empty"]);
  await expect(b.locator(".ub-group-label")).toHaveText(before);
  await addGroup(b, "Peer update");
  await expect(a.locator(".ub-group-label")).toHaveText([...before, "Peer update"]);
  await expect(a.locator('[aria-live="polite"]')).toContainText("Cancelled moving group Empty");
  await a.keyboard.press("ArrowDown");
  await a.keyboard.press("Escape");
  await expect(a.locator(".ub-group-label")).toHaveText([...before, "Peer update"]);
  await expect(b.locator(".ub-group-label")).toHaveText([...before, "Peer update"]);
});

test("touch handle sorting reaches the collaborator", async ({ browser }) => {
  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  const source = a.getByRole("button", { name: "Move group Peer update", exact: true });
  const target = a.locator(".ub-group-head").first();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error("Missing touch targets");
  const cdp = await a.context().newCDPSession(a);
  const touch = (x: number, y: number) => [{ x, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(from.x + from.width / 2, from.y + from.height / 2) });
  await a.waitForTimeout(300);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(to.x + to.width / 2, to.y + to.height / 2) });
  await a.waitForTimeout(100);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(a.locator(".ub-group-label")).toHaveText(["Peer update", "Empty", "Pinned"]);
  await expect(b.locator(".ub-group-label")).toHaveText(["Peer update", "Empty", "Pinned"]);
});
