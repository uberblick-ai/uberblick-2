import { join } from "node:path";
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { activateControl, closeIfOpen, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, proveMcpArrival } from "./settle.js";
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
  await expect(page.locator(".ub-decision-related")).toHaveCount(0);
  await expect(page.getByText(/^Related page:/)).toHaveCount(0);
}

async function selectedRfc(page: Page, rfc: StoredDoc | null, title = ""): Promise<void> {
  const line = page.locator(".ub-decision-rfc");
  if (rfc === null) {
    await expect(line).toHaveCount(0);
    return;
  }
  await expect(line).toHaveCount(1);
  await expect(line.getByText("RFC", { exact: true })).toBeVisible();
  await expect(line.getByRole("link")).toHaveText(title);
  await expect(line.getByRole("link")).toHaveAttribute("href", new RegExp(`/${rfc.uuid}$`));
  await expect(page.locator(".ub-decision-answer + .ub-decision-rfc + .ub-decision-history")).toHaveCount(1);
}

async function rfcLayout(page: Page): Promise<void> {
  const layout = await page.locator(".ub-decision-rfc").evaluate((element) => {
    const answer = element.previousElementSibling;
    const history = element.nextElementSibling;
    const pane = element.closest(".ub-document-pane");
    const label = element.querySelector("span");
    const link = element.querySelector("a");
    if (answer === null || history === null || pane === null || label === null || link === null) throw new Error("e2e: missing RFC layout");
    const probe = document.createElement("span");
    probe.style.color = "var(--muted-foreground)";
    probe.style.fontFamily = "var(--font-sans)";
    element.append(probe);
    try {
      return {
        top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom,
        answerBottom: answer.getBoundingClientRect().bottom, historyTop: history.getBoundingClientRect().top,
        labelColor: getComputedStyle(label).color, linkColor: getComputedStyle(link).color, muted: getComputedStyle(probe).color,
        labelFont: getComputedStyle(label).fontFamily, linkFont: getComputedStyle(link).fontFamily,
        uiFont: getComputedStyle(probe).fontFamily,
        width: element.clientWidth, scroll: element.scrollWidth,
        paneWidth: pane.clientWidth, paneScroll: pane.scrollWidth,
        pageWidth: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth,
      };
    } finally { probe.remove(); }
  });
  expect(layout.top).toBeGreaterThanOrEqual(layout.answerBottom);
  expect(layout.bottom).toBeLessThanOrEqual(layout.historyTop);
  expect(layout.labelColor).toBe(layout.muted);
  expect(layout.linkColor).toBe(layout.muted);
  expect(layout.labelFont).toBe(layout.uiFont);
  expect(layout.linkFont).toBe(layout.uiFont);
  expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
  expect(layout.paneScroll).toBeLessThanOrEqual(layout.paneWidth + 1);
  expect(layout.pageScroll).toBeLessThanOrEqual(layout.pageWidth + 1);
}

async function readThread(page: Page, text: string, touch: boolean): Promise<Locator> {
  await activateControl(editor(page).locator("[data-comment-thread]"), { touch });
  const rail = page.getByRole("region", { name: "Threads", exact: true });
  await expect(rail).toContainText(text);
  return rail;
}

async function closeThreadDrawer(page: Page, touch: boolean): Promise<void> {
  await closeIfOpen(page.getByRole("button", { name: "Close threads", exact: true }), page.locator(".ub-threads-toggle"), { touch });
}

async function selectedTopicPin(page: Page, touch: boolean): Promise<void> {
  const show = page.getByRole("button", { name: "Show document list", exact: true });
  if (await show.isVisible()) await activateControl(show, { touch });
  const pin = page.locator(".ub-pin-row > button");
  await expect(pin).toHaveCount(1);
  await expect(pin).toBeVisible();
  await expect(pin).toHaveText("Initial topic title");
  await expect(pin).toHaveAttribute("aria-current", "page");
  await closeIfOpen(page.getByRole("button", { name: "Close document list", exact: true }), show, { touch });
}

async function topicPins(writer: McpSession, records: string[]): Promise<string[]> {
  const sidebar = await writer.call<{ groups: Array<{ docs: Array<{ uuid: string }> }> }>("get_sidebar", {});
  return sidebar.groups.flatMap((group) => group.docs.map((doc) => doc.uuid)).filter((uuid) => records.includes(uuid));
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
  await activateControl(page.getByRole("button", { name: "Document actions", exact: true }), { touch });
  await activateControl(page.getByRole("menuitem", { name: "Copy link", exact: true }), { touch });
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

async function answerHeader(page: Page, label: string, state: string): Promise<void> {
  const header = page.locator(".ub-decision-answer-header");
  await expect(header).toHaveCount(1);
  await expect(header.getByText("ANSWER", { exact: true })).toBeVisible();
  await expect(header.locator(".ub-decision-answer-state")).toHaveText(label);
  await expect(header.locator(".ub-decision-answer-state")).toHaveAttribute("data-state", state);
  await expect(page.locator(".ub-decision-topic-state, .ub-decision-answer-label")).toHaveCount(0);
  const styles = await header.evaluate((element) => {
    const pill = element.querySelector(".ub-decision-answer-state");
    const mark = pill?.querySelector(".ub-decisions-mark");
    const caption = element.querySelector(".ub-decision-answer-caption");
    if (pill === null || mark === null || mark === undefined || caption === null) throw new Error("e2e: missing answer state mark");
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    element.append(probe);
    const token = (property: string, value: string): string => {
      probe.style.setProperty(property, value);
      return getComputedStyle(probe).getPropertyValue(property);
    };
    try {
      const pillStyle = getComputedStyle(pill);
      const markStyle = getComputedStyle(mark);
      return {
        ink: pillStyle.color, fill: pillStyle.backgroundColor, border: pillStyle.borderTopColor, outline: pillStyle.borderTopStyle,
        markFill: markStyle.backgroundColor, markBorder: markStyle.borderTopColor, markImage: markStyle.backgroundImage,
        markBorderWidth: markStyle.borderTopWidth, markRadius: markStyle.borderRadius,
        font: getComputedStyle(caption).fontFamily, timeFont: getComputedStyle(element.querySelector("time") ?? caption).fontFamily,
        uiFont: token("font-family", "var(--font-sans)"), neutral: token("color", "var(--muted-foreground)"),
        success: token("color", "var(--status-success)"), destructive: token("color", "var(--destructive)"),
        half: token("background-image", "linear-gradient(90deg, var(--muted-foreground) 50%, transparent 50%)"),
        amber: [token("color", "var(--brand)"), token("color", "var(--brand-ink)"), token("color", "var(--status-warning)"), token("color", "var(--status-warning-subtle)")],
      };
    } finally { probe.remove(); }
  });
  expect(styles.font).toBe(styles.uiFont);
  expect(styles.timeFont).toBe(styles.uiFont);
  for (const color of [styles.ink, styles.fill, styles.border, styles.markFill, styles.markBorder]) expect(styles.amber).not.toContain(color);
  if (state === "in-force") expect([styles.markFill, styles.markBorder]).toEqual([styles.success, styles.success]);
  if (state === "under-review") expect(styles.markImage).toBe(styles.half);
  if (state === "agent-stance") {
    expect(styles.markBorderWidth).toBe("2px");
    expect(styles.markFill).toBe("rgba(0, 0, 0, 0)");
  }
  if (state === "conflict" || state === "rejected") expect([styles.markFill, styles.markBorder]).toEqual([styles.destructive, styles.destructive]);
  if (state === "conflict") expect(styles.markRadius).toBe("2px");
  if (state === "superseded" || state === "withdrawn") expect([styles.ink, styles.markBorder]).toEqual([styles.neutral, styles.neutral]);
  if (state === "not-yet-decided" || state === "open-proposal") expect(styles.outline).toBe("dashed");
}

async function relativeAttribution(page: Page, who: string, when: string): Promise<void> {
  const attribution = page.locator(".ub-decision-answer-header .ub-decision-attribution");
  const time = attribution.locator("time");
  await expect(time).toHaveAttribute("datetime", when);
  await expect(time).toHaveText(/^(just now|\d+ (minute|hour|day|week|month|year)s? ago)$/);
  await expect(attribution).toHaveText(`${who} · ${await time.innerText()}`);
  await expect(time).toHaveAttribute("title", await page.evaluate((value) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)), when));
}

async function headerLayout(page: Page, wrapped: boolean | null): Promise<void> {
  const layout = await page.locator(".ub-decision-answer-header").evaluate((element) => {
    const state = element.querySelector(".ub-decision-answer-state");
    const attribution = element.querySelector(".ub-decision-attribution");
    const pane = element.closest(".ub-document-pane");
    if (state === null || attribution === null || pane === null) throw new Error("e2e: missing answer header layout");
    const pill = state.getBoundingClientRect();
    const meta = attribution.getBoundingClientRect();
    return {
      pillTop: pill.top, pillBottom: pill.bottom, attributionTop: meta.top,
      attributionRight: meta.right, headerRight: element.getBoundingClientRect().right,
      headerWidth: element.clientWidth, headerScroll: element.scrollWidth,
      paneWidth: pane.clientWidth, paneScroll: pane.scrollWidth,
      pageWidth: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth,
    };
  });
  if (wrapped === true) expect(layout.attributionTop).toBeGreaterThanOrEqual(layout.pillBottom);
  else if (wrapped === false) {
    expect(layout.attributionTop).toBeLessThan(layout.pillBottom);
    expect(Math.abs(layout.headerRight - layout.attributionRight)).toBeLessThanOrEqual(2);
  }
  expect(layout.headerScroll).toBeLessThanOrEqual(layout.headerWidth + 1);
  expect(layout.paneScroll).toBeLessThanOrEqual(layout.paneWidth + 1);
  expect(layout.pageScroll).toBeLessThanOrEqual(layout.pageWidth + 1);
}

for (const { touch, appearance } of [
  { touch: false, appearance: "light" }, { touch: false, appearance: "dark" },
  { touch: true, appearance: "light" }, { touch: true, appearance: "dark" },
] as const) {
  test(`decision topic history, links and comments on ${touch ? "iPad touch @webkit-touch" : "desktop keyboard and pointer"} in ${appearance}`, async ({ browser }) => {
    const writer = session();
    const formerOwner = await create(writer, "Former related page", "Previous guidance.");
    const owner = await create(writer, "Current related page", "Current guidance remains readable when archived.");
    const firstRfc = await create(writer, "Original answer RFC", "Discuss the original answer here.");
    const currentRfc = await create(writer, "Current answer RFC", "Discuss the current answer here.");
    const rfc = await create(writer, "Replacement RFC", "Discuss the proposed replacement here.");
    const first = await create(writer, "Initial topic title", "Earlier answer remains available as history.", {
      kind: "decision", status: "decided", related: formerOwner.uuid, discussion: firstRfc.uuid, answer: answer("Earlier answerer"),
    });
    await writer.call("pin_doc", { uuid: first.uuid, group: "Reading" });
    const current = await create(writer, "Current topic title", "Current answer stays in force during review.", {
      kind: "decision", status: "decided", supersedes: first.uuid, related: owner.uuid, discussion: currentRfc.uuid, answer: answer("Recorded answerer"),
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
    await answerHeader(page, "In force", "in-force");
    await expect(page.locator(".ub-decision-notice")).toContainText("The current answer stays in force.");
    await selected(page, current.uuid, answerText(current));
    await selectedRfc(page, currentRfc, "Current answer RFC");
    const currentRfcTitle = "RFC: Current guidance and its implementation constraints for the shared workspace";
    await writer.call("set_metadata", { uuid: currentRfc.uuid, title: currentRfcTitle });
    await selectedRfc(page, currentRfc, currentRfcTitle);
    await writer.call("archive_doc", { uuid: currentRfc.uuid });
    await archivedLink(page.locator(".ub-decision-rfc a"));
    await selectedTopicPin(page, touch);
    const topicRecords = [first.uuid, current.uuid, rejected.uuid, withdrawn.uuid, pending.uuid];
    const actions = page.getByRole("button", { name: "Document actions", exact: true });
    await activateControl(actions, { touch });
    await expect(page.getByRole("menuitem", { name: "Unpin from sidebar", exact: true })).toBeEnabled();
    await expect(page.getByRole("menuitem", { name: "Pin to sidebar", exact: true })).toHaveCount(0);
    await activateControl(page.getByRole("menuitem", { name: "Unpin from sidebar", exact: true }), { touch });
    await expect.poll(() => topicPins(writer, topicRecords)).toEqual([]);
    await activateControl(actions, { touch });
    await activateControl(page.getByRole("menuitem", { name: "Pin to sidebar", exact: true }), { touch });
    await expect.poll(() => topicPins(writer, topicRecords)).toEqual([first.uuid]);
    await selectedTopicPin(page, touch);
    const currentColor = await editor(page).locator("p").evaluate((element) => getComputedStyle(element).color);
    await relativeAttribution(page, "Recorded answerer", "2026-10-04T12:00:00.000Z");
    await headerLayout(page, touch ? null : false);
    await expect(entry(page, first.uuid)).toContainText("Linked record");
    await expect(page.locator(".ub-decision-timeline > li")).toHaveCount(5);
    await expect(page.locator(".ub-decision-record-state")).toHaveText(["Superseded", "In force", "Rejected", "Withdrawn", "Open proposal"]);
    await expect(entry(page, rejected.uuid)).toContainText("1 comment");
    await expect(entry(page, current.uuid).locator("time")).toHaveAttribute("datetime", "2026-10-04T12:00:00.000Z");
    await expect(page.locator(`.ub-document-pane a[href$="/${owner.uuid}"], .ub-document-pane a[href$="/${formerOwner.uuid}"]`)).toHaveCount(0);
    await archivedLink(page.locator(".ub-decision-notice a"));
    await archivedLink(entry(page, pending.uuid).locator(".ub-doclink"));
    await rfcLayout(page);
    await copyPath(page, topicPath, touch);
    await page.screenshot({
      path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `decision-topic-${test.info().project.name}-${touch ? "ipad" : "desktop"}-${appearance}.png`), fullPage: true,
    });
    const column = page.locator(".ub-document-pane > .ub-column");
    await column.evaluate((element) => { (element as HTMLElement).style.inlineSize = "18rem"; });
    await headerLayout(page, true);
    await rfcLayout(page);
    await page.screenshot({
      path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `decision-topic-${test.info().project.name}-${touch ? "ipad" : "desktop"}-${appearance}-narrow.png`), fullPage: true,
    });
    await column.evaluate((element) => { (element as HTMLElement).style.removeProperty("inline-size"); });
    await activateControl(page.locator(".ub-decision-rfc a"), { touch });
    await expect(page).toHaveURL(new RegExp(`/${currentRfc.uuid}$`));
    await expect(page.locator(".ub-archived-banner")).toContainText("Archived. Read-only and hidden from the document list.");
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(editor(page)).toHaveText(answerText(currentRfc));
    await page.goBack();
    await selected(page, current.uuid, answerText(current));
    await selectedRfc(page, currentRfc, currentRfcTitle);

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
    await selectedRfc(page, firstRfc, "Original answer RFC");
    await rfcLayout(page);
    const firstRfcLink = page.locator(".ub-decision-rfc a");
    if (touch) await firstRfcLink.tap();
    else {
      await firstRfcLink.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(firstRfcLink).toBeFocused();
      await page.keyboard.press("Enter");
    }
    await expect(page).toHaveURL(new RegExp(`/${firstRfc.uuid}$`));
    await expect(editor(page)).toHaveText(answerText(firstRfc));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${firstPath}$`));
    await selected(page, first.uuid, answerText(first));
    await selectedRfc(page, firstRfc, "Original answer RFC");
    await selectedTopicPin(page, touch);
    await activateControl(actions, { touch });
    await expect(page.getByRole("menuitem", { name: "Unpin from sidebar", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await answerHeader(page, "Superseded", "superseded");
    const replacementAge = await entry(page, current.uuid).locator("time").textContent();
    await expect(page.locator(".ub-decision-earlier-answer")).toContainText(`Earlier answer. Replaced ${replacementAge}; it no longer applies.`);
    await expect(page.getByRole("link", { name: "Go to the current answer", exact: true })).toBeVisible();
    await page.screenshot({
      path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `decision-topic-${test.info().project.name}-${touch ? "ipad" : "desktop"}-${appearance}-earlier.png`), fullPage: true,
    });
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
    await selectedRfc(page, null);
    await answerHeader(page, "Rejected", "rejected");
    await relativeAttribution(page, "Recorded rejecter", "2026-10-04T12:00:00.000Z");
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

    await activateControl(entry(page, pending.uuid).locator(".ub-decision-record"), { touch });
    await selected(page, pending.uuid, answerText(pending));
    await selectedRfc(page, rfc, "Replacement RFC");
    await answerHeader(page, "Under review", "under-review");
    await expect(page.locator(".ub-decision-notice")).toHaveText("The current answer stays in force. Open proposal");
    await expect(page.locator(".ub-decision-attribution")).toHaveText(/^Opened (just now|\d+ (minute|hour|day|week|month|year)s? ago)$/);
    await expect(page.locator(".ub-decision-answer-history")).toBeVisible();
    await activateControl(page.getByRole("link", { name: "Go to the current answer", exact: true }), { touch });
    await selected(page, current.uuid, answerText(current));

    await activateControl(entry(page, withdrawn.uuid).locator(".ub-decision-record"), { touch });
    await selected(page, withdrawn.uuid, answerText(withdrawn));
    await selectedRfc(page, null);
    await answerHeader(page, "Withdrawn", "withdrawn");
    await expect(page.locator(".ub-decision-attribution")).toHaveText(/^Opened (just now|\d+ (minute|hour|day|week|month|year)s? ago)$/);
    await expect(page.locator(".ub-decision-answer-history")).toBeVisible();
    await activateControl(page.getByRole("link", { name: "Go to the current answer", exact: true }), { touch });
    await selected(page, current.uuid, answerText(current));

    await activateControl(page.locator(".ub-decision-notice a"), { touch });
    await expect(page).toHaveURL(new RegExp(`/${rfc.uuid}$`));
    await expect(page.locator(".ub-archived-banner")).toContainText("Archived. Read-only and hidden from the document list.");
    await expect(page.locator(".ub-archived-banner")).not.toContainText("tombstoned");
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(editor(page)).toHaveText(answerText(rfc));
    await page.goBack();
    await selected(page, current.uuid, answerText(current));
    await selectedRfc(page, currentRfc, currentRfcTitle);

    await writer.call("archive_doc", { uuid: first.uuid });
    await expect(page.locator(".ub-archived-banner")).toContainText("Archived. Read-only and hidden from the document list.");
    await expect(page.locator(".ub-decision-timeline > li")).toHaveCount(5);
    await activateControl(entry(page, current.uuid).locator(".ub-decision-record"), { touch });
    await expect(page).toHaveURL(new RegExp(`${currentPath}$`));
    await selected(page, current.uuid, answerText(current));
    await selectedRfc(page, currentRfc, currentRfcTitle);
    await archivedLink(page.locator(".ub-decision-rfc a"));
    await rfcLayout(page);
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
    await page.goto(new URL(firstPath, harness().appUrl).href);
    await selected(page, first.uuid, answerText(first));
    await proveMcpArrival(page, writer, first.uuid, { path: "upstream" });
    await expectMcp(async () => {
      const exact = await writer.call<StoredDoc>("get_doc", { uuid: first.uuid });
      expect(exact.uuid).toBe(first.uuid);
      expect(answerText(exact)).toBe(answerText(first));
    });
  });
}

test("undecided proposals, agent stances and conflicting answers show selected-record headers", async ({ browser }) => {
  const writer = session();
  const rfc = await create(writer, "First topic RFC", "Discuss the first answer.");
  const proposal = await create(writer, "Unanswered topic", "Open proposal is not guidance in force.", { kind: "decision", discussion: rfc.uuid });
  const page = await openApp(browser, `/${harness().workspace}/${proposal.uuid}`, { upstream: true });
  await selected(page, proposal.uuid, answerText(proposal));
  await selectedRfc(page, rfc, "First topic RFC");
  await answerHeader(page, "Not yet decided", "not-yet-decided");
  await expect(page.locator(".ub-decision-notice")).toHaveText("Open proposal");
  await expect(page.locator(".ub-decision-attribution")).toHaveText(/^Opened (just now|\d+ (minute|hour|day|week|month|year)s? ago)$/);
  await expect(page.locator(".ub-decision-answer-history")).toBeVisible();
  await activateControl(page.locator(".ub-decision-notice a"));
  await expect(editor(page)).toHaveText(answerText(rfc));

  const stance = await create(writer, "An initial stance", "Initial agent answer.", { kind: "decision", status: "decided" });
  await page.goto(new URL(`/${harness().workspace}/${stance.uuid}`, harness().appUrl).href);
  await selected(page, stance.uuid, answerText(stance));
  await selectedRfc(page, null);
  await answerHeader(page, "Agent stance", "agent-stance");
  await expect(page.locator(".ub-decision-attribution")).toHaveText(/^(just now|\d+ (minute|hour|day|week|month|year)s? ago)$/);
  await expect(page.locator(".ub-decision-answer-header").getByText("Agent stance", { exact: true })).toHaveCount(1);
  const left = await create(writer, "Competing answer one", "The first conflicting answer.", {
    kind: "decision", status: "decided", supersedes: stance.uuid, discussion: rfc.uuid, answer: answer("First answerer"),
  });
  const right = await create(writer, "Competing answer two", "The second conflicting answer.", {
    kind: "decision", status: "decided", supersedes: stance.uuid, answer: answer("Second answerer"),
  });
  await expect(page.locator(".ub-decision-notice")).toContainText("Nothing is in force.");
  await selected(page, right.uuid, answerText(right));
  await selectedRfc(page, null);
  await answerHeader(page, "Conflicting answer", "conflict");
  await expect(page.locator(".ub-decision-record-state")).toHaveText(["Superseded", "Conflicting answer", "Conflicting answer"]);
  await activateControl(entry(page, left.uuid).locator(".ub-decision-record"));
  await selected(page, left.uuid, answerText(left));
  await selectedRfc(page, rfc, "First topic RFC");
  await expect(page.getByRole("link", { name: "Go to the current answer", exact: true })).toHaveCount(0);
});
