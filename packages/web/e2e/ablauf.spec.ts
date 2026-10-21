/** Ablauf drawings preserve ordinary code source through the production replica. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { importMarkdown } from "@uberblick/schema";
import { activateControl, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { setNativeSelection } from "./native-selection.js";
import { expectMcp, proveMcpArrival, waitForDocumentDraw } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const FLOW = 'flow v0\ncolumns main\n\n# Authored spacing stays literal.  \npill draft tone=agent "Draft"\nbox check tone=system "Check draft"\nend done tone=done "Done"\n\ndraft --> check\ncheck --> done : Accepted';
const FANOUT = 'fan-out v0\nstep "Check approval"\n\noutcome "Approved" reason="A maintainer started it" destination="Start the run" tone="done"\noutcome "Outside input" reason="The input is uncleared" destination="Ask a maintainer" tone="stop"';
const WIDE = `flow v0\ncolumns ${Array.from({ length: 12 }, (_, index) => `c${index}`).join(" ")}\n${Array.from({ length: 12 }, (_, index) =>
  `box n${index} col=c${index}${index === 0 ? "" : " row=n0"} "Outcome ${index + 1}"`).join("\n")}\n${Array.from({ length: 11 }, (_, index) => `n${index} --> n${index + 1}`).join("\n")}`;
const TALL = `flow v0\ncolumns main\n${Array.from({ length: 50 }, (_, index) => `box n${index} "Step ${index + 1}"`).join("\n")}\n${Array.from({ length: 49 }, (_, index) => `n${index} --> n${index + 1}`).join("\n")}`;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-ablauf-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: Ablauf MCP agent is not configured");
  return agent.open({ name: "ablauf-e2e" });
}

interface Block { id: string; type: string; language?: string; text: string; rev: string }
interface Document { uuid: string; blocks: Block[] }

async function ablaufDoc(session: McpSession, title: string, source = FLOW, language = "ablauf"): Promise<string> {
  const result = await session.call<{ uuid: string }>("create_doc", {
    title, description: "An inline diagram with its literal code source preserved.",
    blocks: [{ type: "paragraph", text: "Neighbor prose." }, { type: "code", language, text: source }],
  });
  return result.uuid;
}

async function codeBlock(session: McpSession, uuid: string, index = 0): Promise<Block> {
  const result = await session.call<Document>("get_doc", { uuid });
  const block = result.blocks.filter((entry) => entry.type === "code")[index];
  if (block === undefined) throw new Error("e2e: Ablauf code block is missing");
  return block;
}

async function editSource(session: McpSession, uuid: string, text: string, index = 0): Promise<void> {
  const block = await codeBlock(session, uuid, index);
  await session.call("edit_block", { uuid, block_id: block.id, rev: block.rev, old_text: block.text, new_text: text });
}

function drawing(page: Page): Locator { return page.locator(".ub-ablauf-drawing"); }
function source(page: Page): Locator { return page.locator(".ub-ablauf-source"); }
function neighbor(page: Page): Locator { return editor(page).locator(":scope > p").first(); }
function openSource(page: Page): Locator { return page.getByRole("button", { name: "Open ablauf source", exact: true }); }
function viewer(page: Page): Locator { return page.getByRole("dialog", { name: "Ablauf diagram", exact: true }); }
function expand(page: Page): Locator { return page.getByRole("button", { name: "Expand ablauf diagram", exact: true, includeHidden: true }); }

async function zoomLevel(page: Page): Promise<number> {
  return Number((await viewer(page).getByLabel("Zoom level", { exact: true }).textContent())?.replace("%", ""));
}

async function sourceIsFramed(page: Page): Promise<void> {
  expect(await source(page).evaluate(element => {
    const frame = element.closest(".ub-block-frame");
    return frame !== null && !frame.classList.contains("ub-ablauf");
  })).toBe(true);
}

async function toolbarShown(button: Locator): Promise<boolean> {
  return button.evaluate(element => {
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    }
    return true;
  });
}

async function pinch(page: Page, start: number, end: number): Promise<void> {
  await viewer(page).locator(".ub-ablauf-viewer-drawing").evaluate((element, distances) => {
    const viewport = element.parentElement?.getBoundingClientRect();
    if (viewport === undefined) throw new Error("e2e: pinch viewport missing");
    const center = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
    for (const [type, distance] of [["pointerdown", distances.start], ["pointermove", distances.end], ["pointerup", distances.end]] as const) {
      for (const pointerId of [1, 2]) element.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId, pointerType: "touch", isPrimary: pointerId === 1, button: 0,
        buttons: type === "pointerup" ? 0 : 1, clientX: center.x + (pointerId === 1 ? -distance : distance), clientY: center.y,
      }));
    }
  }, { start, end });
}

async function authoredText(element: Locator): Promise<string> {
  return element.evaluate((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return copy.textContent ?? "";
  });
}

async function caretEnd(element: Locator): Promise<void> {
  await element.evaluate((node) => node.closest<HTMLElement>(".ProseMirror")?.focus());
  await setNativeSelection(element, () => element.evaluate((node) => {
    const texts = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (text) => text.parentElement?.closest(".ProseMirror-yjs-cursor") === null
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    let last: Node | null = null;
    while (texts.nextNode()) last = texts.currentNode;
    if (last === null) throw new Error("e2e: caret target has no authored text");
    const range = document.createRange();
    range.setStart(last, last.textContent?.length ?? 0);
    range.collapse(true);
    const root = node.closest(".ProseMirror") as (HTMLElement & { editor: Editor }) | null;
    if (root === null) throw new Error("e2e: caret target has no editor");
    const position = root.editor.view.posAtDOM(range.startContainer, range.startOffset);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return { anchor: position, head: position };
  }));
  await element.page().keyboard.press("Shift");
  await expect.poll(() => element.evaluate((node) => {
    const selection = document.getSelection();
    const focus = selection?.focusNode;
    return selection?.isCollapsed === true && focus?.nodeType === Node.TEXT_NODE && node.contains(focus)
      && focus.parentElement?.closest(".ProseMirror-yjs-cursor") === null
      && selection.focusOffset === focus.textContent?.length;
  })).toBe(true);
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

test("the renderer loads on first use, hides the pending drawing and retries failed chunk loads on later edits", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const uuid = await ablaufDoc(session, "Ablauf renderer recovery", FLOW, "");
  const requests: string[] = [];
  let unavailable = true;
  let release: (() => void) | undefined;
  let requested: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const firstRequest = new Promise<void>((resolve) => { requested = resolve; });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: async (page) => {
      await page.route(/\/assets\/ablauf-renderer-[^/]+\.js(?:\?.*)?$/, async (route) => {
        requests.push(route.request().url());
        requested?.();
        await held;
        if (unavailable) await route.fulfill({ status: 503, contentType: "text/javascript", headers: { "Cache-Control": "no-store" }, body: "Temporarily unavailable" });
        else await route.continue();
      });
    },
  });
  try {
    await expect(page.locator(".ub-code > code")).toHaveText(FLOW);
    expect(requests).toHaveLength(0);
    await caretEnd(page.locator(".ub-code > code"));
    await chooseLanguage(page, "ablauf", true);
    await firstRequest;
    await expect(page.locator(".ub-ablauf-viewport")).toBeHidden();
    await expect(drawing(page).locator("svg")).toHaveCount(0);
  } finally { release?.(); }
  await expectMcp(async () => { expect((await codeBlock(session, uuid)).language).toBe("ablauf"); });
  await waitForDocumentDraw(page, session, uuid, { source: FLOW, outcome: "error" });
  const diagnostics = page.locator(".ub-ablauf-diagnostics");
  await expect(diagnostics).toContainText("Preview cannot be loaded:");
  expect(requests).toHaveLength(1);
  const failedEdit = FLOW.replace('"Draft"', '"Still unavailable"');
  await editSource(session, uuid, failedEdit);
  await waitForDocumentDraw(page, session, uuid, { source: failedEdit, outcome: "error" });
  await expect(diagnostics).toContainText("Preview cannot be loaded:");
  expect(requests).toHaveLength(2);
  unavailable = false;
  const recovered = FLOW.replace('"Draft"', '"Recovered draft"');
  await editSource(session, uuid, recovered);
  await waitForDocumentDraw(page, session, uuid, { source: recovered });
  await expect(drawing(page).locator("svg")).toContainText("Recovered draft");
  await expect(diagnostics).toBeHidden();
  expect(requests).toHaveLength(3);
  expect(new Set(requests).size).toBe(3);
  expect(await authoredText(source(page))).toBe(recovered);
  await editSource(session, uuid, FLOW);
  await waitForDocumentDraw(page, session, uuid, { source: FLOW });
  expect(requests).toHaveLength(3);
});

test("the language picker draws Ablauf, Source returns its caret, and another language restores ordinary code", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const uuid = await ablaufDoc(session, "Ablauf picker", FLOW, "");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  const keyboard = info.project.use.hasTouch !== true;
  await caretEnd(page.locator(".ub-code > code"));
  await chooseLanguage(page, "ablauf", keyboard);
  await waitForDocumentDraw(page, session, uuid, { source: FLOW });
  await expect(page.locator(".ub-code")).toHaveAttribute("data-language", "ablauf");
  await expect(drawing(page).locator("svg")).toContainText("Check draft");
  await expect(source(page)).toBeVisible();
  await activateControl(neighbor(page));
  await expect(source(page)).toBeHidden();
  if (keyboard) {
    await expect(openSource(page)).toHaveText("Source");
    await openSource(page).focus();
    await page.keyboard.press("Enter");
  } else {
    await page.locator(".ub-ablauf-viewport").tap();
    await expect(viewer(page)).toBeVisible();
    await viewer(page).getByRole("button", { name: "Open ablauf source", exact: true }).tap();
    await expect(viewer(page)).toHaveCount(0);
  }
  await expect(source(page)).toBeVisible();
  await sourceIsFramed(page);
  await expect.poll(() => source(page).evaluate((element) => element.contains(document.getSelection()?.focusNode ?? null))).toBe(true);
  await expect(editor(page)).toBeFocused();
  if (keyboard) {
    await activateControl(openSource(page));
    await expect(source(page)).toBeHidden();
    await activateControl(openSource(page));
    await expect(source(page)).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Code language", exact: true })).toBeVisible();
  await chooseLanguage(page, "python", keyboard);
  await expect(page.locator(".ub-ablauf")).toHaveCount(0);
  expect(await authoredText(page.locator(".ub-code > code"))).toBe(FLOW);
  await expect(page.locator(".ub-code")).toHaveAttribute("data-language", "python");
  await expectMcp(async () => { expect(await codeBlock(session, uuid)).toMatchObject({ type: "code", language: "python", text: FLOW }); });
});

test("Markdown import, browser edits, MCP reads and export retain byte-identical ordinary code for both formats", async ({ browser }) => {
  const session = writer();
  const markdown = `Neighbor prose.\n\n\`\`\`ablauf\n${FLOW}\n\`\`\`\n\n\`\`\`ablauf\n${FANOUT}\n\`\`\``;
  const imported = importMarkdown(markdown);
  expect(imported.blocks.filter((block) => block.type === "code")).toEqual([
    { type: "code", language: "ablauf", text: FLOW }, { type: "code", language: "ablauf", text: FANOUT },
  ]);
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Imported Ablauf sources", description: "Both formats retain their exact source.", blocks: imported.blocks,
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  await expect(drawing(page).locator("svg")).toHaveCount(2);
  await expect(drawing(page).first().locator("svg")).toContainText("Check draft");
  await expect(drawing(page).last().locator("svg")).toContainText("Check approval");
  await drawing(page).first().hover();
  await openSource(page).first().click();
  await caretEnd(source(page).first());
  await page.keyboard.insertText(" revised");
  const revised = `${FLOW} revised`;
  expect(await authoredText(source(page).first())).toBe(revised);
  await expectMcp(async () => { expect(await codeBlock(session, uuid)).toMatchObject({ type: "code", language: "ablauf", text: revised }); });
  await waitForDocumentDraw(page, session, uuid, { source: revised });
  await expect(drawing(page).first().locator("svg")).toContainText("Accepted revised");
  await expectMcp(async () => {
    const exported = await session.call<{ markdown: string }>("export_markdown", { uuid, frontmatter: false });
    const expected = [revised, FANOUT].map((text) => ({ type: "code", language: "ablauf", text }));
    expect(importMarkdown(exported.markdown).blocks.filter((block) => block.type === "code")).toEqual(expected);
    expect(exported.markdown).toContain(`\`\`\`ablauf\n${revised}\n\`\`\``);
    expect(exported.markdown).toContain(`\`\`\`ablauf\n${FANOUT}\n\`\`\``);
  });
});

test("comments keep the source visible and read-only diagrams lose their authoring controls", async ({ browser }) => {
  const session = writer();
  const uuid = await ablaufDoc(session, "Annotated Ablauf");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await waitForDocumentDraw(page, session, uuid);
  await neighbor(page).click();
  await expect(source(page)).toBeHidden();
  const block = await codeBlock(session, uuid);
  await session.call("annotate", {
    uuid, block_id: block.id, start: FLOW.indexOf("draft"), end: FLOW.indexOf("draft") + 5,
    text: "Keep the diagram and its discussed source together.",
  });
  await expect(page.locator(".ub-ablauf")).toHaveAttribute("data-annotated", "true");
  await expect(source(page).locator("[data-comment-thread]")).toHaveText("draft");
  await expect(source(page)).toBeVisible();
  await sourceIsFramed(page);
  await expect(drawing(page).locator("svg")).toBeVisible();
  await drawing(page).hover();
  await openSource(page).click();
  await expect(source(page)).toBeVisible();
  await source(page).locator("[data-comment-thread]").click();
  await expect(page.locator(".ub-thread-card").filter({ hasText: "Keep the diagram and its discussed source together." })).toBeVisible();
  const before = await codeBlock(session, uuid);
  await expand(page).focus();
  await page.keyboard.press("Enter");
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).getByRole("button", { name: "Open ablauf source", exact: true })).toBeVisible();
  await session.call("archive_doc", { uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(viewer(page).getByRole("button", { name: "Open ablauf source", exact: true })).toHaveCount(0);
  await expect(viewer(page).getByRole("button", { name: "Copy ablauf source", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect(source(page)).toBeVisible();
  await expect(openSource(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Code language", exact: true })).toBeHidden();
  await source(page).click();
  await page.keyboard.type("do not mutate");
  await proveMcpArrival(page, session, uuid, { path: "upstream" });
  expect(await authoredText(source(page))).toBe(FLOW);
  await expectMcp(async () => { expect(await codeBlock(session, uuid)).toEqual(before); });
  const plainUuid = await ablaufDoc(session, "Read-only Ablauf", FANOUT);
  await session.call("archive_doc", { uuid: plainUuid });
  const fresh = await openApp(browser, `/${harness().workspace}/${plainUuid}`);
  await waitForDocumentDraw(fresh, session, plainUuid);
  await expect(editor(fresh)).toHaveAttribute("contenteditable", "false");
  await expect(drawing(fresh).locator("svg")).toContainText("Check approval");
  await expect(source(fresh)).toBeHidden();
  await expect(openSource(fresh)).toBeHidden();
});

test("frameless diagrams fit every column, keep natural size, and open by pointer only below 75%", async ({ browser }) => {
  const session = writer();
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Ablauf column fitting", description: "Natural and wide flows stay inside the reading column.",
    blocks: [{ type: "paragraph", text: "Neighbor prose." }, ...[FLOW, WIDE].map(text => ({ type: "code", language: "ablauf", text }))],
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { viewport: { width: 1440, height: 1000 }, hasTouch: false, isMobile: false },
  });
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  const blocks = page.locator(".ub-ablauf");
  const first = blocks.first();
  const natural = await drawing(page).first().locator("svg").evaluate(element => Number(element.getAttribute("width")));
  expect((await drawing(page).first().boundingBox())?.width).toBeCloseTo(natural, 0);
  await neighbor(page).click();
  await page.mouse.move(0, 0);
  await expect.poll(() => toolbarShown(expand(page).first())).toBe(false);
  await first.hover();
  await expect.poll(() => toolbarShown(expand(page).first())).toBe(true);
  await neighbor(page).click();
  await page.mouse.move(0, 0);
  await expand(page).first().focus();
  await expect.poll(() => toolbarShown(expand(page).first())).toBe(true);
  await expect(first.locator(".ub-copy")).toHaveCount(0);
  for (const width of [1440, 1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    const fits = await blocks.evaluateAll(elements => elements.map(element => {
      const viewport = element.querySelector(".ub-ablauf-viewport");
      const svg = element.querySelector(".ub-ablauf-drawing")?.shadowRoot?.querySelector("svg");
      const column = element.closest(".ProseMirror");
      if (viewport === null || svg === null || svg === undefined || column === null) throw new Error("e2e: diagram fitting probes missing");
      return { drawn: svg.getBoundingClientRect().width, natural: Number(svg.getAttribute("width")),
        column: column.getBoundingClientRect().width, scroll: viewport.scrollWidth - viewport.clientWidth };
    }));
    for (const fit of fits) {
      expect(fit.drawn).toBeLessThanOrEqual(fit.column + 0.5);
      expect(fit.drawn).toBeLessThanOrEqual(fit.natural + 0.5);
      expect(fit.scroll).toBeLessThanOrEqual(1);
    }
    expect(fits[1]?.drawn).toBeLessThan((fits[1]?.natural ?? 0) * 0.6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await first.locator(".ub-ablauf-viewport").click();
  await expect(first.locator(".ub-ablauf-viewport")).toBeFocused();
  await expect(viewer(page)).toHaveCount(0);
  const blockId = await first.getAttribute("id");
  if (blockId === null) throw new Error("e2e: Ablauf block identity missing");
  const sheet = await page.addStyleTag({ content: `[id='${blockId}'] { max-width: ${natural * 0.76}px; }` });
  const preview = first.locator(".ub-ablauf-viewport");
  await expect(preview).not.toHaveCSS("cursor", "zoom-in");
  await preview.click();
  await expect(preview).toBeFocused();
  await expect(viewer(page)).toHaveCount(0);
  await sheet.evaluate((element, css) => { element.textContent = css; }, `[id='${blockId}'] { max-width: ${natural * 0.74}px; }`);
  await expect(preview).toHaveCSS("cursor", "zoom-in");
  await preview.click();
  await expect(viewer(page)).toBeVisible();
  await expect.poll(() => zoomLevel(page)).toBe(100);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect(preview).toBeFocused();
});

test("the viewer preserves history state, restores focus on every close path, and Source returns to framed editing", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const previous = await ablaufDoc(session, "Previous Ablauf document");
  const uuid = await ablaufDoc(session, "Ablauf viewer history");
  const page = await openApp(browser, `/${harness().workspace}/${previous}`, {
    contextOptions: { viewport: { width: 1366, height: 900 }, hasTouch: false, isMobile: false },
  });
  await waitForDocumentDraw(page, session, previous);
  await page.goto(new URL(`/${harness().workspace}/${uuid}`, harness().appUrl).href);
  await waitForDocumentDraw(page, session, uuid);
  await page.evaluate(() => history.replaceState({ ...history.state, diagramTest: "retain existing entry state" }, ""));
  const before = await page.evaluate(() => history.state);
  const preview = page.locator(".ub-ablauf-viewport");
  for (const close of ["escape", "button", "back"] as const) {
    await expand(page).focus();
    await page.keyboard.press("Enter");
    await expect(viewer(page)).toBeVisible();
    const bounds = await viewer(page).boundingBox();
    expect(bounds).toMatchObject({ x: 0, y: 0, width: 1366, height: 900 });
    await expect.poll(() => zoomLevel(page)).toBe(100);
    if (close === "escape") await page.keyboard.press("Escape");
    else if (close === "button") await viewer(page).getByRole("button", { name: "Close diagram viewer", exact: true }).click();
    else await page.goBack();
    await expect(viewer(page)).toHaveCount(0);
    await expect(preview).toBeFocused();
    await expect.poll(() => page.evaluate(() => history.state)).toEqual(before);
    await expect(page.locator(".ub-title")).toHaveValue("Ablauf viewer history");
  }
  await page.goBack();
  await expect(page.locator(".ub-title")).toHaveValue("Previous Ablauf document");
  await page.goForward();
  await expect(page.locator(".ub-title")).toHaveValue("Ablauf viewer history");
  await expand(page).focus();
  await page.keyboard.press("Enter");
  await expect(viewer(page)).toBeVisible();
  await viewer(page).getByRole("button", { name: "Open ablauf source", exact: true }).click();
  await expect(viewer(page)).toHaveCount(0);
  await expect(source(page)).toBeVisible();
  await sourceIsFramed(page);
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => source(page).evaluate(element => element.contains(document.getSelection()?.focusNode ?? null))).toBe(true);
  await expect.poll(() => page.evaluate(() => history.state)).toEqual(before);
});

test("Fit shows a tall flow below 25%, while manual zoom, wheel zoom and drag stay usable", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const uuid = await ablaufDoc(session, "Ablauf sub-quarter Fit", TALL);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { viewport: { width: 1024, height: 768 }, hasTouch: false, isMobile: false },
  });
  await waitForDocumentDraw(page, session, uuid, { source: TALL });
  await expand(page).focus();
  await page.keyboard.press("Enter");
  await expect(viewer(page)).toBeVisible();
  await expect.poll(() => zoomLevel(page)).toBeLessThan(25);
  const fit = await zoomLevel(page);
  const canvas = viewer(page).locator(".ub-ablauf-viewer-viewport");
  const svg = viewer(page).locator(".ub-ablauf-viewer-drawing svg");
  await expect.poll(async () => {
    const window = await canvas.boundingBox(), diagram = await svg.boundingBox();
    return window !== null && diagram !== null && diagram.x >= window.x - 1 && diagram.y >= window.y - 1
      && diagram.x + diagram.width <= window.x + window.width + 1 && diagram.y + diagram.height <= window.y + window.height + 1;
  }).toBe(true);
  await viewer(page).getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect.poll(() => zoomLevel(page)).toBe(fit);
  await canvas.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 400);
  await page.keyboard.up("Control");
  await expect.poll(() => zoomLevel(page)).toBe(fit);
  await viewer(page).getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(() => zoomLevel(page)).toBeGreaterThanOrEqual(25);
  for (let index = 0; index < 16; index += 1) await viewer(page).getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(() => zoomLevel(page)).toBe(400);
  await canvas.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await expect.poll(() => zoomLevel(page)).toBeLessThan(400);
  const beforePan = await svg.boundingBox();
  const target = await canvas.boundingBox();
  if (beforePan === null || target === null) throw new Error("e2e: viewer pan targets missing");
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2 + 70, target.y + target.height / 2 + 40, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await svg.boundingBox())?.x).not.toBe(beforePan.x);
  for (let index = 0; index < 16; index += 1) await viewer(page).getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect.poll(() => zoomLevel(page)).toBe(25);
  await viewer(page).getByRole("button", { name: "Fit", exact: true }).click();
  await expect.poll(() => zoomLevel(page)).toBe(fit);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
});

test("iPad taps open the viewer without an inline toolbar and read-only Copy retains exact source", { tag: "@webkit-touch" }, async ({ browser }) => {
  const session = writer();
  const uuid = await ablaufDoc(session, "Read-only touch Ablauf", TALL);
  await session.call("archive_doc", { uuid });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { ...devices["iPad Pro 11"], viewport: { width: 1024, height: 768 } },
    beforeNavigate: async page => { await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => document.documentElement.setAttribute("data-copied-source", text) },
      });
    }); },
  });
  await waitForDocumentDraw(page, session, uuid, { source: TALL });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  const preview = page.locator(".ub-ablauf-viewport");
  await preview.tap();
  await expect(viewer(page)).toBeVisible();
  await expect.poll(() => zoomLevel(page)).toBeLessThan(25);
  const fit = await zoomLevel(page);
  await pinch(page, 60, 30);
  await expect.poll(() => zoomLevel(page)).toBe(fit);
  await pinch(page, 30, 120);
  await expect.poll(() => zoomLevel(page)).toBeGreaterThanOrEqual(25);
  await expect(viewer(page).getByRole("button", { name: "Open ablauf source", exact: true })).toHaveCount(0);
  for (const control of await viewer(page).getByRole("button").all()) {
    const bounds = await control.boundingBox();
    if (bounds === null) throw new Error("e2e: touch viewer control missing");
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
  await viewer(page).getByRole("button", { name: "Copy ablauf source", exact: true }).tap();
  await expect(page.locator("html")).toHaveAttribute("data-copied-source", TALL);
  await expect(viewer(page)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: (command: string) => {
      const focused = document.activeElement;
      if (command !== "copy" || !(focused instanceof HTMLTextAreaElement)) return false;
      document.documentElement.setAttribute("data-fallback-source", focused.value);
      document.documentElement.setAttribute("data-fallback-in-dialog", String(focused.closest("[role='dialog']") !== null));
      return focused.selectionStart === 0 && focused.selectionEnd === focused.value.length;
    } });
  });
  const copy = viewer(page).getByRole("button", { name: "Copy ablauf source", exact: true });
  await copy.focus();
  await copy.tap();
  await expect(page.locator("html")).toHaveAttribute("data-fallback-source", TALL);
  await expect(page.locator("html")).toHaveAttribute("data-fallback-in-dialog", "true");
  await expect(copy).toBeFocused();
  await expect(viewer(page)).toBeVisible();
  await viewer(page).getByRole("button", { name: "Close diagram viewer", exact: true }).tap();
  await expect(viewer(page)).toHaveCount(0);
  await expect(preview).toBeFocused();
  await expect.poll(() => toolbarShown(expand(page))).toBe(false);
  await expect(openSource(page)).toBeHidden();
  await expect(page.locator(".ub-ablauf .ub-copy")).toHaveCount(0);
  await expect(source(page)).toBeHidden();
  await expectMcp(async () => { expect((await codeBlock(session, uuid)).text).toBe(TALL); });
});

test("source diagnostics name their line and a render failure retains a stale last-good drawing until recovery", async ({ browser }) => {
  const session = writer();
  const uuid = await ablaufDoc(session, "Ablauf diagnostics and stale preview");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await waitForDocumentDraw(page, session, uuid);
  const invalid = `${FLOW}\nunknown statement`;
  await editSource(session, uuid, invalid);
  await waitForDocumentDraw(page, session, uuid, { source: invalid });
  await expect(page.locator(".ub-ablauf-diagnostics")).toContainText(`Line ${FLOW.split("\n").length + 1}: error:`);
  await expect(drawing(page).locator("svg")).toContainText("Check draft");
  const good = await drawing(page).locator("svg").elementHandle();
  if (good === null) throw new Error("e2e: last-good drawing is missing");
  await page.evaluate(() => {
    (window as unknown as { ablaufMeasureText: typeof CanvasRenderingContext2D.prototype.measureText }).ablaufMeasureText = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = () => { throw new Error("Injected text measurement failure"); };
  });
  const failed = FLOW.replace('"Draft"', '"Cannot draw yet"');
  try {
    await editSource(session, uuid, failed);
    await waitForDocumentDraw(page, session, uuid, { source: failed, outcome: "error" });
    await expect(page.locator(".ub-ablauf-diagnostics")).toContainText("Preview cannot be drawn: Injected text measurement failure");
    await expect(page.locator(".ub-ablauf-stale")).toHaveText("Preview is stale");
    await expect(page.locator(".ub-ablauf-stale")).toBeVisible();
    expect(await good.evaluate((element) => element.isConnected)).toBe(true);
    await expect(drawing(page).locator("svg")).toContainText("Check draft");
  } finally {
    await page.evaluate(() => { CanvasRenderingContext2D.prototype.measureText = (window as unknown as { ablaufMeasureText: typeof CanvasRenderingContext2D.prototype.measureText }).ablaufMeasureText; });
  }
  await editSource(session, uuid, FLOW);
  await waitForDocumentDraw(page, session, uuid, { source: FLOW });
  await expect(page.locator(".ub-ablauf-diagnostics")).toBeHidden();
  await expect(page.locator(".ub-ablauf-stale")).toBeHidden();
  expect(await good.evaluate((element) => element.isConnected)).toBe(false);
});

test("multiple flow and fan-out drawings keep their own arrowheads, fonts and colours through independent updates", async ({ browser }) => {
  const session = writer();
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Independent Ablauf blocks", description: "Flow and fan-out SVG styles and marker IDs stay local.",
    blocks: [FLOW, FANOUT, FLOW.replace('"Draft"', '"Third draft"')].map((text) => ({ type: "code", language: "ablauf", text })),
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  await expect(drawing(page).locator("svg")).toHaveCount(3);
  const styles = async (): Promise<{ font: string; fill: string; stroke: string }[]> => drawing(page).evaluateAll((hosts) => hosts.map((host) => {
    const root = host.shadowRoot;
    const text = root?.querySelector("text.m");
    const edge = root?.querySelector("[marker-end]");
    if (text === undefined || text === null || edge === undefined || edge === null) throw new Error("e2e: diagram style probes are missing");
    return { font: getComputedStyle(text).fontFamily, fill: getComputedStyle(text).fill, stroke: getComputedStyle(edge).stroke };
  }));
  const before = await styles();
  const markers = await drawing(page).evaluateAll((hosts) => hosts.map((host) => {
    const root = host.shadowRoot;
    if (root === null) throw new Error("e2e: diagram has no isolated SVG root");
    const ids = [...root.querySelectorAll("marker")].map((marker) => marker.id);
    const references = [...root.querySelectorAll("[marker-end]")].map((edge) => edge.getAttribute("marker-end") ?? "");
    return { ids, local: references.length > 0 && references.every((reference) => ids.some((id) => reference === `url(#${id})`)) };
  }));
  expect(markers.every((entry) => entry.local)).toBe(true);
  const ids = markers.flatMap((entry) => entry.ids);
  expect(new Set(ids).size).toBe(ids.length);
  const first = await drawing(page).first().locator("svg").elementHandle();
  const second = await drawing(page).nth(1).locator("svg").elementHandle();
  if (first === null || second === null) throw new Error("e2e: independent drawings are missing");
  const revised = FLOW.replace('"Draft"', '"Only third changes"');
  await editSource(session, uuid, revised, 2);
  await waitForDocumentDraw(page, session, uuid, { index: 2, source: revised });
  await expect(drawing(page).last().locator("svg")).toContainText("Only third changes");
  expect(await first.evaluate((element) => element.isConnected)).toBe(true);
  expect(await second.evaluate((element) => element.isConnected)).toBe(true);
  expect((await styles()).slice(0, 2)).toEqual(before.slice(0, 2));
});

test("markup and script-like labels stay literal text without executable elements or CSP violations", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const script = "<script>window.ablaufExecuted=true</script>";
  const image = "<img src=x onerror='window.ablaufExecuted=true'>";
  const hostile = `flow v0\ncolumns main\npill script "${script}"\nbox image "${image}"\nend done "</text><script>window.ablaufExecuted=true</script>"\nscript --> image : <svg onload='window.ablaufExecuted=true'>\nimage --> done`;
  const uuid = await ablaufDoc(session, "Literal hostile Ablauf text", hostile);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: async (page) => { await page.addInitScript(() => {
      const probe = { executed: false, violations: [] as string[] };
      Object.defineProperty(window, "ablaufExecuted", { get: () => probe.executed, set: () => { probe.executed = true; } });
      (window as unknown as { ablaufSecurity: typeof probe }).ablaufSecurity = probe;
      document.addEventListener("securitypolicyviolation", (event) => { probe.violations.push(event.effectiveDirective); });
    }); },
  });
  await waitForDocumentDraw(page, session, uuid, { source: hostile });
  await expect(drawing(page).locator("svg")).toContainText(script);
  await expect(drawing(page).locator("svg")).toContainText(image);
  await expect(drawing(page).locator("script, image, foreignObject, [onload], [onerror]")).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
  expect(await page.evaluate(() => (window as unknown as { ablaufSecurity: { executed: boolean; violations: string[] } }).ablaufSecurity))
    .toEqual({ executed: false, violations: [] });
  await expectMcp(async () => { expect((await codeBlock(session, uuid)).text).toBe(hostile); });
});
