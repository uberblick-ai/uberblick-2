import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { appendBlock, createGroup, getDirectoryEntry, getDirectoryMap, getMetaMap, pinDoc, sidebarRoom } from "@uberblick/schema";
import { activateControl, closeIfOpen, editor, setupHarness } from "./app-helpers.js";
import { legacyDecisionPeer } from "./legacy-decision-peer.js";
import { renderedText } from "./contrast-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { setNativeSelection } from "./native-selection.js";
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
  title: string;
  approvalChanged?: boolean;
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

test("malformed synced document ids leave valid topics and sidebar navigation usable", async ({ browser }) => {
  const writer = session();
  const other = await create(writer, "Unrelated document", "The other room stays unchanged.");
  const current = await create(writer, "Protected topic", "Keep this room's answer.", { kind: "decision", status: "decided" });
  const peer = await legacyDecisionPeer(harness(), current.uuid);
  let group: string | null = null;
  try {
    const sidebar = await peer.join(sidebarRoom(harness().workspaceUuid));
    group = createGroup(sidebar, "Malformed-id regression");
    pinDoc(sidebar, group, current.uuid);
    sidebar.getArray(`pins:${group}`).push([
      { uuid: "..", since: 0 }, { uuid: "a/record/b", since: 0 }, { uuid: other.uuid.toUpperCase(), since: 0 },
    ]);
    getMetaMap(peer.doc).set("uuid", other.uuid);
    getDirectoryMap(peer.directory).set("evil/key", {
      title: "Forged topic answer", kind: "decision", status: "decided",
      topic: current.uuid, supersedes: current.uuid, createdAt: Date.now() + 1_000,
    });
    const pageErrors: string[] = [];
    const warnings: string[] = [];
    const page = await openApp(browser, `/${harness().workspace}/${current.uuid}`, {
      upstream: true,
      beforeNavigate: async (opened) => {
        opened.on("pageerror", (error) => pageErrors.push(error.message));
        opened.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
      },
    });
    await selected(page, current.uuid, answerText(current));
    await expect(page.locator(".ub-decision-timeline > li")).toHaveCount(1);
    await expect(page.locator('a[href*="evil/key"], a[href$="/.."], a[href$="/a/record/b"]')).toHaveCount(0);
    await expect(page.locator(`a[href$="/${other.uuid.toUpperCase()}"]`)).toHaveCount(0);
    await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Protected topic renamed");
    await expect.poll(() => getDirectoryEntry(peer.directory, current.uuid)?.title).toBe("Protected topic renamed");
    expect(getDirectoryEntry(peer.directory, other.uuid)?.title).toBe(other.title);
    await expect(page.locator('.ub-list button[title=".."], .ub-list button[title="a/record/b"]')).toHaveCount(0);
    await expect(page.locator(`.ub-list button[title="${other.uuid.toUpperCase()}"]`)).toHaveCount(0);
    await expect(page.locator(".ub-list").getByRole("button", { name: "Protected topic renamed", exact: true })).toBeVisible();
    await page.locator(".ub-list").getByRole("button", { name: "Protected topic renamed", exact: true }).click();
    await selected(page, current.uuid, answerText(current));
    expect(warnings.filter((warning) => warning.includes("evil/key"))).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  } finally {
    getDirectoryMap(peer.directory).delete("evil/key");
    getMetaMap(peer.doc).set("uuid", current.uuid);
    try {
      if (group !== null) {
        await expectMcp(() => writer.call<{ groups: { id: string }[] }>("get_sidebar", {}), sidebar => {
          expect(sidebar.groups.some(entry => entry.id === group)).toBe(true);
        });
        await writer.call("sidebar_group", { action: "delete", group });
      }
    } finally { peer.close(); }
  }
});

function answer(who = "A workspace member") {
  return { who, when: "2026-10-04T12:00:00Z", where: "https://example.org/team/decision" };
}

async function create(writer: McpSession, title: string | undefined, text: string, fields: Record<string, unknown> = {}): Promise<StoredDoc> {
  const created = await writer.call<StoredDoc>("create_doc", {
    ...(title === undefined ? {} : { title }),
    description: "Browser acceptance fixture.", blocks: [{ type: "paragraph", text }], ...fields,
  });
  // create_doc names blocks by id and rev; the seeded paragraph stores the text written.
  return fields.blocks === undefined ? { ...created, blocks: created.blocks.map((block) => ({ ...block, text })) } : created;
}

async function comment(writer: McpSession, doc: StoredDoc, text: string): Promise<void> {
  const block = doc.blocks[0];
  if (block === undefined) throw new Error("e2e: the decision has no answer");
  await writer.call("annotate", { uuid: doc.uuid, block_id: block.id, start: 0, end: 7, text });
}

function entry(page: Page, uuid: string): Locator {
  return page.locator(`.ub-decision-timeline > li[data-record="${uuid}"]`);
}

test("legacy decision dates stay calendar dates west of UTC at every decision time", async ({ browser }) => {
  const writer = session();
  const owner = await create(writer, "Legacy decision date owner", "The related page's prose.");
  const first = await create(writer, "Legacy date question", "Earlier answer.", {
    kind: "decision", status: "decided", answer: answer(),
  });
  const current = await create(writer, undefined, "Current answer.", {
    kind: "decision", status: "decided", supersedes: first.uuid, related: owner.uuid, answer: answer(),
  });
  const peer = await legacyDecisionPeer(harness(), current.uuid);
  try {
    getMetaMap(peer.doc).set("decidedAt", "2026-10-24");
    peer.decide("decided");
    await expectMcp(() => writer.call<{ decidedAt?: string }>("get_doc", { uuid: current.uuid }), (stored) => {
      expect(stored.decidedAt).toBe("2026-10-24");
    });
    const topicPath = `/${harness().workspace}/${first.uuid}`;
    const page = await openApp(browser, topicPath, {
      upstream: true, contextOptions: { locale: "en-US", timezoneId: "America/Los_Angeles" },
    });
    await selected(page, current.uuid, answerText(current));
    const calendarTime = async (time: Locator): Promise<void> => {
      await expect(time).toHaveText("Oct 24, 2026");
      await expect(time).toHaveAttribute("datetime", "2026-10-24");
      await expect(time).toHaveAttribute("title", "Oct 24, 2026");
    };
    await calendarTime(entry(page, current.uuid).locator("time"));
    const instant = entry(page, first.uuid).locator("time");
    await expect(instant).toHaveText(/ago$/);
    await expect(instant).toHaveAttribute("datetime", "2026-10-04T12:00:00.000Z");
    await expect(instant).toHaveAttribute("title", await page.evaluate(() =>
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-10-04T12:00:00.000Z"))));
    await entry(page, first.uuid).locator(".ub-decision-record").click();
    await selected(page, first.uuid, answerText(first));
    const replaced = page.locator(".ub-decision-earlier-answer");
    await expect(replaced).toHaveText("Earlier answer. Replaced Oct 24, 2026; it no longer applies.");
    await calendarTime(replaced.locator("time"));
    await page.goto(new URL(`/${harness().workspace}/${owner.uuid}`, page.url()).href);
    await calendarTime(page.getByRole("region", { name: "Decisions" }).locator("time"));
  } finally { peer.close(); }
});

async function selected(page: Page, uuid: string, text: string): Promise<void> {
  await expect(entry(page, uuid).locator(".ub-decision-record")).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".ub-decision-timeline")).not.toContainText("viewing");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(editor(page)).toHaveText(text);
  await expect(entry(page, uuid).locator(".ub-decision-record-state")).toHaveText(await page.locator(".ub-decision-answer-header .ub-decision-answer-state").innerText());
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
  await activateControl(page.getByRole("button", { name: "Copy link", exact: true }), { touch });
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedTexts: string[] }).copiedTexts.at(-1))).toBe(`${new URL(page.url()).origin}${expected}`);
  return `${new URL(page.url()).origin}${expected}`;
}

async function archivedLink(link: Locator): Promise<void> {
  await expect(link).toHaveAttribute("data-doc-link-state", "archived");
  const style = await link.evaluate((element) => ({
    label: getComputedStyle(element, "::after").content,
    display: getComputedStyle(element, "::after").display,
    pillDecoration: getComputedStyle(element, "::after").textDecorationLine,
    decoration: getComputedStyle(element).textDecorationLine,
  }));
  expect(style.label).toBe('"archived"');
  expect(["inline-block", "block"]).toContain(style.display);
  expect(style.pillDecoration).toBe("none");
  expect(style.decoration).not.toContain("line-through");
  const title = link.locator(".ub-decision-rfc-title");
  if (await title.count() > 0) {
    expect(style.decoration).toBe("none");
    await expect(title).toHaveCSS("text-decoration-line", "underline");
    await expect(title).toHaveCSS("text-decoration-style", "dotted");
  }
}

async function bannerAction(action: Locator, touch: boolean): Promise<void> {
  await expect(action).toBeVisible();
  const layout = await action.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(element);
    const label = text.getBoundingClientRect();
    const banner = element.parentElement;
    const message = banner?.querySelector(":scope > span");
    if (banner === null || message === null || message === undefined) throw new Error("e2e: missing banner message");
    const messageBox = message.getBoundingClientRect();
    return {
      coarse: matchMedia("(any-pointer: coarse)").matches,
      height: box.height,
      labelCenter: label.top + label.height / 2,
      center: box.top + box.height / 2,
      sharesLine: Math.min(box.bottom, messageBox.bottom) > Math.max(box.top, messageBox.top),
    };
  });
  expect(layout.coarse).toBe(touch);
  expect(Math.abs(layout.labelCenter - layout.center)).toBeLessThanOrEqual(2);
  if (touch) expect(layout.height).toBeGreaterThanOrEqual(44);
  else {
    expect(layout.height).toBeLessThan(44);
    expect(layout.sharesLine).toBe(true);
  }
}

async function pillStyle(pill: Locator, pseudo = ""): Promise<Record<string, string>> {
  return pill.evaluate((element, pseudo) => {
    const style = getComputedStyle(element, pseudo || null);
    return Object.fromEntries([
      "background-color", "color", "border-top-color", "border-top-style", "border-top-width", "border-radius",
      "padding-top", "padding-right", "padding-bottom", "padding-left", "font-family", "font-size", "font-weight", "line-height",
    ].map(property => [property, style.getPropertyValue(property)]));
  }, pseudo);
}

async function answerHeader(page: Page, label: string, state: string): Promise<void> {
  const header = page.locator(".ub-decision-answer-header");
  await expect(header).toHaveCount(1);
  await expect(header).toHaveText(new RegExp(`^${label}\\s*(Alter decision)?$`));
  await expect(header.locator(".ub-decision-answer-caption, .ub-decision-attribution, time")).toHaveCount(0);
  await expect(header.locator(".ub-decision-answer-state")).toHaveText(label);
  await expect(header.locator(".ub-decision-answer-state")).toHaveAttribute("data-state", state);
  await expect(page.locator(".ub-decision-topic-state, .ub-decision-answer-label")).toHaveCount(0);
  const styles = await header.evaluate((element) => {
    const pill = element.querySelector(".ub-decision-answer-state");
    const mark = pill?.querySelector(".ub-decisions-mark");
    if (pill === null || mark === null || mark === undefined) throw new Error("e2e: missing answer state mark");
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
        font: pillStyle.fontFamily,
        uiFont: token("font-family", "var(--font-sans)"), neutral: token("color", "var(--muted-foreground)"),
        success: token("color", "var(--status-success)"), destructive: token("color", "var(--destructive)"),
        half: token("background-image", "linear-gradient(90deg, var(--muted-foreground) 50%, transparent 50%)"),
        amber: [token("color", "var(--brand)"), token("color", "var(--brand-ink)"), token("color", "var(--status-warning)"), token("color", "var(--status-warning-subtle)")],
      };
    } finally { probe.remove(); }
  });
  expect(styles.font).toBe(styles.uiFont);
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

async function headerLayout(page: Page): Promise<void> {
  const layout = await page.locator(".ub-decision-answer-header").evaluate((element) => {
    const state = element.querySelector(".ub-decision-answer-state");
    const pane = element.closest(".ub-document-pane");
    if (state === null || pane === null) throw new Error("e2e: missing answer header layout");
    const pill = state.getBoundingClientRect();
    const alter = element.querySelector("button")?.getBoundingClientRect() ?? null;
    return {
      pillTop: pill.top, pillBottom: pill.bottom, pillRight: pill.right,
      headerRight: element.getBoundingClientRect().right,
      alter: alter === null ? null : { left: alter.left, right: alter.right, top: alter.top, bottom: alter.bottom },
      headerWidth: element.clientWidth, headerScroll: element.scrollWidth,
      paneWidth: pane.clientWidth, paneScroll: pane.scrollWidth,
      pageWidth: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth,
    };
  });
  if (layout.alter !== null) {
    expect(Math.abs(layout.headerRight - layout.alter.right)).toBeLessThanOrEqual(2);
    expect(layout.alter.top >= layout.pillBottom || layout.alter.left >= layout.pillRight).toBe(true);
  }
  expect(layout.headerScroll).toBeLessThanOrEqual(layout.headerWidth + 1);
  expect(layout.paneScroll).toBeLessThanOrEqual(layout.paneWidth + 1);
  expect(layout.pageScroll).toBeLessThanOrEqual(layout.pageWidth + 1);
}

async function wrappedTitle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  const layout = await page.getByRole("textbox", { name: "Document title" }).evaluate((element) => ({
    width: element.clientWidth, scrollWidth: element.scrollWidth,
    height: element.clientHeight, scrollHeight: element.scrollHeight,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    titleBottom: element.getBoundingClientRect().bottom,
    answerTop: document.querySelector(".ub-decision-answer-header")?.getBoundingClientRect().top ?? 0,
  }));
  expect(layout.height).toBeGreaterThanOrEqual(2 * layout.lineHeight);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1);
  expect(layout.answerTop).toBeGreaterThan(layout.titleBottom);
}

test("decision title renames sync without approving answer changes", async ({ browser }) => {
  const writer = session();
  const owner = await create(writer, "Rename owner", "The related page's prose.");
  const first = await create(writer, "Original rename question", "Earlier answer.", { kind: "decision", status: "decided" });
  const current = await create(writer, undefined, "Approved answer.", {
    kind: "decision", status: "decided", supersedes: first.uuid, related: owner.uuid, answer: answer(),
  });
  const pending = await create(writer, undefined, "Pending proposal.", { kind: "decision", supersedes: current.uuid });
  const topicPath = `/${harness().workspace}/${first.uuid}`;
  const page = await openApp(browser, topicPath, { upstream: true });
  const reader = await openApp(browser, topicPath, { upstream: true });
  const title = page.getByRole("textbox", { name: "Document title" });
  await expect(title).toHaveValue(current.title);
  await expect(title).toBeEditable();
  await expect(page.locator(".ub-lifecycle-badge")).toHaveText("Decision");
  await expect(page.locator(".ub-decision-notice")).toContainText("Under review.");
  const renamed = `Clearer question ${current.uuid}`;
  await writer.call("pin_doc", { uuid: current.uuid, group: "Renamed topic" });
  try {
    await title.fill(renamed);
    await expect(reader.getByRole("textbox", { name: "Document title" })).toHaveValue(renamed);
    await expect(reader.locator(".ub-list").getByRole("button", { name: renamed, exact: true })).toBeVisible();
  } finally { await writer.call("unpin_doc", { uuid: current.uuid }); }
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: current.uuid }), doc => {
    expect(doc).toMatchObject({ title: renamed, approvalChanged: false });
  });
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: pending.uuid }), doc => {
    expect(doc.title).toBe(renamed);
  });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(editor(page)).toHaveText(answerText(current));

  await reader.goto(new URL(`/${harness().workspace}/${owner.uuid}`, reader.url()).href);
  await expect(reader.getByRole("region", { name: "Decisions" }).getByRole("link", { name: `Under review: ${renamed}`, exact: true })).toBeVisible();
  await reader.goto(new URL(`/${harness().workspace}/all`, reader.url()).href);
  await reader.getByRole("tab", { name: /^Decisions/ }).click();
  const row = reader.locator(".ub-docs-row").filter({ hasText: renamed });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText("Changed after approval");

  const mcpTitle = `MCP question ${current.uuid}`;
  await writer.call("set_metadata", { uuid: current.uuid, title: mcpTitle });
  await expect(title).toHaveValue(mcpTitle);
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: current.uuid }), doc => {
    expect(doc).toMatchObject({ approvalChanged: false });
  });

  const peer = await legacyDecisionPeer(harness(), current.uuid);
  try {
    const firstRoom = await peer.join(`${harness().workspaceUuid}/${first.uuid}`);
    await expect.poll(() => getMetaMap(firstRoom).get("title")).toBe(mcpTitle);
    expect(getMetaMap(peer.doc).get("title")).toBe(current.title);
    appendBlock(peer.doc, { type: "paragraph", text: "Changed answer from an older client." });
    peer.decide("decided");
    await expect.poll(async () => (await writer.call<StoredDoc>("get_doc", { uuid: current.uuid })).approvalChanged).toBe(true);
    const changedTitle = `Changed answer question ${current.uuid}`;
    await title.fill(changedTitle);
    await reader.getByRole("combobox", { name: "Decision state" }).selectOption("changed-after-approval");
    await expect(reader.locator(".ub-docs-row").filter({ hasText: changedTitle })).toHaveCount(1);
    await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: current.uuid }), doc => {
      expect(doc).toMatchObject({ title: changedTitle, approvalChanged: true });
    });
    await expect.poll(() => getMetaMap(firstRoom).get("title")).toBe(changedTitle);
    expect(getMetaMap(peer.doc).get("title")).toBe(current.title);
  } finally { peer.close(); }
});

async function timelineLayout(page: Page, selectedUuid: string, touch: boolean, truncated = false): Promise<void> {
  await expect(page.locator(".ub-decision-history > h2")).toHaveText("HISTORY");
  const layout = await page.locator(".ub-decision-timeline").evaluate((element) => {
    const pane = element.closest(".ub-document-pane");
    if (pane === null) throw new Error("e2e: missing timeline pane");
    const probe = document.createElement("span");
    probe.style.color = "var(--muted-foreground)";
    probe.style.backgroundColor = "var(--card-accent)";
    probe.style.fontFamily = "var(--font-sans)";
    element.append(probe);
    try {
      const rows = [...element.querySelectorAll<HTMLLIElement>(":scope > li")].map((row) => {
        const record = row.querySelector<HTMLAnchorElement>(".ub-decision-record");
        const date = row.querySelector(".ub-decision-record-date");
        const count = row.querySelector(".ub-decision-record-comments");
        const preview = row.querySelector(".ub-decision-preview");
        const event = row.querySelector(".ub-decision-event");
        const linked = row.querySelector(".ub-decision-linked");
        const dot = row.querySelector(".ub-decision-rail-dot");
        const pill = row.querySelector(".ub-decision-record-state");
        if (record === null || date === null || dot === null || pill === null) throw new Error("e2e: incomplete timeline row");
        const style = getComputedStyle(row);
        const box = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight,
          };
        };
        const eventText = document.createRange();
        if (event !== null) eventText.selectNodeContents(event);
        const lines = [...row.querySelectorAll(".ub-decision-record-line, .ub-decision-preview, .ub-decision-record-rfc .ub-doclink, .ub-decision-rfc-title")].map((line) => ({
          whiteSpace: getComputedStyle(line).whiteSpace,
          flexWrap: getComputedStyle(line).flexWrap,
          height: line.getBoundingClientRect().height,
          rfc: line.matches(".ub-doclink"),
          record: line.matches(".ub-decision-record-line"),
          left: line.getBoundingClientRect().left, right: line.getBoundingClientRect().right,
        }));
        return {
          uuid: row.dataset.record, selected: row.dataset.selected, state: row.dataset.state,
          previewColor: preview === null ? null : getComputedStyle(preview).color,
          fill: style.backgroundColor, borderStyle: style.borderTopStyle, borderWidth: style.borderTopWidth,
          outline: style.outlineStyle, rowHeight: row.getBoundingClientRect().height,
          dateFont: getComputedStyle(date).fontFamily,
          dateFigures: getComputedStyle(date).fontVariantNumeric,
          countFont: count === null ? null : getComputedStyle(count).fontFamily,
          countFigures: count === null ? null : getComputedStyle(count).fontVariantNumeric,
          dot: box(dot), pill: box(pill), date: box(date),
          count: count === null ? null : box(count), linked: linked === null ? null : box(linked),
          event: event === null ? null : {
            ...box(event), color: getComputedStyle(event).color, font: getComputedStyle(event).fontFamily,
            fragments: [...eventText.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })),
          },
          nestedLinks: record.querySelectorAll("a").length,
          width: row.clientWidth, scroll: row.scrollWidth, lines,
        };
      });
      return {
        rows, accent: getComputedStyle(probe).backgroundColor, muted: getComputedStyle(probe).color,
        font: getComputedStyle(probe).fontFamily,
        wide: element.clientWidth > 34 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        width: element.clientWidth, scroll: element.scrollWidth,
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        paneWidth: pane.clientWidth, paneScroll: pane.scrollWidth,
        pageWidth: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth,
      };
    } finally { probe.remove(); }
  });
  const chosen = layout.rows.find((row) => row.uuid === selectedUuid);
  expect(chosen?.selected).toBe("true");
  expect(chosen?.fill).toBe(layout.accent);
  expect(chosen?.borderStyle).toBe("solid");
  expect(Number.parseFloat(chosen?.borderWidth ?? "0")).toBeGreaterThan(0);
  expect(chosen?.outline).toBe("none");
  for (const row of layout.rows) {
    expect(row.nestedLinks).toBe(0);
    const pillCenter = (row.pill.top + row.pill.bottom) / 2;
    expect(Math.abs((row.dot.top + row.dot.bottom) / 2 - pillCenter)).toBeLessThanOrEqual(1);
    if (layout.wide) {
      expect(Math.abs((row.date.top + row.date.bottom) / 2 - pillCenter)).toBeLessThanOrEqual(1);
      if (row.count !== null) expect(Math.abs((row.count.top + row.count.bottom) / 2 - pillCenter)).toBeLessThanOrEqual(1);
    }
    expect(row.dateFont).toBe(layout.font);
    expect(row.dateFigures).toBe("tabular-nums");
    if (row.countFont !== null) {
      expect(row.countFont).toBe(layout.font);
      expect(row.countFigures).toBe("tabular-nums");
    }
    if (touch) expect(row.rowHeight).toBeGreaterThanOrEqual(44);
    if (["superseded", "rejected", "withdrawn"].includes(row.state ?? "") && row.previewColor !== null) expect(row.previewColor).toBe(layout.muted);
    if (row.event !== null) {
      expect(row.event.color).toBe(layout.muted);
      expect(row.event.font).toBe(layout.font);
      expect(row.event.scrollWidth).toBeLessThanOrEqual(row.event.width + 1);
      expect(row.event.scrollHeight).toBeLessThanOrEqual(row.event.height + 1);
      expect(row.event.fragments.length).toBeGreaterThan(0);
      for (const fragment of row.event.fragments) {
        expect(fragment.left).toBeGreaterThanOrEqual(row.event.left - 1);
        expect(fragment.right).toBeLessThanOrEqual(row.event.right + 1);
        expect(fragment.top).toBeGreaterThanOrEqual(row.event.top - 1);
        expect(fragment.bottom).toBeLessThanOrEqual(row.event.bottom + 1);
      }
      expect(Math.abs((row.event.fragments.at(-1)?.right ?? 0) - row.event.right)).toBeLessThanOrEqual(2);
      for (const other of [row.count, row.linked]) {
        if (other === null) continue;
        expect(other.right).toBeGreaterThan(other.left);
        expect(other.bottom).toBeGreaterThan(other.top);
        expect(other.scrollWidth).toBeLessThanOrEqual(other.width + 1);
        expect(other.scrollHeight).toBeLessThanOrEqual(other.height + 1);
        expect(other.left).toBeGreaterThanOrEqual(layout.left - 1);
        expect(other.right).toBeLessThanOrEqual(layout.right + 1);
        expect(row.event.right <= other.left || row.event.left >= other.right || row.event.bottom <= other.top || row.event.top >= other.bottom).toBe(true);
      }
    }
    expect(row.scroll).toBeLessThanOrEqual(row.width + 1);
    for (const line of row.lines) {
      if (line.rfc) expect(line.flexWrap).toBe("nowrap");
      else if (line.record) expect(line.flexWrap).toBe("wrap");
      else expect(line.whiteSpace).toBe("nowrap");
      if (touch && line.rfc) expect(line.height).toBeGreaterThanOrEqual(44);
      expect(line.left).toBeGreaterThanOrEqual(layout.left - 1);
      expect(line.right).toBeLessThanOrEqual(layout.right + 1);
    }
  }
  if (truncated) {
    expect(layout.rows.some((row) => row.event !== null && row.event.fragments.length > 1)).toBe(true);
    const preview = entry(page, selectedUuid).locator(".ub-decision-preview");
    const rfc = entry(page, selectedUuid).locator(".ub-decision-rfc-title");
    await expect(preview).toHaveCSS("text-overflow", "ellipsis");
    await expect(rfc).toHaveCSS("text-overflow", "ellipsis");
    expect(await preview.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await rfc.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await archivedLink(entry(page, selectedUuid).locator(".ub-decision-record-rfc .ub-doclink"));
  }
  expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
  expect(layout.paneScroll).toBeLessThanOrEqual(layout.paneWidth + 1);
  expect(layout.pageScroll).toBeLessThanOrEqual(layout.pageWidth + 1);
}

async function timelineRail(page: Page, states: string[], inForce: number | null): Promise<void> {
  const rows = page.locator(".ub-decision-timeline > li");
  expect(await rows.evaluateAll((entries) => entries.map((row) => (row as HTMLElement).dataset.state))).toEqual(states);
  const rail = await rows.evaluateAll((entries) => entries.map((row) => {
    const dot = row.querySelector(".ub-decision-rail-dot");
    if (dot === null) throw new Error("e2e: missing timeline dot");
    const probe = document.createElement("span");
    row.append(probe);
    const token = (value: string): string => { probe.style.color = value; return getComputedStyle(probe).color; };
    try {
      const style = getComputedStyle(dot);
      return {
        above: getComputedStyle(row, "::before").backgroundColor,
        below: getComputedStyle(row, "::after").backgroundColor,
        fill: style.backgroundColor, border: style.borderTopColor, borderStyle: style.borderTopStyle,
        width: Number.parseFloat(style.width), ring: style.boxShadow, radius: style.borderRadius,
        success: token("var(--status-success)"), grey: token("var(--muted-foreground)"), destructive: token("var(--destructive)"), ground: token("var(--background)"),
      };
    } finally { probe.remove(); }
  }));
  for (const [index, row] of rail.entries()) {
    const state = states[index];
    if (index > 0) expect(row.above).toBe(inForce !== null && index <= inForce ? row.success : row.grey);
    if (index < rail.length - 1) expect(row.below).toBe(inForce !== null && index < inForce ? row.success : row.grey);
    if (index === inForce) {
      expect(row.fill).toBe(row.success);
      expect(row.ring).not.toBe("none");
    } else if (state === "under-review") {
      expect(row.fill).toBe(row.ground);
      expect(row.borderStyle).toBe("solid");
    } else if (state === "not-yet-decided" || state === "open-proposal") expect(row.borderStyle).toBe("dashed");
    else if (state === "rejected") {
      expect(row.fill).toBe(row.ground);
      expect(row.border).toBe(row.destructive);
    } else if (state === "superseded" || state === "withdrawn") {
      expect(row.fill).toBe(row.grey);
      if (inForce !== null) expect(row.width).toBeLessThan(rail[inForce]?.width ?? 0);
    } else if (state === "conflict") {
      expect(row.fill).toBe(row.destructive);
      expect(row.radius).toBe("2px");
    }
  }
}

for (const { touch, appearance } of [
  { touch: false, appearance: "light" }, { touch: false, appearance: "dark" },
  { touch: true, appearance: "light" }, { touch: true, appearance: "dark" },
] as const) {
  test(`archived prose, table and sidebar pills preserve labels on ${touch ? "iPad touch @webkit-touch" : "desktop keyboard and pointer"} in ${appearance}`, async ({ browser }) => {
    const writer = session();
    const target = await create(writer, "Archived title that must truncate before its marker ".repeat(5), "The archived target remains readable.");
    const source = await create(writer, "Archived reference fixture", "", { blocks: [
      { type: "paragraph", inline: [{ text: "prose reference", marks: { docLink: target.uuid } }] },
      { type: "table", text: `| Reference |\n| --- |\n| [table reference](${target.uuid}) |` },
    ] });
    await writer.call("archive_doc", { uuid: target.uuid });
    const { group } = await writer.call<{ group: { id: string; name: string } }>("pin_doc", { uuid: target.uuid, group: "Archived markers" });
    try {
      const page = await openApp(browser, `/${harness().workspace}/${source.uuid}`, {
        upstream: true,
        contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: appearance },
      });
      const prose = editor(page).locator(":scope > p .ub-doclink");
      const cell = editor(page).locator(".ub-table td .ub-doclink");
      for (const link of [prose, cell]) {
        await archivedLink(link);
        await expect(link).toHaveAttribute("title", "This document is archived. The link opens it read-only.");
        await expect(link).toHaveCSS("text-decoration-style", "dotted");
      }
      await expect(prose).toHaveText("prose reference");
      await expect(cell).toHaveText("table reference");
      const commonStyle = await pillStyle(prose, "::after");
      expect(await pillStyle(cell, "::after")).toEqual(commonStyle);
      const neutral = await prose.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--muted-foreground)";
        probe.style.backgroundColor = "var(--muted)";
        element.append(probe);
        try { return { ink: getComputedStyle(probe).color, fill: getComputedStyle(probe).backgroundColor }; }
        finally { probe.remove(); }
      });
      expect(commonStyle.color).toBe(neutral.ink);
      expect(commonStyle["background-color"]).toBe(neutral.fill);
      const proseReadings = (await renderedText(page, ".ub-editor .ProseMirror")).filter(reading => reading.where.endsWith("::after"));
      expect(proseReadings).toHaveLength(2);
      for (const reading of proseReadings) expect(reading.ratio, reading.where).toBeGreaterThanOrEqual(4.5);
      await setNativeSelection(prose, () => prose.evaluate((element) => {
        const root = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
        root.focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return {
          anchor: root.editor.view.posAtDOM(element, 0),
          head: root.editor.view.posAtDOM(element, element.childNodes.length),
        };
      }));
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("prose reference");
      const copied = await editor(page).evaluate((element) => {
        const clipboard = new DataTransfer();
        element.dispatchEvent(new ClipboardEvent("copy", { clipboardData: clipboard, bubbles: true, cancelable: true }));
        return {
          text: clipboard.getData("text/plain"),
          htmlText: new DOMParser().parseFromString(clipboard.getData("text/html"), "text/html").body.textContent,
        };
      });
      expect(copied.text).toBe("prose reference");
      expect(copied.htmlText).toBe("prose reference");
      for (const link of [prose, cell]) {
        await activateControl(link, { touch });
        await expect(page).toHaveURL(new RegExp(`/${target.uuid}$`));
        await expect(page.locator(".ub-archived-banner")).toBeVisible();
        await expect(editor(page)).toHaveAttribute("contenteditable", "false");
        await expect(editor(page)).toHaveText(answerText(target));
        await page.goBack();
        await expect(prose).toBeVisible();
      }
      const show = page.getByRole("button", { name: "Show document list", exact: true });
      if (await show.isVisible()) await activateControl(show, { touch });
      const pin = page.locator(".ub-pin-row > button").filter({ hasText: target.title });
      const pill = pin.locator(".ub-archived");
      await expect(pill).toHaveText("archived");
      await expect(pill).toBeVisible();
      expect(await pillStyle(pill)).toEqual(commonStyle);
      const layout = await pin.evaluate((element) => {
        const title = element.querySelector(".ub-pin-title");
        const marker = element.querySelector(".ub-archived");
        if (title === null || marker === null) throw new Error("e2e: missing archived pin label");
        const row = element.getBoundingClientRect();
        const titleBox = title.getBoundingClientRect();
        const markerBox = marker.getBoundingClientRect();
        return {
          truncated: title.scrollWidth > title.clientWidth,
          ellipsis: getComputedStyle(title).textOverflow,
          titleRight: titleBox.right, pillLeft: markerBox.left, pillRight: markerBox.right, rowRight: row.right,
        };
      });
      expect(layout.truncated).toBe(true);
      expect(layout.ellipsis).toBe("ellipsis");
      expect(layout.pillLeft).toBeGreaterThanOrEqual(layout.titleRight);
      expect(layout.pillRight).toBeLessThanOrEqual(layout.rowRight);
      const pinReadings = (await renderedText(page, ".ub-pin-row")).filter(reading => reading.where.includes(".ub-archived"));
      expect(pinReadings.length).toBeGreaterThan(0);
      for (const reading of pinReadings) expect(reading.ratio, reading.where).toBeGreaterThanOrEqual(4.5);
      await pin.screenshot({
        path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `archived-pin-${test.info().project.name}-${touch ? "ipad" : "desktop"}-${appearance}.png`),
      });
      await activateControl(pin, { touch });
      await expect(page).toHaveURL(new RegExp(`/${target.uuid}$`));
      await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    } finally {
      await writer.call("sidebar_group", { action: "delete", group: group.id });
    }
  });

  test(`decision record archive and restore preserve the topic on ${touch ? "iPad touch @webkit-touch" : "desktop keyboard and pointer"} in ${appearance}`, async ({ browser }) => {
    const writer = session();
    const first = await create(writer, "Record archive topic", "Original answer to retain.", { kind: "decision", status: "decided" });
    const current = await create(writer, "Record archive topic", "Current answer stays in force.", {
      kind: "decision", status: "decided", supersedes: first.uuid, answer: answer(),
    });
    const proposal = await create(writer, "Record archive topic", "An open replacement proposal.", {
      kind: "decision", supersedes: current.uuid,
    });
    const page = await openApp(browser, `/${harness().workspace}/${first.uuid}`, {
      upstream: true,
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: appearance },
    });
    await selected(page, current.uuid, answerText(current));
    const actions = page.getByRole("button", { name: "Document actions", exact: true });
    await activateControl(actions, { touch });
    await expect(page.getByRole("menuitem", { name: "Archive this record unavailable — it is the decision in force", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("menuitem", { name: "Archive topic", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await activateControl(entry(page, first.uuid).locator(".ub-decision-record"), { touch });
    await activateControl(actions, { touch });
    const archiveItem = page.getByRole("menuitem", { name: "Archive this record", exact: true });
    if (touch) await activateControl(archiveItem, { touch });
    else { await archiveItem.focus(); await page.keyboard.press("Enter"); }
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Archive this record?", exact: true })).toBeVisible();
    await expect(dialog).toContainText("It leaves this topic's history. Links to it show it as archived, and you can restore it from there.");
    await activateControl(dialog.getByRole("button", { name: "Archive", exact: true }), { touch });
    await selected(page, current.uuid, answerText(current));
    await expect(entry(page, first.uuid)).toHaveCount(0);
    await expect(page.locator(".ub-archived-banner")).toHaveCount(0);
    await activateControl(page.getByRole("button", { name: "Undo", exact: true }), { touch });
    await expect(entry(page, first.uuid)).toHaveCount(1);
    await activateControl(entry(page, first.uuid).locator(".ub-decision-record"), { touch });
    await activateControl(actions, { touch });
    await activateControl(archiveItem, { touch });
    await activateControl(dialog.getByRole("button", { name: "Archive", exact: true }), { touch });
    await selected(page, current.uuid, answerText(current));
    await page.goto(new URL(`/${harness().workspace}/${first.uuid}/record/${first.uuid}`, page.url()).href);
    await expect(editor(page)).toHaveText(answerText(first));
    await expect(page.locator(".ub-archived-banner")).toBeVisible();
    await answerHeader(page, "Superseded", "superseded");
    await expect(page.locator(".ub-decision-earlier-answer")).toContainText("it no longer applies.");
    await activateControl(page.getByRole("button", { name: "Restore", exact: true }), { touch });
    await expect(entry(page, first.uuid)).toHaveCount(1);
    await activateControl(entry(page, proposal.uuid).locator(".ub-decision-record"), { touch });
    await activateControl(actions, { touch });
    await activateControl(page.getByRole("menuitem", { name: "Archive this record", exact: true }), { touch });
    await activateControl(dialog.getByRole("button", { name: "Archive", exact: true }), { touch });
    await selected(page, current.uuid, answerText(current));
    await expect(page.locator(".ub-decision-notice")).toHaveCount(0);
    await expectMcp(() => writer.call<{ docs: { uuid: string }[] }>("list_docs", { kind: "decision", include_superseded: true }), result => {
      expect(result.docs.some(record => record.uuid === proposal.uuid)).toBe(false);
    });
    await page.goto(new URL(`/${harness().workspace}/${proposal.uuid}`, page.url()).href);
    await expect(page).toHaveURL(new URL(`/${harness().workspace}/${first.uuid}/record/${proposal.uuid}`, page.url()).href);
    await expect(editor(page)).toHaveText(answerText(proposal));
    await expect(page.locator(".ub-archived-banner")).toBeVisible();
    await answerHeader(page, "Open proposal", "open-proposal");
    await expect(entry(page, proposal.uuid)).toHaveCount(0);
    await activateControl(page.getByRole("button", { name: "Restore", exact: true }), { touch });
    await selected(page, proposal.uuid, answerText(proposal));
    await expect(page.locator(".ub-archived-banner")).toHaveCount(0);
  });

  test(`decision title control stays editable only on the current record on ${touch ? "iPad touch @webkit-touch" : "desktop keyboard and pointer"} in ${appearance}`, async ({ browser }) => {
    const writer = session();
    const first = await create(writer, "May technical pull requests be integrated without a linked issue?", "Earlier answer.", { kind: "decision", status: "decided" });
    const current = await create(writer, undefined, "Approved answer.", {
      kind: "decision", status: "decided", supersedes: first.uuid, answer: answer(),
    });
    const page = await openApp(browser, `/${harness().workspace}/${first.uuid}`, {
      upstream: true,
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: appearance },
    });
    const title = page.getByRole("textbox", { name: "Document title" });
    await expect(title).toHaveValue(current.title);
    await expect(title).toBeEditable();
    await wrappedTitle(page);
    await expect(page.locator(".ub-lifecycle-badge")).toHaveText("Decision");
    if (touch) await title.tap();
    else {
      await title.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(title).toBeFocused();
    }
    await title.fill("Clearer question");
    const shortHeight = await title.evaluate((element) => element.getBoundingClientRect().height);
    const renamed = "May technical pull requests be integrated without a linked issue and without losing the recorded answer approval?";
    await title.fill(renamed);
    await expect(title).toHaveValue(renamed);
    await wrappedTitle(page);
    expect(await title.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(shortHeight);
    await title.press("Enter");
    await title.press("Shift+Enter");
    await expect(title).toHaveValue(renamed);
    await title.fill("May technical pull requests be integrated\n without a linked issue and without losing the recorded answer approval?");
    await expect(title).toHaveValue(renamed);
    await activateControl(entry(page, first.uuid).locator(".ub-decision-record"), { touch });
    await expect(title).toHaveValue(renamed);
    await expect(title).not.toBeEditable();
    await wrappedTitle(page);
    await expect(page.locator(".ub-lifecycle-badge")).toHaveText("Decision");
    await activateControl(page.getByRole("link", { name: "Go to the current answer", exact: true }), { touch });
    await expect(title).toBeEditable();
    await writer.call("archive_doc", { uuid: first.uuid });
    await expect(title).not.toBeEditable();
    await wrappedTitle(page);
    await activateControl(title, { touch });
    await title.evaluate((element) => (element as HTMLTextAreaElement).select());
    expect(await title.evaluate((element) => (element as HTMLTextAreaElement).selectionEnd)).toBe((await title.inputValue()).length);
  });

  test(`decision topic history, links and comments on ${touch ? "iPad touch @webkit-touch" : "desktop keyboard and pointer"} in ${appearance}`, async ({ browser }) => {
    const writer = session();
    const longRecordedName = "Alexandra Margaret ConstantinopoulosSzymanskiVanderbergMontgomeryFeatherstone (alexandra-workspace-member)";
    const formerOwner = await create(writer, "Former related page", "Previous guidance.");
    const owner = await create(writer, "Current related page", "Current guidance remains readable when archived.");
    const firstRfc = await create(writer, "Original answer RFC", "Discuss the original answer here.");
    const currentRfc = await create(writer, "Current answer RFC", "Discuss the current answer here.");
    const rfc = await create(writer, "Replacement RFC", "Discuss the proposed replacement here.");
    const first = await create(writer, "Initial topic title", "Earlier answer remains available as history.", {
      kind: "decision", status: "decided", related: formerOwner.uuid, discussion: firstRfc.uuid, answer: answer(longRecordedName),
    });
    await writer.call("pin_doc", { uuid: first.uuid, group: "Reading" });
    const current = await create(writer, undefined, "Current answer stays in force during review. Keep the embedded database in the hub process so each workspace remains portable, backups remain straightforward, and readers can inspect the same durable answer while the proposed replacement is discussed.", {
      kind: "decision", status: "decided", supersedes: first.uuid, related: owner.uuid, discussion: currentRfc.uuid, answer: answer("Recorded answerer"),
    });
    const rejected = await create(writer, undefined, "Rejected answer remains available as history.", {
      kind: "decision", supersedes: current.uuid, discussion: firstRfc.uuid,
    });
    await writer.call("set_status", { uuid: rejected.uuid, status: "rejected", answer: answer("Recorded rejecter"), reason: "The proposal does not meet the constraint." });
    const withdrawn = await create(writer, undefined, "Withdrawn answer remains available as history.", {
      kind: "decision", supersedes: current.uuid,
    });
    await writer.call("set_status", { uuid: withdrawn.uuid, status: "withdrawn" });
    const pending = await create(writer, undefined, "Pending answer remains an open proposal.", {
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
    await expect(page.getByRole("textbox", { name: "Document title" })).toHaveValue("Initial topic title");
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
    await headerLayout(page);
    await expect(entry(page, first.uuid)).toContainText("Linked record");
    await expect(page.locator(".ub-decision-timeline > li")).toHaveCount(5);
    await expect(page.locator(".ub-decision-record-state")).toHaveText(["Under review", "Withdrawn", "Rejected", "In force", "Superseded"]);
    await expect(entry(page, rejected.uuid).getByLabel("1 comment", { exact: true })).toHaveText("1");
    await expect(entry(page, pending.uuid).locator(".ub-decision-record-comments")).toHaveCount(0);
    await expect(entry(page, rejected.uuid).locator(".ub-decision-event")).toHaveText("Recorded rejecter");
    await expect(entry(page, current.uuid).locator(".ub-decision-event")).toHaveText("Recorded answerer");
    await expect(entry(page, first.uuid).locator(".ub-decision-event")).toHaveText(longRecordedName);
    await expect(entry(page, first.uuid).getByRole("link", { name: longRecordedName })).toHaveAttribute("href", firstPath);
    await expect(entry(page, rejected.uuid).getByRole("link", { name: "Recorded rejecter" })).toHaveAttribute("href", rejectedPath);
    await expect(entry(page, pending.uuid).locator(".ub-decision-event")).toHaveCount(0);
    await expect(entry(page, withdrawn.uuid).locator(".ub-decision-event")).toHaveCount(0);
    await expect(entry(page, current.uuid).locator("time")).toHaveAttribute("datetime", "2026-10-04T12:00:00.000Z");
    await expect(entry(page, current.uuid).locator("time")).toHaveAttribute("title", await page.evaluate(() =>
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-10-04T12:00:00.000Z"))));
    await timelineRail(page, ["under-review", "withdrawn", "rejected", "in-force", "superseded"], 3);
    await timelineLayout(page, current.uuid, touch);
    await expect(page.locator(`.ub-document-pane a[href$="/${owner.uuid}"], .ub-document-pane a[href$="/${formerOwner.uuid}"]`)).toHaveCount(0);
    await archivedLink(page.locator(".ub-decision-notice a"));
    await bannerAction(page.locator(".ub-decision-notice a"), touch);
    await archivedLink(entry(page, pending.uuid).locator(".ub-doclink"));
    const historyRfc = entry(page, current.uuid).locator(".ub-decision-record-rfc a");
    await expect(historyRfc.locator(".ub-decision-rfc-title")).toHaveText(currentRfcTitle);
    await archivedLink(historyRfc);
    expect(await pillStyle(historyRfc, "::after")).toEqual(await pillStyle(page.locator(".ub-decision-notice a"), "::after"));
    expect(await pillStyle(page.locator(".ub-decision-rfc a"), "::after")).toEqual(await pillStyle(historyRfc, "::after"));
    await expect(entry(page, rejected.uuid).locator(".ub-decision-record-rfc a")).toHaveText("Original answer RFC");
    await rfcLayout(page);
    await copyPath(page, topicPath, touch);
    await page.screenshot({
      path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `decision-topic-${test.info().project.name}-${touch ? "ipad" : "desktop"}-${appearance}.png`), fullPage: true,
    });
    await page.locator(".ub-decision-history").screenshot({
      path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `decision-topic-${test.info().project.name}-${touch ? "ipad" : "desktop"}-${appearance}-timeline.png`),
    });
    const column = page.locator(".ub-document-pane > .ub-column");
    await column.evaluate((element) => { (element as HTMLElement).style.inlineSize = "18rem"; });
    await headerLayout(page);
    await rfcLayout(page);
    await timelineLayout(page, current.uuid, touch, true);
    await page.screenshot({
      path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `decision-topic-${test.info().project.name}-${touch ? "ipad" : "desktop"}-${appearance}-narrow.png`), fullPage: true,
    });
    await page.locator(".ub-decision-history").screenshot({
      path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `decision-topic-${test.info().project.name}-${touch ? "ipad" : "desktop"}-${appearance}-timeline-narrow.png`),
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
    const firstRfcLink = entry(page, first.uuid).locator(".ub-decision-record-rfc a");
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
    await headerLayout(page);
    const replacementAge = await entry(page, current.uuid).locator("time").textContent();
    await expect(page.locator(".ub-decision-earlier-answer")).toContainText(`Earlier answer. Replaced ${replacementAge}; it no longer applies.`);
    await expect(page.getByRole("link", { name: "Go to the current answer", exact: true })).toBeVisible();
    await bannerAction(page.getByRole("link", { name: "Go to the current answer", exact: true }), touch);
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
    await selectedRfc(page, firstRfc, "Original answer RFC");
    await answerHeader(page, "Rejected", "rejected");
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
    await expect(page.locator(".ub-decision-notice")).toHaveCount(0);
    await expect(page.locator(".ub-decision-answer-history")).toBeVisible();
    await activateControl(page.getByRole("link", { name: "Go to the current answer", exact: true }), { touch });
    await selected(page, current.uuid, answerText(current));

    await activateControl(entry(page, withdrawn.uuid).locator(".ub-decision-record"), { touch });
    await selected(page, withdrawn.uuid, answerText(withdrawn));
    await selectedRfc(page, null);
    await answerHeader(page, "Withdrawn", "withdrawn");
    await expect(page.locator(".ub-decision-answer-history")).toBeVisible();
    await activateControl(page.getByRole("link", { name: "Go to the current answer", exact: true }), { touch });
    await selected(page, current.uuid, answerText(current));

    await activateControl(entry(page, pending.uuid).locator(".ub-decision-record-rfc a"), { touch });
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
    await expect(page.getByRole("textbox", { name: "Document title" })).not.toBeEditable();
    await expect(page.getByRole("button", { name: "Insert block below", includeHidden: true })).toHaveCount(0);
    await page.goto(new URL(firstPath, page.url()).href);
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
  await timelineRail(page, ["not-yet-decided"], null);
  await expect(page.locator(".ub-decision-notice")).toHaveText("Open proposal");
  await expect(page.locator(".ub-decision-answer-history")).toBeVisible();
  await activateControl(page.locator(".ub-decision-notice a"));
  await expect(editor(page)).toHaveText(answerText(rfc));

  const stance = await create(writer, "An initial stance", "Initial agent answer.", { kind: "decision", status: "decided" });
  await page.goto(new URL(`/${harness().workspace}/${stance.uuid}`, page.url()).href);
  await selected(page, stance.uuid, answerText(stance));
  await selectedRfc(page, null);
  await answerHeader(page, "Agent stance", "agent-stance");
  await timelineRail(page, ["agent-stance"], 0);
  await expect(entry(page, stance.uuid).locator(".ub-decision-event")).toHaveCount(0);
  await expect(entry(page, stance.uuid).locator("time")).toHaveCount(1);
  await expect(page.locator(".ub-decision-answer-header").getByText("Agent stance", { exact: true })).toHaveCount(1);
  const left = await create(writer, undefined, "The first conflicting answer.", {
    kind: "decision", status: "decided", supersedes: stance.uuid, discussion: rfc.uuid, answer: answer("First answerer"),
  });
  const right = await create(writer, undefined, "The second conflicting answer.", {
    kind: "decision", status: "decided", supersedes: stance.uuid, answer: answer("Second answerer"),
  });
  await expect(page.locator(".ub-decision-notice")).toContainText("Nothing is in force.");
  await selected(page, right.uuid, answerText(right));
  await selectedRfc(page, null);
  await answerHeader(page, "Conflicting answer", "conflict");
  await expect(page.locator(".ub-decision-record-state")).toHaveText(["Conflicting answer", "Conflicting answer", "Superseded"]);
  await timelineRail(page, ["conflict", "conflict", "superseded"], null);
  await expect(entry(page, stance.uuid).locator(".ub-decision-event")).toHaveText("Agent stance, never confirmed");
  await activateControl(entry(page, left.uuid).locator(".ub-decision-record"));
  await selected(page, left.uuid, answerText(left));
  await selectedRfc(page, rfc, "First topic RFC");
  await expect(page.getByRole("link", { name: "Go to the current answer", exact: true })).toHaveCount(0);
  const pending = await create(writer, undefined, "An alternative while neither answer is in force.", {
    kind: "decision", supersedes: stance.uuid,
  });
  await expect(entry(page, pending.uuid)).toBeVisible();
  await timelineRail(page, ["open-proposal", "conflict", "conflict", "superseded"], null);
  await activateControl(entry(page, pending.uuid).locator(".ub-decision-record"));
  await answerHeader(page, "Open proposal", "open-proposal");
});
