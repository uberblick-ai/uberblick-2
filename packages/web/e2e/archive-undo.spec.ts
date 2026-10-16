import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { activateControl, createDoc, docButton, docTitle, editor, setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness();

function archivedNotice(page: Page, title: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: `Archived “${title}”.` });
}

async function archive(page: Page, title: string): Promise<Locator> {
  await activateControl(page.getByRole("button", { name: "Document actions" }));
  await activateControl(page.getByRole("menuitem", { name: "Archive document", exact: true }));
  const dialog = page.getByRole("alertdialog", { name: `Archive “${title}”?` });
  await activateControl(dialog.getByRole("button", { name: "Archive", exact: true }));
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  const notice = archivedNotice(page, title);
  await expect(notice).toHaveCount(1);
  await expect(notice.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  return notice;
}

for (const input of ["pointer", "keyboard"] as const) {
  test(`archive Undo restores its original document after navigation — ${input}`, async ({ browser }) => {
    const page = await openApp(browser, "/", {
      upstream: true,
      contextOptions: { viewport: { width: 1440, height: 900 } },
      readySelector: ".ub-workspace",
    });
    const other = docTitle("Keep reading");
    await createDoc(page, other, { pin: true });
    const title = docTitle("Archive then undo");
    const uuid = await createDoc(page, title, { pin: true });
    const notice = await archive(page, title);
    await expect(docButton(page, title)).toHaveCount(0);
    await docButton(page, other).click();
    await expect(page.locator(".ub-title")).toHaveValue(other);
    const undo = notice.getByRole("button", { name: "Undo", exact: true });
    if (input === "keyboard") {
      await page.keyboard.press("Shift+F8");
      await expect(page.locator("[data-sonner-toaster]")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(notice).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(notice.getByRole("button", { name: "Dismiss notification" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(undo).toBeFocused();
      await page.keyboard.press("Enter");
    } else await undo.click();
    await expect(notice).toHaveCount(0);
    await expect(page.locator(".ub-title")).toHaveValue(other);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(docButton(page, title)).toHaveCount(0);
    await expect(docButton(page, other)).toBeVisible();

    await page.goto(new URL(`/${harness().workspace}/${uuid}`, harness().appUrl).href);
    await expect(page.locator(".ub-title")).toHaveValue(title);
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await page.getByRole("button", { name: "Document actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Pin to sidebar", exact: true })).toBeVisible();
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`archive Undo has a usable iPad touch target — ${colorScheme}`, { tag: "@webkit-touch" }, async ({ browser }) => {
    const page = await openApp(browser, "/", {
      upstream: true,
      contextOptions: { viewport: { width: 1024, height: 1366 }, hasTouch: true, isMobile: true, colorScheme },
      readySelector: ".ub-pane",
    });
    await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
    const title = docTitle(`Touch Undo ${colorScheme}`);
    await createDoc(page, title);
    const notice = await archive(page, title);
    const undo = notice.getByRole("button", { name: "Undo", exact: true });
    const box = await undo.boundingBox();
    if (box === null) throw new Error("e2e: Undo has no touch target");
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
    await undo.tap();
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });
}

test("an archive in another tab shows the banner without offering Undo here", async ({ browser }) => {
  const page = await openApp(browser, "/", { upstream: true, readySelector: ".ub-workspace" });
  const title = docTitle("Remote archive");
  await createDoc(page, title);
  const peer = await openApp(browser, new URL(page.url()).pathname, { upstream: true, readySelector: ".ub-title" });
  await expect(peer.locator(".ub-title")).toHaveValue(title);
  await archive(peer, title);
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await expect(archivedNotice(page, title)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
});

test("Undo refused by a lost connection leaves the document archived and keeps recovery visible", async ({ browser }) => {
  const page = await openApp(browser, "/", { upstream: true, readySelector: ".ub-workspace" });
  const title = docTitle("Disconnected Undo");
  await createDoc(page, title);
  const notice = await archive(page, title);
  await notice.hover();
  try {
    await harness().stopHub();
    const restore = page.getByRole("button", { name: /^Restore(?: unavailable)?$/ });
    await expect(restore).toBeDisabled();
    await notice.getByRole("button", { name: "Undo", exact: true }).click();
    const failure = page.locator("[data-sonner-toast]").filter({
      hasText: `“${title}” is still archived. Open its link and choose Restore when the connection is ready.`,
    });
    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute("data-type", "error");
    await page.mouse.move(0, 0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(restore).toBeDisabled();
    await page.waitForTimeout(6500);
    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute("data-removed", "false");
    await harness().startHub();
    await expect(restore).toBeEnabled();
    await restore.click();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await failure.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(failure).toHaveCount(0);
  } finally {
    await harness().startHub();
  }
});
