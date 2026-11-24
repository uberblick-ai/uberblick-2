import { randomUUID } from "node:crypto";
import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { appendBlock, applyDocData, initDoc, prepareDocData, snapshotRevision } from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import * as Y from "yjs";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";
import { mockFigmaLookup } from "./figma-fixtures.js";
import { placeCaretIn } from "./harness.js";
import { legacyDecisionPeer } from "./legacy-decision-peer.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp, proveMcpArrival } from "./settle.js";

const { harness, openApp } = setupHarness();
const SOURCE = ':value{"collection":"results","filter":{"system":"Whisper turbo"},"field":"wer","format":"number","decimals":1}';
const DESCRIPTION = 'results › system = "Whisper turbo" › wer, number, 1 decimal';
const SCHEMA = { version: 1, schema: { type: "object" } } as const;
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({ workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-inline-values-" });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: inline value writer is missing");
  return agent.open({ name: "inline-values-e2e" });
}

interface StoredDoc { uuid: string; blocks: Array<{ id: string; text: string; rev: string }> }

async function create(session: McpSession, blocks: BlockInput[]): Promise<{ uuid: string }> {
  return session.call<{ uuid: string }>("create_doc", { title: docTitle("Inline values"),
    description: "Synthetic data values in prose browser acceptance.", blocks });
}

async function update(session: McpSession, uuid: string, wer: number): Promise<void> {
  await session.call("update_data", { uuid, operations: [{ collection: "results", schema: SCHEMA,
    replaceRecords: [{ id: "whisper", value: { system: "Whisper turbo", wer } }] }] });
}

async function open(browser: Browser, uuid: string, touch: boolean): Promise<Page> {
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    upstream: true,
    contextOptions: { ...(touch ? devices["iPad (gen 7) landscape"] : { viewport: { width: 1366, height: 1000 } }), locale: "en-US" },
    beforeNavigate: async target => {
      await mockFigmaLookup(target);
      await target.route("https://embed.figma.com/**", route => route.fulfill({ contentType: "text/html", body: "<p>Synthetic Figma canvas</p>" }));
    },
  });
  await expect(editor(page)).toBeVisible();
  return page;
}

function selection(page: Page): Promise<{ from: number; to: number }> {
  return editor(page).evaluate(element => {
    const { from, to } = (element as HTMLElement & { editor: Editor }).editor.state.selection;
    return { from, to };
  });
}

function text(page: Page): Promise<string> {
  return editor(page).evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.textContent);
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  const key = process.platform === "darwin" && page.context().browser()?.browserType().name() === "webkit" ? "Alt+Tab" : "Tab";
  for (let index = 0; index < 40; index += 1) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

test("prose values keep table formatting, literal exclusions and readable descriptions while live data changes", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const session = writer();
  const source = `Result ${SOURCE}%`;
  const missing = ':value{"collection":"missing","filter":{"system":"Whisper turbo"},"field":"wer"}';
  const invalid = ':value{"collection":"results","filter":{},"field":"wer"}';
  const created = await create(session, [
    { type: "paragraph", text: source },
    { type: "heading", level: 2, text: source },
    { type: "list-item", text: source },
    { type: "quote", text: source },
    { type: "callout", variant: "note", text: source },
    { type: "table", text: `| Result |\n| --- |\n| ${SOURCE} |` },
    { type: "paragraph", text: `${missing} ${invalid}` },
    { type: "paragraph", inline: [{ text: SOURCE, marks: { inlineCode: true } }] },
    { type: "paragraph", inline: [{ text: SOURCE, marks: { link: "https://example.invalid/literal" } }] },
    { type: "code", language: "text", text: SOURCE },
    { type: "card", text: `title: Literal value\n\n${SOURCE}` },
    { type: "figma", text: `url: https://www.figma.com/design/value123/Fixture\nheight: 240\n\n${SOURCE}` },
    { type: "chart", text: JSON.stringify({ version: 1, type: "table", collection: "results",
      columns: [{ field: "wer", format: "number", decimals: 1 }] }) },
    { type: "footnote", label: "literal", text: SOURCE },
  ]);
  await update(session, created.uuid, 10);
  let original: Array<{ id: string; text: string }> = [];
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), doc => {
    expect(doc.blocks[0]?.text).toBe(source);
    original = doc.blocks.map(block => ({ id: block.id, text: block.text }));
  });
  const touch = info.project.use.hasTouch === true;
  const page = await open(browser, created.uuid, touch);
  const prose = editor(page);
  const values = prose.locator(".ub-inline-value");
  await expect(values).toHaveCount(8);
  const value = prose.locator(":scope > p").first().locator(".ub-inline-value");
  await expect(value).toHaveText("10.0");
  await expect(value).toHaveAttribute("title", DESCRIPTION);
  await expect(value).toHaveAccessibleName(`10.0 · ${DESCRIPTION}`);
  const tableCell = prose.locator(".ub-data-table tbody td");
  await expect(tableCell).toHaveText(await value.textContent() ?? "");
  for (const index of [0, 1, 2, 3, 4, 5]) await expect(values.nth(index)).toHaveText("10.0");
  await expect(values.nth(6)).toHaveText(/collection.*missing|missing.*collection/i);
  await expect(values.nth(7)).toHaveText(/source|unreadable/i);
  await expect(values.nth(6)).toHaveAttribute("aria-label", /collection.*missing|missing.*collection/i);
  await expect(values.nth(7)).toHaveAttribute("title", invalid);
  for (const literal of [
    prose.locator("code").filter({ hasText: SOURCE }),
    prose.getByRole("link", { name: SOURCE, exact: true }),
    prose.locator(".ub-card-body"), prose.locator(".ub-figma-caption"), prose.locator('[data-block-type="footnote"]'),
  ]) {
    await expect(literal.first()).toBeAttached();
    for (const surface of await literal.all()) await expect(surface).toContainText(SOURCE);
    await expect(literal.locator(".ub-inline-value")).toHaveCount(0);
  }
  if (touch) await value.tap();
  else await value.hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]').filter({ hasText: DESCRIPTION });
  for (const appearance of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: appearance });
    await page.evaluate(() => document.fonts.ready);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(DESCRIPTION);
    const readings = await renderedText(page, ".ub-editor", { exclude: ".ub-inline-value-source" });
    const valueInk = readings.filter(reading => reading.where.includes("ub-inline-value"));
    expect(valueInk.length).toBeGreaterThan(0);
    for (const reading of valueInk) expect(reading.ratio, `${appearance}: ${reading.where}`).toBeGreaterThanOrEqual(4.5);
    const bounds = await tooltip.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  }
  await page.keyboard.press("Escape");
  await update(session, created.uuid, 6.25);
  await expect(value).toHaveText("6.3");
  await expect(tableCell).toHaveText("6.3");
  // A later browser metadata write reaches this upstream reader before the unchanged-prose assertion.
  await proveMcpArrival(page, session, created.uuid, { path: "upstream" });
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), doc => {
    expect(doc.blocks.map(block => ({ id: block.id, text: block.text }))).toEqual(original);
  });
  const peer = await legacyDecisionPeer(harness(), created.uuid);
  try {
    const pending = prepareDocData(peer.doc, peer.directory, [{ collection: "results",
      replaceRecords: [{ id: "whisper", value: { system: "Whisper turbo", wer: 4 } }] }]);
    await session.call("archive_doc", { uuid: created.uuid });
    await expect(prose).toHaveAttribute("contenteditable", "false");
    pending.commit();
    await expect(value).toHaveText("4.0");
    await tabTo(page, value);
    await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: DESCRIPTION })).toBeVisible();
  } finally { peer.close(); }
});

test("closing braces and native paste create atomic values with whole-source movement, cut, deletion and undo", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const session = writer();
  const created = await create(session, [{ type: "paragraph", text: "Before " }]);
  await update(session, created.uuid, 10);
  const touch = info.project.use.hasTouch === true;
  const page = await open(browser, created.uuid, touch);
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
  const paragraph = editor(page).locator(":scope > p").first();
  await placeCaretIn(paragraph, { touch });
  await page.keyboard.insertText(SOURCE.slice(0, -1));
  await expect(paragraph.locator(".ub-inline-value")).toHaveCount(0);
  await page.keyboard.type("}");
  await expect(paragraph.locator(".ub-inline-value")).toHaveText("10.0");
  const start = 1 + "Before ".length;
  const end = start + SOURCE.length;
  await expect.poll(() => selection(page)).toEqual({ from: end, to: end });
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => selection(page)).toEqual({ from: start, to: start });
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => selection(page)).toEqual({ from: end, to: end });
  await page.keyboard.press("Escape");
  await tabTo(page, paragraph.locator(".ub-inline-value"));
  await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: DESCRIPTION })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => selection(page)).toEqual({ from: start, to: start });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => selection(page)).toEqual({ from: start, to: end });
  await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: DESCRIPTION })).toBeVisible();
  await page.keyboard.press(`${modifier}+x`);
  await expect.poll(() => text(page)).toBe("Before ");
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => text(page)).toBe(`Before ${SOURCE}`);
  await tabTo(page, paragraph.locator(".ub-inline-value"));
  await page.keyboard.press("Backspace");
  await expect.poll(() => text(page)).toBe("Before ");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => text(page)).toBe(`Before ${SOURCE}`);
  await placeCaretIn(paragraph, { touch });
  await page.keyboard.press("Backspace");
  await expect.poll(() => text(page)).toBe("Before ");
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => text(page)).toBe(`Before ${SOURCE}`);
  await placeCaretIn(paragraph, { touch });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Delete");
  await expect.poll(() => text(page)).toBe("Before ");
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => text(page)).toBe(`Before ${SOURCE}`);
  await placeCaretIn(paragraph, { touch });
  await page.keyboard.press("Enter");
  // The clipboard still holds the earlier native cut, including its exact stored source.
  await page.keyboard.press(`${modifier}+v`);
  await expect(editor(page).locator(".ub-inline-value")).toHaveText(["10.0", "10.0"]);
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), doc => {
    expect(doc.blocks.map(block => block.text)).toEqual([`Before ${SOURCE}`, SOURCE]);
  });
});

test("history values use each shown revision's data in split and inline views", { tag: "@webkit" }, async ({ browser }, info) => {
  const uuid = randomUUID();
  const document = new Y.Doc();
  const directory = new Y.Doc();
  const ids = { latest: randomUUID(), earlier: randomUUID() };
  const states: Record<string, string> = {};
  try {
    initDoc(document, { uuid, title: docTitle("Inline value history") });
    appendBlock(document, { type: "paragraph", text: `Result ${SOURCE}` });
    applyDocData(document, directory, [{ collection: "results", schema: SCHEMA,
      replaceRecords: [{ id: "whisper", value: { system: "Whisper turbo", wer: 5 } }] }]);
    states[ids.earlier] = Buffer.from(snapshotRevision(document).state).toString("base64");
    applyDocData(document, directory, [{ collection: "results",
      replaceRecords: [{ id: "whisper", value: { system: "Whisper turbo", wer: 10 } }] }]);
    states[ids.latest] = Buffer.from(snapshotRevision(document).state).toString("base64");
    await harness().seedDocument(document);
  } finally { document.destroy(); directory.destroy(); }
  const touch = info.project.use.hasTouch === true;
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { ...(touch ? devices["iPad (gen 7) landscape"] : { viewport: { width: 1440, height: 1000 } }), locale: "en-US", reducedMotion: "reduce" },
    beforeNavigate: async target => {
      await target.route("**/api/revisions?**", async route => {
        const id = new URL(route.request().url()).searchParams.get("revision");
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({
          history: { complete: true, lastRefresh: new Date().toISOString(), refreshFailed: false,
            offline: false, newestDownloadedRevision: ids.latest },
          ...(id === null ? { revisions: [
            { id: ids.latest, author: null, startedAt: 2_000, endedAt: null },
            { id: ids.earlier, author: null, startedAt: 1_000, endedAt: 2_000 },
          ] } : { state: states[id] }),
        }) });
      });
    },
  });
  await expect(editor(page).locator(".ub-inline-value")).toHaveText("10.0");
  const history = page.getByRole("group", { name: "Document history", exact: true });
  await activateControl(history.getByRole("button", { name: "Previous revision", exact: true }));
  const list = page.getByRole("navigation", { name: "Revision history", exact: true });
  for (const mode of ["Split", "Inline"] as const) {
    const drawer = !await list.isVisible();
    if (drawer) await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
    await activateControl(list.getByRole("button", { name: mode, exact: true }));
    await list.getByRole("switch", { name: "Collapse unchanged", exact: true }).setChecked(false);
    if (drawer) await page.keyboard.press("Escape");
    const revision = page.locator(".ub-revision-pane");
    const latest = revision.locator('.ProseMirror:not([aria-label="Before this revision"])');
    await expect(latest).toHaveAttribute("aria-readonly", "true");
    await expect(latest.locator(".ub-inline-value")).toHaveText("10.0");
    if (mode === "Split") await expect(revision.locator('[aria-label="Before this revision"] .ub-inline-value')).toHaveText("5.0");
  }
  await activateControl(history.getByRole("button", { name: "Previous revision", exact: true }));
  await expect(page.locator(".ub-revision-pane .ub-inline-value")).toHaveText("5.0");
});
