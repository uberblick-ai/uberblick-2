/** Wireframe previews use ordinary code source through the production replica. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { activateControl, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const SOURCE = "dialog Delete draft?\n  text This cannot be undone.\n  row.end\n    button.focus Cancel\n    button.danger Delete";
const INVALID = "dialog Broken\n text Wrong indentation";

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-wireframe-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: wireframe MCP agent is not configured");
  return agent.open({ name: "wireframe-e2e" });
}

interface Block { id: string; type: string; language?: string; text: string; rev: string }
interface Document { uuid: string; blocks: Block[] }

async function wireframeDoc(session: McpSession, title: string, source = SOURCE, language = "wireframe"): Promise<string> {
  const result = await session.call<{ uuid: string }>("create_doc", {
    title, description: "An editable screen sketch with its source preserved.",
    blocks: [{ type: "paragraph", text: "Neighbor prose." }, { type: "code", language, text: source }],
  });
  return result.uuid;
}

async function codeBlock(session: McpSession, uuid: string): Promise<Block> {
  const result = await session.call<Document>("get_doc", { uuid });
  const block = result.blocks.find((entry) => entry.type === "code");
  if (block === undefined) throw new Error("e2e: wireframe code block is missing");
  return block;
}

async function editSource(session: McpSession, uuid: string, text: string): Promise<void> {
  const block = await codeBlock(session, uuid);
  await session.call("edit_block", { uuid, block_id: block.id, rev: block.rev, old_text: block.text, new_text: text });
}

function preview(page: Page): Locator { return page.locator(".ub-wireframe-drawing"); }
function source(page: Page): Locator { return page.locator(".ub-wireframe-source"); }
function neighbor(page: Page): Locator { return editor(page).locator(":scope > p").first(); }
function openSource(page: Page): Locator { return page.getByRole("button", { name: "Open wireframe source", exact: true }); }

async function authoredText(element: Locator): Promise<string> {
  return element.evaluate((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return copy.textContent ?? "";
  });
}

/** Native range setup leaves the following input and focus handling to the browser. */
async function caretEnd(element: Locator): Promise<void> {
  await element.evaluate((node) => {
    const view = node.closest<HTMLElement>(".ProseMirror");
    if (view === null) throw new Error("e2e: source has no editor");
    view.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await expect.poll(() => element.evaluate((node) => node.contains(document.getSelection()?.focusNode ?? null))).toBe(true);
  await element.page().evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function chooseLanguage(page: Page, language: string, keyboard = false): Promise<void> {
  if (keyboard) await page.keyboard.press("Shift+F10");
  else await activateControl(page.getByRole("button", { name: "Code language", exact: true }));
  const search = page.getByRole("combobox", { name: "Search languages", exact: true });
  await expect(search).toBeFocused();
  await search.fill(language);
  if (keyboard) await page.keyboard.press("Enter");
  else await activateControl(page.getByRole("option", { name: language, exact: true }));
  await expect(search).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
}

test("the language picker makes a wireframe, Source returns its caret, and another language restores ordinary code", async ({ browser }) => {
  const session = writer();
  const uuid = await wireframeDoc(session, "Wireframe picker", SOURCE, "");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await caretEnd(page.locator(".ub-code > code"));
  await chooseLanguage(page, "wireframe", true);
  await expect(page.locator(".ub-code")).toHaveAttribute("data-language", "wireframe");
  await expect(preview(page).locator(".wf-dialog-title")).toHaveText("Delete draft?");
  await expect(source(page)).toBeVisible();
  await neighbor(page).click();
  await expect(source(page)).toBeHidden();
  await expect(openSource(page)).toHaveText("Source");
  await openSource(page).focus();
  await page.keyboard.press("Enter");
  await expect(source(page)).toBeVisible();
  await expect.poll(() => source(page).evaluate((element) => element.contains(document.getSelection()?.focusNode ?? null))).toBe(true);
  await expect(editor(page)).toBeFocused();
  const stored = await codeBlock(session, uuid);
  expect(stored).toMatchObject({ type: "code", language: "wireframe", text: SOURCE });
  expect((await session.call<{ markdown: string }>("export_markdown", { uuid, frontmatter: false })).markdown)
    .toContain(`\`\`\`wireframe\n${SOURCE}\n\`\`\``);
  await chooseLanguage(page, "python", true);
  await expect(page.locator(".ub-wireframe")).toHaveCount(0);
  await expect(page.locator(".ub-code > code")).toHaveText(SOURCE);
  await expect(page.locator(".ub-code")).toHaveAttribute("data-language", "python");
});

test("MCP-created source keeps its preview and comments visible, including after a live read-only transition", async ({ browser }) => {
  const session = writer();
  const uuid = await wireframeDoc(session, "Annotated wireframe");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expect(preview(page).locator(".wf-root")).toBeVisible();
  await neighbor(page).click();
  await expect(source(page)).toBeHidden();
  const block = await codeBlock(session, uuid);
  await session.call("annotate", {
    uuid, block_id: block.id, start: SOURCE.indexOf("draft"), end: SOURCE.indexOf("draft") + 5,
    text: "Keep the screen and the discussed source together.",
  });
  await expect(page.locator(".ub-wireframe")).toHaveAttribute("data-annotated", "true");
  await expect(source(page).locator("[data-comment-thread]")).toHaveText("draft");
  await expect(source(page)).toBeVisible();
  await expect(preview(page).locator(".wf-root")).toBeVisible();
  const before = await codeBlock(session, uuid);
  await session.call("archive_doc", { uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(source(page)).toBeVisible();
  await expect(preview(page).locator(".wf-dialog-title")).toHaveText("Delete draft?");
  await source(page).click();
  await page.keyboard.type("do not mutate");
  expect(await authoredText(source(page))).toBe(SOURCE);
  expect(await codeBlock(session, uuid)).toEqual(before);
  const fresh = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expect(editor(fresh)).toHaveAttribute("contenteditable", "false");
  await expect(preview(fresh).locator(".wf-root")).toBeVisible();
  await expect(source(fresh)).toBeVisible();
});

interface Paint { at: number; sourceAt: number; text: string }
interface PaintProbe { paints: Paint[]; sourceAt: number }

/** Count replacements of the package's drawing, rather than source/cursor DOM. */
async function observePaints(page: Page): Promise<void> {
  await page.evaluate(() => {
    const source = document.querySelector(".ub-wireframe-source");
    const drawing = document.querySelector(".ub-wireframe-drawing");
    if (source === null || drawing === null) throw new Error("e2e: missing wireframe probe targets");
    const probe: PaintProbe = { paints: [], sourceAt: performance.now() };
    (window as unknown as { wireframeProbe: PaintProbe }).wireframeProbe = probe;
    const text = (): string => {
      const copy = source.cloneNode(true) as HTMLElement;
      for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
      return copy.textContent ?? "";
    };
    let previousText = text();
    let previousDrawing = drawing.firstElementChild;
    new MutationObserver(() => {
      const currentText = text();
      if (currentText !== previousText) { previousText = currentText; probe.sourceAt = performance.now(); }
      if (drawing.firstElementChild !== previousDrawing) {
        previousDrawing = drawing.firstElementChild;
        probe.paints.push({ at: performance.now(), sourceAt: probe.sourceAt, text: drawing.textContent ?? "" });
      }
    }).observe(source.closest(".ub-wireframe") ?? drawing, { subtree: true, childList: true, characterData: true });
  });
}

function paints(page: Page): Promise<Paint[]> {
  return page.evaluate(() => (window as unknown as { wireframeProbe: PaintProbe }).wireframeProbe.paints);
}

test("local keystrokes, collaborator changes and agent writes redraw only after a pause", async ({ browser }) => {
  const session = writer();
  const uuid = await wireframeDoc(session, "Wireframe redraws");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  const peer = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  for (const client of [page, peer]) {
    await expect(preview(client).locator(".wf-button").last()).toHaveText("Delete");
    await observePaints(client);
  }
  await openSource(page).click();
  await caretEnd(source(page));
  const suffix = " changed";
  await page.keyboard.type(suffix, { delay: 5 });
  for (const client of [page, peer]) {
    await expect(preview(client).locator(".wf-button").last()).toHaveText(`Delete${suffix}`);
    const recorded = await paints(client);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.length).toBeLessThan(suffix.length);
    expect(recorded.every((entry) => entry.at - entry.sourceAt >= 150)).toBe(true);
  }
  await openSource(peer).click();
  await caretEnd(source(peer));
  await peer.keyboard.type(" peer", { delay: 5 });
  await expect(preview(page).locator(".wf-button").last()).toHaveText("Delete changed peer");
  await expect(preview(peer).locator(".wf-button").last()).toHaveText("Delete changed peer");
  await editSource(session, uuid, SOURCE.replace("Delete draft?", "Agent-updated draft?"));
  for (const client of [page, peer]) {
    await expect(preview(client).locator(".wf-dialog-title")).toHaveText("Agent-updated draft?");
    const recorded = await paints(client);
    expect(recorded.every((entry) => entry.at - entry.sourceAt >= 150)).toBe(true);
  }
});

test("errors retain the last good drawing or show diagnostics alone, while every warning still renders", async ({ browser }) => {
  const session = writer();
  const uuid = await wireframeDoc(session, "Wireframe errors");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  const good = preview(page).locator(".wf-root");
  await expect(good).toBeVisible();
  const original = await good.elementHandle();
  if (original === null) throw new Error("e2e: good wireframe drawing is missing");
  await editSource(session, uuid, INVALID);
  await expect(page.locator(".ub-wireframe-diagnostics")).toContainText(/Line 2: error:.*indentation/);
  await expect(page.locator(".ub-wireframe-stale")).toHaveText("Preview is stale");
  expect(await original.evaluate((element) => element === document.querySelector(".ub-wireframe-drawing > .wf-root"))).toBe(true);
  await expect(preview(page).locator(".wf-dialog-title")).toHaveText("Delete draft?");
  const freshUuid = await wireframeDoc(session, "Wireframe without a good drawing", INVALID);
  const fresh = await openApp(browser, `/${harness().workspace}/${freshUuid}`);
  await expect(fresh.locator(".ub-wireframe-diagnostics")).toContainText(/Line 2: error:.*indentation/);
  await expect(preview(fresh).locator(".wf-root")).toHaveCount(0);
  await expect(fresh.locator(".ub-wireframe-stale")).toBeHidden();
  const warnings = ["dialog.unknown Warning screen", ...Array.from({ length: 6 }, (_, index) => `  text.unknown Warning ${index + 1}`)].join("\n");
  await editSource(session, uuid, warnings);
  await expect(preview(page).locator(".wf-dialog-title")).toHaveText("Warning screen");
  await expect(page.locator(".ub-wireframe-diagnostics li")).toHaveCount(7);
  for (let line = 1; line <= 7; line += 1) await expect(page.locator(".ub-wireframe-diagnostics li").nth(line - 1)).toContainText(`Line ${line}: warning:`);
  await expect(page.locator(".ub-wireframe-stale")).toBeHidden();
  await editSource(session, uuid, SOURCE);
  await expect(preview(page).locator(".wf-dialog-title")).toHaveText("Delete draft?");
  await expect(page.locator(".ub-wireframe-diagnostics")).toBeHidden();
});

function wideSource(buttons: number, labelLength = 12): string {
  return ["banner", "  text Wide screen", "  row", ...Array.from({ length: buttons }, (_, index) => `    button ${String(index).padStart(2, "0")}${"x".repeat(labelLength)}`)].join("\n");
}

async function expectContained(page: Page): Promise<void> {
  expect(await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".ub-pane");
    return pane !== null && pane.scrollWidth <= pane.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  })).toBe(true);
}

async function fitScale(page: Page): Promise<number> {
  return preview(page).evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
}

async function evidence(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.locator(".ub-wireframe").screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("desktop and iPad wireframes fit inside their column and follow both appearances with UI fonts", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const uuid = await wireframeDoc(session, "Wireframe fit and appearance");
  for (const touch of [false, true]) {
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { ...(touch ? devices["iPad Pro 11"] : { viewport: { width: 1280, height: 800 } }), colorScheme: "light" },
    });
    await expect(preview(page).locator(".wf-root")).toBeVisible();
    await activateControl(openSource(page), { touch });
    await expect(source(page)).toBeVisible();
    const font = await preview(page).locator(".wf-root").evaluate((element) => getComputedStyle(element).fontFamily);
    expect(font).not.toMatch(/mono/i);
    expect(await source(page).evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/mono/i);
    expect(await openSource(page).evaluate((element) => getComputedStyle(element).fontFamily)).not.toMatch(/mono/i);
    await activateControl(neighbor(page), { touch });
    await expect(source(page)).toBeHidden();
    const paper = preview(page).locator(".wf-dialog-card");
    const light = await paper.evaluate((element) => getComputedStyle(element).backgroundColor);
    const root = await preview(page).locator(".wf-root").elementHandle();
    if (root === null) throw new Error("e2e: themed wireframe is missing");
    await evidence(page, info, `wireframe-${touch ? "ipad" : "desktop"}-light`);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await expect.poll(() => paper.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(light);
    expect(await root.evaluate((element) => element === document.querySelector(".ub-wireframe-drawing > .wf-root"))).toBe(true);
    expect(await preview(page).locator(".wf-focus").evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--brand)";
      element.append(probe);
      const amber = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(element).outlineColor !== amber;
    })).toBe(true);
    await activateControl(openSource(page), { touch });
    await expect(source(page)).toBeVisible();
    await activateControl(neighbor(page), { touch });
    await evidence(page, info, `wireframe-${touch ? "ipad" : "desktop"}-dark`);
    await editSource(session, uuid, wideSource(12));
    await expect(preview(page).locator(".wf-button")).toHaveCount(12);
    await expect.poll(() => fitScale(page)).toBeCloseTo(0.6, 2);
    const viewport = page.locator(".ub-wireframe-viewport");
    await expect.poll(() => viewport.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await viewport.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    expect(await viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expectContained(page);
    // A less-wide drawing fits by shrinking, before the scrolling floor.
    const mediumLength = await viewport.evaluate((element) => {
      const button = element.querySelector(".wf-button");
      const context = document.createElement("canvas").getContext("2d");
      if (button === null || context === null) throw new Error("e2e: missing width measurement");
      const style = getComputedStyle(button);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return Math.ceil(element.clientWidth * 1.2 / context.measureText("x").width);
    });
    await editSource(session, uuid, wideSource(1, mediumLength));
    await expect(preview(page).locator(".wf-button")).toHaveCount(1);
    await expect.poll(() => fitScale(page)).toBeGreaterThan(0.6);
    expect(await fitScale(page)).toBeLessThan(1);
    await expectContained(page);
    await editSource(session, uuid, SOURCE);
  }
});

test("warning banners use the product warning colours in both appearances", { tag: "@webkit" }, async ({ browser }, info) => {
  const uuid = await wireframeDoc(writer(), "Wireframe banner tones", "banner\n  icon archive\n  text Archived.\nbanner.warning\n  icon archive\n  text Archived.");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  const banners = preview(page).locator(".wf-banner");
  await expect(banners).toHaveCount(2);
  for (const appearance of ["light", "dark"]) {
    await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), appearance);
    const tones = await banners.evaluateAll((elements) => elements.map((element) => {
      const icon = element.querySelector(".wf-icon");
      if (icon === null) throw new Error("e2e: banner icon is missing");
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderColor, icon: getComputedStyle(icon).color };
    }));
    const [neutralTone, warningTone] = tones;
    if (neutralTone === undefined || warningTone === undefined) throw new Error("e2e: banner tones are missing");
    expect(warningTone.background).not.toBe(neutralTone.background);
    expect(warningTone.border).not.toBe(neutralTone.border);
    expect(warningTone.icon).not.toBe(neutralTone.icon);
    const warning = await banners.last().evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--status-warning)";
      probe.style.backgroundColor = "var(--status-warning-subtle)";
      element.append(probe);
      const style = getComputedStyle(probe);
      const result = { background: style.backgroundColor, icon: style.color };
      probe.remove();
      return result;
    });
    expect(warningTone).toMatchObject(warning);
    await evidence(page, info, `wireframe-banners-${appearance}`);
  }
});

test("a phone keeps very wide wireframe content scrolling inside the block", { tag: "@webkit-iphone" }, async ({ browser }, info) => {
  const uuid = await wireframeDoc(writer(), "Phone wireframe", wideSource(12));
  for (const appearance of ["light", "dark"] as const) {
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { ...devices["iPhone 13"], viewport: { width: 360, height: 844 }, colorScheme: appearance },
    });
    await expect(preview(page).locator(".wf-button")).toHaveCount(12);
    await expect.poll(() => fitScale(page)).toBeCloseTo(0.6, 2);
    await expectContained(page);
    const viewport = page.locator(".ub-wireframe-viewport");
    expect(await viewport.evaluate((element) => element.scrollWidth)).toBeGreaterThan(await viewport.evaluate((element) => element.clientWidth));
    await viewport.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    expect(await viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await evidence(page, info, `wireframe-phone-${appearance}`);
  }
});

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? Infinity;
}

test("100 wireframes do no rendering work during prose typing and record comparable ordinary-code typing costs", { tag: "@workload" }, async ({ browser }, info) => {
  test.setTimeout(120_000);
  const session = writer();
  const pages: Page[] = [];
  for (const language of ["", "wireframe"]) {
    const { uuid } = await session.call<{ uuid: string }>("create_doc", {
      title: `100 ${language || "ordinary code"} blocks`, description: "Prose typing with one hundred source blocks.",
      blocks: [{ type: "paragraph", text: "Type here: " }, ...Array.from({ length: 100 }, () => ({ type: "code", language, text: SOURCE }))],
    });
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
    await expect(page.locator(".ub-code")).toHaveCount(100);
    if (language === "wireframe") await expect(preview(page).locator(".wf-root")).toHaveCount(100);
    await page.evaluate(() => {
      const target = document.querySelector(".ub-editor .ProseMirror > p");
      if (target === null) throw new Error("e2e: missing prose timing target");
      const mounted = target.closest(".ProseMirror") as (HTMLElement & {
        editor?: { on(event: "update", listener: () => void): void };
      }) | null;
      if (mounted?.editor === undefined) throw new Error("e2e: missing mounted editor");
      const samples: number[] = [];
      const probe = { samples, redraws: 0 };
      (window as unknown as { wireframeTyping: typeof probe }).wireframeTyping = probe;
      let started: number | null = null;
      mounted.addEventListener("keydown", (event) => {
        if (event.key.length !== 1 || !target.contains(document.getSelection()?.focusNode ?? null)) return;
        started = performance.now();
      }, { capture: true });
      // Tiptap emits update after the document transaction and view.updateState,
      // including native DOM-observer input. Force the resulting prose layout
      // before stopping the clock; an earlier microtask misses that transaction.
      mounted.editor.on("update", () => {
        if (started === null) return;
        target.getBoundingClientRect();
        samples.push(performance.now() - started);
        started = null;
      });
      for (const drawing of document.querySelectorAll(".ub-wireframe-drawing")) {
        new MutationObserver(() => { probe.redraws += 1; }).observe(drawing, { childList: true });
      }
    });
    pages.push(page);
  }
  const plain: number[] = [], wireframe: number[] = [];
  // Reverse the ordering in each pair so first-run warming and shared-host
  // contention cannot consistently favour either document.
  for (const index of [0, 1, 1, 0, 0, 1, 1, 0]) {
    const page = pages[index];
    if (page === undefined) throw new Error("e2e: typing fixture page is missing");
    await caretEnd(neighbor(page));
    await page.evaluate(() => { (window as unknown as { wireframeTyping: { samples: number[] } }).wireframeTyping.samples.length = 0; });
    await page.keyboard.type("The prose keeps flowing while screen sketches stay still. ");
    const samples = await page.evaluate(() => (window as unknown as { wireframeTyping: { samples: number[] } }).wireframeTyping.samples);
    expect(samples.length).toBeGreaterThan(40);
    (index === 0 ? plain : wireframe).push(median(samples));
  }
  const wireframePage = pages[1];
  if (wireframePage === undefined) throw new Error("e2e: wireframe workload page is missing");
  await wireframePage.waitForTimeout(300);
  expect(await wireframePage.evaluate(() => (window as unknown as { wireframeTyping: { redraws: number } }).wireframeTyping.redraws)).toBe(0);
  const measured = { ordinaryCode: plain, wireframes: wireframe, ordinaryMedianMs: median(plain), wireframeMedianMs: median(wireframe), blocks: 100 };
  console.log(`wireframe prose timing: ${JSON.stringify(measured)}`);
  const path = info.outputPath("wireframe-prose-timing.json");
  writeFileSync(path, `${JSON.stringify(measured, null, 2)}\n`);
  await info.attach("wireframe-prose-timing", { path, contentType: "application/json" });
});
