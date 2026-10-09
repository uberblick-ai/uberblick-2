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

async function showSidebar(page: Page, settings = false): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) < 1280 && await drawer(page).count() === 0) {
    await page.getByRole("button", { name: settings ? "Show sidebar" : "Show document list", exact: true }).click();
  }
  await expect(page.locator(settings ? ".ub-settings-nav" : ".ub-list-head")).toBeVisible();
}

async function addGroup(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "+ group", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Group name" });
  await field.fill(name);
  await field.press("Enter");
  await expect(group(page, name)).toBeVisible();
}

async function seed(page: Page, title = "Pinned reference", groupName = "Reading"): Promise<void> {
  await showSidebar(page);
  await createDoc(page, title);
  await page.getByRole("button", { name: "Document actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin to sidebar", exact: true }).click();
  await showSidebar(page);
  await createDoc(page, "Loose note");
  await showSidebar(page);
  await addGroup(page, groupName);
}

async function expectNavigationGeometry(page: Page, controls: Locator[], coarse: boolean): Promise<void> {
  for (const control of controls) {
    await expect(control).toBeVisible();
    const reading = await control.evaluate((element) => {
      const sidebar = element.closest(".ub-list");
      if (sidebar === null) throw new Error("e2e: navigation control has no sidebar");
      const box = element.getBoundingClientRect();
      const bounds = sidebar.getBoundingClientRect();
      return { name: element.getAttribute("aria-label") ?? element.textContent,
        heading: element.classList.contains("ub-group-toggle"), height: box.height,
        minHeight: getComputedStyle(element).minHeight,
        left: box.left - bounds.left, right: bounds.right - box.right };
    });
    expect(reading.height, `${reading.name} height`).toBeGreaterThanOrEqual(coarse ? 44 : 24);
    if (!coarse && !reading.heading) {
      expect(reading.minHeight, `${reading.name} compact minimum`).toBe("34px");
      expect(reading.height, `${reading.name} compact row`).toBeLessThan(44);
    }
    expect(reading.left, `${reading.name} left edge`).toBeGreaterThanOrEqual(0);
    expect(reading.right, `${reading.name} right edge`).toBeGreaterThanOrEqual(0);
  }
  const overflowing = await page.locator(".ub-list").evaluate((sidebar) =>
    [sidebar, ...sidebar.querySelectorAll("*")]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element) => {
        const style = getComputedStyle(element);
        return [style.overflowX, style.overflowY].some((overflow) => /^(auto|scroll)$/.test(overflow))
          && element.scrollWidth > element.clientWidth;
      }).map((element) => element.className),
  );
  expect(overflowing).toEqual([]);
}

for (const { coarse, width } of [
  { coarse: true, width: 375 },
  { coarse: true, width: 1366 },
  { coarse: false, width: 1280 },
]) {
  test(`sidebar navigation rows meet the ${coarse ? "touch" : "compact pointer"} floor at ${width}px`,
    { tag: coarse && width === 375 ? "@webkit-touch" : [] }, async ({ browser }, info) => {
      const page = await openApp(browser, "/", {
        upstream: true,
        // WebKit keeps its actual phone input and viewport; Chromium proves
        // the coarse drawer and iPad landscape docked surfaces explicitly.
        contextOptions: info.project.name === "chromium"
          ? { hasTouch: coarse, isMobile: coarse, viewport: { width, height: 900 } }
          : {},
        beforeNavigate: (page) => page.emulateMedia({ reducedMotion: "reduce" }),
        readySelector: ".ub-pane",
      });
      expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(coarse);
      const title = "Pinned reference with a title long enough to truncate within its sidebar row ".repeat(3);
      const name = "Reading group with a name long enough to truncate within its heading ".repeat(3);
      await seed(page, title, name);
      if ((page.viewportSize()?.width ?? width) < 1280) await expect(drawer(page)).toBeVisible();
      else await expect(drawer(page)).toHaveCount(0);
      const activate = async (control: Locator): Promise<void> => {
        if (coarse) await control.tap();
        else await control.press("Enter");
      };
      const create = page.getByRole("button", { name: "+ new doc", exact: true });
      const allDocs = page.getByRole("button", { name: "All docs", exact: true });
      const settings = page.getByRole("button", { name: "Workspace settings", exact: true });
      const add = page.getByRole("button", { name: "+ group", exact: true });
      const headings = page.locator(".ub-group-toggle");
      const pinned = page.locator(".ub-pin-row > button");
      await expect(headings).toHaveCount(2);
      await expect(pinned).toHaveCount(1);
      await expectNavigationGeometry(page, [create, allDocs, settings, add, ...await headings.all(), ...await pinned.all()], coarse);

      // A quick activation still belongs to each enlarged drag handle.
      const heading = group(page, "Pinned").getByRole("button", { name: "Pinned", exact: true });
      await activate(heading);
      await expect(heading).toHaveAttribute("aria-expanded", "false");
      await activate(heading);
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      await expect(pinned).toHaveAttribute("title", title);
      await activate(pinned);
      await expect(page.locator(".ub-title")).toHaveValue(title);
      await showSidebar(page);
      await expect(pinned).toHaveAttribute("aria-current", "page");
      await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);

      await activate(settings);
      await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
      await showSidebar(page, true);
      const navigation = page.locator(".ub-settings-nav");
      const entries = ["General", "Tags", "Access"].map((label) =>
        navigation.getByRole("button", { name: label, exact: true }));
      await expectNavigationGeometry(page, entries, coarse);
      await expect(navigation.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-current", "page");
      await activate(navigation.getByRole("button", { name: "Access", exact: true }));
      await expect(page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
      await showSidebar(page, true);
      await expect(navigation.getByRole("button", { name: "Access", exact: true })).toHaveAttribute("aria-current", "page");
      await page.locator(".ub-settings-back").click();
      await showSidebar(page);

      // The unavailable create row shares the same floor without losing its
      // native disabled state or explanation when the direct hub disconnects.
      await harness().stopHub();
      const unavailable = page.getByRole("button", { name: "new doc unavailable", exact: true });
      await expect(unavailable).toBeDisabled();
      await expect(unavailable).toHaveAttribute("title", "New document unavailable while the directory is read-only");
      await expectNavigationGeometry(page, [unavailable], coarse);
    });
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
