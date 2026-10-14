import { createRequire } from "node:module";
import { join } from "node:path";
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { roomForDoc } from "@uberblick/schema";
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
    statePrefix: "uberblick-e2e-decisions-block-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc {
  uuid: string;
  blocks: Array<{ id: string; text: string }>;
  decisions?: Array<{ topic: string; relation: "related" | "linked" }>;
}

function session(): McpSession {
  if (agent === null) throw new Error("e2e: the MCP agent is not configured");
  return agent.open({ name: "decisions-block-e2e" });
}

function answer(who = "Ben (@bk-one)", when = new Date(Date.now() - 5 * 86_400_000).toISOString()) {
  return { who, when, where: "https://example.org/team/decision" };
}

async function create(writer: McpSession, title: string, text: string, fields: Record<string, unknown> = {}): Promise<StoredDoc> {
  return writer.call<StoredDoc>("create_doc", {
    title, description: "Browser acceptance fixture.", blocks: [{ type: "paragraph", text }], ...fields,
  });
}

function block(page: Page): Locator {
  return page.getByRole("region", { name: "Decisions", exact: true });
}

function row(page: Page, state: string, question: string): Locator {
  return block(page).getByRole("link", { name: `${state}: ${question}`, exact: true });
}

async function absent(page: Page): Promise<void> {
  await expect(block(page)).toHaveCount(0);
  await expect(page.locator(".ub-decisions-link")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Decisions", exact: true })).toHaveCount(0);
}

// Decode with the provider's own dependency, as the other protocol probes do.
const providerBuild = createRequire(import.meta.url).resolve("@hocuspocus/provider");
const decoding = createRequire(providerBuild)("lib0/decoding") as {
  createDecoder: (data: Uint8Array) => object;
  readVarString: (decoder: object) => string;
};

async function observeRooms(page: Page, rooms: Set<string>): Promise<void> {
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      if (typeof frame.payload === "string") return;
      rooms.add(decoding.readVarString(decoding.createDecoder(frame.payload)));
    });
  });
}

async function jumpFromHeader(page: Page, touch: boolean): Promise<void> {
  const link = page.locator(".ub-decisions-link");
  if (touch) await link.tap();
  else {
    await link.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
  }
  await expect(block(page)).toBeFocused();
  await expectBlockInView(page);
}

async function expectBlockInView(page: Page): Promise<void> {
  await expect(block(page)).toBeInViewport();
  await expect(block(page).getByRole("heading", { name: "Decisions", exact: true })).toBeInViewport({ ratio: 1 });
}

async function geometry(page: Page) {
  return block(page).evaluate((element) => {
    const pane = element.closest<HTMLElement>(".ub-document-pane");
    const host = document.querySelector<HTMLElement>(".ub-editor");
    if (pane === null || host === null) throw new Error("e2e: missing document reading column");
    return {
      inEditor: element.closest(".ub-editor") !== null,
      afterEditor: Boolean(host.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
      editorBottom: host.getBoundingClientRect().bottom,
      blockTop: element.getBoundingClientRect().top,
      paneWidth: pane.clientWidth,
      paneScrollWidth: pane.scrollWidth,
      blockWidth: element.clientWidth,
      blockScrollWidth: element.scrollWidth,
    };
  });
}

async function expectChromeStyles(page: Page): Promise<void> {
  const styles = await block(page).evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    element.append(probe);
    const token = (property: string, value: string): string => {
      probe.style.setProperty(property, value);
      return getComputedStyle(probe).getPropertyValue(property);
    };
    try {
      const caption = element.querySelector(".ub-decisions-heading h2");
      const mark = (state: string) => {
        const node = element.querySelector(`.ub-decisions-row[data-state="${state}"] .ub-decisions-mark`);
        if (node === null) throw new Error(`e2e: missing ${state} state mark`);
        const style = getComputedStyle(node);
        return { fill: style.backgroundColor, border: style.borderTopColor, image: style.backgroundImage };
      };
      if (caption === null) throw new Error("e2e: missing Decisions caption");
      const container = getComputedStyle(element);
      const heading = getComputedStyle(caption);
      return {
        fill: container.backgroundColor,
        card: token("background-color", "var(--card)"),
        page: token("background-color", "var(--background)"),
        borders: [container.borderTopWidth, container.borderRightWidth, container.borderBottomWidth, container.borderLeftWidth],
        radius: container.borderRadius,
        tokenRadius: token("border-radius", "var(--radius)"),
        font: heading.fontFamily,
        uiFont: token("font-family", "var(--font-sans)"),
        uppercase: heading.textTransform,
        letterSpacing: Number.parseFloat(heading.letterSpacing),
        captionSize: Number.parseFloat(heading.fontSize),
        separators: [...element.querySelectorAll(".ub-decisions-list > li")].map((item) => getComputedStyle(item).borderTopWidth),
        success: token("background-color", "var(--status-success)"),
        destructive: token("background-color", "var(--destructive)"),
        neutralHalf: token("background-image", "linear-gradient(90deg, var(--muted-foreground) 50%, transparent 50%)"),
        amber: token("background-color", "var(--brand)"),
        inForce: mark("in-force"),
        conflict: mark("conflict"),
        review: mark("under-review"),
      };
    } finally {
      probe.remove();
    }
  });
  expect(styles.fill).toBe(styles.card);
  expect(styles.fill).not.toBe(styles.page);
  expect(styles.borders).toEqual(["0px", "0px", "0px", "0px"]);
  expect(styles.radius).toBe(styles.tokenRadius);
  expect(styles.font).toBe(styles.uiFont);
  expect(styles.font).toContain("Geist");
  expect(styles.font).not.toContain("Mono");
  expect(styles.uppercase).toBe("uppercase");
  expect(styles.letterSpacing).toBeGreaterThan(0);
  expect(styles.captionSize).toBe(12);
  expect(styles.separators).toEqual(["0px", "1px", "1px", "1px", "1px", "1px"]);
  expect(styles.inForce).toEqual({ fill: styles.success, border: styles.success, image: "none" });
  expect(styles.conflict).toEqual({ fill: styles.destructive, border: styles.destructive, image: "none" });
  expect(styles.review.image).toBe(styles.neutralHalf);
  expect(styles.review.image).not.toContain(styles.amber);
  expect(styles.review.border).not.toBe(styles.amber);
}

async function expectHeaderContained(page: Page): Promise<void> {
  const header = await page.locator(".ub-decisions-link").evaluate((link) => {
    const status = link.closest<HTMLElement>(".ub-status");
    if (status === null) throw new Error("e2e: Decisions link is outside the line under the title");
    const bounds = status.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(link);
    const escapingInk = [...range.getClientRects()].filter((ink) =>
      ink.left < bounds.left - 0.5 || ink.right > bounds.right + 0.5 ||
      ink.top < bounds.top - 0.5 || ink.bottom > bounds.bottom + 0.5,
    );
    return { width: link.clientWidth, scrollWidth: link.scrollWidth, escapingInk: escapingInk.length };
  });
  expect(header.scrollWidth).toBe(header.width);
  expect(header.escapingInk).toBe(0);
}

for (const touch of [false, true]) for (const appearance of ["light", "dark"] as const) {
  test(`related Decisions links and layout on ${touch ? "iPad touch" : "desktop keyboard and pointer"} in ${appearance}`, async ({ browser }) => {
    test.fixme(browser.browserType().name() === "chromium" && !touch && appearance === "light", "Topic navigation intermittently leaves the editor unavailable; stabilization is pending.");
    const writer = session();
    const related = await create(writer, "Supporting page", "Supporting guidance.");
    const owner = await create(writer, "Page with its own decisions", "Regular page guidance.", {
      blocks: [
        { type: "heading", level: 2, text: "Overview" },
        ...Array.from({ length: 16 }, (_, index) => ({ type: "paragraph", text: `Guidance paragraph ${index + 1} stays in the page's content.` })),
        { type: "heading", level: 2, text: "Related" },
        { type: "paragraph", inline: [{ text: "Supporting page", marks: { docLink: related.uuid } }] },
      ],
    });
    const other = await create(writer, "Another related page", "Other guidance.");
    const conflict = await create(writer, "Original conflict question", "Original answer.", {
      kind: "decision", status: "decided", related: owner.uuid, answer: answer(),
    });
    const earlierConflict = await create(writer, "Earlier competing answer", "First conflicting answer must stay out of the block.", {
      kind: "decision", status: "decided", supersedes: conflict.uuid, answer: answer("First answerer"),
    });
    const latestConflict = await create(writer, "Conflict question", "Second conflicting answer must stay out of the block.", {
      kind: "decision", status: "decided", supersedes: conflict.uuid, answer: answer("Second answerer"),
    });
    const review = await create(writer, "Historical review question", "Historical answer.", {
      kind: "decision", status: "decided", related: owner.uuid, answer: answer(),
    });
    const currentReview = await create(writer, "Review question", "The current answer stays in force during review.", {
      kind: "decision", status: "decided", supersedes: review.uuid, related: other.uuid, answer: answer(),
    });
    const pendingReview = await create(writer, "Pending question must not replace the current question", "Pending preview must not appear.", {
      kind: "decision", supersedes: currentReview.uuid,
    });
    const alphaQuestion = "Alpha settled question with enough detail to wrap within a narrow reading column?";
    const recordedAnswer = answer();
    const alpha = await create(writer, alphaQuestion, "The cached answer is deliberately long enough to extend beyond a single line in the compact block, and the remainder stays available on the topic page.", {
      kind: "decision", status: "decided", related: owner.uuid, answer: recordedAnswer,
    });
    const zulu = await create(writer, "Zulu settled question", "A second settled answer.", {
      kind: "decision", status: "decided", related: owner.uuid, answer: answer("bk-one", "An unparseable recorded date"),
    });
    const stance = await create(writer, "Agent question", "An agent answer is labelled as a stance.", {
      kind: "decision", status: "decided", related: owner.uuid,
    });
    const undecided = await create(writer, "Unanswered question", "An open proposal has no answer preview in the block.", {
      kind: "decision", related: owner.uuid,
    });
    const linked = await create(writer, "Linked-only question", "", {
      kind: "decision", status: "decided", answer: answer(),
      blocks: [{ type: "paragraph", inline: [
        { text: "See ", marks: {} },
        { text: "the page", marks: { docLink: owner.uuid } },
        { text: "; this link does not make it the related page.", marks: {} },
      ] }],
    });
    const archived = await create(writer, "Archived question", "Archived guidance stays out of the block.", {
      kind: "decision", status: "decided", related: owner.uuid, answer: answer(),
    });
    await writer.call("archive_doc", { uuid: archived.uuid });
    const before = await writer.call<StoredDoc>("get_doc", { uuid: owner.uuid });
    const markdown = await writer.call<{ markdown: string }>("export_markdown", { uuid: owner.uuid });
    expect(before.decisions?.find((topic) => topic.topic === linked.uuid)?.relation).toBe("linked");

    const rooms = new Set<string>();
    const ownerPath = `/${harness().workspace}/${owner.uuid}`;
    const page = await openApp(browser, ownerPath, {
      upstream: true,
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: appearance },
      beforeNavigate: (target) => observeRooms(target, rooms),
    });
    await expect(editor(page)).toContainText("Supporting page");
    await expect(block(page)).toHaveAttribute("id", `decisions-${owner.uuid}`);
    const rows = block(page).locator(".ub-decisions-row");
    await expect(rows).toHaveCount(6);
    await expect.poll(() => rows.evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")))).toEqual([
      "Conflict: Conflict question",
      "Under review: Review question",
      `In force: ${alphaQuestion}`,
      "In force: Zulu settled question",
      "Agent stance: Agent question",
      "Not yet decided: Unanswered question",
    ]);
    const relatedTopics = before.decisions?.filter((topic) => topic.relation === "related").map((topic) => topic.topic).sort();
    expect((await rows.evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).pathname.split("/").at(-1)))).sort()).toEqual(relatedTopics);
    const summary = "6 decisions · 1 conflict · 1 under review · 1 agent stance · 1 not yet decided";
    await expect(block(page).locator(".ub-decisions-summary")).toHaveText(summary);
    await expect(page.locator(".ub-decisions-link")).toHaveText(`${summary} ↓`);
    await expect(row(page, "Conflict", "Conflict question").locator(".ub-decisions-row-preview")).toHaveText("Nothing is in force.");
    await expect(row(page, "Under review", "Review question").locator(".ub-decisions-row-preview")).toHaveText(currentReview.blocks[0]?.text ?? "");
    await expect(block(page)).not.toContainText("Pending preview");
    await expect(block(page)).not.toContainText("conflicting answer must stay");
    await expect(row(page, "Not yet decided", "Unanswered question").locator(".ub-decisions-row-preview")).toHaveCount(0);
    const alphaRow = row(page, "In force", alphaQuestion);
    await expect(alphaRow.locator(".ub-decisions-row-meta")).toContainText("Ben (@bk-one) · 5d");
    await expect(alphaRow.locator("time")).toHaveAttribute("datetime", recordedAnswer.when);
    await expect(alphaRow.locator("time")).toHaveAttribute("title", /.+/);
    await expect(row(page, "In force", "Zulu settled question").locator(".ub-decisions-row-meta")).toHaveText("bk-one");
    await expect(row(page, "In force", "Zulu settled question").locator("time")).toHaveCount(0);
    await expect(row(page, "Agent stance", "Agent question").locator(".ub-decisions-state-label")).toHaveText("Agent stance");
    await expectChromeStyles(page);
    await expectHeaderContained(page);

    const placement = await geometry(page);
    expect(placement.inEditor).toBe(false);
    expect(placement.afterEditor).toBe(true);
    expect(placement.blockTop).toBeGreaterThanOrEqual(placement.editorBottom);
    await jumpFromHeader(page, touch);
    const contents = page.getByRole("button", { name: "Contents 3", exact: true });
    await page.locator(".ub-document-pane").evaluate((pane) => { pane.scrollTop = 0; });
    await activateControl(contents, { touch });
    const menu = page.getByRole("menu", { name: "Contents 3", exact: true });
    await expect(menu.getByRole("menuitem")).toHaveText(["Overview", "Related", "Decisions"]);
    await activateControl(menu.getByRole("menuitem", { name: "Decisions", exact: true }), { touch });
    await expect(menu).toBeHidden();
    await expectBlockInView(page);
    const displayed = await writer.call<StoredDoc>("get_doc", { uuid: owner.uuid });
    expect(displayed.blocks).toEqual(before.blocks);
    expect((await writer.call<{ markdown: string }>("export_markdown", { uuid: owner.uuid })).markdown).toBe(markdown.markdown);
    const recordIds = [conflict.uuid, earlierConflict.uuid, latestConflict.uuid, review.uuid, currentReview.uuid, pendingReview.uuid, alpha.uuid, zulu.uuid, stance.uuid, undecided.uuid, linked.uuid, archived.uuid];
    for (const uuid of recordIds) expect(rooms.has(roomForDoc(harness().workspaceUuid, uuid))).toBe(false);

    await block(page).screenshot({
      path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `decisions-block-${touch ? "ipad" : "desktop"}-${appearance}.png`),
    });
    if (!touch) {
      await page.setViewportSize({ width: 560, height: 1000 });
      await jumpFromHeader(page, false);
      await expect.poll(async () => {
        const question = await alphaRow.locator(".ub-decisions-question").boundingBox();
        const attribution = await alphaRow.locator(".ub-decisions-row-meta").boundingBox();
        return question !== null && attribution !== null && attribution.y >= question.y + question.height - 0.5;
      }).toBe(true);
      const narrow = await geometry(page);
      expect(narrow.paneScrollWidth).toBe(narrow.paneWidth);
      expect(narrow.blockScrollWidth).toBe(narrow.blockWidth);
      await expectHeaderContained(page);
      const preview = await alphaRow.locator(".ub-decisions-row-preview").evaluate((element) => ({
        whiteSpace: getComputedStyle(element).whiteSpace,
        textOverflow: getComputedStyle(element).textOverflow,
        clipped: element.scrollWidth > element.clientWidth,
      }));
      expect(preview).toEqual({ whiteSpace: "nowrap", textOverflow: "ellipsis", clipped: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }

    await activateControl(alphaRow, { touch });
    await expect(page).toHaveURL(new RegExp(`/${alpha.uuid}$`));
    await expect(editor(page)).toHaveText(alpha.blocks[0]?.text ?? "");
    await absent(page);
    await expect.poll(() => rooms.has(roomForDoc(harness().workspaceUuid, alpha.uuid))).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${ownerPath}$`));
    await expect(rows).toHaveCount(6);
    if (!touch) {
      await alphaRow.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(alphaRow).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${alpha.uuid}$`));
      await page.goBack();
      await expect(rows).toHaveCount(6);
    }
  });
}

test("a page without headings gains and loses its live Decisions chrome", async ({ browser }) => {
  const writer = session();
  const owner = await create(writer, "Live Decisions page", "A page with no outline headings.");
  const page = await openApp(browser, `/${harness().workspace}/${owner.uuid}`, { upstream: true });
  await expect(editor(page)).toHaveText(owner.blocks[0]?.text ?? "");
  await absent(page);
  await expect(page.locator(".ub-outline-trigger")).toHaveCount(0);
  const linked = await create(writer, "A link alone", "", {
    kind: "decision", status: "decided", answer: answer(),
    blocks: [{ type: "paragraph", inline: [
      { text: "See ", marks: {} },
      { text: "this page", marks: { docLink: owner.uuid } },
      { text: ".", marks: {} },
    ] }],
  });
  await expect.poll(async () => (await writer.call<StoredDoc>("get_doc", { uuid: owner.uuid })).decisions?.find((topic) => topic.topic === linked.uuid)?.relation).toBe("linked");
  await absent(page);
  const proposal = await create(writer, "Live question", "The first answer becomes guidance when accepted.", { kind: "decision", related: owner.uuid });
  await expect(row(page, "Not yet decided", "Live question")).toBeVisible();
  await expect(page.locator(".ub-decisions-link")).toHaveText("1 decision · 1 not yet decided ↓");
  const contents = page.getByRole("button", { name: "Contents 1", exact: true });
  await expect(contents).toBeVisible();
  await contents.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Contents 1", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveText(["Decisions"]);
  await menu.getByRole("menuitem", { name: "Decisions", exact: true }).press("Enter");
  await expect(menu).toBeHidden();
  await expectBlockInView(page);
  await writer.call("set_status", { uuid: proposal.uuid, status: "decided", answer: answer() });
  await expect(row(page, "In force", "Live question")).toBeVisible();
  await expect(page.locator(".ub-decisions-link")).toHaveText("1 decision in force ↓");
  const pending = await create(writer, "Proposed replacement question", "The proposed preview never appears on the page.", { kind: "decision", supersedes: proposal.uuid });
  await expect(row(page, "Under review", "Live question")).toBeVisible();
  await expect(page.locator(".ub-decisions-link")).toHaveText("1 decision · 1 under review ↓");
  await expect(row(page, "Under review", "Live question").locator(".ub-decisions-row-preview")).toHaveText(proposal.blocks[0]?.text ?? "");
  await writer.call("set_status", { uuid: pending.uuid, status: "withdrawn" });
  await expect(row(page, "In force", "Live question")).toBeVisible();
  await writer.call("archive_doc", { uuid: proposal.uuid });
  await absent(page);
  await expect(page.locator(".ub-outline-trigger")).toHaveCount(0);
});
