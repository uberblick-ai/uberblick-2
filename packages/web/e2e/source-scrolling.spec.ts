/** Fenced source stays aligned, scrolls inside its panel, and keeps usable chrome. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createDoc, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, trackContext } = setupHarness();
const LONG_LINE = "wide_column ".repeat(32).trimEnd();

async function openDocument(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, "Source scrolling");
  await placeCaret(page);
  await page.keyboard.insertText("Neighbor paragraph");
}

async function insertSource(page: Page, name: "Code" | "Mermaid" | "Terminal demo", text: string): Promise<void> {
  await page.locator(".ub-editor .ProseMirror > *").last().hover();
  await page.getByRole("button", { name: "Insert block below" }).click();
  await page.getByRole("option", { name, exact: true }).click();
  const selector = name === "Code" ? ".ub-code > code" : name === "Mermaid" ? ".ub-mermaid > pre" : ".ub-terminal-source";
  const source = page.locator(selector).last();
  await source.click();
  if (text !== "") await page.keyboard.insertText(text);
  await expect.poll(() => source.textContent()).toBe(text);
}

async function expectContained(page: Page): Promise<void> {
  expect(await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".ub-pane");
    if (pane === null) throw new Error("e2e: missing document pane");
    return document.documentElement.scrollWidth <= innerWidth && pane.scrollWidth <= pane.clientWidth;
  })).toBe(true);
}

/** Compare the first and last glyph of the authored line, including coloured spans. */
async function expectSingleLine(source: Locator, scroller = source): Promise<void> {
  await expect(source).toBeVisible();
  const layout = await source.evaluate((element, lineLength) => {
    const position = (offset: number): [Node, number] => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (offset <= length) return [node, offset];
        offset -= length;
      }
      throw new Error("e2e: glyph offset outside source");
    };
    const first = document.createRange();
    first.setStart(...position(0));
    first.setEnd(...position(1));
    const last = document.createRange();
    last.setStart(...position(lineLength - 1));
    last.setEnd(...position(lineLength));
    const style = getComputedStyle(element);
    return {
      firstTop: first.getBoundingClientRect().top,
      lastTop: last.getBoundingClientRect().top,
      fontSize: Number.parseFloat(style.fontSize),
      previousSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.85,
    };
  }, LONG_LINE.length);
  expect(Math.abs(layout.lastTop - layout.firstTop)).toBeLessThan(1);
  expect(layout.fontSize).toBeLessThan(layout.previousSize);
  await expect.poll(() => scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
}

async function exercisePanels(page: Page, wheel: boolean): Promise<void> {
  await openDocument(page);
  const neighbor = page.locator(".ub-editor .ProseMirror > p").first();
  const neighborWidth = await neighbor.evaluate((element) => element.getBoundingClientRect().width);
  await insertSource(page, "Code", LONG_LINE);
  const code = page.locator(".ub-code > code");
  await expectSingleLine(code);
  await insertSource(page, "Mermaid", LONG_LINE);
  const mermaid = page.locator(".ub-mermaid > pre");
  await expectSingleLine(mermaid);
  await insertSource(page, "Terminal demo", LONG_LINE);
  const terminal = page.locator(".ub-terminal-source");
  await expectSingleLine(terminal);
  await neighbor.click();
  const frame = page.locator(".ub-terminal-frame");
  const screen = page.locator(".ub-terminal-screen");
  await expectSingleLine(frame, screen);

  const fonts = await Promise.all([code, mermaid, terminal, frame].map((source) =>
    source.evaluate((element) => ({ size: getComputedStyle(element).fontSize, family: getComputedStyle(element).fontFamily }))));
  expect(fonts.every((font) => font.size === fonts[0]?.size && font.family === fonts[0]?.family)).toBe(true);
  expect(fonts[0]?.family).toMatch(/mono/i);
  expect(await neighbor.evaluate((element) => element.getBoundingClientRect().width)).toBe(neighborWidth);
  await expectContained(page);

  // Playwright's native wheel event represents a trackpad delta, not an iOS swipe.
  if (wheel) {
    await code.evaluate((element) => { element.scrollLeft = 0; });
    await code.hover();
    await page.mouse.wheel(500, 0);
    await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expectContained(page);
  }
}

test("wide fenced panels share smaller monospace type and contain horizontal scrolling", { tag: "@webkit" }, async ({ page }, info) => {
  await exercisePanels(page, info.project.use.isMobile !== true);
  await info.attach("fenced-panels", { body: await page.screenshot(), contentType: "image/png" });
});

test("wide fenced panels stay contained at iPad width", { tag: "@webkit-touch" }, async ({ browser }) => {
  const context = trackContext(await browser.newContext(devices["iPad Pro 11"]));
  await exercisePanels(await context.newPage(), false);
});

test("code preserves an empty caret and trailing spaces, reveals typed line ends, and pins copy and language", { tag: "@webkit" }, async ({ page }, info) => {
  // Observe the product's whole-source clipboard write without depending on OS permissions.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => {
        document.documentElement.setAttribute("data-copied-source", text);
      } },
    });
  });
  await openDocument(page);
  await insertSource(page, "Code", "");
  const block = page.locator(".ub-code");
  const code = block.locator(":scope > code");
  await expect(code).toBeVisible();
  // An empty block must still be a hit target that accepts real input.
  if (info.project.use.hasTouch === true) await code.tap();
  else await code.click();
  await page.keyboard.insertText("temporary");
  await code.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.keyboard.press("Backspace");
  await expect.poll(() => code.textContent()).toBe("");
  const source = `${LONG_LINE}        `;
  await page.keyboard.insertText(source);
  await expect.poll(() => code.textContent()).toBe(source);
  await page.getByRole("textbox", { name: "Code language" }).fill("text");
  await expect(block).toHaveAttribute("data-language", "text");

  // Clicking the end's laid-out glyph position must place the caret after spaces.
  await code.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  const end = await code.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) last = node;
    if (last === null) throw new Error("e2e: source has no text");
    const range = document.createRange();
    range.setStart(last, last.textContent?.length ?? 0);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2 };
  });
  if (info.project.use.hasTouch === true) await page.touchscreen.tap(end.x, end.y);
  else await page.mouse.click(end.x, end.y);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  await expect.poll(() => code.evaluate((element) => {
    const selection = document.getSelection();
    if (selection === null || !selection.isCollapsed || selection.focusNode === null || !element.contains(selection.focusNode)) return "";
    const prefix = document.createRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(selection.focusNode, selection.focusOffset);
    return prefix.toString();
  })).toBe(source);
  await code.evaluate((element) => { element.scrollLeft = 0; });
  await page.keyboard.insertText("typed");
  const edited = `${source}typed`;
  await expect.poll(() => code.textContent()).toBe(edited);
  await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => code.evaluate((element) => {
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) return false;
    const caret = range.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return caret.left >= bounds.left - 1 && caret.right <= bounds.right + 1;
  })).toBe(true);

  const copy = block.locator(".ub-copy");
  const before = await copy.boundingBox();
  const caption = await block.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { content: style.content, left: style.left, top: style.top };
  });
  expect(caption.content).toBe('"text"');
  await code.evaluate((element) => { element.scrollLeft = 0; });
  expect(await copy.boundingBox()).toEqual(before);
  await code.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  expect(await copy.boundingBox()).toEqual(before);
  expect(await block.evaluate((element) => element.scrollLeft)).toBe(0);
  expect(await block.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { content: style.content, left: style.left, top: style.top };
  })).toEqual(caption);
  await expect(copy).toBeInViewport();
  if (info.project.use.hasTouch === true) await copy.tap();
  else await copy.click();
  await expect(copy).toHaveText("copied");
  await expect(page.locator("html")).toHaveAttribute("data-copied-source", edited);
  await expectContained(page);
});
