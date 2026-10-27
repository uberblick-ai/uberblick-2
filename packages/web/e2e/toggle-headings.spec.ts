import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { BlockInput } from "@uberblick/schema";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { keys, placeCaretIn } from "./harness.js";
import { legacyDecisionPeer } from "./legacy-decision-peer.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const peers: Array<{ close: () => void }> = [];

test.beforeAll(() => {
  agent = new McpAgent({ workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-toggle-headings-" });
});
test.afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await agent?.closeSessions();
});
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc { uuid: string; blocks: Array<{ id: string; text: string; rev: string }> }

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: toggle-heading writer is missing");
  return agent.open({ name: "toggle-headings-e2e" });
}

async function create(session: McpSession, blocks: BlockInput[]): Promise<StoredDoc> {
  return session.call<StoredDoc>("create_doc", {
    title: docTitle("Toggle headings"), description: "Synthetic toggle-heading browser acceptance.", blocks,
  });
}

async function open(browser: Browser, uuid: string, touch = false): Promise<Page> {
  return openApp(browser, `/${harness().workspace}/${uuid}`, {
    upstream: true,
    contextOptions: touch ? devices["iPad (gen 7)"] : { viewport: { width: 1400, height: 1000 } },
    readySelector: ".ub-editor .ProseMirror",
  });
}

function control(page: Page, label: string, expanded = false): Locator {
  return page.getByRole("button", { name: `${expanded ? "Collapse" : "Expand"} ${label}`, exact: true });
}

function block(page: Page, document: StoredDoc, index: number): Locator {
  const id = document.blocks[index]?.id;
  if (id === undefined) throw new Error("e2e: missing toggle-heading fixture block");
  return editor(page).locator(`[id="${id}"]`);
}

async function caret(page: Page): Promise<{ id: string; offset: number; empty: boolean }> {
  return editor(page).evaluate((element) => {
    const selection = (element as HTMLElement & { editor: Editor }).editor.state.selection;
    return { id: String(selection.$head.parent.attrs.id), offset: selection.$head.parentOffset, empty: selection.empty };
  });
}

async function documentContent(page: Page): Promise<unknown> {
  return editor(page).evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.toJSON());
}

test("nested toggles fold their sections, stay local and restart collapsed", async ({ browser }) => {
  const session = writer();
  const created = await create(session, [
    { type: "heading", level: 2, text: "> Outer" },
    { type: "paragraph", text: "Outer prose" },
    { type: "heading", level: 3, text: "> Inner" },
    { type: "paragraph", text: "Inner prose" },
    { type: "heading", level: 3, text: "Inner boundary" },
    { type: "paragraph", text: "Outer remainder" },
    { type: "heading", level: 2, text: "Outer boundary" },
    { type: "heading", level: 3, text: ">x" },
    { type: "heading", level: 3, text: " > x" },
    { type: "heading", level: 2, text: "> Final" },
    { type: "paragraph", text: "Document tail" },
    { type: "code", text: "get_help(get_doc)" },
    { type: "table", text: "| Tool |\n| --- |\n| get_doc |" },
    { type: "card", text: "title: Details\n\nHidden card prose" },
  ]);
  const before = await session.call<StoredDoc>("get_doc", { uuid: created.uuid });
  const page = await open(browser, created.uuid);
  await expect(control(page, "Outer")).toHaveAttribute("aria-expanded", "false");
  await expect(block(page, created, 1)).toBeHidden();
  await expect(block(page, created, 6)).toBeVisible();
  await expect(block(page, created, 7)).toContainText(">x");
  await expect(block(page, created, 8)).toContainText(" > x");
  await expect(editor(page).locator("[data-toggle-heading]")).toHaveCount(3);
  await expect(block(page, created, 10)).toBeHidden();
  for (const index of [11, 12, 13]) await expect(block(page, created, index)).toBeHidden();
  await expect(editor(page).locator(".ub-toggle-heading-marker").first()).toBeHidden();

  await control(page, "Outer").click();
  await expect(block(page, created, 1)).toBeVisible();
  await expect(control(page, "Inner")).toHaveAttribute("aria-expanded", "false");
  await expect(block(page, created, 3)).toBeHidden();
  await expect(block(page, created, 4)).toBeVisible();
  await expect(block(page, created, 5)).toBeVisible();
  await control(page, "Inner").focus();
  await page.keyboard.press("Enter");
  await expect(control(page, "Inner", true)).toHaveAttribute("aria-expanded", "true");
  await expect(block(page, created, 3)).toBeVisible();
  await page.keyboard.press("Space");
  await expect(block(page, created, 3)).toBeHidden();
  await control(page, "Final").click();
  for (const index of [10, 11, 12, 13]) await expect(block(page, created, index)).toBeVisible();

  const other = await open(browser, created.uuid);
  await expect(control(other, "Outer")).toHaveAttribute("aria-expanded", "false");
  await expect(block(other, created, 1)).toBeHidden();
  await expect(control(page, "Outer", true)).toHaveAttribute("aria-expanded", "true");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(control(page, "Outer", true)).toHaveAttribute("aria-expanded", "true");
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }),
    document => { expect(document.blocks).toEqual(before.blocks); });
  await page.reload();
  await expect(control(page, "Outer")).toHaveAttribute("aria-expanded", "false");
  await expect(block(page, created, 1)).toBeHidden();
});

test("expanded sections and their caret survive remote edits and actual undo and redo", async ({ browser }) => {
  const session = writer();
  const created = await create(session, [
    { type: "paragraph", text: "Before" },
    { type: "heading", level: 2, text: "> Help" },
    { type: "paragraph", text: "Details" },
    { type: "heading", level: 2, text: "Next" },
  ]);
  const page = await open(browser, created.uuid);
  const body = block(page, created, 2);
  await control(page, "Help").click();
  await placeCaretIn(body);
  await session.call("edit_block", {
    uuid: created.uuid, block_id: created.blocks[0]?.id, old_text: "Before", new_text: "Before remote",
    rev: created.blocks[0]?.rev,
  });
  await expect(block(page, created, 0)).toContainText("Before remote");
  await expect(control(page, "Help", true)).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  await expect.poll(() => caret(page)).toEqual({ id: created.blocks[2]?.id, offset: "Details".length, empty: true });

  await page.keyboard.type(" more");
  await expect(body).toHaveText("Details more");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(body).toHaveText("Details");
  await expect(control(page, "Help", true)).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  await expect.poll(() => caret(page)).toEqual({ id: created.blocks[2]?.id, offset: "Details".length, empty: true });
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(body).toHaveText("Details more");
  await expect(control(page, "Help", true)).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  await expect.poll(() => caret(page)).toEqual({ id: created.blocks[2]?.id, offset: "Details more".length, empty: true });
});

test("typing and removing the marker keeps a heading editable and navigation outside folded blocks", async ({ browser }) => {
  const session = writer();
  const created = await create(session, [
    { type: "heading", level: 2, text: "Edit marker" },
    { type: "paragraph", text: "Folded text" },
    { type: "heading", level: 2, text: "After section" },
  ]);
  const page = await open(browser, created.uuid);
  const heading = block(page, created, 0);
  await placeCaretIn(heading, { edge: "start" });
  await page.keyboard.type("> ");
  await expect(control(page, "Edit marker")).toBeVisible();
  await expect(heading).toContainText("> Edit marker");
  await expect(heading.locator(".ub-toggle-heading-marker")).toHaveCount(0);
  await expect(block(page, created, 1)).toBeHidden();
  await expect(heading).toHaveJSProperty("tagName", "H2");
  await placeCaretIn(heading);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => caret(page)).toEqual({ id: created.blocks[2]?.id, offset: 0, empty: true });
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => caret(page)).toEqual({ id: created.blocks[0]?.id, offset: "> Edit marker".length, empty: true });
  const protectedContent = await documentContent(page);
  await page.keyboard.press("Delete");
  expect(await documentContent(page)).toEqual(protectedContent);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => caret(page)).toEqual({ id: created.blocks[2]?.id, offset: 0, empty: true });
  await page.keyboard.press("Backspace");
  expect(await documentContent(page)).toEqual(protectedContent);
  await expect(block(page, created, 1)).toHaveText("Folded text");
  await expect(block(page, created, 1)).toBeHidden();

  await control(page, "Edit marker").click();
  await placeCaretIn(block(page, created, 1));
  await page.keyboard.press(`Shift+${keys.lineStart}`);
  await expect(page.locator('[data-slot="selection-composer"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="selection-composer"]')).toHaveCount(0);
  await control(page, "Edit marker", true).click();
  await expect(block(page, created, 1)).toBeHidden();
  await expect.poll(() => caret(page)).toEqual({ id: created.blocks[0]?.id, offset: "> Edit marker".length, empty: true });
  await placeCaretIn(heading);
  await page.keyboard.press(keys.lineStart);
  await page.keyboard.press("Delete");
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), document => {
    expect(document.blocks[0]?.text).toBe(" Edit marker");
  });
  await page.keyboard.press("Delete");
  await expect(heading).toContainText("Edit marker");
  await expect(heading.locator("button")).toHaveCount(0);
  await expect(block(page, created, 1)).toBeVisible();
  await expect.poll(async () => (await session.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks[0]?.text)
    .toBe("Edit marker");
});

for (const key of ["Delete", "Backspace"]) {
  test(`${key} after clicking chart chrome leaves source and neighboring prose unchanged`, async ({ browser }) => {
    const session = writer();
    const created = await create(session, [
      { type: "paragraph", text: "Before" },
      { type: "chart", text: "not a chart" },
      { type: "paragraph", text: "After" },
    ]);
    const page = await open(browser, created.uuid);
    await placeCaretIn(block(page, created, 2));
    const before = await documentContent(page);
    await block(page, created, 1).locator(".ub-chart-message").click();
    expect(await editor(page).evaluate(element => {
      const focus = document.getSelection()?.focusNode;
      return focus !== null && focus !== undefined && element.querySelector(".ub-chart-panel")?.contains(focus);
    })).toBe(true);
    await page.keyboard.press(key);

    expect(await documentContent(page)).toEqual(before);
    await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }),
      document => { expect(document.blocks.map(({ id, rev }) => ({ id, rev }))).toEqual(created.blocks); });
  });
}

test("comment cards and collaborator presence reveal every toggle enclosing their target", async ({ browser }) => {
  const session = writer();
  const created = await create(session, [
    { type: "heading", level: 2, text: "> Outer" },
    { type: "heading", level: 3, text: "> Inner" },
    { type: "paragraph", text: "Hidden discussion target" },
    { type: "heading", level: 2, text: "After section" },
  ]);
  const thread = await session.call<{ annotation: { id: string } }>("annotate", {
    uuid: created.uuid, block_id: created.blocks[2]?.id, start: 0, end: 6, text: "Discuss the folded words.",
  });
  const page = await open(browser, created.uuid);
  const target = block(page, created, 2);
  const card = page.locator(`#ub-thread-${thread.annotation.id}`);
  await expect(target).toBeHidden();
  await expect(card).toContainText("Discuss the folded words.");
  await card.locator(".ub-thread-select").click();
  await expect(control(page, "Outer", true)).toHaveAttribute("aria-expanded", "true");
  await expect(control(page, "Inner", true)).toHaveAttribute("aria-expanded", "true");
  await expect(target.locator("[data-comment-thread]")).toHaveClass(/ub-comment-flash/);
  await expect(target).toBeInViewport();
  await control(page, "Outer", true).click();
  await expect(target).toBeHidden();

  const collaborator = await open(browser, created.uuid);
  await collaborator.getByTestId("account-menu").click();
  await collaborator.getByRole("menuitem", { name: "Preferences", exact: true }).click();
  await collaborator.getByRole("textbox", { name: "Presence name", exact: true }).fill("Toggle collaborator");
  await collaborator.getByRole("button", { name: "Save name", exact: true }).click();
  await collaborator.goBack();
  await control(collaborator, "Outer").click();
  await control(collaborator, "Inner").click();
  await placeCaretIn(block(collaborator, created, 2));
  const presence = page.locator(".ub-peer-control").and(page.getByRole("button", { name: /^Toggle collaborator/ }));
  await expect(presence).toBeVisible();
  await presence.click();
  await expect(control(page, "Outer", true)).toHaveAttribute("aria-expanded", "true");
  await expect(control(page, "Inner", true)).toHaveAttribute("aria-expanded", "true");
  await expect(target).toBeInViewport();
});

test("archived pages and decision records keep accessible reader toggles in both appearances", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  for (const kind of ["archived", "decision"] as const) {
    const created = await create(session, [
      { type: "heading", level: 2, text: "> Reader section" },
      { type: "paragraph", text: "Read-only folded content" },
    ]);
    if (kind === "archived") await session.call("archive_doc", { uuid: created.uuid });
    else {
      const peer = await legacyDecisionPeer(harness(), created.uuid);
      peers.push(peer);
      peer.decide("decided");
    }
    const page = await open(browser, created.uuid, info.project.use.hasTouch === true);
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    const before = await session.call<StoredDoc>("get_doc", { uuid: created.uuid });
    await expect(block(page, created, 1)).toBeHidden();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const disclosure = control(page, "Reader section");
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      const bounds = await disclosure.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(info.project.use.hasTouch === true ? 44 : 24);
      expect(bounds?.height).toBeGreaterThanOrEqual(info.project.use.hasTouch === true ? 44 : 24);
      await activateControl(disclosure);
      await expect(control(page, "Reader section", true)).toHaveAttribute("aria-expanded", "true");
      await expect(block(page, created, 1)).toBeVisible();
      await expect(block(page, created, 0).locator(".ub-toggle-heading-marker")).toBeHidden();
      await activateControl(control(page, "Reader section", true));
      await expect(block(page, created, 1)).toBeHidden();
    }
    await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }),
      document => { expect(document.blocks).toEqual(before.blocks); });
    await page.close();
  }
});
