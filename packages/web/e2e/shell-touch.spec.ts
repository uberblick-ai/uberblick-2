/** Input-dependent shell controls and viewport containment in the real bundle. */
import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import { createDoc, editor, setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness({ scope: "test" });

const drawer = (page: Page): Locator => page.getByRole("dialog", { name: "Sidebar", exact: true });
const group = (page: Page, name: string): Locator => page.locator(".ub-group")
  .filter({ has: page.getByRole("button", { name, exact: true }) });
const pin = (page: Page, title: string): Locator => page.locator(".ub-docs-row")
  .filter({ hasText: title }).locator(".ub-docs-pin");

async function showSidebar(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) < 1280 && await drawer(page).count() === 0) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await expect(page.locator(".ub-list-head")).toBeVisible();
}

async function addGroup(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "+ group", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Group name" });
  await field.fill(name);
  await field.press("Enter");
  await expect(group(page, name)).toBeVisible();
}

async function seed(page: Page): Promise<void> {
  await showSidebar(page);
  await createDoc(page, "Pinned reference");
  await page.getByRole("button", { name: "Document actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin to sidebar", exact: true }).click();
  await showSidebar(page);
  await createDoc(page, "Loose note");
  await showSidebar(page);
  await addGroup(page, "Reading");
}

async function rest(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "All docs", exact: true }).focus();
}

async function ownTreatment(control: Locator) {
  return control.evaluate((node) => {
    const style = getComputedStyle(node);
    return { colour: style.color, ground: style.backgroundColor };
  });
}

async function expectInsideViewport(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await expect.poll(() => control.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    return box.top >= top - 1 && box.bottom <= top + (viewport?.height ?? window.innerHeight) + 1;
  })).toBe(true);
}

async function devicePage(browser: Browser, info: TestInfo, touch = false, upstream = false): Promise<Page> {
  return openApp(browser, "/", {
    upstream,
    // WebKit inherits its project's actual device and input. Chromium supplies
    // the existing synthetic phone proof or a docked pointer surface.
    contextOptions: info.project.name === "chromium"
      ? { hasTouch: touch, viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 800 } }
      : {},
    beforeNavigate: (page) => page.emulateMedia({ reducedMotion: "reduce" }),
    readySelector: ".ub-docs",
  });
}

test("pointer rows retain their rest, hover and focus reveal, and deletion restores docked focus", async ({ browser }, info) => {
  const page = await devicePage(browser, info);
  expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);
  await seed(page);
  const heading = group(page, "Reading").locator(".ub-group-head");
  const actions = heading.locator(".ub-group-act");
  await rest(page);
  for (const action of await actions.all()) await expect(action).toHaveCSS("opacity", "0");
  await heading.hover();
  for (const action of await actions.all()) await expect(action).toHaveCSS("opacity", "1");
  const actionRest = await ownTreatment(actions.first());
  await actions.first().hover();
  expect(await ownTreatment(actions.first())).not.toEqual(actionRest);
  await rest(page);
  await heading.getByRole("button", { name: "Reading", exact: true }).focus();
  for (const action of await actions.all()) await expect(action).toHaveCSS("opacity", "1");

  await page.getByRole("button", { name: "All docs", exact: true }).click();
  const pinned = pin(page, "Pinned reference");
  const unpinned = pin(page, "Loose note");
  await rest(page);
  await expect(pinned).toHaveCSS("opacity", "1");
  await expect(unpinned).toHaveCSS("opacity", "0");
  await unpinned.locator("xpath=ancestor::tr").hover();
  await expect(unpinned).toHaveCSS("opacity", "1");
  const pinRest = await ownTreatment(unpinned);
  await unpinned.hover();
  expect(await ownTreatment(unpinned)).not.toEqual(pinRest);
  await rest(page);
  await unpinned.locator("xpath=ancestor::tr").locator(".ub-docs-open").focus();
  await expect(unpinned).toHaveCSS("opacity", "1");
  await rest(page);
  await expect(unpinned).toHaveCSS("opacity", "0");

  await heading.hover();
  await heading.getByRole("button", { name: "Delete group Reading", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Reading");
  await confirmation.getByRole("button", { name: "Delete group", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(group(page, "Reading")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ group", exact: true })).toBeFocused();
});

test("touch rows expose their actions without sticky hover, and Cancel and Delete keep the drawer open", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await devicePage(browser, info, true);
  expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
  await seed(page);
  for (const action of await page.locator(".ub-group-act").all()) {
    await expect(action).toHaveCSS("opacity", "1");
  }
  const rename = page.getByRole("button", { name: "Rename group Reading", exact: true });
  const remove = page.getByRole("button", { name: "Delete group Reading", exact: true });
  const renameRest = await ownTreatment(rename);
  const deleteRest = await ownTreatment(remove);
  await rename.tap();
  await expect(page.getByRole("textbox", { name: "Group name" })).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await ownTreatment(rename)).toEqual(renameRest);
  await expect(drawer(page)).toBeVisible();

  const confirmation = page.getByRole("alertdialog");
  await remove.tap();
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Reading");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).tap();
  await expect(confirmation).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(remove).toBeFocused();
  expect(await ownTreatment(remove)).toEqual(deleteRest);

  // The installed Radix layers may also dismiss the drawer on Escape. The
  // confirmation must still cancel without deleting the group.
  await remove.tap();
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Reading");
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await showSidebar(page);
  await expect(group(page, "Reading")).toBeVisible();
  await remove.tap();
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Reading");
  await confirmation.getByRole("button", { name: "Delete group", exact: true }).tap();
  await expect(confirmation).toHaveCount(0);
  await expect(group(page, "Reading")).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "+ group", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "All docs", exact: true }).tap();
  const pins = page.locator(".ub-docs-pin");
  await expect(pins).toHaveCount(2);
  for (const control of await pins.all()) await expect(control).toHaveCSS("opacity", "1");
  await expect(pin(page, "Pinned reference")).toHaveAttribute("aria-pressed", "true");
  const unpinned = pin(page, "Loose note");
  await expect(unpinned).toHaveAttribute("aria-pressed", "false");
  const pinRest = await ownTreatment(unpinned);
  await unpinned.tap();
  await expect(unpinned).toHaveAttribute("aria-pressed", "true");
  expect(await ownTreatment(unpinned)).toEqual(pinRest);
  await unpinned.tap();
  await expect(unpinned).toHaveAttribute("aria-pressed", "false");
  await expect(unpinned).toHaveCSS("opacity", "1");
  expect(await ownTreatment(unpinned)).toEqual(pinRest);
});

test("a Delete group confirmation refuses in place after sidebar readiness is lost in the drawer", async ({ browser }, info) => {
  // Direct hub transport makes the room read-only when that hub stops; the
  // local serving replica would remain writable while offline.
  const page = await devicePage(browser, info, true, true);
  await showSidebar(page);
  await addGroup(page, "Reading");
  await page.getByRole("button", { name: "Delete group Reading", exact: true }).tap();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Delete group Reading?");
  await harness().stopHub();
  await expect(confirmation).toContainText("Nothing has been deleted");
  await expect(confirmation.getByRole("button", { name: "Delete group", exact: true })).toBeDisabled();
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).tap();
  await expect(confirmation).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(group(page, "Reading")).toBeVisible();
});

test("the shell, sidebar, document pane and long Contents stay within the visible viewport", { tag: "@webkit" }, async ({ browser }, info) => {
  const page = await devicePage(browser, info);
  await expectInsideViewport(page.locator(".ub-app"));
  await expectInsideViewport(page.locator(".ub-pane"));
  await showSidebar(page);
  await expectInsideViewport(page.locator(".ub-list"));
  await createDoc(page, "Viewport document");
  await expectInsideViewport(page.locator(".ub-document-pane"));
  await editor(page).click();
  for (let number = 1; number <= 60; number += 1) {
    await page.keyboard.type("## ");
    await page.keyboard.insertText(`Section ${number}`);
    await expect(editor(page).locator("h2")).toHaveCount(number);
    await page.keyboard.press("Enter");
    await expect(editor(page).locator(":scope > p")).toHaveCount(1);
  }
  const trigger = page.getByRole("button", { name: "Contents 60", exact: true });
  const pane = page.locator(".ub-document-pane");
  await pane.evaluate((element) => { element.scrollTop = 0; });
  const inset = await trigger.boundingBox();
  expect(inset).not.toBeNull();
  await pane.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => (await trigger.boundingBox())?.y).toBeCloseTo(inset?.y ?? 0, 1);
  await trigger.click();
  const contents = page.locator(".ub-outline-panel");
  await expectInsideViewport(contents);
  expect(await contents.locator("ul").evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
});
