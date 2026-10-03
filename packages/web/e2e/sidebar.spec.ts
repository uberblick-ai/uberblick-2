/** Browser layout, composed drawer input, and docked motion. */

import { expect, test } from "@playwright/test";
import { docTitle, setupHarness } from "./app-helpers.js";
import type { Locator, Page } from "@playwright/test";
import { createPinnedDoc, dragOnto } from "./sidebar-helpers.js";

const { openApp } = setupHarness({ app: { readySelector: ".ub-list-head" } });

/** The titles the sidebar lists, top to bottom. */
function pinnedTitles(page: Page): Locator {
  return page.locator(".ub-group-body li:not([inert]) > button:first-child");
}

test("the docked sidebar shares the pane's top edge and transfers focus", async ({ browser }) => {
  const page = await openApp(browser);
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeEnabled();
  const path = new URL(page.url()).pathname;
  const sidebar = page.locator(".ub-list");
  const pane = page.locator(".ub-pane");
  expect((await sidebar.boundingBox())?.y).toBe(0);
  expect((await pane.boundingBox())?.y).toBe(0);
  await page.getByRole("button", { name: "Hide document list" }).click();
  const restore = page.getByRole("button", { name: "Show document list" });
  await expect(restore).toBeFocused();
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  expect(await page.evaluate(() => localStorage.getItem("uberblick.sidebar.collapsed"))).toBe("true");
  await restore.click();
  await expect(page.getByRole("button", { name: "Hide document list" })).toBeFocused();
  await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem("uberblick.sidebar.collapsed"))).toBe("false");
  expect(new URL(page.url()).pathname).toBe(path);

  // Reading the saved preference on load is not a toggle gesture.
  await page.evaluate(() => localStorage.setItem("uberblick.sidebar.collapsed", "true"));
  await page.reload();
  await expect(restore).toBeVisible();
  await expect(restore).not.toBeFocused();
  expect(await page.locator(".ub-body").evaluate((body) => body.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSTransition).length)).toBe(0);
});

async function openDrawer(page: Page, settings = false): Promise<void> {
  await page.getByRole("button", { name: settings ? "Show sidebar" : "Show document list", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
}

test("narrowing hands sidebar focus to the opener and preserves pane focus", async ({ browser }) => {
  const page = await openApp(browser);
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeEnabled();
  const paneControl = page.locator(".ub-pane").getByRole("button", { name: "Working", exact: true });
  await page.setViewportSize({ width: 1400, height: 832 });
  await paneControl.focus();
  await page.setViewportSize({ width: 820, height: 832 });
  await expect(page.getByRole("button", { name: "Show document list", exact: true })).toBeVisible();
  await expect(paneControl).toBeFocused();

  for (const settings of [false, true]) {
    await page.setViewportSize({ width: 1400, height: 832 });
    if (settings) {
      await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
      await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: settings ? "Hide sidebar" : "Hide document list", exact: true }).focus();
    await page.setViewportSize({ width: 820, height: 832 });
    await expect(page.getByRole("button", { name: settings ? "Show sidebar" : "Show document list", exact: true })).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
  }
});

async function expectPaneClearsOpener(page: Page): Promise<{ left: number; width: number }> {
  await page.locator(".ub-body").evaluate(async (body) => {
    await Promise.all(body.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished.catch(() => undefined)));
  });
  const layout = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".ub-pane");
    const content = pane?.querySelector<HTMLElement>(":scope > .ub-column, :scope[data-settings-page] > div");
    const opener = document.querySelector<HTMLButtonElement>(".ub-sidebar-restore");
    if (!pane || !content || !opener) throw new Error("e2e: incomplete pane");
    const p = pane.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    const o = opener.getBoundingClientRect();
    return {
      paneTop: p.top,
      paneLeft: p.left,
      paneWidth: p.width,
      viewport: innerWidth,
      contentTop: c.top,
      openerBottom: o.bottom,
      reachable: document.elementFromPoint(o.left + o.width / 2, o.top + o.height / 2) === opener,
    };
  });
  expect(layout.paneLeft).toBe(0);
  expect(layout.paneWidth).toBeGreaterThan(0);
  expect(layout.paneWidth).toBeLessThanOrEqual(layout.viewport);
  // The scrollport itself clears the opener, so scrolling cannot cover prose.
  expect(layout.paneTop).toBeGreaterThanOrEqual(layout.openerBottom);
  expect(layout.contentTop).toBeGreaterThanOrEqual(layout.openerBottom);
  expect(layout.reachable).toBe(true);
  return { left: layout.paneLeft, width: layout.paneWidth };
}

test("phone, iPad and MacBook widths keep the drawer and pane controls inside the viewport", async ({ browser }) => {
  const page = await openApp(browser);
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeEnabled();
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  for (const settings of [false, true]) {
    await page.setViewportSize({ width: 1280, height: 832 });
    if (settings) {
      await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
      await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    }
    for (const width of [320, 375, 744, 932, 1024, 1279, 1280, 1366, 1470]) {
      await test.step(`${settings ? "settings" : "documents"} at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 832 });
        if (width < 1280) {
          await expect(page.getByRole("button", { name: settings ? "Show sidebar" : "Show document list", exact: true })).toBeVisible();
          const before = await expectPaneClearsOpener(page);
          await openDrawer(page, settings);
          const sidebar = await page.locator(".ub-list").boundingBox();
          const close = await page.getByRole("button", { name: settings ? "Close sidebar" : "Close document list", exact: true }).boundingBox();
          if (!sidebar || !close) throw new Error("e2e: drawer has no geometry");
          expect(sidebar.x).toBe(0);
          expect(sidebar.width).toBeLessThan(width);
          expect(close.x).toBeGreaterThanOrEqual(sidebar.x);
          expect(close.x + close.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
          const pane = await page.locator(".ub-pane").boundingBox();
          expect(pane?.x).toBe(before.left);
          expect(pane?.width).toBe(before.width);
          await expect(page.locator('[data-slot="sheet-overlay"]')).toBeVisible();
          await page.getByRole("button", { name: settings ? "Close sidebar" : "Close document list", exact: true }).click();
          await expectPaneClearsOpener(page);
        } else {
          await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
          await expect(page.locator(".ub-list")).toBeVisible();
          await expect.poll(async () => (await page.locator(".ub-pane").boundingBox())?.x).toBe(288);
        }
      });
    }
  }
});

/** Sample layout transitions only; loading animations have their own lifetime. */
async function sampleToggle(page: Page, collapse: boolean) {
  return page.evaluate(async (collapse) => {
    const body = document.querySelector<HTMLElement>(".ub-body");
    const sidebar = document.querySelector<HTMLElement>(".ub-list");
    const pane = document.querySelector<HTMLElement>(".ub-pane");
    const content = pane?.querySelector<HTMLElement>(
      ":scope > .ub-column, :scope[data-settings-page] > div",
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
    const animations = body.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSTransition);
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
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeEnabled();
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  for (const width of [1280, 1400]) {
    await page.setViewportSize({ width, height: 800 });
    // Finish any inset transition caused by the breakpoint change itself.
    await page.locator(".ub-body").evaluate((body) => {
      for (const animation of body.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSTransition)) {
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
      expect(endInset).toBe(collapse ? 64 : 32);
    }
  }
});

test("collapse isolates contents and portals immediately, and rapid reversal keeps the last state", async ({
  browser,
}) => {
  const page = await openApp(browser);
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeEnabled();
  const sidebar = page.locator(".ub-list");
  const restore = page.getByRole("button", { name: "Show document list" });
  // A portalled menu must also retire when its owning sidebar closes.
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.locator(".ub-workspace-menu")).toBeVisible();
  await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>(".ub-sidebar-hide")?.click();
    await new Promise(requestAnimationFrame);
    const animations =
      document.querySelector(".ub-body")?.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSTransition) ?? [];
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
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
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

test("reduced motion keeps docked toggles immediate", async ({ browser }) => {
  const page = await openApp(browser);
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeEnabled();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  for (const collapse of [true, false]) {
    const { frames, animated } = await sampleToggle(page, collapse);
    expect(animated).toBe(false);
    for (const frame of frames) expect(frame).toEqual(frames[0]);
    expect(frames[0]?.paneLeft).toBe(collapse ? 0 : 288);
  }
});

test("a drag reorders the sidebar, and the other browser sees the new order", async ({
  browser,
}) => {
  const first = docTitle("first");
  const second = docTitle("second");

  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await expect(a.getByRole("button", { name: "+ new doc" })).toBeEnabled();
  await expect(b.getByRole("button", { name: "+ new doc" })).toBeEnabled();
  await createPinnedDoc(a, first);
  await createPinnedDoc(a, second);
  await expect(pinnedTitles(a)).toHaveText([first, second]);

  // The sidebar is a synced document like any other, so the second browser is
  // already looking at it — nobody told it anything.
  await expect(pinnedTitles(b)).toHaveText([first, second]);

  // Dragging the row reorders it without also opening its document.
  await dragOnto(a, a.getByRole("button", { name: second, exact: true }), pinnedTitles(a).nth(0));

  await expect(pinnedTitles(a)).toHaveText([second, first]);
  await expect(pinnedTitles(b)).toHaveText([second, first]);
});

test("the drawer's menus, group editing and pointer, keyboard and touch sorting work with a hidden docked preference", async ({ browser }) => {
  const page = await openApp(browser, "/", { contextOptions: { hasTouch: true } });
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeEnabled();
  const first = docTitle("drawer-first");
  const second = docTitle("drawer-second");
  await createPinnedDoc(page, first);
  await createPinnedDoc(page, second);
  await page.getByRole("button", { name: "Hide document list" }).click();
  await page.setViewportSize({ width: 820, height: 832 });
  await openDrawer(page);
  const drawer = page.getByRole("dialog", { name: "Sidebar", exact: true });

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.locator(".ub-workspace-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeVisible();
  await page.getByRole("button", { name: "You", exact: true }).click();
  await expect(page.locator(".ub-user-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeVisible();

  const groups = page.locator(".ub-group-label");
  const before = await groups.allTextContents();
  await page.getByRole("button", { name: "+ group", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Group name" });
  await field.fill("Cancelled draft");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(groups).toHaveText(before);
  await expect(drawer).toBeVisible();

  const name = docTitle("drawer-group");
  const renamed = `${name}-renamed`;
  await page.getByRole("button", { name: "+ group", exact: true }).click();
  await field.fill(name);
  await field.press("Enter");
  await page.getByRole("button", { name: `Rename group ${name}`, exact: true }).click();
  await field.fill("Cancelled rename");
  await field.press("Escape");
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(drawer).toBeVisible();
  await page.getByRole("button", { name: `Rename group ${name}`, exact: true }).click();
  await field.fill(renamed);
  await field.press("Enter");
  const group = page.getByRole("button", { name: renamed, exact: true });
  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toBeVisible();

  const selectedTitles = pinnedTitles(page).filter({ hasText: new RegExp(`${first}|${second}`) });
  const row = (title: string) => page.getByRole("button", { name: title, exact: true });
  const path = new URL(page.url()).pathname;
  await dragOnto(page, row(second), selectedTitles.filter({ hasText: first }));
  await expect(selectedTitles).toHaveText([second, first]);
  await expect(drawer).toBeVisible();

  await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
  await row(first).focus();
  await page.keyboard.press("Space");
  await expect(row(first).locator('xpath=ancestor::*[@data-dnd-dragging="true"][1]')).toHaveCount(1);
  const announcements = page.locator('body > [role="status"]');
  await expect(announcements).not.toHaveAttribute("aria-hidden", "true");
  await expect(announcements).toContainText(`Moving ${first}.`);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(selectedTitles).toHaveText([first, second]);
  await expect(row(first)).toBeFocused();
  expect(new URL(page.url()).pathname).toBe(path);
  await expect(drawer).toBeVisible();
  await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
  await row(first).focus();
  await page.keyboard.press("Space");
  await expect(row(first).locator('xpath=ancestor::*[@data-dnd-dragging="true"][1]')).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(selectedTitles).toHaveText([second, first]);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
  await expect(selectedTitles).toHaveText([first, second]);
  await expect(row(first)).toBeFocused();
  await expect(drawer).toBeVisible();

  const from = await row(second).boundingBox();
  const to = await selectedTitles.filter({ hasText: first }).boundingBox();
  if (!from || !to) throw new Error("e2e: missing touch targets");
  const cdp = await page.context().newCDPSession(page);
  try {
    const touch = (x: number, y: number) => [{ x, y, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(from.x + from.width / 2, from.y + from.height / 2) });
    await expect(row(second).locator('xpath=ancestor::*[@data-dnd-dragging="true"][1]')).toHaveCount(1);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(to.x + to.width / 2, to.y + to.height / 2) });
    await expect(selectedTitles).toHaveText([second, first]);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await expect(drawer).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(path);
  expect(await page.evaluate(() => localStorage.getItem("uberblick.sidebar.collapsed"))).toBe("true");
  await page.getByRole("button", { name: "Close document list", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show document list", exact: true })).toBeFocused();
});
