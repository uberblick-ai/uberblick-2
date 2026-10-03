/** Real gestures, React ownership, and convergence through a private hub. */
import { expect, test as base } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { setupHarness } from "./app-helpers.js";
import { createPinnedDoc, dragOnto } from "./sidebar-helpers.js";

// Exact ordering proofs need each case to begin with an empty sidebar.
const { openApp } = setupHarness({ scope: "test" });

const test = base.extend<{ peers: [Page, Page] }>({
  peers: async ({ browser }, use) => {
    const errors: string[] = [];
    const beforeNavigate = async (page: Page): Promise<void> => {
      page.on("pageerror", (error) => errors.push(error.message));
    };
    const pages = await Promise.all([
      openApp(browser, "/", { contextOptions: { hasTouch: true }, beforeNavigate, readySelector: ".ub-list-head" }),
      openApp(browser, "/", { beforeNavigate, readySelector: ".ub-list-head" }),
    ]);
    await use(pages as [Page, Page]);
    expect(errors).toEqual([]);
  },
});

const group = (page: Page, name: string): Locator => page.locator(".ub-group")
  .filter({ has: page.getByRole("button", { name, exact: true }) });
const titles = (page: Page, name: string): Locator => group(page, name).locator("li:not([inert]) > button:first-child");
const row = (page: Page, name: string): Locator => page.getByRole("button", { name, exact: true });
const groups = (page: Page): Locator => page.locator(".ub-group:not([inert]) .ub-group-label");

async function addGroup(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "+ group", exact: true }).click();
  await page.getByRole("textbox", { name: "Group name" }).fill(name);
  await page.getByRole("textbox", { name: "Group name" }).press("Enter");
  await expect(group(page, name)).toBeVisible();
}

async function startKeyboard(page: Page, target: Locator): Promise<void> {
  await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
  await target.focus();
  await page.keyboard.press("Space");
  await expect(target.locator('xpath=ancestor::*[@data-dnd-dragging="true"][1]')).toHaveCount(1);
}

async function hover(page: Page, source: Locator, target: Locator): Promise<void> {
  await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("Missing drag targets");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 8);
  await expect(source.locator('xpath=ancestor::*[@data-dnd-dragging="true"][1]')).toHaveCount(1);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
}

async function seedTwoGroups(a: Page, b: Page): Promise<void> {
  for (const title of ["alpha", "beta", "gamma"]) await createPinnedDoc(a, title);
  await addGroup(a, "Other");
  await dragOnto(a, row(a, "gamma"), group(a, "Other").locator(".ub-group-head"));
  await expect(titles(a, "Other")).toHaveText(["gamma"]);
  await expect(titles(b, "Pinned")).toHaveText(["alpha", "beta"]);
  await expect(titles(b, "Other")).toHaveText(["gamma"]);
}

test("stationary mouse holds and Enter retain the rows' own actions", async ({ peers: [a] }) => {
  for (const title of ["alpha", "beta"]) await createPinnedDoc(a, title);
  await row(a, "alpha").click({ delay: 650 });
  await expect(a.locator(".ub-title")).toHaveValue("alpha");
  const heading = row(a, "Pinned");
  await heading.click({ delay: 650 });
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await heading.focus();
  await a.keyboard.press("Enter");
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  await row(a, "beta").focus();
  await a.keyboard.press("Enter");
  await expect(a.locator(".ub-title")).toHaveValue("beta");
  await expect(a.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
});

for (const width of [1400, 820]) {
  test(`held touch releases and cancellations preserve row actions at ${width}px`, async ({ peers: [a, b] }) => {
    for (const title of ["alpha", "beta"]) await createPinnedDoc(a, title);
    await expect(titles(b, "Pinned")).toHaveText(["alpha", "beta"]);
    await a.setViewportSize({ width, height: 832 });
    const drawer = a.getByRole("dialog", { name: "Sidebar", exact: true });
    const openDrawer = async (): Promise<void> => {
      if (width < 1280) {
        await a.getByRole("button", { name: "Show document list", exact: true }).click();
        await expect(drawer).toBeVisible();
      }
    };
    await openDrawer();
    const cdp = await a.context().newCDPSession(a);
    const tap = async (target: Locator): Promise<void> => {
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (!box) throw new Error("Missing touch row");
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const releaseHeld = async (target: Locator, label: string, ending: "drop" | "escape" | "touchCancel"): Promise<void> => {
      await expect(a.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
      await target.focus();
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (!box) throw new Error("Missing held touch row");
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }],
      });
      await expect(target.locator('xpath=ancestor::*[@data-dnd-dragging="true"][1]')).toHaveCount(1);
      if (ending === "escape") {
        await a.keyboard.press("Escape");
        await expect(a.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
      }
      // No touchMove: the native click after releasing in place is the regression.
      await cdp.send("Input.dispatchTouchEvent", {
        type: ending === "touchCancel" ? "touchCancel" : "touchEnd", touchPoints: [],
      });
      await expect(a.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
      await expect(a.locator('body > [role="status"]')).toContainText(
        ending === "drop" ? `Kept ${label} in place.` : `Cancelled moving ${label}.`,
      );
    };
    try {
      for (const canceled of [false, true]) {
        const path = new URL(a.url()).pathname;
        const heading = row(a, "Pinned");
        await releaseHeld(heading, "group Pinned", canceled ? "escape" : "drop");
        await expect(heading).toHaveAttribute("aria-expanded", "true");
        expect(new URL(a.url()).pathname).toBe(path);
        if (width < 1280) await expect(drawer).toBeVisible();

        // The guard must clear for a new deliberate activation, including a
        // keyboard action after cancellation without an intervening pointer.
        if (canceled) await heading.press("Enter");
        else await tap(heading);
        await expect(heading).toHaveAttribute("aria-expanded", "false");
        await tap(heading);
        await expect(heading).toHaveAttribute("aria-expanded", "true");
        if (width < 1280) await expect(drawer).toBeVisible();

        const document = row(a, "alpha");
        await releaseHeld(document, "alpha", canceled ? "escape" : "drop");
        await expect(a.locator(".ub-title")).toHaveValue("beta");
        expect(new URL(a.url()).pathname).toBe(path);
        if (width < 1280) await expect(drawer).toBeVisible();
        for (const page of [a, b]) await expect(titles(page, "Pinned")).toHaveText(["alpha", "beta"]);

        if (canceled) await document.press("Enter");
        else await tap(document);
        await expect(a.locator(".ub-title")).toHaveValue("alpha");
        expect(new URL(a.url()).pathname).not.toBe(path);
        if (width < 1280) await expect(drawer).toHaveCount(0);
        await openDrawer();
        await tap(row(a, "beta"));
        await expect(a.locator(".ub-title")).toHaveValue("beta");
        if (width < 1280) await expect(drawer).toHaveCount(0);
        await openDrawer();
      }
      // touchCancel emits no click, so the next keyboard/touch interaction must
      // work even with an unconsumed guard left by the previous gesture.
      const heading = row(a, "Pinned");
      await releaseHeld(heading, "group Pinned", "touchCancel");
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      await heading.press("Enter");
      await expect(heading).toHaveAttribute("aria-expanded", "false");
      await tap(heading);
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      if (width < 1280) await expect(drawer).toBeVisible();
    } finally {
      await cdp.detach();
    }
  });
}

test("group actions and selecting a rename draft never pick up a group", async ({ peers: [a, b] }) => {
  await addGroup(a, "First");
  await addGroup(a, "Second");
  await expect(groups(b)).toHaveText(["First", "Second"]);
  const pressMoveRelease = async (action: Locator): Promise<void> => {
    await action.hover();
    const box = await action.boundingBox();
    if (!box) throw new Error("Missing group action");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await a.mouse.down();
    await a.mouse.move(x - 40, y, { steps: 8 });
    await expect(a.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
    await a.mouse.move(x, y, { steps: 8 });
    await a.mouse.up();
  };
  await pressMoveRelease(a.getByRole("button", { name: "Rename group Second", exact: true }));
  const field = a.getByRole("textbox", { name: "Group name" });
  await expect(field).toBeFocused();
  await field.press("End");
  await field.press("Space");
  await field.pressSequentially("renamed");
  await expect(field).toHaveValue("Second renamed");
  const box = await field.boundingBox();
  if (!box) throw new Error("Missing rename field");
  await a.mouse.move(box.x + 8, box.y + box.height / 2);
  await a.mouse.down();
  await a.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 12 });
  await a.mouse.up();
  await expect.poll(() => field.evaluate((element: HTMLInputElement) => (element.selectionEnd ?? 0) - (element.selectionStart ?? 0))).toBeGreaterThan(0);
  await expect(a.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
  await expect(groups(b)).toHaveText(["First", "Second"]);
  await field.press("Enter");
  await expect(groups(b)).toHaveText(["First", "Second renamed"]);
  await pressMoveRelease(a.getByRole("button", { name: "Delete group Second renamed", exact: true }));
  for (const page of [a, b]) await expect(groups(page)).toHaveText(["First"]);
});

test("cross-group row drops keep React mounted and synchronize both browsers", async ({ peers: [a, b] }) => {
  await seedTwoGroups(a, b);
  const path = new URL(a.url()).pathname;
  await hover(a, row(a, "alpha"), titles(a, "Other"));
  await a.mouse.up();
  expect(new URL(a.url()).pathname).toBe(path);
  for (const page of [a, b]) {
    await expect(titles(page, "Pinned")).toHaveText(["beta"]);
    await expect(titles(page, "Other")).toHaveText(["alpha", "gamma"]);
    await expect(page.locator(".ub-app")).toBeVisible();
  }
});

test("leaving a cross-group target cancels; a later peer unpin stays safe", async ({ peers: [a, b] }) => {
  await seedTwoGroups(a, b);
  const path = new URL(a.url()).pathname;
  await hover(a, row(a, "alpha"), titles(a, "Other"));
  await a.mouse.move(900, 500, { steps: 16 });
  await expect(a.locator('body > [role="status"]')).toContainText("No drop target");
  await a.mouse.up();
  await expect(a.locator('body > [role="status"]')).toContainText("Cancelled moving alpha");
  expect(new URL(a.url()).pathname).toBe(path);
  for (const page of [a, b]) {
    await expect(titles(page, "Pinned")).toHaveText(["alpha", "beta"]);
    await expect(titles(page, "Other")).toHaveText(["gamma"]);
  }
  await titles(b, "Pinned").filter({ hasText: "alpha" }).click();
  await b.getByRole("button", { name: "Document actions" }).click();
  await b.getByRole("menuitem", { name: "Unpin from sidebar" }).click();
  for (const page of [a, b]) await expect(titles(page, "Pinned")).toHaveText(["beta"]);
});

test("leaving an in-group target restores the optimistic order", async ({ peers: [a, b] }) => {
  for (const title of ["alpha", "beta"]) await createPinnedDoc(a, title);
  await expect(titles(b, "Pinned")).toHaveText(["alpha", "beta"]);
  await hover(a, row(a, "beta"), titles(a, "Pinned").first());
  await expect(titles(a, "Pinned")).toHaveText(["beta", "alpha"]);
  const first = await titles(a, "Pinned").first().boundingBox();
  if (!first) throw new Error("Missing preview row");
  // Leave straight up: crossing alpha on the way out would undo the preview
  // before release and let this test pass even without the cancellation fix.
  await a.mouse.move(first.x + first.width / 2, 2, { steps: 16 });
  await expect(a.locator('body > [role="status"]')).toContainText("No drop target");
  await expect(titles(a, "Pinned")).toHaveText(["beta", "alpha"]);
  await expect(titles(b, "Pinned")).toHaveText(["alpha", "beta"]);
  await a.mouse.up();
  for (const page of [a, b]) await expect(titles(page, "Pinned")).toHaveText(["alpha", "beta"]);
  await expect(a.locator('body > [role="status"]')).toContainText("Cancelled moving beta");
});

test("keyboard boundaries do not wrap and adjacent moves synchronize", async ({ peers: [a, b] }) => {
  for (const title of ["alpha", "beta", "gamma"]) await createPinnedDoc(a, title);
  await expect(titles(b, "Pinned")).toHaveText(["alpha", "beta", "gamma"]);
  for (const [title, key] of [["alpha", "ArrowUp"], ["gamma", "ArrowDown"]] as const) {
    await startKeyboard(a, row(a, title));
    await a.keyboard.press(key);
    await a.keyboard.press("Space");
    for (const page of [a, b]) await expect(titles(page, "Pinned")).toHaveText(["alpha", "beta", "gamma"]);
  }
  await startKeyboard(a, row(a, "beta"));
  const path = new URL(a.url()).pathname;
  await a.keyboard.press("ArrowUp");
  await expect(titles(a, "Pinned")).toHaveText(["beta", "alpha", "gamma"]);
  await a.keyboard.press("Enter");
  await expect(titles(b, "Pinned")).toHaveText(["beta", "alpha", "gamma"]);
  await expect(row(a, "beta")).toBeFocused();
  expect(new URL(a.url()).pathname).toBe(path);
});

test("expanded headers still accept pointer drops and keyboard uses visible rows", async ({ peers: [a, b] }) => {
  await seedTwoGroups(a, b);
  await dragOnto(a, row(a, "alpha"), group(a, "Other").locator(".ub-group-head"));
  await expect(titles(b, "Other")).toHaveText(["gamma", "alpha"]);
  await startKeyboard(a, row(a, "beta"));
  await a.keyboard.press("ArrowDown");
  await expect(a.locator('body > [role="status"]')).toContainText("Over gamma");
  await a.keyboard.press("Space");
  for (const page of [a, b]) await expect(titles(page, "Other")).toHaveText(["beta", "gamma", "alpha"]);
  await expect(row(a, "beta")).toBeFocused();
});

test("collapsed and empty destinations, group sorting, and Escape", async ({ peers: [a, b] }) => {
  await createPinnedDoc(a, "alpha");
  await addGroup(a, "Empty");
  await group(a, "Empty").getByRole("button", { name: "Empty", exact: true }).click();
  await expect(group(a, "Empty").locator(".ub-group-body")).toHaveAttribute("inert", "");
  await dragOnto(a, row(a, "alpha"), group(a, "Empty").locator(".ub-group-head"));
  await expect(titles(b, "Empty")).toHaveText(["alpha"]);
  const moveGroup = a.getByRole("button", { name: "Empty", exact: true });
  await startKeyboard(a, moveGroup);
  await a.keyboard.press("ArrowUp");
  await expect(groups(a)).toHaveText(["Empty", "Pinned"]);
  await a.keyboard.press("Space");
  await expect(groups(b)).toHaveText(["Empty", "Pinned"]);
  await expect(moveGroup).toHaveAttribute("aria-expanded", "false");
  await startKeyboard(a, moveGroup);
  await a.keyboard.press("ArrowDown");
  await expect(groups(a)).toHaveText(["Pinned", "Empty"]);
  await a.keyboard.press("Escape");
  for (const page of [a, b]) await expect(groups(page)).toHaveText(["Empty", "Pinned"]);
  await expect(moveGroup).toBeFocused();
  await expect(moveGroup).toHaveAttribute("aria-expanded", "false");
});

test("a peer order change cancels the active drag without rolling back shared data", async ({ peers: [a, b] }) => {
  await addGroup(a, "First");
  await addGroup(a, "Second");
  await expect(groups(b)).toHaveText(["First", "Second"]);
  await startKeyboard(a, a.getByRole("button", { name: "First", exact: true }));
  await a.keyboard.press("ArrowDown");
  await expect(groups(a)).toHaveText(["Second", "First"]);
  await expect(groups(b)).toHaveText(["First", "Second"]);
  await addGroup(b, "Peer update");
  await expect(a.locator('body > [role="status"]')).toContainText("Cancelled moving group First");
  for (const page of [a, b]) await expect(groups(page)).toHaveText(["First", "Second", "Peer update"]);
});

test("touch sorting reaches a collaborator", async ({ peers: [a, b] }) => {
  await addGroup(a, "First");
  await addGroup(a, "Second");
  await expect(groups(b)).toHaveText(["First", "Second"]);
  const source = a.getByRole("button", { name: "Second", exact: true });
  const from = await source.boundingBox();
  const to = await group(a, "First").locator(".ub-group-head").boundingBox();
  if (!from || !to) throw new Error("Missing touch targets");
  const cdp = await a.context().newCDPSession(a);
  const touch = (x: number, y: number) => [{ x, y, id: 1 }];
  try {
    for (const expanded of ["false", "true"]) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(from.x + from.width / 2, from.y + from.height / 2) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(source).toHaveAttribute("aria-expanded", expanded);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(from.x + from.width / 2, from.y + from.height / 2) });
    await expect(source.locator('xpath=ancestor::*[@data-dnd-dragging="true"][1]')).toHaveCount(1);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(to.x + to.width / 2, to.y + to.height / 2) });
    await expect(groups(a)).toHaveText(["Second", "First"]);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await expect(groups(b)).toHaveText(["Second", "First"]);
  await expect(source).toHaveAttribute("aria-expanded", "true");
});

test("a touch swipe scrolls from a row, while a held drag keeps native scrolling still", async ({ peers: [a, b] }) => {
  await a.setViewportSize({ width: 1280, height: 500 });
  const names = Array.from({ length: 16 }, (_, index) => `Document ${index}`);
  for (const name of names) await createPinnedDoc(a, name);
  await expect(titles(b, "Pinned")).toHaveText(names);
  const pane = a.locator('.ub-sidebar-pane:not([inert]) [data-slot="sidebar-content"]');
  await pane.evaluate((element) => { element.scrollTop = 0; });
  // Pick actual visible rows: navigation above the pins can change height.
  // Leave room for the 120px swipe and stay clear of drag edge auto-scroll.
  const visibleNames = await titles(a, "Pinned").evaluateAll((buttons) => {
    const bounds = buttons[0]?.closest('[data-slot="sidebar-content"]')?.getBoundingClientRect();
    if (!bounds) throw new Error("Missing touch scroll pane");
    const top = Math.max(bounds.top, 0);
    const bottom = Math.min(bounds.bottom, window.innerHeight);
    return buttons.filter((button) => {
      const box = button.getBoundingClientRect();
      return box.top >= top && box.bottom <= bottom
        && box.y + box.height / 2 >= top + 120
        && box.y + box.height / 2 <= bottom - 60;
    }).map((button) => button.textContent ?? "");
  });
  const tappedName = visibleNames[visibleNames.length - 2];
  const swipedName = visibleNames[visibleNames.length - 1];
  if (tappedName === undefined || swipedName === undefined) throw new Error("Missing visible touch rows");
  const tap = row(a, tappedName);
  const swipe = row(a, swipedName);
  const tapped = await tap.boundingBox();
  if (!tapped) throw new Error("Missing touch row");
  const cdp = await a.context().newCDPSession(a);
  const touch = (x: number, y: number) => [{ x, y, id: 1 }];
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(tapped.x + tapped.width / 2, tapped.y + tapped.height / 2) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(a.locator(".ub-title")).toHaveValue(tappedName);
    const path = new URL(a.url()).pathname;
    const from = await swipe.boundingBox();
    if (!from) throw new Error("Missing swipe row");
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    await pane.evaluate((element) => {
      element.dataset.touchScrollEnded = "false";
      element.addEventListener("scrollend", () => { element.dataset.touchScrollEnded = "true"; }, { once: true });
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(x, y) });
    for (let step = 1; step <= 4; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(x, y - step * 30) });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(pane).toHaveAttribute("data-touch-scroll-ended", "true");
    await expect(a.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
    await expect(titles(a, "Pinned")).toHaveText(names);
    await expect(row(a, "Pinned")).toHaveAttribute("aria-expanded", "true");
    expect(new URL(a.url()).pathname).toBe(path);

    await pane.evaluate((element) => { element.scrollTop = 0; });
    const held = await swipe.boundingBox();
    if (!held) throw new Error("Missing held touch row");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(held.x + held.width / 2, held.y + held.height / 2) });
    await expect(swipe.locator('xpath=ancestor::*[@data-dnd-dragging="true"][1]')).toHaveCount(1);
    const top = await pane.evaluate((element) => element.scrollTop);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(held.x + held.width / 2, held.y + held.height / 2 - 40) });
    await expect(titles(a, "Pinned")).not.toHaveText(names);
    // Observe several rendered frames after the preview has moved, so delayed
    // native scrolling cannot evade an immediate scrollTop read.
    const offsets = await pane.evaluate(async (element) => {
      const values: number[] = [];
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        values.push(element.scrollTop);
      }
      return values;
    });
    expect(offsets.every((offset) => offset === top)).toBe(true);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect(a.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
    for (const page of [a, b]) await expect(titles(page, "Pinned")).toHaveText(names);
    expect(new URL(a.url()).pathname).toBe(path);
  } finally {
    await cdp.detach();
  }
});
