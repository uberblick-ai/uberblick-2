import { join } from "node:path";
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { activateControl, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-decision-topic-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc {
  uuid: string;
  blocks: Array<{ id: string; text: string }>;
}

function answerText(doc: StoredDoc): string {
  const block = doc.blocks[0];
  if (block === undefined) throw new Error("e2e: the decision has no answer");
  return block.text;
}

function session(): McpSession {
  if (agent === null) throw new Error("e2e: the MCP agent is not configured");
  return agent.open({ name: "decision-topic-e2e" });
}

function answer(who = "A workspace member") {
  return { who, when: "2026-10-04T12:00:00Z", where: "https://example.org/team/decision" };
}

async function create(writer: McpSession, title: string, text: string, fields: Record<string, unknown> = {}): Promise<StoredDoc> {
  return writer.call<StoredDoc>("create_doc", {
    title, description: "Browser acceptance fixture.", blocks: [{ type: "paragraph", text }], ...fields,
  });
}

async function comment(writer: McpSession, doc: StoredDoc, text: string): Promise<void> {
  const block = doc.blocks[0];
  if (block === undefined) throw new Error("e2e: the decision has no answer");
  await writer.call("annotate", { uuid: doc.uuid, block_id: block.id, start: 0, end: 7, text });
}

function entry(page: Page, uuid: string): Locator {
  return page.locator(`.ub-decision-timeline > li[data-record="${uuid}"]`);
}

async function selected(page: Page, uuid: string, text: string): Promise<void> {
  await expect(entry(page, uuid).locator(".ub-decision-record")).toHaveAttribute("aria-current", "true");
  await expect(entry(page, uuid).locator(".ub-decision-selection")).toHaveText("Selected");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(editor(page)).toHaveText(text);
}

async function readThread(page: Page, text: string, touch: boolean): Promise<Locator> {
  await activateControl(editor(page).locator("[data-comment-thread]"), { touch });
  const rail = page.getByRole("region", { name: "Threads", exact: true });
  await expect(rail).toContainText(text);
  return rail;
}

async function closeThreadDrawer(page: Page, touch: boolean): Promise<void> {
  const close = page.getByRole("button", { name: "Close threads", exact: true });
  if (await close.isVisible()) await activateControl(close, { touch });
}

async function captureClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { copiedTexts: string[] };
    state.copiedTexts = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { state.copiedTexts.push(text); } },
    });
  });
}

async function copyPath(page: Page, expected: string, touch: boolean): Promise<string> {
  await activateControl(page.locator(".ub-copy-link"), { touch });
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedTexts: string[] }).copiedTexts.at(-1))).toBe(`${new URL(page.url()).origin}${expected}`);
  return `${new URL(page.url()).origin}${expected}`;
}

async function archivedLink(link: Locator): Promise<void> {
  await expect(link).toHaveAttribute("data-doc-link-state", "archived");
  const style = await link.evaluate((element) => ({
    label: getComputedStyle(element, "::after").content,
    decoration: getComputedStyle(element).textDecorationLine,
  }));
  expect(style.label).toContain("archived");
  expect(style.decoration).not.toContain("line-through");
}

for (const touch of [false, true]) for (const appearance of ["light", "dark"] as const) {
  test(`decision topic history, links and comments on ${touch ? "iPad touch" : "desktop keyboard and pointer"} in ${appearance}`, async ({ browser }) => {
    const writer = session();
    const formerOwner = await create(writer, "Former related page", "Previous guidance.");
    const owner = await create(writer, "Current related page", "Current guidance remains readable when archived.");
    const rfc = await create(writer, "Replacement RFC", "Discuss the proposed replacement here.");
    const first = await create(writer, "Initial topic title", "Earlier answer remains available as history.", {
      kind: "decision", status: "decided", related: formerOwner.uuid, answer: answer("Earlier answerer"),
    });
    const current = await create(writer, "Current topic title", "Current answer stays in force during review.", {
      kind: "decision", status: "decided", supersedes: first.uuid, related: owner.uuid, answer: answer("Recorded answerer"),
    });
    const rejected = await create(writer, "Rejected alternative", "Rejected answer remains available as history.", {
      kind: "decision", supersedes: current.uuid,
    });
    await writer.call("set_status", { uuid: rejected.uuid, status: "rejected", answer: answer("Recorded rejecter"), reason: "The proposal does not meet the constraint." });
    const withdrawn = await create(writer, "Withdrawn alternative", "Withdrawn answer remains available as history.", {
      kind: "decision", supersedes: current.uuid,
    });
    await writer.call("set_status", { uuid: withdrawn.uuid, status: "withdrawn" });
    const pending = await create(writer, "Pending alternative", "Pending answer remains an open proposal.", {
      kind: "decision", supersedes: current.uuid, discussion: rfc.uuid,
    });
    await comment(writer, first, "Conversation about the earlier answer.");
    await comment(writer, current, "Conversation about the current answer.");
    await comment(writer, rejected, "Conversation about the rejection.");
    await writer.call("archive_doc", { uuid: owner.uuid });
    await writer.call("archive_doc", { uuid: rfc.uuid });

    const topicPath = `/${harness().workspace}/${first.uuid}`;
    const firstPath = `${topicPath}/record/${first.uuid}`;
    const currentPath = `${topicPath}/record/${current.uuid}`;
    const rejectedPath = `${topicPath}/record/${rejected.uuid}`;
    const page = await openApp(browser, topicPath, {
      upstream: true,
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: appearance },
      beforeNavigate: captureClipboard,
    });
    await expect(page.getByRole("heading", { name: "Current topic title", exact: true })).toBeVisible();
    await expect(page.locator(".ub-decision-topic-state")).toHaveText("Under review");
    await expect(page.locator(".ub-decision-notice")).toContainText("The current answer stays in force.");
    await selected(page, current.uuid, answerText(current));
    const currentColor = await editor(page).locator("p").evaluate((element) => getComputedStyle(element).color);
    await expect(page.locator(".ub-decision-attribution")).toHaveText("Decided by Recorded answerer · 2026-10-04T12:00:00Z");
    await expect(entry(page, first.uuid)).toContainText("Linked record");
    await expect(page.locator(".ub-decision-timeline > li")).toHaveCount(5);
    await expect(page.locator(".ub-decision-record-state")).toHaveText(["Superseded", "In force", "Rejected", "Withdrawn", "Open proposal"]);
    await expect(entry(page, rejected.uuid)).toContainText("1 comment");
    await expect(entry(page, current.uuid).locator("time")).toHaveAttribute("datetime", "2026-10-04T12:00:00.000Z");
    await archivedLink(page.locator(".ub-decision-related a"));
    await expect(page.locator(".ub-decision-related a")).toContainText("Current related page");
    await archivedLink(page.locator(".ub-decision-notice a"));
    await archivedLink(entry(page, pending.uuid).locator(".ub-doclink"));
    await copyPath(page, topicPath, touch);
    if (touch && appearance === "dark" || !touch && appearance === "light") await page.screenshot({
      path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `decision-topic-${touch ? "ipad-dark" : "desktop-light"}.png`), fullPage: true,
    });

    const earlier = entry(page, first.uuid).locator(".ub-decision-record");
    if (touch) await earlier.tap();
    else {
      await earlier.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(earlier).toBeFocused();
      const outline = await earlier.evaluate((element) => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }));
      expect(outline.style).not.toBe("none");
      expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);
      await page.keyboard.press("Enter");
    }
    await expect(page).toHaveURL(new RegExp(`${firstPath}$`));
    await selected(page, first.uuid, answerText(first));
    await expect(page.locator(".ub-decision-answer-label")).toContainText("History · Superseded");
    await expect(page.locator(".ub-decision-answer-history")).toBeVisible();
    expect(await editor(page).locator("p").evaluate((element) => getComputedStyle(element).color)).not.toBe(currentColor);
    const rail = await readThread(page, "Conversation about the earlier answer.", touch);
    await expect(rail).not.toContainText("Conversation about the current answer.");
    await activateControl(rail.getByRole("button", { name: "Reply", exact: true }), { touch });
    await rail.getByPlaceholder("Reply…").fill("Readers can still discuss historical answers.");
    await activateControl(rail.getByRole("button", { name: "Reply", exact: true }), { touch });
    await expect(rail).toContainText("Readers can still discuss historical answers.");
    await closeThreadDrawer(page, touch);
    const copied = await copyPath(page, firstPath, touch);
    await page.reload();
    await selected(page, first.uuid, answerText(first));
    const shared = await openApp(browser, new URL(copied).pathname, { upstream: true });
    await selected(shared, first.uuid, answerText(first));

    await activateControl(entry(page, rejected.uuid).locator(".ub-decision-record"), { touch });
    await expect(page).toHaveURL(new RegExp(`${rejectedPath}$`));
    await selected(page, rejected.uuid, answerText(rejected));
    await expect(page.locator(".ub-decision-answer-label")).toContainText("History · Rejected");
    await expect(page.locator(".ub-decision-attribution")).toContainText("Rejected by Recorded rejecter");
    await expect(page.locator(".ub-decision-rejection")).toHaveText("Rejection reason: The proposal does not meet the constraint.");
    await readThread(page, "Conversation about the rejection.", touch);
    await closeThreadDrawer(page, touch);
    await page.goBack();
    await selected(page, first.uuid, answerText(first));
    await page.goForward();
    await selected(page, rejected.uuid, answerText(rejected));
    await activateControl(page.getByRole("link", { name: "Go to the current answer", exact: true }), { touch });
    await selected(page, current.uuid, answerText(current));
    await expect(page).toHaveURL(new RegExp(`${topicPath}$`));

    await activateControl(page.locator(".ub-decision-notice a"), { touch });
    await expect(page).toHaveURL(new RegExp(`/${rfc.uuid}$`));
    await expect(page.locator(".ub-archived-banner")).toContainText("Archived. Read-only and hidden from the document list.");
    await expect(page.locator(".ub-archived-banner")).not.toContainText("tombstoned");
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(editor(page)).toHaveText(answerText(rfc));
    await page.goBack();
    await selected(page, current.uuid, answerText(current));
    await activateControl(page.locator(".ub-decision-related a"), { touch });
    await expect(editor(page)).toHaveText(answerText(owner));
    await expect(page.locator(".ub-archived-banner")).toContainText("Archived. Read-only and hidden from the document list.");
    await page.goBack();
    await selected(page, current.uuid, answerText(current));

    await writer.call("archive_doc", { uuid: first.uuid });
    await expect(page.locator(".ub-archived-banner")).toContainText("Archived. Read-only and hidden from the document list.");
    await expect(page.locator(".ub-decision-timeline > li")).toHaveCount(5);
    await activateControl(entry(page, current.uuid).locator(".ub-decision-record"), { touch });
    await expect(page).toHaveURL(new RegExp(`${currentPath}$`));
    await selected(page, current.uuid, answerText(current));
    const archivedRail = await readThread(page, "Conversation about the current answer.", touch);
    await expect(archivedRail.getByRole("button", { name: /^(Reply|Resolve|Reopen)$/ })).toHaveCount(0);
    await closeThreadDrawer(page, touch);
    await editor(page).locator("p").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await expect(page.locator('[data-slot="selection-composer"]')).toHaveCount(0);
    await expect(page.locator("input.ub-title")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Insert block below", includeHidden: true })).toHaveCount(0);
    const exact = await writer.call<StoredDoc>("get_doc", { uuid: first.uuid });
    expect(exact.uuid).toBe(first.uuid);
    expect(answerText(exact)).toBe(answerText(first));
  });
}

test("undecided proposals and conflicting answers remain labelled as history", async ({ browser }) => {
  const writer = session();
  const rfc = await create(writer, "First topic RFC", "Discuss the first answer.");
  const proposal = await create(writer, "Unanswered topic", "Open proposal is not guidance in force.", { kind: "decision", discussion: rfc.uuid });
  const page = await openApp(browser, `/${harness().workspace}/${proposal.uuid}`, { upstream: true });
  await selected(page, proposal.uuid, answerText(proposal));
  await expect(page.locator(".ub-decision-topic-state")).toHaveText("Not yet decided");
  await expect(page.locator(".ub-decision-answer-label")).toHaveText("History · Open proposal");
  await activateControl(page.locator(".ub-decision-notice a"));
  await expect(editor(page)).toHaveText(answerText(rfc));

  const stance = await create(writer, "An initial stance", "Initial agent answer.", { kind: "decision", status: "decided" });
  await page.goto(new URL(`/${harness().workspace}/${stance.uuid}`, harness().appUrl).href);
  await selected(page, stance.uuid, answerText(stance));
  await expect(page.locator(".ub-decision-topic-state")).toHaveText("Agent stance");
  await expect(page.locator(".ub-decision-attribution")).toHaveCount(0);
  const left = await create(writer, "Competing answer one", "The first conflicting answer.", {
    kind: "decision", status: "decided", supersedes: stance.uuid, answer: answer("First answerer"),
  });
  const right = await create(writer, "Competing answer two", "The second conflicting answer.", {
    kind: "decision", status: "decided", supersedes: stance.uuid, answer: answer("Second answerer"),
  });
  await expect(page.locator(".ub-decision-topic-state")).toHaveText("Conflict");
  await expect(page.locator(".ub-decision-notice")).toContainText("Nothing is in force.");
  await selected(page, right.uuid, answerText(right));
  await expect(page.locator(".ub-decision-answer-label")).toHaveText("History · Conflicting answer");
  await expect(page.locator(".ub-decision-record-state")).toHaveText(["Superseded", "Conflicting answer", "Conflicting answer"]);
  await activateControl(entry(page, left.uuid).locator(".ub-decision-record"));
  await selected(page, left.uuid, answerText(left));
  await expect(page.getByRole("link", { name: "Go to the current answer", exact: true })).toHaveCount(0);
});
