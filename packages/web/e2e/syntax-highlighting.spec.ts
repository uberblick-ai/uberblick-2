/**
 * Syntax colouring in the browser (#922).
 *
 * The jsdom contract test owns document invariants and grammar routing. This
 * proof owns token ink, native focus and key events, and touch operation of
 * the code block's language control.
 */

import { devices, expect, test } from "@playwright/test";
import { createDoc, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";
import type { Locator, Page, TestInfo } from "@playwright/test";

const { harness, trackContext } = setupHarness();

async function ink(element: Locator): Promise<string> {
  return element.evaluate((node) => getComputedStyle(node).color);
}

async function openDocument(page: Page, title: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, title);
  await placeCaret(page);
}

async function insertCode(page: Page, text: string): Promise<Locator> {
  await page.locator(".ub-editor .ProseMirror > *").last().hover();
  await page.getByRole("button", { name: "Insert block below" }).click();
  await page.getByRole("option", { name: "Code", exact: true }).click();
  await page.keyboard.insertText(text);
  const block = page.locator(".ub-code").last();
  await expect(block.locator(":scope > code")).toHaveText(text);
  const id = await block.getAttribute("id");
  if (id === null) throw new Error("e2e: missing code block id");
  return page.locator(`.ub-code[id="${id}"]`);
}

/** Native selection is setup; the next key still follows the browser's tab order. */
async function focusCode(source: Locator): Promise<void> {
  await source.evaluate((element) => {
    const editor = element.closest(".ProseMirror");
    if (!(editor instanceof HTMLElement)) throw new Error("e2e: missing editor");
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await source.page().evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

function languageControl(page: Page): Locator {
  return page.getByRole("button", { name: "Code language", exact: true });
}

function languageSearch(page: Page): Locator {
  return page.getByRole("combobox", { name: "Search languages", exact: true });
}

async function chooseLanguage(page: Page, name: string): Promise<void> {
  await languageControl(page).click();
  await languageSearch(page).fill(name);
  await page.getByRole("option", { name, exact: true }).click();
  await expect(languageSearch(page)).toHaveCount(0);
  await expect(page.locator(".ub-editor .ProseMirror")).toBeFocused();
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

async function expectCompactDropdown(page: Page): Promise<void> {
  const search = languageSearch(page);
  const popover = page.locator('[data-slot="popover-content"]').filter({ has: search });
  await expect(search).toBeInViewport();
  await expect.poll(() => popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    return rect.left >= left - 1 && rect.top >= top - 1 &&
      rect.right <= left + (viewport?.width ?? innerWidth) + 1 &&
      rect.bottom <= top + (viewport?.height ?? innerHeight) + 1;
  })).toBe(true);
  const list = popover.getByRole("listbox", { name: "Code languages", exact: true });
  await expect(list).toHaveCSS("overflow-y", "auto");
  expect(await list.evaluate((element) =>
    element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  )).toBeLessThanOrEqual(15);
}

test("code tokens follow the appearance and real Enter inserts a newline", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openDocument(page, "syntax highlighting");
  const block = await insertCode(page, "const answer = 42;");
  await chooseLanguage(page, "typescript");
  const source = block.locator("code");
  const keyword = block.locator(".hljs-keyword").first();
  const lightKeyword = await ink(keyword);
  expect(lightKeyword).not.toBe(await ink(source));

  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "dark"),
  );
  await expect.poll(() => ink(keyword)).not.toBe(lightKeyword);
  expect(await ink(keyword)).not.toBe(await ink(source));

  await source.click();
  // Match the harness's caret setup: let the focus sync settle, then let
  // End's selectionchange reach the editor before sending the real Enter.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  await page.keyboard.press("End");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.keyboard.press("Enter");
  await page.keyboard.type("return answer;", { delay: 15 });
  await expect(source).toHaveText("const answer = 42;\nreturn answer;");
});

test("the block language is keyboard reachable, filters, cancels and returns typing to the code", { tag: "@webkit" }, async ({ page, browserName }, info) => {
  await openDocument(page, "keyboard code language");
  const block = await insertCode(page, "const answer = 42;");
  const source = block.locator(":scope > code");
  const language = languageControl(page);
  // Safari's native Option-Tab includes buttons when its Tab preference only
  // visits text fields. This preserves the browser's own keyboard navigation.
  const nextControl = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await expect(language).toContainText("Plain text");
  await expect(block.locator(".ub-code-caption")).toContainText("Plain text");
  await expect(page.locator(".ub-toolbar")).toHaveCount(0);
  await capture(page, info, "code-language-desktop-closed");

  await focusCode(source);
  await page.keyboard.press(nextControl);
  await expect(language).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(languageSearch(page)).toBeFocused();
  await expectCompactDropdown(page);
  await expect(page.getByRole("option", { name: "Plain text", exact: true })).toHaveCount(1);
  await expect(page.getByRole("option", { name: "plaintext", exact: true })).toHaveCount(0);
  await capture(page, info, "code-language-desktop-open");
  await languageSearch(page).fill("typescript");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(block).toHaveAttribute("data-language", "typescript");
  await expect(block.locator(".hljs-keyword").first()).toHaveText("const");
  await expect(page.locator(".ub-editor .ProseMirror")).toBeFocused();
  await page.keyboard.insertText(" // continued");
  await expect(source).toHaveText("const answer = 42; // continued");

  await page.keyboard.press(nextControl);
  await expect(language).toBeFocused();
  await page.keyboard.press("Enter");
  await languageSearch(page).fill("python");
  await page.keyboard.press("Escape");
  await expect(languageSearch(page)).toHaveCount(0);
  await expect(block).toHaveAttribute("data-language", "typescript");
  await expect(page.locator(".ub-editor .ProseMirror")).toBeFocused();

  await chooseLanguage(page, "Plain text");
  await expect(block).toHaveAttribute("data-language", "");
  await expect(block.locator(".hljs-keyword")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(block).toHaveAttribute("data-language", "typescript");
  await expect(source).toHaveText("const answer = 42; // continued");
});

test("an open language menu keeps its own block after a peer shifts positions", async ({ page, browser }) => {
  await openDocument(page, "language block identity");
  await page.keyboard.insertText("neighbor paragraph");
  const target = await insertCode(page, "const answer = 42;");
  const targetId = await target.getAttribute("id");
  if (targetId === null) throw new Error("e2e: missing code block id");
  const other = await insertCode(page, "let untouched = 9;");
  const otherLanguage = await other.getAttribute("data-language");
  await focusCode(target.locator(":scope > code"));
  await languageControl(page).click();
  await languageSearch(page).fill("python");

  const peerContext = trackContext(await browser.newContext());
  const peer = await peerContext.newPage();
  await peer.goto(page.url());
  const peerNeighbor = peer.locator(".ub-editor .ProseMirror > p").first();
  await expect(peerNeighbor).toHaveText("neighbor paragraph");
  await focusCode(peerNeighbor);
  await peer.keyboard.insertText(" before the code".repeat(8));
  await expect(page.locator(".ub-editor .ProseMirror > p").first()).toContainText("before the code");
  // The peer's inserted text shifts positions while the picker keeps focus.
  // Changing a browser selection into another editable block also focuses it,
  // which correctly dismisses a standard Popover before a pick is possible.
  await page.getByRole("option", { name: "python", exact: true }).click();
  await expect(page.locator(`.ub-code[id="${targetId}"]`)).toHaveAttribute("data-language", "python");
  await expect.poll(() => other.getAttribute("data-language")).toBe(otherLanguage);
  await expect(target.locator(":scope > code")).toHaveText("const answer = 42;");
  await expect(other.locator(":scope > code")).toHaveText("let untouched = 9;");
});

for (const deviceName of ["iPhone 13", "iPad Pro 11"] as const) {
  test(`the code language control opens, filters and picks by touch on ${deviceName}`, { tag: "@webkit-touch" }, async ({ browser }, info) => {
    const context = trackContext(await browser.newContext(devices[deviceName]));
    const page = await context.newPage();
    await openDocument(page, `touch code language ${deviceName}`);
    const block = await insertCode(page, "const answer = 42;");
    const source = block.locator(":scope > code");
    await source.tap();
    const language = languageControl(page);
    await expect(language).toBeVisible();
    const bounds = await language.boundingBox();
    const blockBounds = await block.boundingBox();
    if (bounds === null || blockBounds === null) throw new Error("e2e: missing code header geometry");
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.y).toBeGreaterThanOrEqual(blockBounds.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(blockBounds.y + blockBounds.height);
    await capture(page, info, `code-language-${deviceName}-closed`);
    await language.tap();
    await expect(languageSearch(page)).toBeFocused();
    await expectCompactDropdown(page);
    await capture(page, info, `code-language-${deviceName}-open`);
    await languageSearch(page).fill("typescript");
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.getByRole("option", { name: "typescript", exact: true }).tap();
    await expect(block).toHaveAttribute("data-language", "typescript");
    await expect(block.locator(".hljs-keyword").first()).toHaveText("const");
    await expect(languageSearch(page)).toHaveCount(0);
    await expect(page.locator(".ub-editor .ProseMirror")).toBeFocused();
    await page.keyboard.insertText(" // touch");
    await expect(source).toContainText("// touch");
  });
}
