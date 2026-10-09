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
  for (const [index, line] of text.split("\n").entries()) {
    if (index > 0) {
      await page.keyboard.press("Enter");
      // WebKit's native range can lag the editor's newline transaction. Wait
      // for the caret before sending the next fixture line to insertText.
      const prefix = `${text.split("\n").slice(0, index).join("\n")}\n`;
      await expect.poll(() => source.evaluate((element) => {
        const selection = document.getSelection();
        if (selection === null || !selection.isCollapsed || selection.focusNode === null ||
          !element.contains(selection.focusNode)) return null;
        const beforeCaret = document.createRange();
        beforeCaret.selectNodeContents(element);
        beforeCaret.setEnd(selection.focusNode, selection.focusOffset);
        return beforeCaret.toString();
      })).toBe(prefix);
    }
    if (line !== "") await page.keyboard.insertText(line);
  }
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

async function expectSourceControl(control: Locator, source: Locator, floor: number): Promise<void> {
  await expect(control).toBeVisible();
  const button = await control.boundingBox();
  const textTop = await source.evaluate((element) => {
    const first = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
    if (first === null) throw new Error("e2e: missing source text");
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(first, 1);
    return range.getBoundingClientRect().top;
  });
  if (button === null) throw new Error("e2e: missing source-control geometry");
  expect(button.width).toBeGreaterThanOrEqual(floor);
  expect(button.height).toBeGreaterThanOrEqual(floor);
  expect(button.y + button.height).toBeLessThanOrEqual(await source.evaluate((element) => element.getBoundingClientRect().top));
  expect(button.y + button.height).toBeLessThanOrEqual(textTop);
}

async function expectPinned(control: Locator, scroller: Locator): Promise<void> {
  await scroller.scrollIntoViewIfNeeded();
  await scroller.evaluate((element) => { element.scrollLeft = 0; });
  const before = await control.boundingBox();
  await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await control.boundingBox()).toEqual(before);
}

async function exerciseSourceTargets(page: Page, touch: boolean): Promise<void> {
  await openDocument(page);
  expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(touch);
  const floor = touch ? 44 : 24;
  for (const [name, selector] of [
    ["Code", ".ub-code > code"],
    ["Mermaid", ".ub-mermaid > pre"],
    ["Terminal demo", ".ub-terminal-source"],
  ] as const) {
    await insertSource(page, name, LONG_LINE);
    const source = page.locator(selector);
    const copy = source.locator("..").locator(":scope > .ub-copy");
    await expectSourceControl(copy, source, floor);
    await expectPinned(copy, source);
    if (name === "Code") {
      const language = page.getByRole("button", { name: "Code language" });
      const copyBox = await copy.boundingBox();
      const languageBox = await language.boundingBox();
      if (copyBox === null || languageBox === null) throw new Error("e2e: missing code language geometry");
      expect(languageBox.x + languageBox.width).toBeLessThanOrEqual(copyBox.x);
      const labelCenter = (control: Locator) => control.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element.querySelector("span") ?? element);
        const label = range.getBoundingClientRect();
        return label.top + label.height / 2;
      });
      expect(Math.abs(await labelCenter(language) - await labelCenter(copy))).toBeLessThanOrEqual(1);
    }
  }

  // Playback chrome stays outside the same scrolling screen as the frame.
  await page.locator(".ub-editor .ProseMirror > p").first().click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const toggle = page.locator(".ub-terminal-toggle");
  await expect(toggle).toHaveText("Pause");
  await expect.poll(() => page.locator(".ub-terminal-frame").textContent()).toContain(LONG_LINE);
  if (touch) await toggle.tap();
  else await toggle.click();
  await expect(toggle).toHaveText("Play");
  const frame = page.locator(".ub-terminal-frame");
  await expectSourceControl(toggle, frame, floor);
  const copy = page.locator(".ub-terminal > .ub-copy");
  await expectSourceControl(copy, frame, floor);
  for (const control of [toggle, copy]) await expectPinned(control, page.locator(".ub-terminal-screen"));
  if (touch) await toggle.tap();
  else {
    await toggle.focus();
    await page.keyboard.press("Enter");
  }
  await expect(toggle).toHaveText("Pause");
  await expectContained(page);
}

test("source controls meet fine-pointer floors without covering source or scrolling with it", { tag: "@webkit" }, async ({ page }) => {
  test.skip(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches), "fine-pointer proof");
  await exerciseSourceTargets(page, false);
});

test("source controls meet iPad touch floors without covering source or scrolling with it", { tag: "@webkit-touch" }, async ({ browser }) => {
  const context = trackContext(await browser.newContext(devices["iPad Pro 11"]));
  await exerciseSourceTargets(await context.newPage(), true);
});

async function editorSelection(page: Page) {
  return page.locator(".ub-editor .ProseMirror").evaluate((editor) => {
    const selection = document.getSelection();
    return {
      focused: document.activeElement === editor,
      anchor: selection?.anchorNode?.textContent,
      anchorOffset: selection?.anchorOffset,
      focus: selection?.focusNode?.textContent,
      focusOffset: selection?.focusOffset,
      text: selection?.toString(),
    };
  });
}

async function exerciseSourceCopy(page: Page, touch: boolean): Promise<void> {
  await openDocument(page);
  const sourceText = `${LONG_LINE}\nsecond line with trailing spaces    `;
  const notices = page.locator("[data-sonner-toast]:not([data-removed=true])");
  for (const name of ["Code", "Mermaid", "Terminal demo"] as const) await insertSource(page, name, sourceText);
  for (const path of ["clipboard", "selection"] as const) {
    // Record the product's clipboard boundary; OS clipboard permissions are
    // outside this proof. The fallback must use a focused, fully selected field.
    await page.evaluate((mode) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: mode === "clipboard" ? { writeText: async (text: string) => {
          document.documentElement.setAttribute("data-copied-source", text);
        } } : undefined,
      });
      document.execCommand = (command: string): boolean => {
        const field = document.activeElement;
        if (command !== "copy" || !(field instanceof HTMLTextAreaElement) ||
          field.selectionStart !== 0 || field.selectionEnd !== field.value.length) return false;
        document.documentElement.setAttribute("data-copied-source", field.value);
        return true;
      };
    }, path);
    for (const selector of [".ub-code > code", ".ub-mermaid > pre", ".ub-terminal-source"]) {
      const source = page.locator(selector);
      // Clicking a drawn terminal opens its editable transcript.
      if (selector === ".ub-terminal-source" && !await source.isVisible()) await page.locator(".ub-terminal-screen").click();
      await source.scrollIntoViewIfNeeded();
      const copy = source.locator("..").locator(":scope > .ub-copy");
      for (const collapsed of [true, false]) {
        await page.locator(".ub-editor .ProseMirror").focus();
        await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
        await source.evaluate((element, caretOnly) => {
          const first = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
          if (first === null) throw new Error("e2e: missing source text");
          const range = document.createRange();
          range.setStart(first, 0);
          range.setEnd(first, caretOnly ? 0 : 4);
          const selection = document.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }, collapsed);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        const before = await editorSelection(page);
        expect(before.focused).toBe(true);
        expect(before.text).toBe(collapsed ? "" : sourceText.slice(0, 4));
        await page.locator("html").evaluate((element) => element.removeAttribute("data-copied-source"));
        const previous = (await notices.elementHandles())[0];
        if (touch) await copy.tap();
        else await copy.click();
        await expect(copy).toHaveText("copy");
        // Wait for native dismissal so the previous success cannot satisfy
        // assertions before the replacement has been published.
        if (previous !== undefined) {
          await expect.poll(() => previous.evaluate((element) => element.isConnected)).toBe(false);
          await previous.dispose();
        }
        await expect(notices).toHaveCount(1);
        await expect(notices).toBeVisible();
        await expect(notices.locator("[data-description]")).toHaveText("Copied to clipboard");
        await expect(notices).toHaveAttribute("data-type", "success");
        await expect(page.locator("html")).toHaveAttribute("data-copied-source", sourceText);
        await expect.poll(() => editorSelection(page)).toEqual(before);
        await expect.poll(() => source.textContent()).toBe(sourceText);
      }
    }
  }
}

test("source copy preserves desktop caret, selection and focus through both clipboard paths", { tag: "@webkit" }, async ({ page }) => {
  test.skip(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches), "fine-pointer proof");
  await exerciseSourceCopy(page, false);
});

test("source copy preserves iPad caret, selection and focus through both clipboard paths", { tag: "@webkit-touch" }, async ({ browser }) => {
  const context = trackContext(await browser.newContext(devices["iPad Pro 11"]));
  await exerciseSourceCopy(await context.newPage(), true);
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
  await page.getByRole("button", { name: "Code language" }).click();
  await page.getByRole("combobox", { name: "Search languages" }).fill("python");
  await page.getByRole("option", { name: "python", exact: true }).click();
  await expect(block).toHaveAttribute("data-language", "python");

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
  const language = block.getByRole("button", { name: "Code language" });
  await expect(language).toHaveText("python▾");
  const caption = await language.boundingBox();
  await code.evaluate((element) => { element.scrollLeft = 0; });
  expect(await copy.boundingBox()).toEqual(before);
  await code.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  expect(await copy.boundingBox()).toEqual(before);
  expect(await block.evaluate((element) => element.scrollLeft)).toBe(0);
  expect(await language.boundingBox()).toEqual(caption);
  await expect(copy).toBeInViewport();
  if (info.project.use.hasTouch === true) await copy.tap();
  else await copy.click();
  await expect(copy).toHaveText("copy");
  const copied = page.locator("[data-sonner-toast]:not([data-removed=true])").filter({
    has: page.locator("[data-description]", { hasText: /^Copied to clipboard$/ }),
  });
  await expect(copied).toHaveAttribute("data-type", "success");
  await expect(page.locator("html")).toHaveAttribute("data-copied-source", edited);
  await expectContained(page);
});
