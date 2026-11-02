/**
 * Decision records use the editor's native read-only selection in a browser.
 * Pointer dragging and touch ranges still reach comments; metadata arriving
 * over the real transport locks an existing view without replacing or moving it.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { activateControl, closeIfOpen, editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, proveMcpArrival } from "./settle.js";
import type { McpSession } from "./mcp-agent.js";
import { legacyDecisionPeer } from "./legacy-decision-peer.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const peers: Array<{ close: () => void }> = [];

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-decided-editor-",
  });
});
test.afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await agent?.closeSessions();
});
test.afterAll(async () => { await agent?.close(); agent = null; });

function session(): McpSession {
  if (agent === null) throw new Error("e2e: the MCP agent is not configured");
  return agent.open({ name: "decided-editor-e2e" });
}

async function record(
  writer: McpSession,
  status: "open" | "decided",
  blocks = [{ type: "paragraph", text: "Selected words remain readable after deciding." }],
): Promise<string> {
  const result = await writer.call<{ uuid: string }>("create_doc", {
    title: "Decided editor",
    description: "Read-only reasoning with an open conversation.",
    blocks,
  });
  const peer = await legacyDecisionPeer(harness(), result.uuid);
  peers.push(peer);
  peer.decide(status, "Keep the approved wording.");
  await expectMcp(async () => { expect((await writer.call<{ status: string }>("get_doc", { uuid: result.uuid })).status).toBe(status); });
  return result.uuid;
}

function composer(page: Page): Locator {
  return page.locator('[data-slot="selection-composer"]');
}

async function onlyComment(page: Page): Promise<void> {
  await expect(composer(page)).toBeVisible();
  await expect(composer(page).getByRole("button")).toHaveCount(1);
  await expect(composer(page).getByRole("button", { name: "Comment", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Bold|Italic|Strikethrough|Inline code|External link)$/ })).toHaveCount(0);
}

async function addComment(page: Page, text: string, touch = false, expectedThreads = 1): Promise<void> {
  const comment = composer(page).getByRole("button", { name: "Comment", exact: true });
  if (touch) await comment.tap();
  else await comment.click();
  await page.getByPlaceholder(/Comment as/).fill(text);
  const submit = composer(page).getByRole("button", { name: "Comment", exact: true });
  if (touch) await submit.tap();
  else await submit.click();
  await expect(editor(page).locator("[data-comment-thread]")).toHaveCount(expectedThreads);
}

test("decided prose and cells offer only Comment, keep threads keyboard reachable and preserve approved content", async ({ browser }) => {
  const writer = session();
  const uuid = await record(writer, "decided", [
    { type: "paragraph", text: "Selected words remain readable after deciding." },
    { type: "table", text: "| Approved cell |\n| --- |\n| Approved value |" },
  ]);
  const before = await writer.call<{ blocks: Array<{ text: string; rev: string }> }>("get_doc", { uuid });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("region", { name: "TL;DR", exact: true })).toHaveCount(0);
  await expect(page.getByText("Keep the approved wording.", { exact: true })).toHaveCount(0);
  await expect(page.locator(".ub-tldr-form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit TL;DR", exact: true })).toHaveCount(0);
  const prose = editor(page).locator(":scope > p").first();
  const header = editor(page).locator(".ub-table th").first();
  const rail = page.getByRole("region", { name: "Comments", exact: true });
  for (const [index, part] of [
    { target: prose, container: prose, inset: 8, length: 170, comment: "Pointer comment on approved reasoning.", reply: "Keyboard readers can continue this thread." },
    { target: header.locator("p"), container: header, inset: 2, length: 70, comment: "Discuss the approved cell.", reply: "Cell reply." },
  ].entries()) {
    const box = await part.target.boundingBox();
    if (box === null) throw new Error("e2e: approved content has no box");
    const baseline = box.y + Math.min(box.height, 24) / 2;
    await page.mouse.move(box.x + part.inset, baseline);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(part.length, box.width - part.inset), baseline, { steps: 12 });
    await page.mouse.up();
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.length).toBeGreaterThan(0);
    await onlyComment(page);
    await addComment(page, part.comment, false, index + 1);
    const highlight = part.container.locator("[data-comment-thread]");
    await expect(highlight).toHaveText(selected);
    await highlight.click();
    await expect(rail).toContainText(part.comment);
    const card = rail.locator(".ub-thread-card").filter({ hasText: part.comment });
    const cardButton = card.locator(".ub-thread");
    await expect(card.locator(".ub-thread-excerpt")).toHaveCount(0);
    await expect(cardButton).toHaveAttribute("aria-current", "true");
    await cardButton.locator(".ub-thread-select").click();
    await expect(highlight).toHaveClass(/ub-comment-flash/);

    // Native Tab reaches each highlight without an editing caret; Enter
    // moves keyboard focus into that highlight's matching rail card.
    await page.getByRole("button", { name: "Document actions" }).focus();
    for (let count = 0; count < 20; count += 1) {
      if (await highlight.evaluate((element) => document.activeElement === element)) break;
      await page.keyboard.press("Tab");
    }
    await expect(highlight).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(cardButton.locator(".ub-thread-select")).toBeFocused();
    await card.getByPlaceholder("Reply…").fill(part.reply);
    await card.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(card).toContainText(part.reply);
    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(highlight).not.toHaveAttribute("role");
    await expect(highlight).not.toHaveAttribute("tabindex");
    await expect(highlight).not.toHaveClass(/(?:^| )ub-comment(?: |$)/);
    await rail.getByRole("button", { name: /resolved$/ }).click();
    await card.locator(".ub-thread").click();
    await expect(card.getByRole("button", { name: "Reopen", exact: true })).toHaveCount(0);
    await expect(card.getByPlaceholder("Reply…")).toHaveCount(0);
    await expect(highlight).not.toHaveAttribute("role");
  }
  await expect(prose).toHaveText("Selected words remain readable after deciding.");
  await proveMcpArrival(page, writer, uuid, { path: "upstream" });
  await expectMcp(async () => {
    const after = await writer.call<{ blocks: Array<{ text: string; rev: string }> }>("get_doc", { uuid });
    expect(after.blocks).toEqual(before.blocks);
  });
});

test("touch selection on a decided record starts a thread and its highlight opens the writable rail", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const uuid = await record(session(), "decided");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    upstream: true,
    contextOptions: info.project.name === "chromium"
      ? { hasTouch: true, viewport: { width: 810, height: 1080 } }
      : {},
  });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("region", { name: "TL;DR", exact: true })).toHaveCount(0);
  await expect(page.locator(".ub-tldr-form")).toHaveCount(0);
  const paragraph = editor(page).locator(":scope > p").first();
  await paragraph.tap();
  // The same native range setup used by touch-editor.spec stands in for iOS's
  // selection handles, while the browser owns range geometry and observation.
  await paragraph.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", {
      pointerType: "touch", bubbles: true, pointerId: 1,
    }));
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await onlyComment(page);
  await addComment(page, "Touch readers can discuss the decided record.", true);
  const highlight = editor(page).locator("[data-comment-thread]");
  const close = page.getByRole("button", { name: "Close comments", exact: true });
  await closeIfOpen(close, page.locator(".ub-threads-toggle"), { touch: true });
  await highlight.tap();
  const rail = page.getByRole("region", { name: "Comments", exact: true });
  await expect(rail).toContainText("Touch readers can discuss the decided record.");
  await rail.getByPlaceholder("Reply…").fill("Touch reply.");
  await rail.getByRole("button", { name: "Reply", exact: true }).tap();
  await expect(rail).toContainText("Touch reply.");
  await rail.getByRole("button", { name: "Resolve", exact: true }).tap();
  // Dismissing the drawer exposes the text highlight for the touch route back.
  await closeIfOpen(close, page.locator(".ub-threads-toggle"), { touch: true });
  await expect(highlight).not.toHaveAttribute("role");
  await expect(highlight).not.toHaveAttribute("tabindex");
  await page.locator(".ub-threads-toggle").tap();
  await rail.getByRole("button", { name: "1 resolved" }).tap();
  await rail.locator(".ub-thread").tap();
  await expect(rail.getByRole("button", { name: "Reopen", exact: true })).toHaveCount(0);
  await expect(rail.getByPlaceholder("Reply…")).toHaveCount(0);
  await closeIfOpen(close, page.locator(".ub-threads-toggle"), { touch: true });
  await expect(highlight).not.toHaveAttribute("role");
  await expect(paragraph).toHaveText("Selected words remain readable after deciding.");
});

test("an open answer edits and saves before remote settlement locks the same view and its native input", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const touch = info.project.use.hasTouch === true;
  const writer = session();
  const prose = "Selected words remain open to revision.";
  const initialSource = Array.from({ length: 40 }, (_, index) => `const reason${index} = "Keep this answer editable until settled.";`).join("\n");
  const source = `${initialSource} // revised`;
  const uuid = await record(writer, "open", [
    { type: "paragraph", text: prose },
    { type: "code", text: initialSource },
    { type: "table", text: "| Name | Value |\n| --- | --- |\n| Original | Kept |" },
  ]);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  const view = editor(page);
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
  await expect(view).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".ub-decision-answer-header .ub-decision-answer-state")).toHaveText("Not yet decided");
  await expect(page.getByRole("region", { name: "TL;DR", exact: true })).toHaveCount(0);
  const paragraph = view.locator(":scope > p").first();
  await placeCaretIn(paragraph, { touch });
  await page.keyboard.type(" Reworded here.");
  await expect(paragraph).toHaveText(`${prose} Reworded here.`);
  for (let count = 0; count < 9; count += 1) await page.keyboard.press("Shift+ArrowLeft");
  for (const name of ["Bold", "Italic", "Strikethrough", "Inline code", "External link", "Comment"]) {
    await expect(composer(page).getByRole("button", { name, exact: true })).toBeVisible();
  }
  await activateControl(composer(page).getByRole("button", { name: "Bold", exact: true }), { touch });
  await expect(paragraph.locator("strong")).toHaveText("ded here.");
  await activateControl(composer(page).getByRole("button", { name: "External link", exact: true }), { touch });
  await page.getByLabel("External link URL").fill("https://example.org/open-answer");
  await activateControl(composer(page).getByRole("button", { name: "Apply", exact: true }), { touch });
  const external = paragraph.locator('a[href="https://example.org/open-answer"]');
  await expect(external).toHaveText("ded here.");
  await addComment(page, "Discuss the answer while it is still open.", touch);
  await closeIfOpen(page.getByRole("button", { name: "Close comments", exact: true }), page.locator(".ub-threads-toggle"), { touch });

  // The page's real block menu offers only answer types. Its fourth-block
  // insertion is refused before any content changes.
  await placeCaretIn(paragraph, { touch });
  await activateControl(page.getByRole("button", { name: "Insert block below", exact: true }), { touch });
  const menu = page.getByRole("listbox", { name: "Block types", exact: true });
  await expect.poll(() => menu.getByRole("option").evaluateAll((options) => options.map((option) => option.getAttribute("aria-label"))))
    .toEqual(["Paragraph", "Bullet list", "Numbered list", "Code", "Table"]);
  await activateControl(menu.getByRole("option", { name: "Paragraph", exact: true }), { touch });
  await expect(view.locator(":scope > p")).toHaveCount(1);
  const code = view.locator("pre > code");
  await placeCaretIn(code, { touch });
  await page.keyboard.insertText(" // revised");
  await expect(code).toHaveText(source);
  await activateControl(page.getByRole("button", { name: "Code language", exact: true }), { touch });
  await page.getByRole("combobox", { name: "Search languages", exact: true }).fill("typescript");
  await activateControl(page.getByRole("option", { name: "typescript", exact: true }), { touch });
  await expect(page.getByRole("button", { name: "Code language", exact: true })).toHaveText(/TypeScript/);
  const table = view.locator("table");
  await placeCaretIn(table.locator("td").first(), { touch });
  await page.keyboard.type(" revised");
  await activateControl(page.getByRole("button", { name: "Column 1 actions", exact: true }), { touch });
  await activateControl(page.getByRole("menuitem", { name: "Move column right", exact: true }), { touch });
  await expect(table.locator("th")).toHaveText(["Value", "Name"]);
  await expect(table.locator("td")).toHaveText(["Kept", "Original revised"]);
  await placeCaretIn(paragraph, { touch });
  await page.keyboard.press("Enter");
  await expect(view.locator(":scope > p")).toHaveCount(1);
  await expect(paragraph).toHaveText(`${prose} Reworded here.`);
  if (!touch) {
    await placeCaretIn(paragraph);
    await page.keyboard.press(`${modifier}+a`);
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toContain("reason39");
    await page.keyboard.press(`${modifier}+c`);
    await placeCaretIn(paragraph);
    await page.keyboard.press(`${modifier}+v`);
    await expect(view.locator(":scope > p")).toHaveCount(1);
    await expect(paragraph).toHaveText(`${prose} Reworded here.`);
    await expect(code).toHaveText(source);
    await expect(view.locator("table")).toHaveCount(1);
  }
  if (touch) await activateControl(page.locator(".ub-threads-toggle"), { touch });
  else await activateControl(view.locator("[data-comment-thread]"));
  const rail = page.getByRole("region", { name: "Comments", exact: true });
  await expect(rail).toContainText("Discuss the answer while it is still open.");
  if (touch) await activateControl(rail.locator(".ub-thread-select"), { touch });
  await rail.getByPlaceholder("Reply…").fill("The refined answer keeps this conversation.");
  await activateControl(rail.getByRole("button", { name: "Reply", exact: true }), { touch });
  await expect(rail).toContainText("The refined answer keeps this conversation.");
  await closeIfOpen(page.getByRole("button", { name: "Close comments", exact: true }), page.locator(".ub-threads-toggle"), { touch });
  await proveMcpArrival(page, writer, uuid, { path: "upstream" });
  type SavedAnswer = { blocks: Array<{ type: string; text: string; rev: string; language?: string }> };
  let approved: SavedAnswer["blocks"] = [];
  await expectMcp(() => writer.call<SavedAnswer>("get_doc", { uuid }), saved => {
    expect(saved.blocks).toHaveLength(3);
    expect(saved.blocks[0]?.text).toBe(`${prose} Reworded here.`);
    expect(saved.blocks[1]).toMatchObject({ type: "code", text: source, language: "typescript" });
    expect(saved.blocks[2]?.text).toContain("Original revised");
    approved = saved.blocks;
  });

  // Leave the native range and its formatting toolbar open when metadata arrives
  // through the hub. The view retains that range and the pane's position.
  await placeCaretIn(paragraph, { touch });
  for (let count = 0; count < 9; count += 1) await page.keyboard.press("Shift+ArrowLeft");
  await expect(composer(page).getByRole("button", { name: "Bold", exact: true })).toBeVisible();
  const originalView = await view.elementHandle();
  if (originalView === null) throw new Error("e2e: missing live editor");
  const pane = page.locator(".ub-pane");
  await pane.evaluate((element) => { element.scrollTop = 80; });
  const scroll = await pane.evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  const selection = await view.evaluate((element) => {
    const mounted = element as HTMLElement & { editor: Editor };
    const native = document.getSelection();
    return {
      anchor: mounted.editor.state.selection.anchor, head: mounted.editor.state.selection.head,
      native: native === null || native.anchorNode === null || native.focusNode === null ? null : {
        anchor: mounted.editor.view.posAtDOM(native.anchorNode, native.anchorOffset),
        head: mounted.editor.view.posAtDOM(native.focusNode, native.focusOffset), text: native.toString(),
      },
    };
  });
  expect(selection.anchor).not.toBe(selection.head);
  expect(selection.native?.text).toBe("ded here.");
  const peer = await legacyDecisionPeer(harness(), uuid);
  peers.push(peer);
  peer.decide("decided");
  await expect(view).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".ub-decision-answer-header .ub-decision-answer-state")).toHaveText("In force");
  await onlyComment(page);
  expect(await originalView.evaluate((element) => element === document.querySelector(".ub-editor .ProseMirror"))).toBe(true);
  expect(await pane.evaluate((element) => element.scrollTop)).toBe(scroll);
  expect(await view.evaluate((element) => {
    const mounted = element as HTMLElement & { editor: Editor };
    const native = document.getSelection();
    return {
      anchor: mounted.editor.state.selection.anchor, head: mounted.editor.state.selection.head,
      native: native === null || native.anchorNode === null || native.focusNode === null ? null : {
        anchor: mounted.editor.view.posAtDOM(native.anchorNode, native.anchorOffset),
        head: mounted.editor.view.posAtDOM(native.focusNode, native.focusOffset), text: native.toString(),
      },
    };
  })).toEqual(selection);
  await expect(page.getByRole("textbox", { name: "Document title" })).toHaveValue("Decided editor");
  await expect(page.getByRole("textbox", { name: "Document title" })).toBeEditable();
  await expect(page.getByRole("button", { name: "Edit TL;DR", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Document actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit TL;DR", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Add TL;DR", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Remove TL;DR", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Desktop keyboard shortcuts use a real non-empty system clipboard. The iPad
  // path retains native tap/selection and text input without an OS edit menu.
  await activateControl(paragraph, { touch });
  if (!touch) {
    await page.keyboard.press(`${modifier}+a`);
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toContain(prose);
    await page.keyboard.press(`${modifier}+c`);
    await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.type("typed mutation");
  if (!touch) {
    await page.keyboard.press(`${modifier}+b`);
    await page.keyboard.press(`${modifier}+v`);
    await page.keyboard.press(`${modifier}+z`);
    await page.keyboard.press(`${modifier}+Shift+z`);
  }
  await expect(paragraph).toHaveText(`${prose} Reworded here.`);
  const header = table.locator("th").first();
  await activateControl(header, { touch });
  await page.keyboard.type("table mutation");
  await page.keyboard.press("Tab");
  await page.keyboard.type("cell mutation");
  await expect(header).toHaveText("Value");
  await expect(table.locator("td")).toHaveText(["Kept", "Original revised"]);
  await view.evaluate(element => {
    const drop = new DataTransfer();
    drop.setData("text/plain", "dropped mutation");
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: drop, bubbles: true, cancelable: true }));
  });
  await expect(paragraph).toHaveText(`${prose} Reworded here.`);
  await expect(page.getByRole("button", { name: "Insert block below", includeHidden: true })).toHaveCount(0);
  for (const status of ["rejected", "withdrawn"] as const) {
    peer.decide(status);
    await expect(page.locator(".ub-lifecycle-badge")).toHaveText("Decision");
    await expect(view).toHaveAttribute("contenteditable", "false");
    await expect(page.getByRole("region", { name: "TL;DR", exact: true })).toHaveCount(0);
    expect(await originalView.evaluate((element) => element === document.querySelector(".ub-editor .ProseMirror"))).toBe(true);
    await expect(page.getByRole("button", { name: "Insert block below", includeHidden: true })).toHaveCount(0);
  }
  await proveMcpArrival(page, writer, uuid, { path: "upstream" });
  await expectMcp(async () => {
    const saved = await writer.call<SavedAnswer>("get_doc", { uuid });
    expect(saved.blocks).toEqual(approved);
  });
});
