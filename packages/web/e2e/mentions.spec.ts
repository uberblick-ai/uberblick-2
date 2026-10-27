/** One member-backed @ picker across prose and plain-text comment fields. */
import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import type { McpAgent, McpSession } from "./mcp-agent.js";
import { expectMcp } from "./settle.js";

const { harness, openApp } = setupHarness({ accessRole: "member" });
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = harness().createMcpAgent(`uberblick-e2e-mentions-${process.env.UB_AGENTS_RUN ?? "local"}-`);
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc {
  uuid: string;
  blocks: Array<{ id: string; text: string }>;
  annotations: Array<{ comments: Array<{ text: string }> }>;
}

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: mention writer is missing");
  return agent.open({ name: "mention-e2e" });
}

async function fixture(session: McpSession) {
  const title = docTitle("other-admin reference");
  const target = await session.call<StoredDoc>("create_doc", {
    title, description: "A document offered beside an offline member.",
    blocks: [{ type: "paragraph", text: "Reference destination" }],
  });
  const source = await session.call<StoredDoc>("create_doc", {
    title: docTitle("Mention writing"), description: "Shared @ mention browser acceptance.",
    blocks: [
      { type: "paragraph", text: "Agent @other-admin and @someone." },
      { type: "paragraph", text: "Write here " },
      { type: "paragraph", text: "Comment anchor" },
    ],
  });
  const first = source.blocks[0];
  if (first === undefined) throw new Error("e2e: mention paragraph is missing");
  const storedLink = `[${title}](${target.uuid})`;
  await session.call("annotate", { uuid: source.uuid, block_id: first.id, start: 0, end: 5,
    text: `Agent @other-admin ${storedLink} **plain** [external](https://example.com)` });
  return { source, target, title, storedLink };
}

async function open(browser: Browser, uuid: string, touch = false): Promise<Page> {
  return openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1400, height: 900 } }),
      reducedMotion: "reduce" },
    readySelector: ".ub-editor .ProseMirror",
  });
}

function menu(page: Page): Locator {
  return page.getByRole("listbox", { name: "People and documents", exact: true });
}

async function selectParagraph(paragraph: Locator): Promise<void> {
  await paragraph.evaluate((node) => {
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const selection = node.ownerDocument.getSelection();
    if (selection === null) throw new Error("e2e: comment selection is unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    node.ownerDocument.dispatchEvent(new Event("selectionchange"));
  });
}

test("members pick people and documents in prose, new comments and replies while stored text stays portable", async ({ browser }) => {
  const session = writer();
  const { source, target, title, storedLink } = await fixture(session);
  const page = await open(browser, source.uuid);
  const prose = editor(page).locator(":scope > p");
  await expect(prose.first().locator(".ub-person-pill")).toHaveText("@other-admin");
  await expect(prose.first()).toContainText("@someone");
  await expect(prose.first().locator(".ub-person-pill", { hasText: "@someone" })).toHaveCount(0);
  const agentCard = page.locator(".ub-thread-card").filter({ hasText: "Agent @other-admin" });
  await expect(agentCard.locator(".ub-person-pill")).toHaveText("@other-admin");
  await expect(agentCard.getByRole("link", { name: title, exact: true })).toBeVisible();
  await expect(agentCard.locator("strong")).toHaveText("plain");
  await expect(agentCard.getByRole("link", { name: "external", exact: true })).toHaveAttribute("href", "https://example.com");
  await expect(agentCard.getByRole("link")).toHaveCount(2);

  await placeCaretIn(prose.nth(1));
  await page.keyboard.type("@other");
  await expect(menu(page).getByRole("option")).toHaveText(["@other-admin", title]);
  await page.keyboard.press("Tab");
  await expect(menu(page)).toHaveCount(0);
  await expect(prose.nth(1).locator(".ub-person-pill")).toHaveText("@other-admin");
  await page.keyboard.type(" @other");
  await expect(menu(page).getByRole("option")).toHaveText(["@other-admin", title]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(prose.nth(1).locator("a")).toHaveText(title);
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type(" mail@example.com");
  await expect(menu(page)).toHaveCount(0);

  await selectParagraph(prose.nth(2));
  await page.getByRole("button", { name: "Comment", exact: true }).and(page.locator("[data-selection-tool], .ub-composer button")).click();
  const field = page.getByPlaceholder(/Comment as/);
  await field.fill("Review ");
  await field.pressSequentially("@other");
  await expect(menu(page).getByRole("option")).toHaveText(["@other-admin", title]);
  await field.press("Enter");
  await expect(field).toBeVisible();
  await expect(page.locator(".ub-thread-card")).toHaveCount(1);
  await field.pressSequentially(" @other");
  await field.press("ArrowDown");
  await field.press("Tab");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(new RegExp(`^Review @other-admin\\s+\\[${title}\\]\\(${target.uuid}\\)\\s*$`));
  const commentText = (await field.inputValue()).trim();
  await field.pressSequentially(" @bro");
  await expect(menu(page)).toBeVisible();
  const beforeEscape = await field.inputValue();
  await field.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(beforeEscape);
  await expect(page.locator(".ub-mentions")).toHaveCount(0);
  await field.fill(commentText);
  await page.locator(".ub-composer").getByRole("button", { name: "Comment", exact: true }).click();
  const card = page.locator(".ub-thread-card").filter({ hasText: "Review @other-admin" });
  await expect(card.locator(".ub-person-pill")).toHaveText("@other-admin");
  await card.locator(".ub-thread-select").click();
  const reply = card.getByPlaceholder("Reply…", { exact: true });
  await reply.pressSequentially("@bro");
  await expect(menu(page).getByRole("option")).toHaveText(["@browser-person"]);
  await reply.press("Enter");
  await expect(reply).toBeVisible();
  const replyText = (await reply.inputValue()).trim();
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(card.locator(".ub-person-pill")).toHaveText(["@other-admin", "@browser-person"]);
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: source.uuid }), (stored) => {
    expect(stored.blocks[1]?.text).toContain("@other-admin");
    expect(stored.annotations.flatMap((annotation) => annotation.comments.map((comment) => comment.text)))
      .toEqual(expect.arrayContaining([commentText, replyText]));
    expect(commentText).toContain(storedLink);
  });
  await expectMcp(() => session.call<{ markdown: string }>("export_markdown", { uuid: source.uuid, frontmatter: false }),
    (exported) => { expect(exported.markdown).toContain("@other-admin"); });

  const link = card.getByRole("link", { name: title, exact: true });
  await link.click();
  await expect(page.locator(".ub-title")).toHaveValue(title);
  await page.goBack();
  await expect(card).toBeVisible();
  await card.locator(".ub-thread-select").focus();
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await link.press("Enter");
  await expect(page.locator(".ub-title")).toHaveValue(title);
});

test("the shared comment picker is visible in both appearances and touch picks preserve an iPad reply", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const session = writer();
  const { source, title, storedLink } = await fixture(session);
  const touch = info.project.use.hasTouch === true;
  const page = await open(browser, source.uuid, touch);
  if (touch) {
    await activateControl(page.locator(".ub-threads-toggle"), { touch });
    await expect(page.getByRole("dialog", { name: "Comments", exact: true })).toBeVisible();
  }
  const card = page.locator(".ub-thread-card").filter({ hasText: "Agent @other-admin" });
  await activateControl(card.locator(".ub-thread-select"), { touch });
  const reply = card.getByPlaceholder("Reply…", { exact: true });
  await reply.pressSequentially("@other");
  const option = menu(page).getByRole("option", { name: "@other-admin", exact: true });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(option).toBeVisible();
    await expect(option).toBeInViewport({ ratio: 0.99 });
    await expect(card.locator(".ub-person-pill")).toBeVisible();
    const paint = await option.evaluate((node) => {
      const popup = node.closest('[data-slot="caret-menu-content"], [data-slot="popover-content"]');
      if (popup === null) throw new Error("e2e: mention popup surface is missing");
      const style = getComputedStyle(popup);
      return { color: style.color, background: style.backgroundColor };
    });
    expect(paint.color).not.toBe(paint.background);
    expect(paint.background).not.toBe("rgba(0, 0, 0, 0)");
  }
  await activateControl(option, { touch });
  await expect(reply).toHaveValue(/@other-admin/);
  await reply.pressSequentially(" @other");
  await activateControl(menu(page).getByRole("option", { name: title, exact: true }), { touch });
  const replyText = (await reply.inputValue()).trim();
  expect(replyText).toContain(storedLink);
  await reply.pressSequentially(" @bro");
  await expect(menu(page)).toBeVisible();
  const beforeEscape = await reply.inputValue();
  await reply.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(reply).toBeVisible();
  await expect(reply).toHaveValue(beforeEscape);
  if (touch) await expect(page.getByRole("dialog", { name: "Comments", exact: true })).toBeVisible();
  await reply.fill(replyText);
  await activateControl(card.getByRole("button", { name: "Reply", exact: true }), { touch });
  await expect(card.locator(".ub-person-pill")).toHaveCount(2);
  await expect(card.getByRole("link", { name: title, exact: true })).toHaveCount(2);
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: source.uuid }), (stored) => {
    expect(stored.annotations.flatMap((annotation) => annotation.comments.map((comment) => comment.text))).toContain(replyText);
  });
});
