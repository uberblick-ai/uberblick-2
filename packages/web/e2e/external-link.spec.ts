/** Native editor activation and selection require a real browser. */
import { expect, test } from "@playwright/test";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import type { Locator, Page } from "@playwright/test";
import { placeCaret } from "./harness.js";

const { harness } = setupHarness();

const TARGET = "https://example.invalid/external-link";
const TEXT = "before external target after";
const PILL_TARGET = "https://github.com/Example/SomeRepo/pull/12/files#diff-abc";

async function openDoc(page: Page, withPill = false): Promise<void> {
  // Every target is fulfilled locally, including the first request in a new
  // tab (a page route cannot catch that request).
  await page.context().route("https://example.invalid/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<p>External target</p>" });
  });
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, "External link activation");
  await placeCaret(page);
  await page.keyboard.type(`before [external target](${TARGET}) after${withPill ? ` and [#12](${PILL_TARGET})` : ""}`);
  if (withPill) {
    await expect(editor(page)).toContainText(TEXT);
    await expect(page.locator(".ub-github-pill")).toBeVisible();
  } else await expect(editor(page)).toHaveText(TEXT);
}

async function expectPopup(page: Page, activate: () => Promise<unknown>, target = TARGET): Promise<void> {
  const pagesBefore = page.context().pages().length;
  const [popup] = await Promise.all([
    page.context().waitForEvent("page", { timeout: 5_000 }),
    activate(),
  ]);
  try {
    await popup.waitForLoadState();
    await expect(popup).toHaveURL(target);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await popup.evaluate(() => document.referrer)).toBe("");
    expect(page.context().pages()).toHaveLength(pagesBefore + 1);
  } finally {
    await popup.close();
    await page.bringToFront();
  }
}

test("primary, Ctrl and Cmd clicks open isolated tabs while Shift-click extends selection", { tag: "@webkit" }, async ({ page }) => {
  await openDoc(page);
  const link = page.locator(".ub-editor a.ub-link");
  for (const modifiers of [[], ["Control"], ["Meta"]] as const) {
    await test.step(`${modifiers.join("+") || "Plain"} primary click`, async () => {
      // Each is a fresh single gesture. The first press of a double/triple
      // click follows the link before later presses select text.
      await page.reload();
      await expect(link).toBeVisible();
      await expectPopup(page, () => link.click({ modifiers: [...modifiers] }));
      await expect(editor(page)).toHaveText(TEXT);
    });
  }
  await page.reload();
  await expect(editor(page)).toHaveText(TEXT);
  await expect(link).toHaveAttribute("href", TARGET);
  await placeCaret(page, "start");
  await link.click({ modifiers: ["Shift"] });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toMatch(/^before e/);
  await expect(page.getByRole("toolbar", { name: "Text formatting and comment" })).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);

  // In read-only prose, Shift extends an existing native range; a fresh pane
  // has no caret or range to extend. Select outside the anchor first.
  await archiveDoc(page);
  const paragraph = page.locator(".ub-editor .ub-paragraph").first();
  const start = await textPoint(paragraph, 0);
  const end = await textPoint(paragraph, 5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");
  await link.click({ modifiers: ["Shift"] });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toMatch(/^before e/);
  expect(page.context().pages()).toHaveLength(1);
});

async function textPoint(target: Locator, offset: number): Promise<{ x: number; y: number }> {
  return target.evaluate((element, index) => {
    const text = element.firstChild;
    if (text === null || text.nodeType !== Node.TEXT_NODE) {
      throw new Error("e2e: the prose fixture has no text node");
    }
    const range = document.createRange();
    range.setStart(text, index);
    range.setEnd(text, index + 1);
    const box = range.getBoundingClientRect();
    return { x: box.x + 1, y: box.y + box.height / 2 };
  }, offset);
}

test("dragging a link selects text and the toolbar still edits its URL", { tag: "@webkit" }, async ({ page }) => {
  await openDoc(page);
  const link = page.locator(".ub-editor a.ub-link");
  const toolbar = page.getByRole("toolbar", { name: "Text formatting and comment" });
  const start = await textPoint(link, 1);
  const end = await textPoint(link, 13);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.length).toBeGreaterThan(0);
  await expect(toolbar).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);

  await page.getByRole("button", { name: "External link", exact: true }).click();
  const field = page.getByLabel("External link URL");
  await expect(field).toHaveValue(TARGET);
  await field.fill("https://example.invalid/edited-link");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator('a.ub-link[href="https://example.invalid/edited-link"]')).toHaveText(selected);
  await expect(editor(page)).toHaveText(TEXT);

  expect(page.context().pages()).toHaveLength(1);
});

async function commentSentence(page: Page): Promise<void> {
  await placeCaret(page, "start");
  await page.keyboard.press("Shift+End");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByPlaceholder(/Comment as/).fill("Link overlap conversation");
  await page.keyboard.press("Enter");
  // On a narrow viewport the closed rail has no mounted cards. The prose
  // anchor proves the comment exists without opening the drawer over the link.
  await expect(page.locator(".ub-editor [data-comment-thread]").first()).toBeVisible();
  await page.reload();
  await expect(page.locator(".ub-editor a.ub-link").first()).toBeVisible();
}

async function expectNoSelectedThread(page: Page): Promise<void> {
  await expect(page.locator('.ub-thread[aria-current="true"]')).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Threads", exact: true })).toHaveCount(0);
}

async function archiveDoc(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive document" }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
}

test("a link inside a comment wins in editable and read-only panes; other thread gestures still select", async ({ page }) => {
  await openDoc(page);
  await commentSentence(page);
  const link = page.locator(".ub-editor a.ub-link");
  await expectPopup(page, () => link.click());
  await expectNoSelectedThread(page);

  // The part of the comment highlight preceding the anchor keeps its ordinary
  // action. Reload clears transient thread focus before each independent act.
  await page.locator(".ub-editor [data-comment-thread]").first().click({ position: { x: 3, y: 5 } });
  await expect(page.locator('.ub-thread[aria-current="true"]')).toHaveCount(1);
  await page.reload();
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.locator(".ub-threads-toggle").click();
  }
  await page.locator(".ub-thread-card .ub-thread").click();
  await expect(page.locator('.ub-thread[aria-current="true"]')).toHaveCount(1);
  await page.reload();

  await archiveDoc(page);
  await page.reload();
  await expectPopup(page, () => link.click());
  await expectNoSelectedThread(page);
  await page.reload();
  await expect(link).toBeVisible();
  await link.focus();
  await expectPopup(page, () => page.keyboard.press("Enter"));
  await expectNoSelectedThread(page);
  await expect(editor(page)).toHaveText(TEXT);
});

test("touch taps follow a commented plain link and GitHub pill without opening either thread", { tag: "@webkit-touch" }, async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch !== true, "A touch-capable device supplies this input path.");
  await page.context().route("https://github.com/**", route => route.fulfill({
    contentType: "text/html", body: "<p>GitHub destination</p>",
  }));
  await openDoc(page, true);
  await commentSentence(page);
  for (const target of [TARGET, PILL_TARGET]) {
    await page.reload();
    const link = target === PILL_TARGET
      ? page.locator(".ub-github-pill")
      : page.locator(`.ub-editor a.ub-link[href="${target}"]`);
    await expect.poll(() => link.evaluate(element => element.closest("[data-comment-thread]") !== null || element.querySelector("[data-comment-thread]") !== null)).toBe(true);
    await expectPopup(page, () => link.tap(), target);
    await expectNoSelectedThread(page);
    await expect.poll(() => editor(page).evaluate(element => {
      const prose = element.cloneNode(true) as HTMLElement;
      for (const pill of prose.querySelectorAll(".ub-github-pill")) pill.remove();
      return prose.textContent;
    })).toBe(`${TEXT} and #12`);
    await expect(page.locator(".ub-github-pill")).toBeVisible();
  }
});
