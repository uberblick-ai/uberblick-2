/**
 * Decided records use the editor's native read-only selection in a browser.
 * Pointer dragging and touch ranges still reach comments; metadata arriving
 * over the real transport locks an existing view without replacing or moving it.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
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
    statePrefix: "uberblick-e2e-decided-editor-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
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
    kind: "decision", status, tldr: "Keep the approved wording.", blocks,
  });
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

async function addComment(page: Page, text: string, touch = false): Promise<void> {
  const comment = composer(page).getByRole("button", { name: "Comment", exact: true });
  if (touch) await comment.tap();
  else await comment.click();
  await page.getByPlaceholder(/Comment as/).fill(text);
  const submit = composer(page).getByRole("button", { name: "Comment", exact: true });
  if (touch) await submit.tap();
  else await submit.click();
  await expect(editor(page).locator("[data-comment-thread]")).toHaveCount(1);
}

test("a pointer selection on a decided record offers only Comment and keeps existing threads keyboard reachable", async ({ browser }) => {
  const uuid = await record(session(), "decided");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await page.locator(".ub-tldr-body > p").click();
  await expect(page.locator(".ub-tldr-form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit TL;DR", exact: true })).toHaveCount(0);
  const paragraph = editor(page).locator(":scope > p").first();
  const box = await paragraph.boundingBox();
  if (box === null) throw new Error("e2e: prose block has no box");
  const baseline = box.y + Math.min(box.height, 24) / 2;
  await page.mouse.move(box.x + 8, baseline);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(170, box.width - 8), baseline, { steps: 12 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.length).toBeGreaterThan(0);
  await onlyComment(page);
  await addComment(page, "Pointer comment on approved reasoning.");
  const highlight = editor(page).locator("[data-comment-thread]");
  await expect(highlight).toHaveText(selected);
  await highlight.click();
  const rail = page.getByRole("region", { name: "Threads", exact: true });
  await expect(rail).toContainText("Pointer comment on approved reasoning.");

  // Native Tab reaches the highlight even though the editor itself has no
  // editing caret. Enter moves keyboard focus into the matching rail card.
  await page.locator(".ub-title").focus();
  for (let count = 0; count < 20; count += 1) {
    if (await highlight.evaluate((element) => document.activeElement === element)) break;
    await page.keyboard.press("Tab");
  }
  await expect(highlight).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rail.locator(".ub-thread")).toBeFocused();
  await rail.getByRole("button", { name: "Reply", exact: true }).click();
  await rail.getByPlaceholder("Reply…").fill("Keyboard readers can continue this thread.");
  await rail.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(rail).toContainText("Keyboard readers can continue this thread.");
  await rail.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(highlight).toHaveAccessibleName("Resolved comment thread");
  await highlight.click();
  await rail.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(highlight).toHaveAccessibleName("Comment thread");
  await expect(paragraph).toHaveText("Selected words remain readable after deciding.");
});

test("a decided cell offers only Comment and its rail and highlight keep the approved content", async ({ browser }) => {
  const writer = session();
  const uuid = await record(writer, "decided", [{ type: "table", text: "| Approved cell |\n| --- |\n| Approved value |" }]);
  const before = await writer.call<{ blocks: Array<{ text: string; rev: string }> }>("get_doc", { uuid });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  const header = editor(page).locator(".ub-table th").first();
  const paragraph = header.locator("p");
  const box = await paragraph.boundingBox();
  if (box === null) throw new Error("e2e: cell has no box");
  const baseline = box.y + Math.min(box.height, 24) / 2;
  await page.mouse.move(box.x + 2, baseline);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(70, box.width - 2), baseline, { steps: 12 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.length).toBeGreaterThan(0);
  await onlyComment(page);
  await addComment(page, "Discuss the approved cell.");
  const highlight = header.locator("[data-comment-thread]");
  await expect(highlight).toHaveText(selected);
  const rail = page.getByRole("region", { name: "Threads", exact: true });
  await expect(rail.locator(".ub-thread-excerpt")).toHaveText(selected);
  await expect(rail.locator(".ub-thread")).toHaveAttribute("aria-current", "true");
  await rail.locator(".ub-thread").click();
  await expect(highlight).toHaveClass(/ub-comment-flash/);
  await page.locator(".ub-title").focus();
  for (let count = 0; count < 20; count += 1) {
    if (await highlight.evaluate((element) => document.activeElement === element)) break;
    await page.keyboard.press("Tab");
  }
  await expect(highlight).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rail.locator(".ub-thread")).toBeFocused();
  await rail.getByRole("button", { name: "Reply", exact: true }).click();
  await rail.getByPlaceholder("Reply…").fill("Cell reply.");
  await rail.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(rail).toContainText("Cell reply.");
  await rail.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(highlight).toHaveAccessibleName("Resolved comment thread");
  await highlight.click();
  await rail.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(highlight).toHaveAccessibleName("Comment thread");
  const after = await writer.call<{ blocks: Array<{ text: string; rev: string }> }>("get_doc", { uuid });
  expect(after.blocks).toEqual(before.blocks);
});

test("touch selection on a decided record starts a thread and its highlight opens the writable rail", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const uuid = await record(session(), "decided");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    upstream: true,
    contextOptions: info.project.name === "chromium"
      ? { hasTouch: true, viewport: { width: 390, height: 844 } }
      : {},
  });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await page.locator(".ub-tldr-body > p").tap();
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
  const close = page.getByRole("button", { name: "Close threads", exact: true });
  if (await close.isVisible()) await close.tap();
  await highlight.tap();
  const rail = page.getByRole("region", { name: "Threads", exact: true });
  await expect(rail).toContainText("Touch readers can discuss the decided record.");
  await rail.getByRole("button", { name: "Reply", exact: true }).tap();
  await rail.getByPlaceholder("Reply…").fill("Touch reply.");
  await rail.getByRole("button", { name: "Reply", exact: true }).tap();
  await expect(rail).toContainText("Touch reply.");
  await rail.getByRole("button", { name: "Resolve", exact: true }).tap();
  // Dismissing the drawer exposes the text highlight for the touch route back.
  if (await close.isVisible()) await close.tap();
  await expect(highlight).toHaveAccessibleName("Resolved comment thread");
  await highlight.tap();
  await rail.getByRole("button", { name: "Reopen", exact: true }).tap();
  if (await close.isVisible()) await close.tap();
  await expect(highlight).toHaveAccessibleName("Comment thread");
  await expect(paragraph).toHaveText("Selected words remain readable after deciding.");
});

test("a live decision makes an already open TL;DR editor read-only without saving its draft", async ({ browser }) => {
  const writer = session();
  const uuid = await record(writer, "open");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  await page.getByRole("button", { name: "Edit TL;DR", exact: true }).click();
  const summary = page.getByLabel(
    "Write one or two plain-English sentences that help a reader understand this document.",
  );
  await expect(summary).toBeFocused();
  await summary.fill("An unsaved draft must not change the approved line.");
  await writer.call("set_status", { uuid, status: "decided" });
  await expect(summary).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Clear", exact: true })).toBeDisabled();
  await summary.press("Enter");
  await expect(summary).toHaveValue("An unsaved draft must not change the approved line.");
  const saved = await writer.call<{ tldr: string | null }>("get_doc", { uuid });
  expect(saved.tldr).toBe("Keep the approved wording.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".ub-tldr-body > p").click();
  await expect(page.locator(".ub-tldr-form")).toHaveCount(0);
  await expect(page.locator(".ub-tldr-body > p")).toHaveText("Keep the approved wording.");
});

test("a live decision locks title, line, prose and tables without replacing the view or moving its scroll", async ({ browser }) => {
  const writer = session();
  const prose = "Approved content survives every editor input.";
  const uuid = await record(writer, "open", [
    { type: "paragraph", text: prose },
    { type: "table", text: "| Approved cell |\n| --- |\n| Approved value |" },
    ...Array.from({ length: 30 }, (_, index) => ({ type: "paragraph", text: `Reason ${index}: ${prose}` })),
  ]);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  const view = editor(page);
  await expect(view).toHaveAttribute("contenteditable", "true");
  const originalView = await view.elementHandle();
  if (originalView === null) throw new Error("e2e: missing live editor");
  const pane = page.locator(".ub-pane");
  await pane.evaluate((element) => { element.scrollTop = 400; });
  const scroll = await pane.evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await writer.call("set_status", { uuid, status: "decided" });
  await expect(view).toHaveAttribute("contenteditable", "false");
  expect(await originalView.evaluate((element) => element === document.querySelector(".ub-editor .ProseMirror"))).toBe(true);
  expect(await pane.evaluate((element) => element.scrollTop)).toBe(scroll);
  await expect(page.locator(".ub-title")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "Edit TL;DR", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Document actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit TL;DR", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Pin to sidebar", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Archive document", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ub-tag-placeholder")).toHaveText("Add tags");

  // Native events that the editable ProseMirror view normally consumes must
  // not alter prose or TableKit cells once the remote status has arrived.
  const paragraph = view.locator(":scope > p").first();
  await paragraph.click();
  await page.keyboard.type("typed mutation");
  await page.keyboard.press("ControlOrMeta+b");
  await view.evaluate((element) => {
    const paste = new DataTransfer();
    paste.setData("text/plain", "pasted mutation");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true }));
    const drop = new DataTransfer();
    drop.setData("text/plain", "dropped mutation");
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: drop, bubbles: true, cancelable: true }));
  });
  await expect(paragraph).toHaveText(prose);
  await expect(paragraph.locator("strong, em, s, code, a")).toHaveCount(0);
  const header = view.locator(".ub-table th").first();
  await header.click();
  await page.keyboard.type("table mutation");
  await page.keyboard.press("Tab");
  await page.keyboard.type("cell mutation");
  await expect(header).toHaveText("Approved cell");
  await expect(view.locator(".ub-table td").first()).toHaveText("Approved value");
  await expect(page.getByRole("button", { name: "Insert block below", includeHidden: true })).toHaveCount(0);
  const saved = await writer.call<{ blocks: Array<{ text: string }> }>("get_doc", { uuid });
  expect(saved.blocks[0]?.text).toBe(prose);
  expect(saved.blocks[1]?.text).toContain("Approved cell");
  expect(saved.blocks[1]?.text).toContain("Approved value");
  expect(saved.blocks).toHaveLength(32);
});
