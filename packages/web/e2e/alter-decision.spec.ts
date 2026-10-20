import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp, waitForAcknowledged } from "./settle.js";

const { harness, openApp } = setupHarness({ gitUserName: "Browser decision maker" });
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-alter-decision-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc {
  uuid: string;
  title: string;
  status?: string;
  decidedBy?: string;
  discussion?: string | null;
  blocks: Array<{ type: string; text: string }>;
  resolution?: { inForce: { uuid: string } | null; pending: Array<{ uuid: string }> };
  tags?: Array<{ name: string }>;
}

function session(): McpSession {
  if (agent === null) throw new Error("e2e: MCP agent is not configured");
  return agent.open({ name: "alter-decision-e2e" });
}

async function create(writer: McpSession, title: string, blocks = [{ type: "paragraph", text: "Keep the original answer." }], fields: Record<string, unknown> = {}): Promise<StoredDoc> {
  return writer.call<StoredDoc>("create_doc", {
    title, description: "Alter decision browser acceptance fixture.", blocks, kind: "decision", status: "decided", ...fields,
  });
}

function dialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Alter decision", exact: true });
}

function draft(page: Page): Locator {
  return dialog(page).locator('.ProseMirror[contenteditable="true"]');
}

async function openDialog(page: Page, touch = false): Promise<void> {
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await activateControl(page.getByRole("button", { name: "Alter decision", exact: true }), { touch });
  await expect(dialog(page)).toBeVisible();
  await expect(draft(page)).toBeVisible();
}

async function unchanged(writer: McpSession, source: StoredDoc, page: Page): Promise<void> {
  await waitForAcknowledged(page, { path: "upstream" });
  // A later directory edit proves that the browser's preceding work reached
  // the same replica before checking for an unwanted record or RFC.
  const marker = `${source.title} checked`;
  await page.getByRole("textbox", { name: "Document title", exact: true }).fill(marker);
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: source.uuid }), (stored) => {
    expect(stored.title).toBe(marker);
    expect(stored.blocks.map(({ type, text }) => ({ type, text }))).toEqual(source.blocks.map(({ type, text }) => ({ type, text })));
    expect(stored.resolution?.inForce?.uuid).toBe(source.uuid);
    expect(stored.resolution?.pending).toEqual([]);
  });
  await expectMcp(() => writer.call<{ docs: Array<{ uuid: string; title: string }> }>("list_docs", { kind: "decision", include_superseded: true }), (listed) => {
    expect(listed.docs.filter((doc) => doc.title === source.title || doc.title === marker).map((doc) => doc.uuid)).toEqual([source.uuid]);
  });
  await expectMcp(() => writer.call<{ docs: Array<{ title: string }> }>("list_docs", {}), (listed) => {
    expect(listed.docs.some((doc) => doc.title === source.title)).toBe(false);
  });
}

for (const touch of [false, true]) for (const appearance of ["light", "dark"] as const) {
  test(`rich answer controls stay inside the modal on ${touch ? "iPad touch" : "desktop keyboard and pointer"} in ${appearance}${touch ? " @webkit-touch" : ""}`, async ({ browser }) => {
    const writer = session();
    const title = docTitle("Alter controls");
    const reference = await writer.call<StoredDoc>("create_doc", {
      title: `${title.replaceAll(" ", "-")}-reference`, description: "An answer-editor reference target.",
      blocks: [{ type: "paragraph", text: "A reference target." }],
    });
    const source = await create(writer, title, [
      { type: "paragraph", text: "Select this answer before changing it." },
      { type: "code", text: "return original;" },
      { type: "table", text: "| Name | Value |\n| --- | --- |\n| Original | Kept |" },
    ]);
    const page = await openApp(browser, `/${harness().workspace}/${source.uuid}`, {
      contextOptions: { ...(touch ? devices["iPad (gen 7) landscape"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: appearance },
    });
    await expect(editor(page)).toContainText("Select this answer");
    await openDialog(page, touch);
    await expect(dialog(page)).toContainText(title);
    await expect(dialog(page).getByRole("button", { name: "Decide", exact: true })).toBeDisabled();
    await expect(dialog(page).getByRole("button", { name: "Open an RFC instead", exact: true })).toBeDisabled();

    const paragraph = draft(page).locator(":scope > p").first();
    const currentColor = await dialog(page).locator('.ProseMirror[contenteditable="false"] > p').first()
      .evaluate((element) => getComputedStyle(element).color);
    const draftColor = await paragraph.evaluate((element) => getComputedStyle(element).color);
    expect(currentColor).not.toBe(draftColor);
    await placeCaretIn(paragraph, { touch });
    for (let character = 0; character < 15; character += 1) await page.keyboard.press("Shift+ArrowLeft");
    const selected = await page.evaluate(() => document.getSelection()?.toString() ?? "");
    expect(selected.length).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
    for (const name of ["Bold", "Italic", "Strikethrough", "Inline code", "External link"]) {
      await expect(dialog(page).getByRole("button", { name, exact: true })).toBeVisible();
    }
    await activateControl(dialog(page).getByRole("button", { name: "Bold", exact: true }), { touch });
    await expect(paragraph.locator("strong")).toContainText(selected);
    await activateControl(dialog(page).getByRole("button", { name: "External link", exact: true }), { touch });
    await dialog(page).getByLabel("External link URL").fill("https://example.org/answer");
    await page.keyboard.press("Escape");
    await expect(dialog(page).getByLabel("External link URL")).toHaveCount(0);
    await expect(dialog(page).getByRole("toolbar", { name: "Text formatting", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page).getByRole("toolbar", { name: "Text formatting", exact: true })).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    await expect(draft(page)).toContainText("Select this answer");
    await placeCaretIn(paragraph, { touch });
    for (let character = 0; character < 15; character += 1) await page.keyboard.press("Shift+ArrowLeft");
    await activateControl(dialog(page).getByRole("button", { name: "External link", exact: true }), { touch });
    await dialog(page).getByLabel("External link URL").fill("https://example.org/answer");
    await activateControl(dialog(page).getByRole("button", { name: "Apply", exact: true }), { touch });
    await expect(paragraph.locator('a[href="https://example.org/answer"]')).toContainText(selected);

    const code = draft(page).locator("pre > code");
    await placeCaretIn(code, { touch });
    await activateControl(dialog(page).getByRole("button", { name: "Code language", exact: true }), { touch });
    await expect(dialog(page).getByRole("combobox", { name: "Search languages", exact: true })).toBeFocused();
    await dialog(page).getByRole("combobox", { name: "Search languages", exact: true }).fill("typescript");
    await activateControl(dialog(page).getByRole("option", { name: "typescript", exact: true }), { touch });
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Code language", exact: true })).toHaveText(/TypeScript/);
    await activateControl(dialog(page).getByRole("button", { name: "Code language", exact: true }), { touch });
    await page.keyboard.press("Escape");
    await expect(dialog(page).getByRole("combobox", { name: "Search languages", exact: true })).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();

    const table = draft(page).locator("table");
    await placeCaretIn(table.locator("td").first(), { touch });
    await activateControl(dialog(page).getByRole("button", { name: "Column 1 actions", exact: true }), { touch });
    await activateControl(dialog(page).getByRole("menuitem", { name: "Move column right", exact: true }), { touch });
    await expect(table.locator("th")).toHaveText(["Value", "Name"]);
    await expect(dialog(page)).toBeVisible();
    await activateControl(dialog(page).getByRole("button", { name: "Column 2 actions", exact: true }), { touch });
    await page.keyboard.press("Escape");
    await expect(dialog(page).getByRole("menu")).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();

    await placeCaretIn(paragraph, { touch });
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const menu = dialog(page).getByRole("listbox", { name: "Block types", exact: true });
    await expect.poll(() => menu.getByRole("option").evaluateAll((options) => options.map((option) => option.getAttribute("aria-label"))))
      .toEqual(["Paragraph", "Bullet list", "Numbered list", "Code", "Table"]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Backspace");
    await page.keyboard.type(`@${reference.title}`);
    const mentions = dialog(page).getByRole("listbox", { name: "Documents", exact: true });
    await activateControl(mentions.getByRole("option", { name: reference.title, exact: true }), { touch });
    await expect(draft(page).locator(`a[data-doc-id="${reference.uuid}"]`)).toHaveText(reference.title);

    const screenshot = test.info().outputPath("alter-decision.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    await test.info().attach(`alter-decision-${touch ? "ipad" : "desktop"}-${appearance}`, { path: screenshot, contentType: "image/png" });
    await activateControl(dialog(page).getByRole("button", { name: "Cancel", exact: true }), { touch });
    await expect(dialog(page)).toHaveCount(0);
    await unchanged(writer, source, page);
  });
}

test("Decide records a successor at the topic address and RFC opens its new page", async ({ browser }) => {
  const writer = session();
  const source = await create(writer, docTitle("Alter outcomes"));
  const page = await openApp(browser, `/${harness().workspace}/${source.uuid}`);
  await openDialog(page);
  await expect(draft(page)).toHaveText("Keep the original answer.");
  await expect(dialog(page)).toContainText("Browser decision maker");
  await draft(page).fill("Use the replacement answer.");
  await expect(dialog(page).getByRole("button", { name: "Decide", exact: true })).toBeDisabled();
  await dialog(page).getByLabel(/Why the change/).fill("The replacement meets the current need.");
  await dialog(page).getByRole("button", { name: "Decide", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/${source.uuid}$`));
  await expect(editor(page)).toContainText("Use the replacement answer.");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".ub-decision-answer-header")).toContainText("Browser decision maker");
  await expect(page.locator(".ub-decision-answer-header .ub-decision-answer-state")).toHaveText("In force");
  await expect(page.locator(`.ub-decision-timeline > li[data-record="${source.uuid}"]`)).toContainText("Superseded");
  await expect(page.locator(".ub-decision-answer-header time")).toHaveAttribute("datetime", /^\d{4}-/);

  await openDialog(page);
  await draft(page).fill("Discuss this proposed replacement first.");
  await dialog(page).getByRole("button", { name: "Open an RFC instead", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(`/${source.uuid}$`));
  const rfc = new URL(page.url()).pathname.split("/").at(-1);
  if (rfc === undefined) throw new Error("e2e: RFC page has no identity");
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await expect(editor(page)).toContainText("Proposed change to");
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: rfc }), (stored) => {
    expect(stored.tags?.some((tag) => tag.name === "rfc")).toBe(true);
  });
  await page.goto(new URL(`/${harness().workspace}/${source.uuid}`, harness().appUrl).href);
  await expect(page.locator(".ub-decision-notice")).toContainText("The current answer stays in force.");
  await expect(editor(page)).toContainText("Use the replacement answer.");
  await expect(page.getByRole("button", { name: "Alter decision", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Approve|Reject|Withdraw)$/ })).toHaveCount(0);
});

test("Escape and an outside click discard the isolated answer without writes", async ({ browser }) => {
  const writer = session();
  const source = await create(writer, docTitle("Alter dismissal"));
  const page = await openApp(browser, `/${harness().workspace}/${source.uuid}`);
  await openDialog(page);
  await draft(page).fill("Discard this answer with Escape.");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Alter decision", exact: true })).toBeFocused();
  await openDialog(page);
  await expect(draft(page)).toHaveText("Keep the original answer.");
  await draft(page).fill("Discard this answer by dismissal.");
  await page.mouse.click(3, 3);
  await expect(dialog(page)).toHaveCount(0);
  await unchanged(writer, source, page);
});

test("a remote answer replacement preserves the open draft and refuses a stale Decide", async ({ browser }) => {
  const writer = session();
  const source = await create(writer, docTitle("Alter stale"));
  const page = await openApp(browser, `/${harness().workspace}/${source.uuid}`);
  await openDialog(page);
  await draft(page).fill("Keep my typed answer after the page changes.");
  await dialog(page).getByLabel(/Why the change/).fill("Keep my typed reason too.");
  const successor = await create(writer, source.title, [{ type: "paragraph", text: "A different answer took effect." }], {
    supersedes: source.uuid,
    answer: { who: "Another person", when: "2026-10-20T12:00:00Z", where: "https://example.org/decision" },
  });
  await expect(page.locator(`.ub-decision-timeline > li[data-record="${successor.uuid}"] .ub-decision-record`)).toHaveAttribute("aria-current", "true");
  await expect(dialog(page)).toBeVisible();
  await expect(draft(page)).toHaveText("Keep my typed answer after the page changes.");
  await dialog(page).getByRole("button", { name: "Decide", exact: true }).click();
  await expect(dialog(page)).toContainText(/no longer the answer in force/);
  await expect(draft(page)).toHaveText("Keep my typed answer after the page changes.");
  await expect(dialog(page).getByLabel(/Why the change/)).toHaveValue("Keep my typed reason too.");
  await expect(page.locator(".ub-decision-timeline > li")).toHaveCount(2);
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: source.uuid }), (stored) => {
    expect(stored.resolution?.inForce?.uuid).toBe(successor.uuid);
    expect(stored.resolution?.pending).toEqual([]);
  });
});
