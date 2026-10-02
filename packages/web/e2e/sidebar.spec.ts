/**
 * The sidebar's browser-only claims: its real top-edge layout and collapse
 * focus hand-off (#611), plus a real drag seen by a *second* browser (#115).
 *
 * `test/sidebar.test.tsx` pins the data mechanics — stored order, where a drop
 * lands, an agent's pin arriving live, the keyboard path — over shared Y.Docs
 * and dispatched drag events. The browser also proves continuous shell motion,
 * reduced motion, focus and isolation, which depend on real layout and input.
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
        body: { left: bodyBox.left, right: bodyBox.right, width: bodyBox.width },
        sidebar: { left: sidebarBox.left, right: sidebarBox.right },
        pane: { left: paneBox.left, right: paneBox.right, width: paneBox.width },
      };
    });

  expect(await origins()).toEqual([0, 0]);
  await page.setViewportSize({ width: 420, height: 720 });
  expect(await origins()).toEqual([0, 0]);
  const narrow = await geometry();
  expect(narrow.sidebar.left).toBeCloseTo(narrow.body.left, 1);
  expect(narrow.sidebar.right).toBeLessThan(narrow.body.right);
  expect(narrow.pane.left).toBeCloseTo(narrow.body.left, 1);
  expect(narrow.pane.right).toBeCloseTo(narrow.body.right, 1);
  expect(narrow.pane.width).toBeCloseTo(narrow.body.width, 1);

  await page.getByRole("button", { name: "Hide document list" }).click();
  await expect(page.locator(".ub-list")).toBeHidden();
  const restore = page.getByRole("button", { name: "Show document list" });
  await expect(restore).toBeFocused();
  await expect(restore).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => localStorage.getItem("uberblick.sidebar.collapsed"))).toBe("true");
  const collapsedPane = await page.locator(".ub-pane").boundingBox();
  if (collapsedPane === null) throw new Error("e2e: collapsed pane is not laid out");
  expect(collapsedPane.y).toBe(0);
  expect(new URL(page.url()).pathname).toBe(path);

  await restore.click();
  await expect(page.getByRole("button", { name: "Hide document list" })).toBeFocused();
  await expect(page.getByRole("button", { name: "You" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("uberblick.sidebar.collapsed"))).toBe("false");
  expect(await origins()).toEqual([0, 0]);
  expect(new URL(page.url()).pathname).toBe(path);

  // The breakpoint changes presentation, not state: the open sidebar becomes a
  // fixed column at 768px and the same open state becomes an overlay again when
  // the window narrows, without a reload or a second gesture.
  await page.setViewportSize({ width: 768, height: 720 });
  const wide = await geometry();
  expect(wide.pane.left).toBeCloseTo(wide.sidebar.right, 1);
  await page.setViewportSize({ width: 420, height: 720 });
  const narrowAgain = await geometry();
  expect(narrowAgain.pane.left).toBeCloseTo(narrowAgain.body.left, 1);
  expect(narrowAgain.pane.width).toBeCloseTo(narrowAgain.body.width, 1);

  // Settings is the other mode of this same sidebar shell. It must overlay the
  // settings pane too rather than quietly returning to a narrow fixed column.
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await expect(page.locator('.ub-list[data-mode="settings"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  const settings = await geometry();
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
  expect(await page.locator(".ub-body").evaluate((body) =>
    body.getAnimations({ subtree: true }).length,
  )).toBe(0);
  expect(new URL(page.url()).pathname).toBe(path);
});

/** Sample real CSS transitions at fixed times, without racing a 180ms clock. */
async function sampleToggle(page: Page, collapse: boolean) {
  return page.evaluate(async (collapse) => {
    const body = document.querySelector<HTMLElement>(".ub-body");
    const sidebar = document.querySelector<HTMLElement>(".ub-list");
    const pane = document.querySelector<HTMLElement>(".ub-pane");
    const content = pane?.querySelector<HTMLElement>(
      ":scope > .ub-column, :scope > .ub-settings-column",
    );
    const toggle = document.querySelector<HTMLButtonElement>(
      collapse ? ".ub-sidebar-hide" : ".ub-sidebar-restore",
    );
    if (!body || !sidebar || !pane || !content || !toggle) {
      throw new Error("e2e: shell is incomplete");
    }
    const reading = () => {
      const s = sidebar.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      const c = content.getBoundingClientRect();
      return {
        sidebarRight: s.right,
        sidebarWidth: s.width,
        paneLeft: p.left,
        paneTop: p.top,
        paneWidth: p.width,
        paneHeight: p.height,
        contentLeft: c.left,
        contentTop: c.top,
      };
    };
    const before = reading();
    toggle.click();
    await new Promise(requestAnimationFrame);
    const animations = body.getAnimations({ subtree: true });
    for (const animation of animations) animation.pause();
    const frames = [0, 45, 90, 135, 180].map((time) => {
      for (const animation of animations) animation.currentTime = time;
      return reading();
    });
    for (const animation of animations) animation.finish();
    return { before, frames, animated: animations.length > 0 };
  }, collapse);
}

test("desktop edges and document inset move together in both directions", async ({
  browser,
}) => {
  const page = await openApp(browser);
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-document-pane > .ub-column")).toBeVisible();
  for (const width of [768, 1400]) {
    await page.setViewportSize({ width, height: 800 });
    // Finish any inset transition caused by the breakpoint change itself.
    await page.locator(".ub-body").evaluate((body) => {
      for (const animation of body.getAnimations({ subtree: true })) {
        animation.finish();
      }
    });
    for (const collapse of [true, false]) {
      const { before, frames, animated } = await sampleToggle(page, collapse);
      expect(animated).toBe(true);
      const end = frames[frames.length - 1];
      if (!end) throw new Error("e2e: no final frame");
      const startInset = before.contentLeft - before.paneLeft;
      const endInset = end.contentLeft - end.paneLeft;
      for (const frame of frames) {
        expect(frame.paneLeft).toBeCloseTo(frame.sidebarRight, 1);
        expect(frame.sidebarWidth).toBeCloseTo(before.sidebarWidth, 1);
        const progress =
          (frame.paneLeft - before.paneLeft) / (end.paneLeft - before.paneLeft);
        expect(frame.contentLeft - frame.paneLeft).toBeCloseTo(
          startInset + (endInset - startInset) * progress,
          1,
        );
      }
      expect(frames[1]?.paneLeft).not.toBeCloseTo(before.paneLeft, 1);
      expect(frames[1]?.paneLeft).not.toBeCloseTo(end.paneLeft, 1);
      expect(end.paneLeft).toBeCloseTo(collapse ? 0 : before.sidebarWidth, 1);
      expect(endInset).toBe(collapse ? 64 : width === 768 ? 16 : 32);
    }
  }
});

test("narrow drawer and restore clearance move together over a stationary pane", async ({
  browser,
}) => {
  const page = await openApp(browser);
  await page.setViewportSize({ width: 420, height: 720 });
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-document-pane > .ub-column")).toBeVisible();
  for (const settings of [false, true]) {
    if (settings) {
      await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
      await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
    }
    for (const collapse of [true, false]) {
      const { before, frames, animated } = await sampleToggle(page, collapse);
      expect(animated).toBe(true);
      const end = frames[frames.length - 1];
      if (!end) throw new Error("e2e: no final frame");
      expect(end.contentTop - before.contentTop).toBeCloseTo(collapse ? 44 : -44, 1);
      expect(end.contentTop).toBe(collapse ? 56 : 12);
      await expect(page.locator(collapse ? ".ub-sidebar-restore" : ".ub-sidebar-hide")).toBeFocused();
      for (const frame of frames) {
        expect(frame.paneLeft).toBe(0);
        expect(frame.paneTop).toBe(0);
        expect(frame.paneWidth).toBe(420);
        expect(frame.paneHeight).toBe(720);
        const progress =
          (frame.sidebarRight - before.sidebarRight) /
          (end.sidebarRight - before.sidebarRight);
        expect(frame.contentTop).toBeCloseTo(
          before.contentTop + (end.contentTop - before.contentTop) * progress,
          1,
        );
      }
      expect(frames[1]?.sidebarRight).not.toBeCloseTo(before.sidebarRight, 1);
      expect(frames[1]?.sidebarRight).not.toBeCloseTo(end.sidebarRight, 1);
    }
  }
});

test("collapse isolates contents and portals immediately, and rapid reversal keeps the last state", async ({
  browser,
}) => {
  const page = await openApp(browser);
  const sidebar = page.locator(".ub-list");
  const restore = page.getByRole("button", { name: "Show document list" });
  // A portalled menu must also retire when its owning sidebar closes.
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.locator(".ub-workspace-menu")).toBeVisible();
  await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>(".ub-sidebar-hide")?.click();
    await new Promise(requestAnimationFrame);
    const animations =
      document.querySelector(".ub-body")?.getAnimations({ subtree: true }) ?? [];
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 60;
    }
  });
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".ub-workspace-menu")).toHaveCount(0);
  await expect(restore).toBeFocused();
  expect(await page.locator("body").ariaSnapshot()).not.toContain('navigation "Documents"');
  await sidebar.locator(".ub-sidebar-hide").evaluate((button: HTMLButtonElement) => {
    button.focus();
  });
  await expect(restore).toBeFocused();
  for (let step = 0; step < 5; step += 1) {
    await page.keyboard.press("Tab");
    expect(await sidebar.evaluate((s) => s.contains(document.activeElement))).toBe(false);
  }
  // Use keyboard activation, which can restore even while the old edge moves.
  await restore.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Hide document list" })).toBeFocused();
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    document.querySelector<HTMLButtonElement>(".ub-sidebar-hide")?.click();
  });
  await expect(restore).toBeFocused();
  await expect(sidebar).toBeHidden();
  await expect.poll(() =>
    page.locator(".ub-pane").evaluate((p) => p.getBoundingClientRect().left),
  ).toBe(0);
  await restore.click();
  await expect(sidebar).toBeVisible();
  await expect.poll(() =>
    page.locator(".ub-pane").evaluate((p) => p.getBoundingClientRect().left),
  ).toBe(288);
  await page.getByRole("button", { name: "You" }).click();
  await expect(page.locator(".ub-user-panel")).toBeVisible();
  await sidebar.locator(".ub-sidebar-hide").evaluate((button: HTMLButtonElement) => {
    button.click();
  });
  await expect(page.locator(".ub-user-panel")).toHaveCount(0);
  await expect(restore).toBeFocused();
});

test("reduced motion toggles immediately on desktop and narrow screens", async ({
  browser,
}) => {
  const page = await openApp(browser);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-document-pane > .ub-column")).toBeVisible();
  for (const width of [1400, 420]) {
    await page.setViewportSize({ width, height: 720 });
    for (const collapse of [true, false]) {
      const { before, frames, animated } = await sampleToggle(page, collapse);
      expect(animated).toBe(false);
      for (const frame of frames) expect(frame).toEqual(frames[0]);
      if (width < 768) {
        expect((frames[0]?.contentTop ?? 0) - before.contentTop).toBeCloseTo(collapse ? 44 : -44, 1);
      } else {
        expect(frames[0]?.paneLeft).toBe(collapse ? 0 : 288);
      }
    }
  }
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
