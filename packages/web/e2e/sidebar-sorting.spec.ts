/** Real gestures, React ownership, and convergence through a private hub. */
import { expect, test as base } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { startHarness } from "./harness.js";
import { createPinnedDoc, dragOnto } from "./sidebar-helpers.js";

// Each case owns its workspace; running one test never needs an earlier test.
const test = base.extend<{ peers: [Page, Page] }>({
  peers: async ({ browser }, use) => {
    const running = await startHarness();
    const contexts = await Promise.all([browser.newContext({ hasTouch: true }), browser.newContext()]);
    const errors: string[] = [];
    try {
      const pages = await Promise.all(contexts.map(async (context) => {
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(running.appUrl);
        await expect(page.locator(".ub-list-head")).toBeVisible();
        return page;
      }));
      await use(pages as [Page, Page]);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
      await running.stop();
    }
  },
});

const group = (page: Page, name: string): Locator => page.locator(".ub-group")
  .filter({ has: page.getByRole("button", { name, exact: true }) });
const titles = (page: Page, name: string): Locator => group(page, name).locator("li:not([inert]) > button:first-child");
const handle = (page: Page, name: string): Locator => page.getByRole("button", { name: `Move document ${name}`, exact: true });
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
  await expect(target).toHaveAttribute("aria-pressed", "true");
}

async function hover(page: Page, source: Locator, target: Locator): Promise<void> {
  await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("Missing drag targets");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 8);
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
}

async function seedTwoGroups(a: Page, b: Page): Promise<void> {
  for (const title of ["alpha", "beta", "gamma"]) await createPinnedDoc(a, title);
  await addGroup(a, "Other");
  await dragOnto(a, handle(a, "gamma"), group(a, "Other").locator(".ub-group-head"));
  await expect(titles(a, "Other")).toHaveText(["gamma"]);
  await expect(titles(b, "Pinned")).toHaveText(["alpha", "beta"]);
  await expect(titles(b, "Other")).toHaveText(["gamma"]);
}

test("cross-group row drops keep React mounted and synchronize both browsers", async ({ peers: [a, b] }) => {
  await seedTwoGroups(a, b);
  await hover(a, handle(a, "alpha"), titles(a, "Other"));
  await a.mouse.up();
  for (const page of [a, b]) {
    await expect(titles(page, "Pinned")).toHaveText(["beta"]);
    await expect(titles(page, "Other")).toHaveText(["alpha", "gamma"]);
    await expect(page.locator(".ub-app")).toBeVisible();
  }
});

test("leaving a cross-group target cancels; a later peer unpin stays safe", async ({ peers: [a, b] }) => {
  await seedTwoGroups(a, b);
  await hover(a, handle(a, "alpha"), titles(a, "Other"));
  await a.mouse.move(900, 500, { steps: 16 });
  await expect(a.locator('[aria-live="polite"]')).toContainText("No drop target");
  await a.mouse.up();
  await expect(a.locator('[aria-live="polite"]')).toContainText("Cancelled moving alpha");
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
  await hover(a, handle(a, "beta"), titles(a, "Pinned").first());
  await expect(titles(a, "Pinned")).toHaveText(["beta", "alpha"]);
  await a.mouse.move(900, 500, { steps: 16 });
  await a.mouse.up();
  for (const page of [a, b]) await expect(titles(page, "Pinned")).toHaveText(["alpha", "beta"]);
  await expect(a.locator('[aria-live="polite"]')).toContainText("Cancelled moving beta");
});

test("keyboard boundaries do not wrap and adjacent moves synchronize", async ({ peers: [a, b] }) => {
  for (const title of ["alpha", "beta", "gamma"]) await createPinnedDoc(a, title);
  await expect(titles(b, "Pinned")).toHaveText(["alpha", "beta", "gamma"]);
  for (const [title, key] of [["alpha", "ArrowUp"], ["gamma", "ArrowDown"]] as const) {
    await startKeyboard(a, handle(a, title));
    await a.keyboard.press(key);
    await a.keyboard.press("Space");
    for (const page of [a, b]) await expect(titles(page, "Pinned")).toHaveText(["alpha", "beta", "gamma"]);
  }
  await startKeyboard(a, handle(a, "beta"));
  await a.keyboard.press("ArrowUp");
  await expect(titles(a, "Pinned")).toHaveText(["beta", "alpha", "gamma"]);
  await a.keyboard.press("Space");
  await expect(titles(b, "Pinned")).toHaveText(["beta", "alpha", "gamma"]);
});

test("expanded headers still accept pointer drops and keyboard uses visible rows", async ({ peers: [a, b] }) => {
  await seedTwoGroups(a, b);
  await dragOnto(a, handle(a, "alpha"), group(a, "Other").locator(".ub-group-head"));
  await expect(titles(b, "Other")).toHaveText(["gamma", "alpha"]);
  await startKeyboard(a, handle(a, "beta"));
  await a.keyboard.press("ArrowDown");
  await expect(a.locator('[aria-live="polite"]')).toContainText("Over gamma");
  await a.keyboard.press("Space");
  for (const page of [a, b]) await expect(titles(page, "Other")).toHaveText(["beta", "gamma", "alpha"]);
  await expect(handle(a, "beta")).toBeFocused();
});

test("collapsed and empty destinations, group sorting, and Escape", async ({ peers: [a, b] }) => {
  await createPinnedDoc(a, "alpha");
  await addGroup(a, "Empty");
  await group(a, "Empty").getByRole("button", { name: "Empty", exact: true }).click();
  await expect(group(a, "Empty").locator(".ub-group-body")).toHaveAttribute("inert", "");
  await dragOnto(a, handle(a, "alpha"), group(a, "Empty").locator(".ub-group-head"));
  await expect(titles(b, "Empty")).toHaveText(["alpha"]);
  const moveGroup = a.getByRole("button", { name: "Move group Empty", exact: true });
  await startKeyboard(a, moveGroup);
  await a.keyboard.press("ArrowUp");
  await expect(groups(a)).toHaveText(["Empty", "Pinned"]);
  await a.keyboard.press("Space");
  await expect(groups(b)).toHaveText(["Empty", "Pinned"]);
  await startKeyboard(a, moveGroup);
  await a.keyboard.press("ArrowDown");
  await expect(groups(a)).toHaveText(["Pinned", "Empty"]);
  await a.keyboard.press("Escape");
  for (const page of [a, b]) await expect(groups(page)).toHaveText(["Empty", "Pinned"]);
  await expect(moveGroup).toBeFocused();
});

test("a peer order change cancels the active drag without rolling back shared data", async ({ peers: [a, b] }) => {
  await addGroup(a, "First");
  await addGroup(a, "Second");
  await expect(groups(b)).toHaveText(["First", "Second"]);
  await startKeyboard(a, a.getByRole("button", { name: "Move group First", exact: true }));
  await a.keyboard.press("ArrowDown");
  await expect(groups(a)).toHaveText(["Second", "First"]);
  await expect(groups(b)).toHaveText(["First", "Second"]);
  await addGroup(b, "Peer update");
  await expect(a.locator('[aria-live="polite"]')).toContainText("Cancelled moving group First");
  for (const page of [a, b]) await expect(groups(page)).toHaveText(["First", "Second", "Peer update"]);
});

test("touch sorting reaches a collaborator", async ({ peers: [a, b] }) => {
  await addGroup(a, "First");
  await addGroup(a, "Second");
  await expect(groups(b)).toHaveText(["First", "Second"]);
  const source = a.getByRole("button", { name: "Move group Second", exact: true });
  const from = await source.boundingBox();
  const to = await group(a, "First").locator(".ub-group-head").boundingBox();
  if (!from || !to) throw new Error("Missing touch targets");
  const cdp = await a.context().newCDPSession(a);
  const touch = (x: number, y: number) => [{ x, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(from.x + from.width / 2, from.y + from.height / 2) });
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(to.x + to.width / 2, to.y + to.height / 2) });
  await expect(groups(a)).toHaveText(["Second", "First"]);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(groups(b)).toHaveText(["Second", "First"]);
});
