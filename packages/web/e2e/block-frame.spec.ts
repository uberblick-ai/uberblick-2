/** Shared block chrome through the production renderer, with real input and paint. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { activateControl, editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { renderedText } from "./contrast-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, proveMcpArrival, waitForDocumentDraw } from "./settle.js";
import type { McpSession } from "./mcp-agent.js";
import { installPageTimers, withPageTimers } from "./page-timers.js";
import { alphaOf, contrast, oklab, pageGrounds } from "../test/colour.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-frame-${process.env.UB_AGENTS_RUN ?? "local"}-`,
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface Block { id: string; type: string; language?: string; text: string; rev: string }
interface Document { blocks: Block[] }
const CODE = '// An ordinary code block\nconst message = JSON.stringify({ answer: 42, text: "Hello" });';
const WIREFRAME = "banner\n  text A live wireframe preview.";
const TERMINAL = "$ ub status\nworkspace ready";
const MAPPING = {
  version: 1, type: "line", collection: "measurements", title: "Measurements with a deliberately long caption title that must truncate inside a narrow iPad window",
  x: { field: "day", type: "date" }, y: [{ field: "value", label: "Measured value" }],
};
const FRAME_TYPES = [
  [".ub-code:not(.ub-wireframe)", "slate", "TypeScript"],
  [".ub-wireframe", "slate", "Wireframe"],
  [".ub-terminal", "green", "Terminal"],
  [".ub-chart[data-view=line]", "blue", "Chart"],
] as const;
const CALLOUTS = [
  ["note", "Note", 245], ["tip", "Tip", 150], ["important", "Important", 300],
  ["warning", "Warning", 75], ["caution", "Caution", 25],
] as const;

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: frame writer is missing");
  return agent.open({ name: "block-frame-e2e" });
}

async function fixture(session: McpSession, title: string): Promise<string> {
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title, description: "Shared frame proof with literal source preserved.",
    blocks: [
      { type: "paragraph", text: "Every block shares one frame." },
      { type: "quote", text: "A quiet quote with a rose accent." },
      { type: "code", language: "typescript", text: CODE },
      { type: "code", language: "wireframe", text: WIREFRAME },
      { type: "terminal", text: TERMINAL },
      { type: "chart", text: JSON.stringify(MAPPING) },
      ...CALLOUTS.map(([variant]) => ({ type: "callout", variant,
        inline: [{ text: "Ordinary upright prose with ", marks: {} }, { text: "bold", marks: { bold: true } },
          { text: ", ", marks: {} }, { text: "a link", marks: { link: "https://example.invalid/callout" } },
          { text: " and :claude:.", marks: {} }] })),
      { type: "callout", variant: "tip", icon: "🚀", text: "An emoji replaces the default icon." },
      { type: "callout", variant: "important", icon: ":claude:", text: "A curated icon replaces the default icon." },
    ],
  });
  await session.call("update_data", { uuid, operations: [{
    collection: "measurements", schema: { version: 1, schema: { type: "object" } },
    replaceRecords: [
      { id: "first", value: { day: "2026-01-01", value: 10 } },
      { id: "second", value: { day: "2026-01-02", value: 20 } },
      { id: "third", value: { day: "2026-01-03", value: 15 } },
    ],
  }] });
  return uuid;
}

async function observeCanvas(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const ink: { text: string; color: string }[] = [];
    (window as unknown as { frameCanvasInk: typeof ink }).frameCanvasInk = ink;
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (this.canvas.closest(".ub-chart") !== null) ink.push({ text: String(text), color: String(this.fillStyle) });
      if (maxWidth === undefined) fill.call(this, text, x, y);
      else fill.call(this, text, x, y, maxWidth);
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => document.documentElement.setAttribute("data-copied-source", text) },
    });
  });
}

async function colorToken(frame: Locator, token: string): Promise<string> {
  return frame.evaluate((element, name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    element.append(probe);
    const result = getComputedStyle(probe).color;
    probe.remove();
    return result;
  }, token);
}

async function frameGeometry(frame: Locator) {
  const paint = await frame.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      bar: style.borderLeftColor, ground: style.backgroundColor,
      widths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      radii: [style.borderTopLeftRadius, style.borderBottomLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius],
      radius: getComputedStyle(document.documentElement).getPropertyValue("--radius").trim(),
    };
  });
  expect(paint.widths).toEqual(["0px", "0px", "0px", "3px"]);
  expect(paint.radii.slice(0, 2)).toEqual(["0px", "0px"]);
  // Resolve rem through the browser instead of assuming a root font size.
  const radius = await frame.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.borderTopRightRadius = "var(--radius)";
    element.append(probe);
    const result = getComputedStyle(probe).borderTopRightRadius;
    probe.remove();
    return result;
  });
  expect(paint.radii.slice(2)).toEqual([radius, radius]);
  return paint;
}

async function expectFrame(frame: Locator, hue: string): Promise<void> {
  const paint = await frameGeometry(frame);
  expect(paint.bar).toBe(await colorToken(frame, `--block-${hue}-bar`));
  expect(paint.ground).toBe(await colorToken(frame, `--block-${hue}-tint`));
  expect(paint.bar).not.toBe(await colorToken(frame, "--brand"));
  for (const color of [paint.bar, paint.ground]) {
    const lab = oklab(color);
    expect(Math.hypot(lab.a, lab.b)).toBeLessThan(0.09);
  }
  const chrome = await frame.locator(
    ":scope > code, .ub-block-caption, .ub-wireframe-source, .ub-terminal-source, .ub-terminal-screen, .ub-chart-panel, .ub-chart-source",
  ).evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { selector: element.className || element.tagName, ground: style.backgroundColor,
      border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth] };
  }));
  for (const item of chrome) {
    expect(item.border, item.selector).toEqual(["0px", "0px", "0px", "0px"]);
    expect(alphaOf(item.ground), item.selector).toBe(0);
  }
}

async function expectCallout(page: Page, frame: Locator, variant: string, label: string, hue: number, touch: boolean): Promise<void> {
  const paint = await frameGeometry(frame);
  expect(paint.bar).toBe(await colorToken(frame, `--block-${variant}-bar`));
  expect(paint.ground).toBe(await colorToken(frame, `--block-${variant}-tint`));
  const bar = oklab(paint.bar);
  expect(bar.chroma).toBeGreaterThan(0.10);
  expect(bar.chroma).toBeLessThanOrEqual(0.13);
  const paintedHue = (Math.atan2(bar.b, bar.a) * 180 / Math.PI + 360) % 360;
  expect(Math.abs(paintedHue - hue)).toBeLessThan(1);
  const pagePaint = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { image: style.backgroundImage, color: style.backgroundColor };
  });
  for (const ground of pageGrounds(pagePaint.image, pagePaint.color)) {
    expect(contrast(paint.bar, ground), variant).toBeGreaterThanOrEqual(3);
  }
  await expect(frame).toHaveAttribute("role", "note");
  await expect(frame).toHaveAccessibleName(label);
  await expect(frame).not.toHaveAttribute("role", "alert");
  await expectCaption(frame, label, touch);
  const caption = frame.locator(":scope > .ub-block-caption");
  await expect(caption).toHaveAttribute("contenteditable", "false");
  await expect(caption).toHaveCSS("font-weight", "500");
  await expect(caption).toHaveCSS("color", await colorToken(frame, `--block-${variant}-ink`));
  const body = frame.locator(".ub-callout-body");
  await expect(body).toHaveCSS("font-style", "normal");
  await expect(body).toHaveCSS("font-size", await editor(page).locator(":scope > p").first().evaluate(element => getComputedStyle(element).fontSize));
  await expect(body.locator("strong")).toHaveText("bold");
  await expect(body.getByRole("link", { name: "a link", exact: true })).toBeVisible();
  await expect(body.locator('.ub-inline-icon[data-icon="claude"] svg')).toHaveCount(1);
  const icon = caption.locator(".ub-callout-icon");
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  const iconPaint = await icon.evaluate(element => {
    const svg = element.querySelector("svg");
    if (svg === null) throw new Error("e2e: default callout icon is missing");
    return { ink: getComputedStyle(element).color, svgInk: getComputedStyle(svg).color,
      source: svg.outerHTML, animations: element.getAnimations({ subtree: true }).length };
  });
  expect(iconPaint.svgInk).toBe(iconPaint.ink);
  expect(iconPaint.source).toContain("currentColor");
  expect(iconPaint.animations).toBe(0);
}

async function expectCaption(frame: Locator, label: string, touch: boolean): Promise<void> {
  const caption = frame.locator(":scope > .ub-block-caption");
  await expect(caption).toHaveCount(1);
  await expect(caption.locator(".ub-block-label")).toContainText(label);
  if (touch && label === "Chart") {
    expect(await caption.locator(".ub-chart-title").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  }
  const layout = await caption.evaluate((element) => {
    const rect = element.getBoundingClientRect(), frame = element.parentElement?.getBoundingClientRect();
    if (frame === undefined) throw new Error("e2e: caption frame is missing");
    const items = [...element.querySelectorAll<HTMLElement>(".ub-block-label, .ub-block-actions button")]
      .filter(item => item.getClientRects().length > 0).map(item => {
      const box = item.getBoundingClientRect(), style = getComputedStyle(item);
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        width: box.width, height: box.height, size: parseFloat(style.fontSize), line: parseFloat(style.lineHeight), font: style.fontFamily };
    });
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      frameLeft: frame.left, frameRight: frame.right, frameTop: frame.top, frameBottom: frame.bottom, items };
  });
  expect(layout.left).toBeGreaterThanOrEqual(layout.frameLeft + 3);
  expect(layout.right).toBeLessThanOrEqual(layout.frameRight + 0.5);
  for (const item of layout.items) {
    expect(item.size).toBe(12);
    expect(item.line).toBeCloseTo(16, 1);
    expect(item.font).not.toMatch(/mono/i);
    expect(item.left).toBeGreaterThanOrEqual(layout.left - 0.5);
    expect(item.right).toBeLessThanOrEqual(layout.right + 0.5);
    expect(item.top).toBeGreaterThanOrEqual(layout.top - 0.5);
    expect(item.bottom).toBeLessThanOrEqual(layout.bottom + 0.5);
  }
  for (const action of await caption.locator(".ub-block-actions button:visible").all()) {
    const box = await action.boundingBox();
    if (box === null) throw new Error("e2e: caption action has no box");
    expect(box.width).toBeGreaterThanOrEqual(touch ? 44 : 24);
    expect(box.height).toBeGreaterThanOrEqual(touch ? 44 : 24);
    await expect(action).toHaveText(/^(Copy|Source|Pause|Play)$/);
  }
  const items = layout.items;
  for (let index = 1; index < items.length; index += 1) {
    expect(items[index]?.left).toBeGreaterThanOrEqual((items[index - 1]?.right ?? Infinity) - 0.5);
  }
}

async function expectAA(page: Page, selector: string): Promise<void> {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const readings = await renderedText(page, selector, { exclude: ".ProseMirror-yjs-cursor" });
  expect(readings.length, selector).toBeGreaterThan(0);
  for (const reading of readings) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
}

async function controlStates(page: Page, selector: string, touch: boolean): Promise<void> {
  const controls = page.locator(`${selector} .ub-block-actions button:visible`);
  for (const control of await controls.all()) {
    await control.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expectAA(page, selector);
    if (!touch) {
      await control.hover();
      await expectAA(page, selector);
    }
    await control.focus();
    await page.keyboard.press("ArrowRight");
    expect(await control.evaluate(element => element.matches(":focus-visible"))).toBe(true);
    const focus = await control.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.outlineColor, style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(focus.style).not.toBe("none");
    expect(focus.width).toBeGreaterThan(0);
    expect(alphaOf(focus.color)).toBeGreaterThan(0);
    expect(focus.color).toBe(await colorToken(control, "--ring"));
    expect(focus.color).not.toBe(await colorToken(control, "--brand"));
    await expectAA(page, selector);
  }
}

async function edit(session: McpSession, uuid: string, block: Block, text: string): Promise<void> {
  await session.call("edit_block", { uuid, block_id: block.id, rev: block.rev, old_text: block.text, new_text: text });
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  await placeCaretIn(editor(page).locator(":scope > p").first());
  await expect.poll(() => page.evaluate(() => document.getSelection()?.isCollapsed)).toBe(true);
  await expect(page.getByRole("toolbar", { name: "Text formatting and comment", exact: true })).toHaveCount(0);
  await editor(page).scrollIntoViewIfNeeded();
  const path = info.outputPath(`${name}.png`);
  await editor(page).screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const touch of [false, true]) {
  for (const appearance of ["light", "dark"] as const) {
    test(`shared frames, source actions and AA paint on ${touch ? "narrow iPad" : "desktop"} — ${appearance}`,
      { tag: "@webkit" }, async ({ browser }, info) => {
      const session = writer();
      const uuid = await fixture(session, "One block frame");
      const before = await session.call<Document>("get_doc", { uuid });
      const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
        beforeNavigate: async (page) => {
          await installPageTimers(page);
          await observeCanvas(page);
        },
        contextOptions: { ...(touch ? devices["iPad Pro 11"] : { hasTouch: false, isMobile: false }),
          viewport: { width: touch ? 600 : 1366, height: 1100 }, colorScheme: appearance, reducedMotion: "reduce" },
      });
      await waitForDocumentDraw(page, session, uuid, { index: "all" });
      await expect(page.locator(".ub-wireframe .wf-root")).toBeVisible();
      await expect(page.locator(".ub-chart-panel")).toHaveAttribute("data-state", "ready");
      expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(touch);
      const quote = page.locator(".ub-quote");
      await expectFrame(quote, "rose");
      await expect(quote.locator(".ub-block-caption")).toHaveCount(0);
      await expect(quote).toHaveCSS("font-style", "italic");
      await expectAA(page, ".ub-quote");
      const defaultIcons: string[] = [];
      for (const [variant, label, hue] of CALLOUTS) {
        const selector = `.ub-callout[data-variant="${variant}"]:not([data-icon])`;
        const frame = page.locator(selector);
        await frame.scrollIntoViewIfNeeded();
        await expectCallout(page, frame, variant, label, hue, touch);
        await expectAA(page, selector);
        defaultIcons.push(await frame.locator(".ub-callout-icon svg").evaluate(element => element.innerHTML));
      }
      expect(new Set(defaultIcons).size).toBe(CALLOUTS.length);
      const emoji = page.locator('.ub-callout[data-icon="🚀"]');
      await expect(emoji).toHaveAccessibleName("Tip");
      await expect(emoji.locator(".ub-callout-icon")).toHaveText("🚀");
      await expect(emoji.locator(".ub-callout-icon svg")).toHaveCount(0);
      const curated = page.locator('.ub-callout[data-icon=":claude:"]');
      await expect(curated).toHaveAccessibleName("Important");
      await expect(curated.locator(".ub-block-caption .ub-inline-icon svg")).toHaveCount(1);
      for (const frame of [emoji, curated]) {
        await frame.scrollIntoViewIfNeeded();
        const variant = await frame.getAttribute("data-variant");
        await expect(frame.locator(".ub-block-caption")).toHaveCSS("color", await colorToken(frame, `--block-${variant}-ink`));
        await expectAA(page, `.ub-callout[data-icon="${await frame.getAttribute("data-icon")}"]`);
      }
      for (const [selector, hue, label] of FRAME_TYPES) {
        const frame = page.locator(selector);
        await expectFrame(frame, hue);
        await expectCaption(frame, label, touch);
        await controlStates(page, selector, touch);
        const id = await frame.getAttribute("id");
        const block = before.blocks.find(block => block.id === id);
        if (block === undefined) throw new Error(`e2e: missing source for ${selector}`);
        await activateControl(frame.locator(".ub-copy"), { touch });
        await expect(page.locator("html")).toHaveAttribute("data-copied-source", block.text);
      }
      await expect(page.locator(".ub-terminal-toggle")).toBeHidden();
      const chartGround = await page.locator(".ub-chart").evaluate(element => getComputedStyle(element).backgroundColor);
      const canvasInk = await page.evaluate(() => (window as unknown as { frameCanvasInk: { text: string; color: string }[] }).frameCanvasInk);
      expect(canvasInk.some(ink => ink.text.includes("Measured value"))).toBe(true);
      expect(canvasInk.some(ink => /^Jan/.test(ink.text))).toBe(true);
      for (const ink of canvasInk) expect(contrast(ink.color, chartGround), JSON.stringify(ink)).toBeGreaterThanOrEqual(4.5);
      for (const sourceName of ["Open wireframe source", "Open chart source"]) {
        const action = page.getByRole("button", { name: sourceName, exact: true });
        if (touch) await action.tap();
        else {
          await action.focus();
          await page.keyboard.press("Enter");
        }
        const kind = sourceName.includes("wireframe") ? "wireframe" : "chart";
        const selector = `.ub-${kind}`;
        await expect(page.locator(`${selector}-source`)).toBeVisible();
        await expectCaption(page.locator(selector), kind === "wireframe" ? "Wireframe" : "Chart", touch);
        await expectAA(page, selector);
        await activateControl(editor(page).locator(":scope > p").first(), { touch });
      }
      await activateControl(page.locator(".ub-terminal-screen"), { touch });
      await expect(page.locator(".ub-terminal-source")).toBeVisible();
      await expectAA(page, ".ub-terminal");
      await activateControl(editor(page).locator(":scope > p").first(), { touch });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const toggle = page.locator(".ub-terminal-toggle");
      await expect(toggle).toHaveText("Pause");
      if (touch) await toggle.tap();
      else {
        await toggle.focus();
        await page.keyboard.press("Enter");
      }
      await expect(toggle).toHaveText("Play");
      await expectCaption(page.locator(".ub-terminal"), "Terminal", touch);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(page.locator(".ub-terminal-frame")).toHaveText(TERMINAL);
      await withPageTimers(page, async () => {
        await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      });
      await capture(page, info, `block-frames-${touch ? "ipad-narrow" : "desktop"}-${appearance}`);
      await proveMcpArrival(page, session, uuid, { path: "upstream" });
      await expectMcp(async () => {
        expect((await session.call<Document>("get_doc", { uuid })).blocks).toEqual(before.blocks);
      });
      const codeFrame = page.locator(".ub-code:not(.ub-wireframe)");
      const ground = await codeFrame.evaluate(element => getComputedStyle(element).backgroundColor);
      for (const token of ["comment", "keyword", "name", "string", "number"]) {
        expect(contrast(await colorToken(codeFrame, `--syntax-${token}`), ground), token).toBeGreaterThanOrEqual(4.5);
      }
      const wireframe = before.blocks.find(block => block.language === "wireframe");
      const chart = before.blocks.find(block => block.type === "chart");
      if (wireframe === undefined || chart === undefined) throw new Error("e2e: rendered fixtures are missing");
      await edit(session, uuid, wireframe, "banner\n text Bad indentation");
      await expect(page.locator(".ub-wireframe-stale")).toBeVisible();
      await expect(page.locator(".ub-wireframe-diagnostics")).toBeVisible();
      await edit(session, uuid, chart, "{");
      await expect(page.locator(".ub-chart-message")).toBeVisible();
      for (const selector of [".ub-wireframe", ".ub-chart"]) await expectAA(page, selector);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

for (const appearance of ["light", "dark"] as const) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`a flashing framed comment keeps its neutral keyboard ring — ${appearance}, ${reducedMotion}`,
      { tag: "@webkit" }, async ({ browser, browserName }) => {
      const session = writer();
      const { uuid } = await session.call<{ uuid: string }>("create_doc", {
        title: "Framed comment focus", description: "Keyboard focus while a real rail activation flashes its comment.",
        blocks: [{ type: "paragraph", text: "Neighbor prose." }, { type: "quote", text: "A framed comment stays readable." }],
      });
      const stored = await session.call<Document>("get_doc", { uuid });
      const quote = stored.blocks.find(block => block.type === "quote");
      if (quote === undefined) throw new Error("e2e: quote fixture is missing");
      await session.call("annotate", { uuid, block_id: quote.id, start: 2, end: 16, text: "Discuss this framed comment." });
      const before = await session.call<Document>("get_doc", { uuid });
      const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
        contextOptions: { viewport: { width: 1366, height: 900 }, hasTouch: false, isMobile: false,
          colorScheme: appearance, reducedMotion },
      });
      const highlight = page.locator(".ub-quote [data-comment-thread]");
      await expect(highlight).toHaveText("framed comment");
      const card = page.locator(".ub-thread-card").filter({ hasText: "Discuss this framed comment." });
      const cardButton = card.locator(".ub-thread");
      await highlight.click();
      await expect(cardButton).toHaveAttribute("aria-current", "true");
      // Hold the product's removal timer while native Tab and CSS focus paint
      // run, so the flash cannot expire before the conflicting cascade is read.
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 100));
      await cardButton.click();
      await expect(highlight).toHaveClass(/ub-comment-flash/);
      await page.getByRole("button", { name: "Document actions", exact: true }).focus();
      const nextControl = browserName === "webkit" ? "Alt+Tab" : "Tab";
      for (let count = 0; count < 20; count += 1) {
        if (await highlight.evaluate(element => document.activeElement === element)) break;
        await page.keyboard.press(nextControl);
      }
      await expect(highlight).toBeFocused();
      expect(await highlight.evaluate(element => element.matches(":focus-visible"))).toBe(true);
      const ring = await colorToken(page.locator(".ub-pane"), "--ring");
      const amber = await colorToken(page.locator(".ub-pane"), "--brand");
      for (const advance of [0, 400]) {
        if (advance > 0) await page.clock.runFor(advance);
        await expect(highlight).toHaveClass(/ub-comment-flash/);
        const paint = await highlight.evaluate(element => {
          const style = getComputedStyle(element);
          return { color: style.outlineColor, style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
        });
        expect(paint.style).not.toBe("none");
        expect(paint.width).toBeGreaterThan(0);
        expect(paint.color).toBe(ring);
        expect(paint.color).not.toBe(amber);
      }
      await page.keyboard.press("Enter");
      await expect(cardButton.getByRole("button").first()).toBeFocused();
      await page.clock.resume();
      await proveMcpArrival(page, session, uuid, { path: "upstream" });
      await expectMcp(async () => {
        expect((await session.call<Document>("get_doc", { uuid })).blocks).toEqual(before.blocks);
      });
    });
  }
}
