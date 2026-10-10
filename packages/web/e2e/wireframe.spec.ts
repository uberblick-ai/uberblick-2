/**
 * SPIKE: wireframe previews on ```wireframe code blocks.
 *
 * Evidence, not regression coverage: an agent writes wireframe source over
 * MCP as an ordinary code block, and the editor served by `ub open` draws it.
 * Screenshots land in test-results (or WIREFRAME_EVIDENCE when set); timings
 * are printed as JSON lines for the spike report.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-wireframe-${process.env.UB_AGENTS_RUN ?? "local"}-`,
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: wireframe MCP agent is not configured");
  return agent.open({ name: "wireframe-e2e" });
}

interface DocPayload { uuid: string; blocks: { id: string; type: string; text: string; rev: string; language?: string }[] }

const DECISION_LOG = `frame w=760 Decision Log
  h2 Decision Log
  list
    item.card
      row
        icon chevron-right
        text.fill What should \`ub init\` accept as the hub argument?
        text.muted 12 :comment:
        tabs.segmented active=Done Open | Ongoing | Done
    item.card
      row
        icon chevron-right
        text.fill What does \`ub init <url>\` do on a machine that already has a different hubUrl?
        text.muted 1 :comment:
        tabs.segmented active=Open Open | Ongoing | Done
    item.card.selected
      row
        icon chevron-down
        text.fill Should \`ub workspace create\` ship in release 1?
        tabs.segmented active=Open Open | Ongoing | Done
      text The basic options are:
      list.bullets
        - We ship it in release 1
        - We skip it and defer it for a later release
      row align=top
        avatar.lg
        textarea lines=3 Add to the discussion
      row align=end
        button.primary Post`;

const DOC_LIST = `frame.window url=uberblick.local/docs All documents
  row
    col w=fill
      title All documents
      text.small.muted 24 documents
    button.primary :plus: New document
  row
    input icon=search w=fill Search titles
    tabs.pills active=All All | Requirements | Decisions
    dropdown Sort: Updated
  table
    | Title | Tags | Updated | |
    | **Wireframe blocks** | {spec} {draft} | 2 h ago | :pin: |
    | Decision Log | {decision} {+2} | yesterday | :pin: |
    | Card blocks | {spec} | 3 days ago | |
    | Embed blocks | {spec} | last week | |`;

const STORYBOARD = `frame.phone Topics
  input icon=search Search
  row
    title Topics
    spacer
    avatar BK
  grid cols=2
    image h=84 Topic 1
    image h=84 Topic 2
    image h=84 Topic 3
    image h=84 Topic 4
  spacer
  tabs.bar active=Home :home: Home | :chat: Talk | :fire: Quiz | :book: Vocab
frame.phone Call
  row
    icon close
    spacer
    text.strong 2 min
  avatar w=fill
  lorem lines=4
  spacer
  input Send message
frame.phone Settings
  h2 Settings
  box.card
    row
      text.fill Notifications
      switch.on
    line
    row
      text.fill Daily reminder
      switch
    line
    row
      text.fill Dark mode
      switch.on
  banner hue=amber icon=archive This workspace is archived
  spacer
  button.danger Sign out`;

const COMMENTS = `row gap=lg align=top
  col w=55%
    text We ship the beta to ten workspaces ==first==.
    lorem lines=3
  line.v
  col w=fill
    row
      text.caption On this page
      spacer
      text.small Rollout
      icon chevron-down
    box.card
      row
        avatar AL
        text.strong Ana Lopez
        spacer
        text.small.muted 2 h ago
      text Ten feels low. Could we do twenty?
      text.small.muted 2 replies
    text.small.muted 1 resolved`;

const ROUGH = `frame Robustness
  carousel 3 slides
  ??? this line is not an element
  button.primary w=120 w=140 Twice
      text over-indented
  icon not-an-icon
  text <img src=x onerror=alert(1)> stays text`;

const SAMPLES = { "decision-log": DECISION_LOG, "doc-list": DOC_LIST, storyboard: STORYBOARD, comments: COMMENTS, rough: ROUGH };

async function wireframeDoc(session: McpSession, title: string, sources: string[], extra = ""): Promise<string> {
  const blocks = sources.flatMap((text, index) => [
    { type: "paragraph", text: `Screen ${index + 1}${extra}` },
    { type: "code", language: "wireframe", text },
  ]);
  const result = await session.call<{ uuid: string }>("create_doc", {
    title, description: "Wireframe preview spike.", blocks: [{ type: "paragraph", text: "Wireframes follow." }, ...blocks],
  });
  return result.uuid;
}

async function evidence(target: Locator, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await target.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
  const directory = process.env.WIREFRAME_EVIDENCE;
  if (directory !== undefined) {
    mkdirSync(directory, { recursive: true });
    copyFileSync(path, join(directory, `${name}.png`));
  }
}

async function ready(page: Page, count: number): Promise<void> {
  await expect(page.locator(".ub-wireframe .wf-root")).toHaveCount(count);
  await page.evaluate(() => document.fonts.ready);
}

test("an agent's wireframe blocks render in the editor in both appearances, desktop width", async ({ browser }, info) => {
  const session = writer();
  const uuid = await wireframeDoc(session, "Wireframe samples", Object.values(SAMPLES));
  for (const appearance of ["light", "dark"] as const) {
    const errors: string[] = [];
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { colorScheme: appearance, viewport: { width: 1440, height: 1000 } },
    });
    page.on("pageerror", error => errors.push(String(error)));
    page.on("dialog", dialog => { errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });
    await ready(page, 5);
    const blocks = page.locator(".ub-wireframe");
    // Previews show; the source stays hidden until the caret enters the block.
    await expect(page.locator(".ub-wireframe-source").first()).toBeHidden();
    // The renderer never styles the host page.
    const host = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily, html: getComputedStyle(document.documentElement).colorScheme,
    }));
    expect(host.body).toContain("Geist");
    // Inert output: nothing inside a preview is focusable or a real control.
    expect(await page.locator(".wf-root").locator("button, input, textarea, a, [tabindex]").count()).toBe(0);
    // Hostile text stays text.
    await expect(page.locator(".wf-root img")).toHaveCount(0);
    const names = Object.keys(SAMPLES);
    const measures: Record<string, unknown> = {};
    for (let index = 0; index < names.length; index += 1) {
      const block = blocks.nth(index);
      await block.scrollIntoViewIfNeeded();
      await evidence(block.locator(".ub-wireframe-panel"), info, `${names[index]}-desktop-${appearance}`);
      measures[names[index] ?? ""] = await block.locator(".ub-wireframe-viewport").evaluate(element => ({
        scale: (element as HTMLElement).dataset.scale, scrolls: (element as HTMLElement).dataset.scrolls,
        renderMs: (element as HTMLElement).dataset.renderMs, column: element.clientWidth,
      }));
    }
    await expect(blocks.nth(0).locator(".ub-wireframe-viewport")).toHaveAttribute("aria-label", /Wireframe, one screen \(Decision Log\)/);
    await expect(blocks.nth(4).locator(".ub-wireframe-diagnostics")).toContainText("not an element");
    await expect(blocks.nth(4).locator(".ub-wireframe-diagnostics")).toContainText("given twice");
    await expect(blocks.nth(4).locator(".wf-unknown")).toContainText("carousel");
    console.log(`wireframe desktop ${appearance}: ${JSON.stringify(measures)}`);
    expect(errors).toEqual([]);
    await page.context().close();
  }
});

test("phone width keeps previews legible: scale floor 0.6, then sideways scroll", async ({ browser }, info) => {
  const session = writer();
  const uuid = await wireframeDoc(session, "Wireframes on a phone", [DECISION_LOG, STORYBOARD, COMMENTS]);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  });
  await ready(page, 3);
  const measures = [];
  for (const [index, name] of ["decision-log", "storyboard", "comments"].entries()) {
    const block = page.locator(".ub-wireframe").nth(index);
    await block.scrollIntoViewIfNeeded();
    const viewport = block.locator(".ub-wireframe-viewport");
    const scale = Number(await viewport.getAttribute("data-scale"));
    expect(scale).toBeGreaterThanOrEqual(0.6);
    measures.push({ name, scale, scrolls: await viewport.getAttribute("data-scrolls"), column: await viewport.evaluate(element => element.clientWidth) });
    await evidence(block.locator(".ub-wireframe-panel"), info, `${name}-phone`);
  }
  // The page itself never scrolls sideways; only a preview's own viewport does.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  console.log(`wireframe phone: ${JSON.stringify(measures)}`);
});

test("caret in the block shows source below a live preview; edits store as plain code-block text", async ({ browser }, info) => {
  const session = writer();
  const uuid = await wireframeDoc(session, "Editable wireframe", [DECISION_LOG]);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { contextOptions: { viewport: { width: 1280, height: 1000 } } });
  await ready(page, 1);
  const block = page.locator(".ub-wireframe");
  await block.hover();
  await block.getByRole("button", { name: "Edit wireframe source" }).click();
  const source = block.locator(".ub-wireframe-source");
  await expect(source).toBeVisible();
  await expect(block.locator(".ub-wireframe-panel")).toBeVisible();
  await expect(block).toHaveClass(/ub-wireframe-editing/);
  // Type a new element at the end of the source and watch the preview follow.
  await expect(source).toBeVisible();
  await source.locator("code").click();
  // Collapse the selection at the end of the source, as the chart proof does.
  await source.locator("code").evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  // Enter, not "\n" in insertText: Chromium drops a newline sent as text input.
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("        button.quiet Cancel");
  await expect(block.locator(".wf-btn", { hasText: "Cancel" })).toBeVisible();
  await evidence(block, info, "editing-source-and-preview");
  await expect.poll(async () => {
    const doc = await session.call<DocPayload>("get_doc", { uuid });
    return doc.blocks.find(entry => entry.type === "code")?.text.split("\n").at(-1)?.trim();
  }).toBe("button.quiet Cancel");
  const stored = await session.call<DocPayload>("get_doc", { uuid });
  const code = stored.blocks.find(entry => entry.type === "code");
  expect(code?.language ?? "wireframe").toBe("wireframe");
  const markdown = await session.call<{ markdown: string } | string>("export_markdown", { uuid, frontmatter: false });
  const text = typeof markdown === "string" ? markdown : JSON.stringify(markdown);
  expect(text).toContain("```wireframe");
  // Leaving the block hides the source again.
  await editor(page).locator(":scope > p").first().click();
  await expect(source).toBeHidden();
  // An agent's edit_block redraws the open preview.
  const fresh = (await session.call<DocPayload>("get_doc", { uuid })).blocks.find(entry => entry.type === "code");
  await session.call("edit_block", { uuid, block_id: fresh?.id, old_text: fresh?.text ?? "", new_text: (fresh?.text ?? "").replace("button.primary Post", "button.primary Publish"), rev: fresh?.rev });
  await expect(block.locator(".wf-btn", { hasText: "Publish" })).toBeVisible();
  // Full size opens an unscaled copy in a dialog.
  await block.hover();
  await block.getByRole("button", { name: "Open wireframe at full size" }).click();
  const dialog = page.locator("dialog.ub-wireframe-dialog");
  await expect(dialog).toBeVisible();
  await evidence(dialog, info, "full-size-dialog");
  await dialog.getByRole("button", { name: "close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("a comment on the source keeps both source and preview visible", async ({ browser }, info) => {
  const session = writer();
  const uuid = await wireframeDoc(session, "Commented wireframe", [DOC_LIST]);
  const doc = await session.call<DocPayload>("get_doc", { uuid });
  const code = doc.blocks.find(entry => entry.type === "code");
  if (code === undefined) throw new Error("e2e: no wireframe block");
  const start = code.text.indexOf("Decision Log");
  await session.call("annotate", { uuid, block_id: code.id, start, end: start + "Decision Log".length, text: "Should this row show its status?" });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { contextOptions: { viewport: { width: 1280, height: 1000 } } });
  await ready(page, 1);
  const block = page.locator(".ub-wireframe");
  await expect(block).toHaveAttribute("data-annotated", "true");
  await expect(block.locator(".ub-wireframe-source")).toBeVisible();
  await expect(block.locator(".ub-wireframe-panel")).toBeVisible();
  await expect(block.locator(".ub-comment")).toContainText("Decision Log");
  await evidence(block, info, "commented-source-and-preview");
  // Renaming the commented words through an agent edit: does the anchor survive?
  const live = (await session.call<DocPayload>("get_doc", { uuid })).blocks.find(entry => entry.type === "code");
  await session.call("edit_block", { uuid, block_id: live?.id, old_text: live?.text ?? "", new_text: (live?.text ?? "").replace("| Decision Log |", "| Decision log |"), rev: live?.rev });
  await expect(block.locator(".wf-table")).toContainText("Decision log");
  console.log(`wireframe comment after rename: annotated=${await block.getAttribute("data-annotated")} anchoredText=${JSON.stringify(await block.locator(".ub-comment").allTextContents())}`);
});

/** Keydown-to-next-frame latency for `keys` keystrokes, in milliseconds. */
async function typingLatency(page: Page, target: Locator, keys: number): Promise<{ median: number; p95: number; max: number }> {
  await target.click();
  await page.keyboard.press("End");
  await page.evaluate(() => {
    const state = window as unknown as { latencies: number[]; probing?: boolean };
    state.latencies = [];
    if (state.probing === true) return;
    state.probing = true;
    document.addEventListener("keydown", event => {
      if (event.key.length !== 1) return;
      const started = performance.now();
      requestAnimationFrame(() => setTimeout(() => state.latencies.push(performance.now() - started), 0));
    }, { capture: true });
  });
  for (let index = 0; index < keys; index += 1) await page.keyboard.type(String.fromCharCode(97 + (index % 26)), { delay: 40 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { latencies: number[] }).latencies.length)).toBe(keys);
  const values = (await page.evaluate(() => (window as unknown as { latencies: number[] }).latencies)).sort((a, b) => a - b);
  const pick = (q: number): number => Math.round((values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0) * 10) / 10;
  return { median: pick(0.5), p95: pick(0.95), max: pick(1) };
}

test("typing stays responsive in a document with 100 wireframe blocks", async ({ browser }) => {
  test.setTimeout(240_000);
  const session = writer();
  const many = Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? DOC_LIST : DECISION_LOG));
  const wireframes = await wireframeDoc(session, "Hundred wireframes", many);
  const baseline = await session.call<{ uuid: string }>("create_doc", {
    title: "Hundred code blocks", description: "Baseline.",
    blocks: [{ type: "paragraph", text: "Code follows." }, ...many.flatMap((text, index) => [
      { type: "paragraph", text: `Screen ${index + 1}` }, { type: "code", language: "yaml", text },
    ])],
  });
  const results: Record<string, unknown> = {};
  for (const throttle of [1, 4]) {
    for (const [name, uuid] of [["code blocks", baseline.uuid], ["wireframes", wireframes]] as const) {
      const page = await openApp(browser, "about:blank", { contextOptions: { viewport: { width: 1440, height: 1000 } } });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
      const started = Date.now();
      await page.goto(new URL(`/${harness().workspace}/${uuid}`, harness().appUrl).href);
      if (name === "wireframes") await expect(page.locator(".ub-wireframe .wf-root")).toHaveCount(100, { timeout: 60_000 });
      else await expect(page.locator("pre.ub-code")).toHaveCount(100, { timeout: 60_000 });
      const loadMs = Date.now() - started;
      const renderMs = name === "wireframes"
        ? await page.locator(".ub-wireframe-viewport").evaluateAll(elements =>
          elements.reduce((sum, element) => sum + Number((element as HTMLElement).dataset.renderMs ?? 0), 0))
        : 0;
      const paragraph = typingLatency(page, editor(page).locator(":scope > p").first(), 30);
      const prose = await paragraph;
      let inBlock: unknown = null;
      if (name === "wireframes") {
        const block = page.locator(".ub-wireframe").first();
        await block.hover();
        await block.getByRole("button", { name: "Edit wireframe source" }).click();
        inBlock = await typingLatency(page, block.locator(".ub-wireframe-source code"), 30);
      }
      results[`${name} @${throttle}x`] = { loadMs, renderMsTotal: Math.round(renderMs), prose, inBlock };
      await page.context().close();
    }
  }
  console.log(`wireframe typing: ${JSON.stringify(results)}`);
});

