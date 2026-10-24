import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { appendBlock, applyDocData, deleteBlock, editBlock, getBlock, getBlocksFragment, initDoc, insertBlock, setTitle, snapshotRevision } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import * as Y from "yjs";
import { activateControl, createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import { assertNoViolations, WCAG_TAGS } from "./accessibility-assertions.js";
import { waitForAcknowledged } from "./settle.js";
import { setPointerSelection } from "./native-selection.js";

function history(page: Page): Locator {
  return page.getByRole("group", { name: "Document history", exact: true });
}

/** The selected revision: the right side of a side-by-side comparison, or the single column. */
function historicalEditor(page: Page): Locator {
  return page.locator('.ub-revision-pane .ProseMirror:not([aria-label="Before this revision"])');
}

/** Where removals show: the left side of a side-by-side comparison, or the single column. */
function earlierSide(page: Page): Locator {
  return page.locator('.ub-revision-pane .ProseMirror:not([aria-label="This revision"])');
}

function historyList(page: Page): Locator {
  return page.getByRole("navigation", { name: "Revision history", exact: true });
}

/** On narrow layouts the history list lives in the drawer; true when this opened it. */
async function showHistoryList(page: Page): Promise<boolean> {
  if (await historyList(page).isVisible()) return false;
  await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
  await expect(historyList(page)).toBeVisible();
  return true;
}

/** The open drawer covers the revision header, as it covers any document. */
async function closeHistoryList(page: Page, drawer: boolean): Promise<void> {
  if (!drawer) return;
  await page.keyboard.press("Escape");
  await expect(historyList(page)).toBeHidden();
}

/** The live status line's ‹ opens history; in history it steps to an older revision. */
async function previous(page: Page): Promise<void> {
  await activateControl(history(page).getByRole("button", { name: "Previous revision", exact: true }));
}

async function backToNow(page: Page): Promise<void> {
  // The sidebar holds it on desktop; the revision's status row keeps it when the sidebar is a drawer.
  await activateControl(page.getByRole("button", { name: "Back to now", exact: true }).first());
}

async function newDocument(page: Page, title: string): Promise<string> {
  if (!await page.getByRole("button", { name: "+ New page", exact: true }).isVisible()) {
    await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
  }
  const uuid = await createDoc(page, title);
  await waitForAcknowledged(page, { path: "relay" });
  return uuid;
}

async function selectPositions(view: Locator, from: number, to = from): Promise<void> {
  await view.evaluate((element, selection) => {
    const mounted = element as HTMLElement & { editor: Editor };
    mounted.editor.view.focus();
    mounted.editor.commands.setTextSelection(selection);
  }, { from, to });
  await view.page().keyboard.press("Shift");
  await expect.poll(() => view.evaluate((element, selection) => {
    const mounted = element as HTMLElement & { editor: Editor };
    return mounted.editor.state.selection.from === selection.from && mounted.editor.state.selection.to === selection.to &&
      mounted.contains(document.activeElement);
  }, { from, to })).toBe(true);
}

async function archiveAndRestore(page: Page, title: string): Promise<void> {
  await activateControl(page.getByRole("button", { name: "Document actions", exact: true }));
  await activateControl(page.getByRole("menuitem", { name: "Archive document", exact: true }));
  const dialog = page.getByRole("alertdialog", { name: `Archive “${title}”?` });
  await activateControl(dialog.getByRole("button", { name: "Archive", exact: true }));
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await expect(restore).toBeVisible();
  await activateControl(restore);
  await expect(restore).toHaveCount(0);
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
}

function savedState(uuid: string, title: string, text: string): string {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    appendBlock(document, { type: "paragraph", text });
    return Buffer.from(snapshotRevision(document).state).toString("base64");
  } finally {
    document.destroy();
  }
}

async function serveHistory(page: Page, revisions: RevisionEntry[], states: Record<string, string>): Promise<string[]> {
  const snapshotReads: string[] = [];
  await page.route("**/api/revisions?**", async route => {
    const revision = new URL(route.request().url()).searchParams.get("revision");
    if (revision !== null) snapshotReads.push(revision);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(revision === null ? { revisions } : { state: states[revision] }),
    });
  });
  return snapshotReads;
}

/** Two states with a word change, a wrapped removal, an addition, a table row and an unchanged block. */
function splitHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    const heading = appendBlock(document, { type: "heading", level: 2, text: "Rollout plan" });
    const fox = appendBlock(document, { type: "paragraph", text: "The amber fox stays." });
    ((getBlocksFragment(document).get(1) as Y.XmlElement).firstChild as Y.XmlText).format(0, 3, { bold: {} });
    const gone = appendBlock(document, { type: "paragraph", text: "A paragraph that goes away, long enough to wrap across several lines in one half of the side-by-side comparison, so the opposite filler has to grow with it." });
    const table = appendBlock(document, { type: "table", text: "| Day | Latency |\n| --- | --- |\n| Mon | 10 |" });
    appendBlock(document, { type: "paragraph", text: "An unchanged closing paragraph." });
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    editBlock(document, fox, "The amber fox stays.", "The blue fox stays.");
    deleteBlock(document, gone);
    insertBlock(document, heading, { type: "paragraph", text: "An added note." });
    const rows = getBlock(document, table)?.text ?? "";
    editBlock(document, table, rows, rows.replace("10", "12"));
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

/** A json-tree block whose items move, gain one entry and change a version string. */
function jsonHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  const agents = (entries: { id: string; image: string }[]) => JSON.stringify({ service: "planner", agents: entries,
    limits: { tokens: 4096, price: 1.5, retries: 3, timeout: 30, region: "eu" }, owner: "platform", tier: "standard", zone: "eu-central" }, null, 2);
  const before = agents([{ id: "implementer", image: "ub-hub:0.4.8" }, { id: "reviewer", image: "ub-hub:0.4.8" }]);
  const after = agents([{ id: "reviewer", image: "ub-hub:0.4.8" }, { id: "implementer", image: "ub-hub:0.4.9" }, { id: "preparer", image: "ub-hub:0.4.9" }]);
  try {
    initDoc(document, { uuid, title });
    appendBlock(document, { type: "paragraph", text: "The planner's settings, as the hub reports them." });
    const block = appendBlock(document, { type: "code", language: "json-tree", text: before });
    appendBlock(document, { type: "paragraph", text: "An unchanged closing paragraph." });
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    editBlock(document, block, before, after);
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

/** A change near the top, a long unchanged middle with headings, and a change near the end. */
function foldHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    const first = appendBlock(document, { type: "paragraph", text: "The opening line changes." });
    for (const section of ["Background", "Approach"]) {
      appendBlock(document, { type: "heading", level: 2, text: section });
      for (let index = 1; index <= 5; index += 1) {
        appendBlock(document, { type: "paragraph", text: `${section} paragraph ${index} stays exactly as it was, long enough to take some room on the page.` });
      }
    }
    const last = appendBlock(document, { type: "paragraph", text: "The closing line changes." });
    appendBlock(document, { type: "paragraph", text: "A final unchanged line." });
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    editBlock(document, first, "The opening line changes.", "The opening line changed.");
    editBlock(document, last, "The closing line changes.", "The closing line changed.");
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

function linkedHistory(uuid: string, title: string, target: string, deleted: string): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    appendBlock(document, { type: "paragraph", inline: [
      { text: "Read ", marks: {} },
      { text: "the linked document", marks: { docLink: target } },
      { text: ".", marks: {} },
    ] });
    appendBlock(document, { type: "paragraph", inline: [
      { text: "Read ", marks: {} },
      { text: "the external page", marks: { link: "https://example.invalid/history-link" } },
      { text: ".", marks: {} },
    ] });
    appendBlock(document, { type: "paragraph", inline: [
      { text: "Read ", marks: {} },
      { text: "the deleted document", marks: { docLink: deleted } },
      { text: ".", marks: {} },
    ] });
    appendBlock(document, { type: "list-item", text: "A historical list item." });
    appendBlock(document, { type: "table", text: "| Status |\n| --- |\n| Ready |" });
    const paragraph = appendBlock(document, { type: "paragraph", text: "Earlier wording." });
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    editBlock(document, paragraph, "Earlier wording.", "Selected wording.");
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

/** Animations still running in either document view: none once motion has settled. */
function runningMotion(page: Page): Promise<number> {
  return page.evaluate(() => document.getAnimations().filter((animation) => {
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    return animation.playState === "running" && target instanceof Element && target.closest(".ub-document-pane") !== null;
  }).length);
}

interface RulerGeometry {
  top: number; bottom: number; paneBottom: number; firstRow: number;
  marks: { kind: string; top: number; height: number }[];
  view: { top: number; height: number };
  scrollTop: number; maxScroll: number;
}

async function rulerGeometry(page: Page): Promise<RulerGeometry> {
  return await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".ub-revision-pane");
    const ruler = document.querySelector<HTMLElement>("[data-testid='revision-ruler']");
    const first = document.querySelector<HTMLElement>('.ub-revision-pane .ProseMirror[aria-label="This revision"] > .ub-revision-row-start');
    const view = ruler?.querySelector<HTMLElement>(".ub-revision-ruler-view");
    if (pane === null || ruler === null || first === null || view == null) throw new Error("The ruler is not shown");
    const track = ruler.getBoundingClientRect();
    const box = view.getBoundingClientRect();
    return {
      top: track.top, bottom: track.bottom, paneBottom: pane.getBoundingClientRect().bottom, firstRow: first.getBoundingClientRect().top,
      marks: [...ruler.querySelectorAll<HTMLElement>(".ub-revision-ruler-mark")].map((mark) => ({
        kind: mark.dataset.mark ?? "", top: mark.getBoundingClientRect().top - track.top, height: mark.getBoundingClientRect().height,
      })),
      view: { top: box.top - track.top, height: box.height },
      scrollTop: pane.scrollTop, maxScroll: pane.scrollHeight - pane.clientHeight,
    };
  });
}

/** An earlier draft under another title, then the current title and one changed line. */
function renamedHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title: "Earlier draft" });
    const line = appendBlock(document, { type: "paragraph", text: "The plan starts small." });
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    setTitle(document, title);
    editBlock(document, line, "The plan starts small.", "The plan starts smaller.");
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

function dataHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  const directory = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    appendBlock(document, { type: "chart", text: JSON.stringify({
      version: 1, type: "table", collection: "measurements", title: "Historical measurements",
      columns: [{ field: "day", label: "Day" }, { field: "latency", label: "Latency", format: "number", unit: "ms" }],
    }) });
    appendBlock(document, { type: "chart", text: JSON.stringify({
      version: 1, type: "line", collection: "measurements", title: "Historical latency",
      x: { field: "day", type: "date", label: "Day" },
      y: [{ field: "latency", label: "Latency", unit: "ms" }],
    }) });
    const update = (first: number, last: number): void => {
      applyDocData(document, directory, [{ collection: "measurements", schema: { version: 1, schema: { type: "object" } }, replaceRecords: [
        { id: "a", value: { day: "2026-10-20", latency: first } },
        { id: "b", value: { day: "2026-10-21", latency: last } },
      ] }]);
    };
    update(10, 20);
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    update(90, 100);
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
    directory.destroy();
  }
}

test.describe("document history through ub open", () => {
  const { harness, openApp } = setupHarness({ accessRole: "admin" });

  test("names the reviewed state, compares since it, and lets its namer rename or remove it", { tag: "@webkit" }, async ({ browser, browserName }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await page.emulateMedia({ colorScheme: browserName === "webkit" ? "dark" : "light" });
    const title = docTitle("Named review state");
    const uuid = await newDocument(page, title);
    const room = `${harness().workspaceUuid}/${uuid}`;
    const live = editor(page);
    await activateControl(live);
    await page.keyboard.type("The amber fox stays.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("An outdated paragraph.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("The oldest paragraph.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("An unchanged paragraph.");
    await expect.poll(() => harness().hubText(room)).toContain("An unchanged paragraph.");
    const trigger = history(page).getByRole("button", { name: "Name current revision", exact: true });
    const input = history(page).getByRole("textbox", { name: "Revision name", exact: true });
    // Escape settles the field; the blur that follows saves nothing.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(input).toBeFocused();
    await input.fill("Discarded name");
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Tab");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("");
    await input.fill("Reviewed after auth rewrite");
    const screenshotName = browserName === "webkit" ? "naming-ipad-dark" : "naming-desktop-light";
    const screenshot = info.outputPath(`${screenshotName}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach(screenshotName, { path: screenshot, contentType: "image/png" });
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByText("Revision named", { exact: true })).toBeVisible();
    await previous(page);
    await expect(history(page)).toContainText("“Reviewed after auth rewrite”, named by browser-person in the browser at ");
    await expect(history(page).locator(".ub-history-who .sr-only")).not.toContainText("from ");
    await backToNow(page);
    for (const [before, after] of [["amber", "blue"], ["outdated", "current"], ["oldest", "latest"]] as const) {
      const positions = await live.evaluate((element, before) => {
        const doc = (element as HTMLElement & { editor: Editor }).editor.state.doc;
        let from = -1;
        doc.descendants((node, position) => {
          const index = node.text?.indexOf(before) ?? -1;
          if (index >= 0) from = position + index;
        });
        if (from < 0) throw new Error(`Missing text ${before}`);
        return { from, to: from + before.length };
      }, before);
      await selectPositions(live, positions.from, positions.to);
      await page.keyboard.type(after);
    }
    await expect.poll(() => harness().hubText(room)).toContain("The latest paragraph.");
    await previous(page);
    await expect(historicalEditor(page)).toBeVisible();
    const drawer = await showHistoryList(page);
    const since = historyList(page).getByRole("button", { name: "Changes since this name", exact: true });
    await activateControl(since);
    await expect(since).toHaveAttribute("aria-current", "true");
    await closeHistoryList(page, drawer);
    const view = historicalEditor(page);
    await expect(history(page)).toContainText("compared with “Reviewed after auth rewrite”");
    await expect(view.locator('[data-revision-change="added"]')).toHaveText(["blue", "current", "latest"]);
    await expect(earlierSide(page).locator('[data-revision-change="removed"]')).toHaveText(["amber", "outdated", "oldest"]);
    for (const side of [view, earlierSide(page)]) {
      await expect(side.locator("p").filter({ hasText: "An unchanged paragraph." }).locator("[data-revision-change]")).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await activateControl(history(page).getByRole("button", { name: "Next revision", exact: true }));
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(history(page).getByRole("button", { name: "Previous revision", exact: true })).toBeFocused();
    await previous(page);
    await expect(historicalEditor(page)).toBeVisible();
    await previous(page);
    const renaming = history(page).getByRole("textbox", { name: "Revision name", exact: true });
    await activateControl(history(page).getByRole("button", { name: "Rename revision", exact: true }));
    await expect(renaming).toHaveValue("Reviewed after auth rewrite");
    await renaming.fill("Reviewed baseline");
    await renaming.press("Enter");
    await expect(renaming).toHaveCount(0);
    await expect(history(page)).toContainText("“Reviewed baseline”, named by browser-person in the browser at ");
    // Saving an empty name removes it.
    await activateControl(history(page).getByRole("button", { name: "Rename revision", exact: true }));
    await renaming.fill("");
    await renaming.press("Enter");
    await expect(renaming).toHaveCount(0);
    await expect(view).toContainText("The amber fox stays.");
    await expect(history(page)).not.toContainText("Reviewed baseline");
    await expect(since).toHaveCount(0);
    await backToNow(page);
    await expect(live).toHaveAttribute("contenteditable", "true");
    await expect(live).toContainText("The blue fox stays.");
  });

  test("refuses naming if the displayed state changes after opening the naming dialog", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const uuid = await newDocument(page, docTitle("Stale review state"));
    await activateControl(editor(page));
    await page.keyboard.type("Reviewed current content.");
    await expect.poll(() => harness().hubText(`${harness().workspaceUuid}/${uuid}`)).toBe("Reviewed current content.");
    const peer = await openApp(browser, new URL(page.url()).pathname, { readySelector: ".ub-editor .ProseMirror" });
    await expect.poll(() => editor(peer).evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.textContent))
      .toBe("Reviewed current content.");
    await activateControl(history(page).getByRole("button", { name: "Name current revision", exact: true }));
    const naming = history(page).getByRole("textbox", { name: "Revision name", exact: true });
    await naming.fill("Reviewed");
    await selectPositions(editor(peer), 1);
    await peer.keyboard.type("Later collaborator change: ");
    await expect.poll(() => harness().hubText(`${harness().workspaceUuid}/${uuid}`)).toContain("Later collaborator change:");
    // The field named the state it opened on; the refusal keeps the typed text.
    await naming.press("Enter");
    await expect(history(page).getByRole("alert")).toContainText("review the current content");
    await expect(naming).toHaveValue("Reviewed");
    await expect(naming).toBeEnabled();
    await naming.press("Escape");
    await expect(naming).toHaveCount(0);
    await previous(page);
    await expect(historicalEditor(page)).toBeVisible();
    await expect(historyList(page).getByRole("button", { name: "Changes since this name", exact: true })).toHaveCount(0);
    await expect(historyList(page).locator(".ub-history-name")).toHaveCount(0);
    await backToNow(page);
    await expect(editor(page)).toContainText("Later collaborator change:");
  });

  test("real hub revisions navigate, keep removed text selectable and isolate the live editor", { tag: "@webkit" }, async ({ browser, browserName }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await page.emulateMedia({ colorScheme: browserName === "webkit" ? "dark" : "light" });
    const title = docTitle("Selectable revision changes");
    const uuid = await newDocument(page, title);
    const room = `${harness().workspaceUuid}/${uuid}`;
    const live = page.locator(".ub-document-pane:not(.ub-revision-pane) .ub-editor .ProseMirror");
    await activateControl(live);
    await page.keyboard.type("The amber fox stays.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("A removed paragraph.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("A surviving paragraph.");
    await expect.poll(() => harness().hubText(room)).toContain("A surviving paragraph.");

    // Archiving closes the actual hub's authored stretch without a fake clock.
    await archiveAndRestore(page, title);
    await selectPositions(live, 5, 10);
    await page.keyboard.type("blue");
    const deleted = await live.evaluate(element => {
      const doc = (element as HTMLElement & { editor: Editor }).editor.state.doc;
      const start = doc.child(0).nodeSize;
      return { from: start, to: start + doc.child(1).nodeSize };
    });
    await selectPositions(live, deleted.from, deleted.to);
    await page.keyboard.press("Backspace");
    await expect(live.locator(":scope > p")).toHaveText(["The blue fox stays.", "A surviving paragraph."]);
    await expect.poll(() => harness().hubText(room)).not.toContain("A removed paragraph.");

    const path = new URL(page.url()).pathname;
    const peer = await openApp(browser, path, { readySelector: ".ub-editor .ProseMirror" });
    await expect(editor(peer)).toContainText("The blue fox stays.");
    await previous(page);
    const view = historicalEditor(page);
    expect(await view.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.isEditable)).toBe(false);
    await expect(history(page)).toContainText("browser-person");
    await expect(history(page)).toContainText(/from /);
    await expect(page).toHaveURL(new URL(path, harness().appUrl).href);
    await expect(view.locator('[data-revision-change="added"]')).toContainText("blue");
    const earlier = earlierSide(page);
    const removed = earlier.locator('[data-revision-change="removed"]').filter({ hasText: "amber" });
    await expect(removed).toHaveText("amber");
    await expect(earlier).toContainText("A removed paragraph.");
    await expect(earlier.locator('[data-revision-change="removed"]').filter({ hasText: "A removed paragraph." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (browserName === "webkit") {
      for (const name of ["Previous revision", "Next revision", "Back to now"]) {
        const box = await history(page).getByRole("button", { name, exact: true }).boundingBox();
        if (box === null) throw new Error(`history control ${name} has no touch target`);
        // WebKit's transformed bounding boxes can round a 44px target just below 44.
        expect(box.height).toBeGreaterThanOrEqual(44 - 0.01);
        expect(box.width).toBeGreaterThanOrEqual(44 - 0.01);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
      }
    }
    const screenshotName = browserName === "webkit" ? "revision-ipad-dark" : "revision-desktop-light";
    const screenshot = info.outputPath(`${screenshotName}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach(screenshotName, { path: screenshot, contentType: "image/png" });

    const copied = await removed.evaluate(element => {
      const root = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
      const text = element.firstChild;
      if (text === null) throw new Error("removed content has no text node");
      const from = root.editor.view.posAtDOM(text, 0);
      root.editor.commands.setTextSelection({ from, to: from + (element.textContent?.length ?? 0) });
      const clipboard = new DataTransfer();
      root.dispatchEvent(new ClipboardEvent("copy", { clipboardData: clipboard, bubbles: true, cancelable: true }));
      return { text: clipboard.getData("text/plain"), html: clipboard.getData("text/html") };
    });
    expect(copied.text).toBe("amber");
    expect(copied.html).not.toMatch(/ub-revision-|data-revision-change|<s[\s>]/);
    await expect(page.locator('[data-slot="selection-composer"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Document actions", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Insert block below", includeHidden: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Threads", exact: true })).toHaveCount(0);
    await expect(page.locator(".ub-revision-pane [data-comment-thread]")).toHaveCount(0);

    const snapshot = () => page.locator(".ub-revision-pane .ProseMirror").evaluateAll(elements =>
      elements.map(element => (element as HTMLElement & { editor: Editor }).editor.getJSON()));
    const before = await snapshot();
    await activateControl(removed);
    await page.keyboard.type("typed mutation");
    await page.keyboard.press("ControlOrMeta+b");
    await earlier.evaluate(element => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "pasted or dropped mutation");
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      element.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      const mounted = element as HTMLElement & { editor: Editor };
      mounted.editor.view.dispatch(mounted.editor.state.tr.insertText("command mutation", 1));
    });
    expect(await snapshot()).toEqual(before);
    await expect(editor(peer)).toContainText("The blue fox stays.");
    await expect(editor(peer)).not.toContainText("mutation");

    await previous(page);
    await expect(view).toContainText("The amber fox stays.");
    await expect(view.locator("[data-revision-change]")).toHaveCount(0);
    await expect(history(page).getByRole("button", { name: "Previous revision", exact: true })).toBeDisabled();
    await activateControl(history(page).getByRole("button", { name: "Next revision", exact: true }));
    await expect(view.locator('[data-revision-change="added"]')).toContainText("blue");

    await selectPositions(editor(peer), 1);
    await peer.keyboard.type("Live collaborator: ");
    await expect(editor(peer)).toContainText("Live collaborator: The blue fox stays.");
    await expect(view).not.toContainText("Live collaborator:");
    await backToNow(page);
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(live).toHaveAttribute("contenteditable", "true");
    await expect.poll(() => live.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.textContent))
      .toContain("Live collaborator: The blue fox stays.");
    await expect(live.locator("[data-revision-change]")).toHaveCount(0);
    await expect.poll(() => harness().hubText(room)).toContain("Live collaborator: The blue fox stays.");
    await selectPositions(live, await live.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.content.size - 1));
    await live.evaluate((element, copied) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", copied.text);
      clipboard.setData("text/html", copied.html);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    }, copied);
    await expect(live).toContainText("amber");
    await expect(editor(peer)).toContainText("amber");
    await expect(live.locator("s, del, strike, [data-revision-change]")).toHaveCount(0);
    await expect(editor(peer).locator("s, del, strike, [data-revision-change]")).toHaveCount(0);
    await expect.poll(() => harness().hubText(room)).toContain("amber");
    await page.reload();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(editor(page).locator("[data-revision-change]")).toHaveCount(0);
  });

  test("keyboard history navigation retains control focus and moves to an available control at either boundary", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Keyboard revision navigation");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 3_000, endedAt: null },
      { id: "middle", author: null, startedAt: 2_000, endedAt: 3_000 },
      { id: "earliest", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], {
      latest: savedState(uuid, title, "Latest content."),
      middle: savedState(uuid, title, "Middle content."),
      earliest: savedState(uuid, title, "Earliest content."),
    });
    const back = history(page).getByRole("button", { name: "Previous revision", exact: true });
    const forward = history(page).getByRole("button", { name: "Next revision", exact: true });
    await expect(back).toBeEnabled();
    await back.focus();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(back).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Middle content.");
    await expect(back).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toHaveText("Earliest content.");
    await expect(back).toBeDisabled();
    await expect(forward).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Middle content.");
    await expect(forward).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(forward).toBeFocused();
    // Next from the newest revision returns to the live document and its ‹.
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(back).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await page.getByRole("button", { name: "Back to now", exact: true }).first().focus();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(back).toBeFocused();
  });

  test("the history list opens any revision, filters named ones and passes an accessibility scan", { tag: "@webkit" }, async ({ browser, browserName }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await page.emulateMedia({ colorScheme: browserName === "webkit" ? "dark" : "light" });
    const title = docTitle("Revision list");
    const uuid = await newDocument(page, title);
    const person = { githubUsername: "browser-person", surface: { kind: "browser" as const, name: "Browser" } };
    const now = Date.now();
    await serveHistory(page, [
      { id: "latest", title, author: { githubUsername: "Ben", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: now - 60_000, endedAt: null },
      { id: "reviewed", title, author: person, startedAt: now - 3_600_000, endedAt: now - 3_000_000,
        name: { text: "Reviewed after the auth rewrite with a name long enough to be cut", namer: person, namedAt: now - 3_000_000, canManage: true } },
      { id: "earliest", title: "Kickoff notes", author: null, startedAt: null, endedAt: now - 7_200_000 },
    ], {
      latest: savedState(uuid, title, "Latest content."),
      reviewed: savedState(uuid, title, "Reviewed content."),
      earliest: savedState(uuid, "Kickoff notes", "Earliest content."),
    });
    await previous(page);
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(history(page)).not.toContainText("renamed from");
    await expect(history(page).locator(".ub-history-when")).toHaveText("· current version");
    const drawer = await showHistoryList(page);
    const list = historyList(page);
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await expect(list.locator('[aria-current="true"]')).toHaveCount(1);
    await expect(list.locator('[aria-current="true"]')).toContainText("Current version");
    await expect(list.locator('[aria-current="true"] time')).toHaveCount(0);
    const reviewed = list.getByRole("button", { name: /Reviewed after the auth rewrite/ });
    const name = list.locator(".ub-history-name > span:last-child");
    expect(await name.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await expect(name).toHaveCSS("text-overflow", "ellipsis");
    await reviewed.focus();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Reviewed content.");
    await expect(reviewed).toHaveAttribute("aria-current", "true");
    await expect(reviewed).toBeFocused();
    await closeHistoryList(page, drawer);
    await expect(history(page)).toContainText("2 of 3");
    await expect(history(page).locator(".ub-history-when")).not.toContainText("current version");
    // This revision changed the title: the header shows it as it was, the row and the entry say so.
    await expect(page.locator(".ub-revision-title")).toHaveText(title);
    await expect(history(page).locator(".ub-history-renamed s")).toHaveText("Kickoff notes");
    const restore = page.getByRole("button", { name: "Restore this version", exact: true });
    await expect(restore).toHaveAttribute("aria-disabled", "true");
    await expect(restore).toHaveAccessibleDescription("Restore is not available yet");
    await expect(page.locator(".ub-revision-header")).toHaveCSS("position", "sticky");
    await showHistoryList(page);
    await expect(reviewed).toContainText("renamed");
    await expect(list.getByRole("button", { name: /Ben via Claude Code/ })).not.toContainText("renamed");
    const screenshotName = browserName === "webkit" ? "history-list-ipad-dark" : "history-list-desktop-light";
    const screenshot = info.outputPath(`${screenshotName}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach(screenshotName, { path: screenshot, contentType: "image/png" });
    const scan = await new AxeBuilder({ page }).include(".ub-history-sidebar").include(".ub-revision-pane").withTags(WCAG_TAGS).analyze();
    assertNoViolations(scan.violations);
    await activateControl(list.getByRole("button", { name: "Named", exact: true }));
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).not.toContainText("Current version");
    await activateControl(list.getByRole("button", { name: "All", exact: true }));
    await activateControl(list.getByRole("button", { name: /Earlier content/ }));
    await expect(historicalEditor(page)).toHaveText("Earliest content.");
    await backToNow(page);
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(list).toBeHidden();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });

  test("side by side, rows line up, selections stay on one side and copies keep authored content", { tag: "@webkit" }, async ({ browser, browserName }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 900 } } });
    const title = docTitle("Side by side rows");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: { githubUsername: "Ben", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: { githubUsername: "browser-person", surface: { kind: "browser", name: "Browser" } }, startedAt: 1_000, endedAt: 2_000 },
    ], splitHistory(uuid, title));
    await previous(page);
    const split = page.locator(".ub-revision-split");
    await expect(split).toBeVisible();
    await expect(split).toContainText("Before · browser-person");
    await expect(split).toContainText("After · Ben");
    const before = earlierSide(page);
    const after = historicalEditor(page);
    await expect(after.locator('[data-revision-change="added"]').filter({ hasText: "blue" })).toHaveText("blue");
    await expect(before.locator('[data-revision-change="removed"]').filter({ hasText: "amber" })).toHaveText("amber");
    await expect(after).not.toContainText("amber");
    await expect(before).not.toContainText("An added note.");
    await expect(before.locator(".ub-revision-row-filler")).toHaveCount(1);
    await expect(after.locator(".ub-revision-row-filler")).toHaveCount(1);
    // Every row, and the end of both documents, starts at the same height on both sides.
    const aligned = () => page.evaluate(() => {
      const sides = [...document.querySelectorAll<HTMLElement>(".ub-revision-split .ProseMirror")];
      const rows = sides.map(side => [...side.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-start")]
        .map(start => start.getBoundingClientRect().top).concat(side.getBoundingClientRect().bottom));
      const [left = [], right = []] = rows;
      return left.length === right.length && left.every((top, index) => Math.abs(top - (right[index] ?? Number.NaN)) <= 1);
    });
    await expect.poll(aligned).toBe(true);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const screenshot = info.outputPath(`split-${scheme}.png`);
      await page.screenshot({ path: screenshot });
      await info.attach(`split-${scheme}`, { path: screenshot, contentType: "image/png" });
    }
    await page.emulateMedia({ colorScheme: "light" });
    // A block that grows late, like a drawing that finishes loading, realigns both sides.
    await before.locator(":scope > .ub-revision-row").first().evaluate(element => { element.style.paddingBottom = "80px"; });
    await expect.poll(aligned).toBe(true);
    const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
    if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const copy = async () => {
      await page.keyboard.press(`${modifier}+c`);
      // WebKit proves the clipboard through the native paste into the live document below.
      if (browserName !== "chromium") return null;
      return page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const item = items[0];
        if (item === undefined) throw new Error("No copied content");
        return { text: await (await item.getType("text/plain")).text(), html: await (await item.getType("text/html")).text() };
      });
    };
    for (const [own, other, word, excluded] of [[before, after, "amber", "blue"], [after, before, "blue", "amber"]] as const) {
      const paragraph = own.locator(":scope > p").filter({ hasText: `The ${word} fox stays.` });
      const start = await paragraph.boundingBox();
      const end = await other.locator(":scope > p").filter({ hasText: `The ${excluded} fox stays.` }).boundingBox();
      if (start === null || end === null) throw new Error("Missing comparison paragraph");
      // Native pointer selection that leaves its column must keep both endpoints in its host.
      await page.mouse.move(start.x + 20, start.y + 10);
      await page.mouse.down();
      await page.mouse.move(end.x + 90, end.y + 10, { steps: 12 });
      await page.mouse.up();
      await expect.poll(() => own.evaluate(element => {
        const selection = window.getSelection();
        return { nonempty: selection !== null && !selection.isCollapsed, anchor: element.contains(selection?.anchorNode ?? null), focus: element.contains(selection?.focusNode ?? null) };
      })).toEqual({ nonempty: true, anchor: true, focus: true });
      const selected = await own.evaluate(() => window.getSelection()?.toString().trim());
      const partial = await copy();
      if (partial !== null) {
        expect(partial.text.trim()).toBe(selected);
        expect(partial.text).not.toContain(excluded);
      }
      // A normal click and the platform shortcut select this side alone.
      await setPointerSelection(paragraph, () => paragraph.click());
      await expect(own).toBeFocused();
      await page.keyboard.press(`${modifier}+a`);
      await expect.poll(() => own.evaluate(() => window.getSelection()?.toString())).toContain("Rollout plan");
      const copied = await copy();
      if (copied !== null) {
        expect(copied.text).toContain(`The ${word} fox stays.`);
        expect(copied.text).not.toContain(excluded);
        expect(copied.text).not.toMatch(/Before ·|After ·|Back to now/);
        expect(copied.html).not.toMatch(/ub-revision-|data-revision-change|revision-filler|data-id="revision-/);
      }
      // Text input, deletion, formatting, cut and paste cannot change the snapshot.
      const original = await own.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getJSON());
      await page.keyboard.type("mutation");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Enter");
      await page.keyboard.press(`${modifier}+b`);
      await page.keyboard.press(`${modifier}+x`);
      await page.keyboard.press(`${modifier}+v`);
      expect(await own.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(original);
      // Paste the real system clipboard into the live document, preserving authored formatting.
      await setPointerSelection(paragraph, () => paragraph.click());
      await page.keyboard.press(`${modifier}+a`);
      await expect.poll(() => own.evaluate(() => window.getSelection()?.toString())).toContain("Rollout plan");
      await copy();
      await backToNow(page);
      const live = editor(page);
      // Prepare the paste target; the revision-side selections above use native input.
      await live.evaluate(element => {
        const mounted = element as HTMLElement & { editor: Editor };
        mounted.editor.view.focus();
        mounted.editor.commands.selectAll();
      });
      await page.keyboard.press(`${modifier}+v`);
      await expect(live).toContainText(`The ${word} fox stays.`);
      await expect(live).not.toContainText(excluded);
      await expect(live).not.toContainText(/Before ·|After ·|Back to now/);
      // This Linux WebKit clipboard backend delivers only plain text on native paste.
      if (browserName === "chromium") {
        await expect(live.getByRole("heading", { name: "Rollout plan" })).toHaveCount(1);
        await expect(live.locator("strong").filter({ hasText: "The" })).toHaveCount(1);
      }
      await expect(live.locator('[data-revision-change], .ub-revision-filler, [data-id^="revision-"]')).toHaveCount(0);
      await previous(page);
      await expect(split).toBeVisible();
    }
    // Without room for two readable columns, the single-column comparison returns.
    await page.setViewportSize({ width: 860, height: 900 });
    await expect(split).toHaveCount(0);
    await expect(page.getByLabel("Document revision", { exact: true })).toContainText("The amberblue fox stays.");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(split).toBeVisible();
  });

  test("each comparison side follows document links by click and Enter, and Tab leaves lists and tables", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 900 } } });
    const targetTitle = docTitle("Historical link target");
    const target = await newDocument(page, targetTitle);
    const deleted = await newDocument(page, docTitle("Deleted historical link target"));
    await activateControl(page.getByRole("button", { name: "Document actions", exact: true }));
    await activateControl(page.getByRole("menuitem", { name: "Archive document", exact: true }));
    await activateControl(page.getByRole("alertdialog").getByRole("button", { name: "Archive", exact: true }));
    await activateControl(page.locator(".ub-archived-banner").getByRole("button", { name: "Delete…", exact: true }));
    await activateControl(page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }));
    await expect(page.locator(".ub-document-pane")).toHaveText("This document was deleted.");
    const title = docTitle("Historical link source");
    const uuid = await newDocument(page, title);
    const sourceAddress = page.url();
    await page.context().route("https://example.invalid/history-link", route => route.fulfill({
      contentType: "text/html", body: "<p>Historical external link target</p>",
    }));
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], linkedHistory(uuid, title, target, deleted));
    await previous(page);
    const drawer = await showHistoryList(page);
    await activateControl(historyList(page).getByRole("switch", { name: "Collapse unchanged" }));
    await closeHistoryList(page, drawer);
    const split = page.locator(".ub-revision-split");
    await expect(split).toBeVisible();
    for (const side of [earlierSide(page), historicalEditor(page)]) {
      const caretInLink = async (label: string): Promise<void> => {
        const paragraph = side.locator(":scope > p").filter({ hasText: `Read ${label}.` });
        // Place the caret before the link with a real click, then enter it with the keyboard.
        await setPointerSelection(paragraph, () => paragraph.click({ position: { x: 2, y: 10 } }));
        for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowRight");
        await expect.poll(() => paragraph.locator("a").evaluate(element => {
          const selection = document.getSelection();
          return selection?.isCollapsed && element.contains(selection.anchorNode);
        })).toBe(true);
      };
      for (const open of ["click", "Enter"] as const) {
        const link = side.locator(`a.ub-doclink[data-doc-id="${target}"]`);
        await expect(link).toHaveAttribute("data-doc-id", target);
        if (open === "click") {
          await link.click();
        } else {
          await caretInLink("the linked document");
          await page.keyboard.press("Enter");
        }
        await expect(page).toHaveURL(new RegExp(`/${harness().workspace}/${target}$`));
        await expect(page.locator(".ub-title")).toHaveValue(targetTitle);
        await expect(split).toHaveCount(0);
        await page.goBack();
        await expect(page.locator(".ub-title")).toHaveValue(title);
        await previous(page);
        await expect(split).toBeVisible();
      }
      await caretInLink("the external page");
      const [popup] = await Promise.all([
        page.context().waitForEvent("page", { timeout: 5_000 }),
        page.keyboard.press("Enter"),
      ]);
      try {
        await expect(popup).toHaveURL("https://example.invalid/history-link");
      } finally {
        await popup.close();
        await page.bringToFront();
      }
      const deletedLink = side.locator(`a.ub-doclink[data-doc-id="${deleted}"]`);
      await expect(deletedLink).toHaveAttribute("data-doc-link-state", "deleted");
      await expect(deletedLink).not.toHaveAttribute("href");
      await deletedLink.click();
      await expect(page).toHaveURL(sourceAddress);
      await expect(split).toBeVisible();
      await caretInLink("the deleted document");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(sourceAddress);
      await expect(split).toBeVisible();
      const original = await side.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getJSON());
      for (const block of [side.getByRole("listitem"), side.locator("td").last()]) {
        for (const key of ["Tab", "Shift+Tab"]) {
          await setPointerSelection(block, () => block.click());
          await expect(side).toBeFocused();
          await page.keyboard.press(key);
          await expect.poll(() => side.evaluate(element => element.contains(document.activeElement))).toBe(false);
        }
      }
      expect(await side.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(original);
    }
  });

  test("folding a section boundary keeps the next change and its fold bar visible", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 640 } } });
    const title = docTitle("Folded toggle boundary");
    const uuid = await newDocument(page, title);
    const document = new Y.Doc();
    let states: Record<string, string>;
    try {
      initDoc(document, { uuid, title });
      appendBlock(document, { type: "heading", level: 2, text: "> Details" });
      const inside = appendBlock(document, { type: "paragraph", text: "Inside section" });
      appendBlock(document, { type: "paragraph", text: "Context after first change" });
      appendBlock(document, { type: "heading", level: 2, text: "Outside section" });
      appendBlock(document, { type: "paragraph", text: "Quiet block" });
      appendBlock(document, { type: "paragraph", text: "Context before second change" });
      const outside = appendBlock(document, { type: "paragraph", text: "Outside section change" });
      appendBlock(document, { type: "paragraph", text: "Long unchanged tail. ".repeat(100) });
      const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
      editBlock(document, inside, "Inside section", "Inside section changed");
      editBlock(document, outside, "Outside section change", "Outside section change changed");
      states = { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
    } finally { document.destroy(); }
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], states);
    await previous(page);
    for (const side of [earlierSide(page), historicalEditor(page)]) {
      const bar = side.locator(".ub-revision-fold-button");
      await expect(bar).toHaveText("2 unchanged blocks · Outside section");
      await expect(bar).toBeVisible();
      await expect(side.locator("p").filter({ hasText: "Outside section change" })).toBeVisible();
      await expect(side.locator("p").filter({ hasText: "Inside section" })).toBeHidden();
      await expect(side).not.toContainText("Quiet block");
    }
    await historicalEditor(page).locator(".ub-revision-fold-button").click();
    for (const side of [earlierSide(page), historicalEditor(page)]) {
      await expect(side.getByRole("heading", { name: "Outside section", exact: true })).toBeVisible();
      await expect(side.getByText("Quiet block", { exact: true })).toBeVisible();
      await expect(side.locator("p").filter({ hasText: "Outside section change" })).toBeVisible();
    }
  });

  test("a changed json-tree block spans both columns with paired rows and its own Collapse unchanged switch", async ({ browser }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 1000 } } });
    const title = docTitle("JSON comparison");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: { githubUsername: "Ben", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: { githubUsername: "browser-person", surface: { kind: "browser", name: "Browser" } }, startedAt: 1_000, endedAt: 2_000 },
    ], jsonHistory(uuid, title));
    await previous(page);
    const split = page.locator(".ub-revision-split");
    await expect(split).toBeVisible();
    const compare = page.locator(".ub-json-compare");
    await expect(compare).toBeVisible();
    // The block covers both columns: it starts where the left side starts and ends where the right side ends.
    const bounds = await page.evaluate(() => {
      const [left, right] = [...document.querySelectorAll<HTMLElement>(".ub-revision-split .ProseMirror")].map((side) => side.getBoundingClientRect());
      const block = document.querySelector(".ub-json-compare")?.getBoundingClientRect();
      return { left: left?.left, right: right?.right, blockLeft: block?.left, blockRight: block?.right };
    });
    expect(Math.abs((bounds.blockLeft ?? 0) - (bounds.left ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((bounds.blockRight ?? 0) - (bounds.right ?? 0))).toBeLessThanOrEqual(1);
    await expect(compare.locator("mark.ub-json-compare-added").first()).toHaveText("9");
    await expect(compare.locator("mark.ub-json-compare-removed").first()).toHaveText("8");
    await expect(compare.locator(".ub-json-compare-note")).toContainText(["moved from [1]"]);
    await expect(compare.locator(".ub-json-compare-after .ub-json-compare-run")).toHaveText(["3 unchanged keys"]);
    // Rows after the block still line up on both sides.
    const aligned = () => page.evaluate(() => {
      const sides = [...document.querySelectorAll<HTMLElement>(".ub-revision-split .ProseMirror")];
      const rows = sides.map(side => [...side.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-start")]
        .map(start => start.getBoundingClientRect().top).concat(side.getBoundingClientRect().bottom));
      const [left = [], right = []] = rows;
      return left.length === right.length && left.every((top, index) => Math.abs(top - (right[index] ?? Number.NaN)) <= 1);
    });
    await expect.poll(aligned).toBe(true);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const screenshot = info.outputPath(`json-compare-${scheme}.png`);
      await compare.screenshot({ path: screenshot });
      await info.attach(`json-compare-${scheme}`, { path: screenshot, contentType: "image/png" });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await compare.getByRole("switch", { name: "Collapse unchanged" }).uncheck();
    await expect(compare.locator(".ub-json-compare-run")).toHaveCount(0);
    await expect(compare).toContainText('"timeout": 30');
    await expect.poll(aligned).toBe(true);
    // Each cell pair starts at the same height.
    expect(await compare.evaluate((element) => [...element.querySelectorAll(".ub-json-compare-row")].every((row) => {
      const [left, right] = [...row.children].map((cell) => cell.getBoundingClientRect().top);
      return Math.abs((left ?? 0) - (right ?? 0)) <= 1;
    }))).toBe(true);
  });

  test("unchanged runs fold on both sides, open on demand, and changes are one step apart", async ({ browser }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 640 } } });
    const title = docTitle("Folded comparison");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], foldHistory(uuid, title));
    await previous(page);
    const after = historicalEditor(page);
    const before = earlierSide(page);
    // The heading and the paragraph next to each change stay as context.
    const bars = page.locator(".ub-revision-fold-button");
    await expect(bars).toHaveCount(2);
    await expect(after.locator(".ub-revision-fold-button")).toHaveText("10 unchanged blocks · Approach");
    await expect(before.locator(".ub-revision-fold-button")).toHaveText("10 unchanged blocks · Approach");
    await expect(after).not.toContainText("Background paragraph 2");
    await expect(after).toContainText("Approach paragraph 5");
    await expect(page.locator(".ub-revision-pane").getByText("Background paragraph 1", { exact: false })).toHaveCount(0);
    const screenshot = info.outputPath("folded.png");
    await page.screenshot({ path: screenshot });
    await info.attach("folded", { path: screenshot, contentType: "image/png" });
    // Folded, both changes fit on screen: there is nowhere to step to.
    const previousChange = page.getByRole("button", { name: "Previous change", exact: true });
    const nextChange = page.getByRole("button", { name: "Next change", exact: true });
    await expect(previousChange).toBeDisabled();
    await expect(nextChange).toBeDisabled();
    // Bars open their run from the keyboard.
    await after.locator(".ub-revision-fold-button").focus();
    await expect(after.locator(".ub-revision-fold-button")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(bars).toHaveCount(0);
    await expect(after).toContainText("Background paragraph 2");
    await expect(before).toContainText("Background paragraph 2");
    // Previous and next change step between the two changes.
    await expect(previousChange).toBeDisabled();
    await expect(nextChange).toBeEnabled();
    await activateControl(nextChange);
    const closing = after.locator("p").filter({ hasText: "The closing line changed." });
    // The last change sits near the end, so the pane stops at the bottom with it in view below the header.
    const pane = page.locator(".ub-revision-pane");
    await expect.poll(() => pane.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
    await expect.poll(async () => {
      const line = await page.locator(".ub-revision-header").evaluate(element => element.getBoundingClientRect().bottom);
      const start = await closing.evaluate(element => element.getBoundingClientRect().top);
      return start > line && start < 640;
    }).toBe(true);
    await expect(previousChange).toBeEnabled();
    await expect(nextChange).toBeDisabled();
    await activateControl(previousChange);
    await expect.poll(() => page.locator(".ub-revision-pane").evaluate(element => element.scrollTop)).toBeLessThan(40);
    // The switch turns folding off for this browser, across a reload.
    if (!await historyList(page).isVisible()) await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
    const collapse = historyList(page).getByRole("switch", { name: "Collapse unchanged" });
    await expect(collapse).toBeChecked();
    await activateControl(collapse);
    await expect(collapse).not.toBeChecked();
    await page.reload();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await previous(page);
    await expect(historicalEditor(page)).toContainText("Background paragraph 2");
    await expect(page.locator(".ub-revision-fold-button")).toHaveCount(0);
    await expect(historyList(page).getByRole("switch", { name: "Collapse unchanged" })).not.toBeChecked();
    await activateControl(historyList(page).getByRole("switch", { name: "Collapse unchanged" }));
    await expect(bars).toHaveCount(2);
    await earlierSide(page).locator(".ub-revision-fold-button").focus();
    await expect(earlierSide(page).locator(".ub-revision-fold-button")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(bars).toHaveCount(0);
    // The pane still scrolls natively.
    await page.mouse.move(900, 400);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => page.locator(".ub-revision-pane").evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  });

  test("the overview ruler maps the comparison, follows scrolling, folding and growth, and scrolls on press and drag", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 640 } } });
    const title = docTitle("Ruler comparison");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], foldHistory(uuid, title));
    await previous(page);
    const ruler = page.getByTestId("revision-ruler");
    await expect(ruler).toBeVisible();
    const pane = page.locator(".ub-revision-pane");
    // A fine pointer scrolls with the ruler; the native scrollbar steps aside.
    await expect.poll(() => pane.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe("none");
    await expect.poll(() => runningMotion(page)).toBe(0);
    // It starts level with the first row and ends just above the pane's bottom edge.
    let geometry = await rulerGeometry(page);
    expect(Math.abs(geometry.top - geometry.firstRow)).toBeLessThan(1.5);
    expect(Math.abs(geometry.paneBottom - 12 - geometry.bottom)).toBeLessThan(1.5);
    // Folded, everything fits: one box covers every mark, and pressing scrolls nowhere.
    expect(geometry.marks.filter((mark) => mark.kind === "changed")).toHaveLength(2);
    expect(geometry.marks.filter((mark) => mark.kind === "fold")).toHaveLength(1);
    const last = geometry.marks.at(-1);
    expect(geometry.view.top).toBeLessThan(0.5);
    expect(Math.abs(geometry.view.height - ((last?.top ?? 0) + (last?.height ?? 0)))).toBeLessThan(4);
    const track = await ruler.boundingBox();
    if (track === null) throw new Error("The ruler has no box");
    await page.mouse.click(track.x + 7, track.y + track.height - 4);
    expect((await rulerGeometry(page)).scrollTop).toBe(0);
    // Opening the run maps every row; the box now shows only part of it.
    await activateControl(historicalEditor(page).locator(".ub-revision-fold-button"));
    await expect.poll(async () => (await rulerGeometry(page)).marks.length).toBeGreaterThan(geometry.marks.length);
    await expect.poll(() => runningMotion(page)).toBe(0);
    geometry = await rulerGeometry(page);
    expect(geometry.maxScroll).toBeGreaterThan(0);
    expect(geometry.view.height).toBeLessThan(track.height - 20);
    // Changes are marked by the same rule as previous and next change.
    expect(geometry.marks.filter((mark) => mark.kind === "changed")).toHaveLength(2);
    // Scrolling moves the box in proportion.
    await pane.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
    await expect.poll(async () => (await rulerGeometry(page)).view.top).toBeGreaterThan(geometry.view.top + 20);
    // Pressing below the box centres that place; dragging the box carries the pane with it.
    await pane.evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(async () => (await rulerGeometry(page)).view.top).toBeLessThan(0.5);
    await page.mouse.click(track.x + 7, track.y + track.height - 4);
    await expect.poll(async () => { const now = await rulerGeometry(page); return now.maxScroll - now.scrollTop; }).toBeLessThan(2);
    const box = (await rulerGeometry(page)).view;
    await page.mouse.move(track.x + 7, track.y + box.top + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + 7, track.y + box.height / 2 - 40, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await rulerGeometry(page)).scrollTop).toBe(0);
    // A drawing or image that loads late grows its row, and the marks follow it.
    const firstMark = (await rulerGeometry(page)).marks[0]?.height ?? 0;
    // A stylesheet changes layout without asking ProseMirror to repair a DOM mutation.
    const growth = await page.addStyleTag({ content: ".ub-revision-side-after .ProseMirror > .ub-revision-row-start:first-child + .ub-revision-row { padding-bottom: 400px; }" });
    await expect.poll(async () => (await rulerGeometry(page)).marks[0]?.height ?? 0).toBeGreaterThan(firstMark + 20);
    await growth.evaluate((element) => { element.parentNode?.removeChild(element); });
    // A taller window gives a taller ruler, still ending above the pane's edge.
    await page.setViewportSize({ width: 1440, height: 820 });
    await expect.poll(async () => { const now = await rulerGeometry(page); return Math.abs(now.paneBottom - 12 - now.bottom); }).toBeLessThan(1.5);
    // Rapid toggles settle on the instant result, with no copy or hidden control left behind.
    const collapse = historyList(page).getByRole("switch", { name: "Collapse unchanged" });
    for (let toggle = 0; toggle < 5; toggle += 1) await collapse.click();
    await expect(collapse).not.toBeChecked();
    await expect.poll(() => runningMotion(page)).toBe(0);
    await expect(page.locator(".ub-revision-ghost")).toHaveCount(0);
    await expect(page.locator(".ub-revision-fold-button")).toHaveCount(0);
    await collapse.click();
    await expect(page.locator(".ub-revision-fold-button")).toHaveCount(2);
    // While rows close into their bar, their copy is inert.
    await expect.poll(() => page.locator(".ub-revision-ghost").evaluateAll((ghosts) => ghosts.every((ghost) => (ghost as HTMLElement).inert))).toBe(true);
    await expect.poll(() => runningMotion(page)).toBe(0);
    await expect(page.locator(".ub-revision-ghost")).toHaveCount(0);
  });

  test("the revision header morphs both ways, slides between titles, and never holds up leaving", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1280, height: 800 } } });
    const title = docTitle("A long plan title that wraps onto a second line in the live document view");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], renamedHistory(uuid, title));
    // A scrolled live document: its title stands partly above the pane.
    const live = page.locator(".ub-document-pane:not(.ub-revision-pane)");
    await live.locator(".ub-column").evaluate((element) => { (element as HTMLElement).style.paddingBottom = "2000px"; });
    await live.evaluate((element) => { element.scrollTop = 24; });
    const start = await live.locator(".ub-title").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, left: rect.left, height: rect.height, size: Number.parseFloat(getComputedStyle(element).fontSize) };
    });
    expect(start.height).toBeGreaterThan(start.size * 1.8);
    await history(page).getByRole("button", { name: "Previous revision", exact: true }).click();
    // At its first frame the revision title stands exactly where the live title stood.
    const first = await page.evaluate(() => {
      const heading = document.querySelector(".ub-revision-title");
      const morph = heading?.getAnimations().find((animation) => animation instanceof CSSAnimation === false);
      if (heading == null || morph === undefined) return null;
      morph.pause();
      morph.currentTime = 0;
      const rect = heading.getBoundingClientRect();
      morph.play();
      return { top: rect.top, left: rect.left };
    });
    expect(first).not.toBeNull();
    expect(Math.abs((first?.top ?? 0) - start.top)).toBeLessThan(2);
    expect(Math.abs((first?.left ?? 0) - start.left)).toBeLessThan(2);
    await expect.poll(() => runningMotion(page)).toBe(0);
    const heading = page.locator(".ub-revision-title");
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    // Record where stepped content starts: it comes from the side its revision lies on.
    await page.evaluate(() => {
      const steps: string[] = [];
      Object.assign(window, { revisionSteps: steps });
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, keyframes, options) {
        const first = Array.isArray(keyframes) ? keyframes[0] : undefined;
        if (this.matches(".ub-revision-split, .ub-revision-pane .ub-revision-view")) steps.push(String(first?.transform ?? ""));
        const animation = animate.call(this, keyframes, options);
        // Freeze the returning live layout to check its start and immediate usability.
        if (this.closest(".ub-document-pane:not(.ub-revision-pane)") !== null) { animation.pause(); animation.currentTime = 0; }
        return animation;
      };
    });
    const steps = () => page.evaluate(() => (window as unknown as { revisionSteps: string[] }).revisionSteps);
    // Stepping to a revision under another title slides the old one out; the heading names only the new one.
    await history(page).getByRole("button", { name: "Previous revision", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Earlier draft", exact: true })).toBeVisible();
    await expect(heading.locator("[data-leaving]")).toHaveCount(0);
    await expect(heading).toHaveText("Earlier draft");
    await expect.poll(steps).toEqual(["translateX(-40px)"]);
    await history(page).getByRole("button", { name: "Next revision", exact: true }).click();
    await expect(heading).toHaveText(title);
    await expect.poll(steps).toEqual(["translateX(-40px)", "translateX(40px)"]);
    await expect.poll(() => runningMotion(page)).toBe(0);
    const from = await page.locator(".ub-revision-header").evaluate(element => {
      const heading = element.querySelector<HTMLElement>(".ub-revision-title");
      const title = heading?.getBoundingClientRect();
      const status = element.querySelector(".ub-history-controls")?.getBoundingClientRect();
      return { title: { top: title?.top, left: title?.left }, status: status?.top,
        size: heading == null ? 0 : Number.parseFloat(getComputedStyle(heading).fontSize) * (title?.height ?? 0) / heading.offsetHeight };
    });
    await backToNow(page);
    await expect(editor(page)).toBeVisible();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(page.locator(".ub-revision-pane")).toHaveCount(0);
    await expect(history(page).getByRole("button", { name: "Previous revision", exact: true })).toBeFocused();
    const returning = await live.evaluate(element => {
      const title = element.querySelector<HTMLElement>(".ub-title");
      const rect = title?.getBoundingClientRect();
      const status = element.querySelector(".ub-status")?.getBoundingClientRect();
      return { title: { top: rect?.top ?? 0, left: rect?.left ?? 0 }, status: status?.top ?? 0,
        size: title === null ? 0 : Number.parseFloat(getComputedStyle(title).fontSize) * (rect?.height ?? 0) / title.offsetHeight,
        paused: element.getAnimations({ subtree: true }).filter(animation => animation.playState === "paused").length };
    });
    expect(returning.paused).toBeGreaterThan(0);
    expect(Math.abs(returning.title.top - (from.title.top ?? 0))).toBeLessThan(2);
    expect(Math.abs(returning.title.left - (from.title.left ?? 0))).toBeLessThan(2);
    expect(Math.abs(returning.size - from.size)).toBeLessThan(1);
    expect(Math.abs(returning.status - (from.status ?? 0))).toBeLessThan(2);
    await live.evaluate(element => { for (const animation of element.getAnimations({ subtree: true })) animation.finish(); });
    const landed = await live.locator(".ub-title").boundingBox();
    expect(Math.abs((landed?.y ?? 0) - start.top)).toBeLessThan(2);
    expect(Math.abs((landed?.x ?? 0) - start.left)).toBeLessThan(2);
    expect(Math.abs((landed?.height ?? 0) - start.height)).toBeLessThan(2);
    expect(await live.evaluate(element => element.scrollTop)).toBe(24);
    // Leaving during arrival and reopening during the reverse never delays navigation.
    await history(page).getByRole("button", { name: "Previous revision", exact: true }).click();
    await backToNow(page);
    await expect(editor(page)).toBeVisible();
    await history(page).getByRole("button", { name: "Previous revision", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".ub-revision-pane")).toBeVisible();
    expect(await live.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    await backToNow(page);
    await live.evaluate(element => { for (const animation of element.getAnimations({ subtree: true })) animation.finish(); });
    await expect(page.locator(".ub-revision-pane")).toHaveCount(0);
    expect(await page.evaluate(() => document.getAnimations().filter((animation) =>
      animation.effect instanceof KeyframeEffect && animation.effect.target instanceof Element && !animation.effect.target.isConnected && animation.playState === "running").length)).toBe(0);
  });

  test("with reduced motion, history arrives, steps and folds without animating", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 640 }, reducedMotion: "reduce" } });
    const title = docTitle("Still comparison");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], foldHistory(uuid, title));
    await previous(page);
    expect(await runningMotion(page)).toBe(0);
    await expect(page.getByTestId("revision-ruler")).toBeVisible();
    await activateControl(historicalEditor(page).locator(".ub-revision-fold-button"));
    await expect(historicalEditor(page)).toContainText("Background paragraph 2");
    expect(await runningMotion(page)).toBe(0);
    await expect(page.locator(".ub-revision-ghost")).toHaveCount(0);
    await backToNow(page);
    await expect(editor(page)).toBeVisible();
    await expect(history(page).getByRole("button", { name: "Previous revision", exact: true })).toBeFocused();
    expect(await runningMotion(page)).toBe(0);
  });

  test("Back to now in the history drawer closes it and returns focus to the live history control", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1024, height: 768 } } });
    const title = docTitle("History drawer return");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [{ id: "latest", author: null, startedAt: 1_000, endedAt: null }], {
      latest: savedState(uuid, title, "Historical content."),
    });
    await previous(page);
    await expect(historicalEditor(page)).toHaveText("Historical content.");
    expect(await showHistoryList(page)).toBe(true);
    const drawer = page.getByRole("dialog", { name: "Sidebar", exact: true });
    await expect(drawer).toBeVisible();
    await activateControl(historyList(page).getByRole("button", { name: "Back to now", exact: true }));
    await expect(drawer).toBeHidden();
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(history(page).getByRole("button", { name: "Previous revision", exact: true })).toBeFocused();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });

  test("rename markers are available before visiting and survive a named comparison without misattributing the rename", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const uuid = await newDocument(page, docTitle("Rename attribution"));
    const person = { githubUsername: "browser-person", surface: { kind: "browser" as const, name: "Browser" } };
    const snapshotReads = await serveHistory(page, [
      { id: "latest", title: "Beta", author: { ...person, githubUsername: "Latest author" }, startedAt: 3_000, endedAt: null },
      { id: "middle", title: "Beta", author: { ...person, githubUsername: "Middle author" }, startedAt: 2_000, endedAt: 3_000 },
      { id: "baseline", title: "Alpha", author: person, startedAt: 1_000, endedAt: 2_000,
        name: { text: "Kickoff", namer: person, namedAt: 2_000, canManage: true } },
    ], {
      latest: savedState(uuid, "Beta", "Latest content."),
      middle: savedState(uuid, "Beta", "Middle content."),
      baseline: savedState(uuid, "Alpha", "Baseline content."),
    });
    await previous(page);
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(history(page)).not.toContainText("renamed from");
    let drawer = await showHistoryList(page);
    const list = historyList(page);
    const middle = list.getByRole("button", { name: /Middle author/ });
    await expect(middle).toContainText("renamed");
    expect(snapshotReads).toEqual(["latest", "middle"]);
    await expect(list.getByRole("button", { name: /Latest author/ })).not.toContainText("renamed");
    await activateControl(middle);
    await expect(historicalEditor(page)).toContainText("Middle content.");
    await closeHistoryList(page, drawer);
    await expect(history(page).locator(".ub-history-renamed s")).toHaveText("Alpha");
    drawer = await showHistoryList(page);
    const since = list.getByRole("button", { name: "Changes since this name", exact: true });
    await activateControl(since);
    await expect(since).toHaveAttribute("aria-current", "true");
    await closeHistoryList(page, drawer);
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(history(page)).toContainText("compared with “Kickoff”");
    await expect(history(page)).not.toContainText("renamed from");
    await showHistoryList(page);
    await expect(middle).toContainText("renamed");
  });

  test("an older hub's title-less list keeps history available without markers or background snapshot reads", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const uuid = await newDocument(page, docTitle("Legacy revision titles"));
    const person = { githubUsername: "browser-person", surface: { kind: "browser" as const, name: "Browser" } };
    const snapshotReads = await serveHistory(page, [
      { id: "latest", author: { ...person, githubUsername: "Latest author" }, startedAt: 3_000, endedAt: null },
      { id: "middle", author: { ...person, githubUsername: "Middle author" }, startedAt: 2_000, endedAt: 3_000 },
      { id: "baseline", author: person, startedAt: 1_000, endedAt: 2_000,
        name: { text: "Kickoff", namer: person, namedAt: 2_000, canManage: true } },
    ], {
      latest: savedState(uuid, "Alpha", "Latest content."),
      middle: savedState(uuid, "Beta", "Middle content."),
      baseline: savedState(uuid, "Alpha", "Baseline content."),
    });
    await previous(page);
    await expect(historicalEditor(page)).toContainText("Latest content.");
    let drawer = await showHistoryList(page);
    expect(snapshotReads).toEqual(["latest", "middle"]);
    await expect(historyList(page).locator(".ub-history-renamed-tag")).toHaveCount(0);
    await activateControl(historyList(page).getByRole("button", { name: /Middle author/ }));
    await expect(historicalEditor(page)).toContainText("Middle content.");
    await closeHistoryList(page, drawer);
    await expect(history(page)).not.toContainText("renamed from");
    drawer = await showHistoryList(page);
    await activateControl(historyList(page).getByRole("button", { name: "Changes since this name", exact: true }));
    await closeHistoryList(page, drawer);
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(history(page)).toContainText("compared with “Kickoff”");
    await expect(history(page)).not.toContainText("renamed from");
    await expect(history(page)).not.toContainText("unavailable");
    await showHistoryList(page);
    await expect(historyList(page).locator(".ub-history-renamed-tag")).toHaveCount(0);
    expect(snapshotReads).toEqual(["latest", "middle", "baseline", "latest", "baseline"]);
  });

  test("a named comparison attributes a rename back to the immediate predecessor", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const uuid = await newDocument(page, docTitle("Rename back attribution"));
    const person = { githubUsername: "browser-person", surface: { kind: "browser" as const, name: "Browser" } };
    await serveHistory(page, [
      { id: "latest", title: "Alpha", author: person, startedAt: 3_000, endedAt: 4_000 },
      { id: "middle", title: "Beta", author: person, startedAt: 2_000, endedAt: 3_000 },
      { id: "baseline", title: "Alpha", author: person, startedAt: 1_000, endedAt: 2_000,
        name: { text: "Kickoff", namer: person, namedAt: 2_000, canManage: true } },
    ], {
      latest: savedState(uuid, "Alpha", "Latest content."),
      middle: savedState(uuid, "Beta", "Middle content."),
      baseline: savedState(uuid, "Alpha", "Baseline content."),
    });
    await previous(page);
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(history(page).locator(".ub-history-renamed s")).toHaveText("Beta");
    await expect(history(page).locator(".ub-history-when")).toContainText("· current version");
    await expect(history(page).locator(".ub-history-when time")).toHaveAttribute("datetime", new Date(4_000).toISOString());
    const drawer = await showHistoryList(page);
    const since = historyList(page).getByRole("button", { name: "Changes since this name", exact: true });
    await activateControl(since);
    await expect(since).toHaveAttribute("aria-current", "true");
    await closeHistoryList(page, drawer);
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(history(page)).toContainText("compared with “Kickoff”");
    await expect(history(page).locator(".ub-history-renamed s")).toHaveText("Beta");
    await expect(history(page).locator(".ub-history-when")).toContainText("· current version");
    await expect(history(page).locator(".ub-history-when time")).toHaveAttribute("datetime", new Date(4_000).toISOString());
  });

  test("opening history preserves unsent comment and reply drafts", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Retained discussion drafts");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [{ id: "earlier", author: null, startedAt: 1_000, endedAt: null }], {
      earlier: savedState(uuid, title, "Historical text without comments."),
    });
    await activateControl(editor(page));
    await page.keyboard.type("First comment target. Another comment target.");
    await selectPositions(editor(page), 1, 6);
    await activateControl(page.getByRole("button", { name: "Comment", exact: true }));
    await page.getByPlaceholder(/Comment as/).fill("A saved comment.");
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Threads", exact: true });
    await expect(page.getByRole("region", { name: "Threads", exact: true })).toContainText("A saved comment.");
    await activateControl(page.getByRole("button", { name: "Reply", exact: true }));
    await page.getByPlaceholder("Reply…").fill("An unsent reply.");
    if (await sheet.isVisible()) await activateControl(sheet.getByRole("button", { name: "Close threads", exact: true }));
    await selectPositions(editor(page), 23, 30);
    await activateControl(page.getByRole("button", { name: "Comment", exact: true }));
    const comment = page.getByPlaceholder(/Comment as/);
    await comment.fill("An unsent comment.");
    await history(page).getByRole("button", { name: "Previous revision", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toHaveText("Historical text without comments.");
    await expect(comment).toBeHidden();
    await expect(page.getByRole("region", { name: "Threads", exact: true })).toHaveCount(0);
    await expect(sheet).toBeHidden();
    await backToNow(page);
    await expect(comment).toHaveValue("An unsent comment.");
    await expect(comment).toBeVisible();
    await activateControl(page.locator('[data-slot="selection-composer"]').getByRole("button", { name: "Cancel", exact: true }));
    const toggle = page.locator(".ub-threads-toggle");
    if (await toggle.isVisible()) await activateControl(toggle);
    await expect(page.getByPlaceholder("Reply…")).toHaveValue("An unsent reply.");
  });

  test("returning to now preserves an offline draft and history labels expose unknown attribution", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Offline current draft");
    const uuid = await newDocument(page, title);
    const room = `${harness().workspaceUuid}/${uuid}`;
    await activateControl(editor(page));
    await page.keyboard.type("Shared current content.");
    await expect.poll(() => harness().hubText(room)).toBe("Shared current content.");
    await serveHistory(page, [
      { id: "agent", author: { githubUsername: "Ben", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: null, endedAt: 1_000 },
    ], {
      agent: savedState(uuid, title, "Earlier agent content."),
      earlier: savedState(uuid, title, "Earlier content."),
    });
    await expect(history(page).getByRole("button", { name: "Previous revision", exact: true })).toBeEnabled();
    await harness().stopHub();
    try {
      await selectPositions(editor(page), 1);
      await page.keyboard.type("Unsynced draft: ");
      await expect(editor(page)).toContainText("Unsynced draft: Shared current content.");
      await previous(page);
      await expect(history(page)).toContainText("Ben via Claude Code, from ");
      await expect(history(page)).toContainText("current version");
      await previous(page);
      await expect(historicalEditor(page)).toHaveText("Earlier content.");
      await expect(history(page)).toContainText("Unknown author, unknown start to ");
      await expect(history(page)).toContainText("Earlier content");
      await backToNow(page);
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await expect(editor(page)).toContainText("Unsynced draft: Shared current content.");
    } finally {
      await harness().startHub();
    }
    await expect.poll(() => harness().hubText(room)).toBe("Unsynced draft: Shared current content.");
  });

  test("empty history is stated explicitly", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await newDocument(page, docTitle("No revisions"));
    await serveHistory(page, [], {});
    await previous(page);
    await expect(page.locator(".ub-revision-pane").getByRole("status")).toHaveText("No revisions yet");
    await expect(historicalEditor(page)).toHaveCount(0);
    await backToNow(page);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });

  test("a data-only revision draws its own chart and generated-table numbers", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Historical data projections");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], dataHistory(uuid, title));
    await previous(page);
    const view = historicalEditor(page);
    const table = view.getByRole("table", { name: "Historical measurements", exact: true });
    await expect(table.locator("tbody tr")).toHaveText(["2026-10-2090 ms", "2026-10-21100 ms"]);
    await expect(view.locator(".ub-revision-fields")).toHaveText(["Data changed: measurements", "Data changed: measurements"]);
    const chart = view.locator(".ub-chart").filter({ has: page.getByRole("img", { name: "Historical latency", exact: true }) });
    await expect(chart).toHaveAttribute("data-draw-state", "success");
    await expect(chart.locator(".ub-chart-description")).toContainText("Latest values: Latency: 100 ms.");
    if (await page.locator(".ub-revision-split").isVisible()) {
      // Side by side, the predecessor draws its own numbers with the same mapping.
      const earlier = earlierSide(page);
      await expect(earlier.getByRole("table", { name: "Historical measurements", exact: true }).locator("tbody tr")).toHaveText(["2026-10-2010 ms", "2026-10-2120 ms"]);
      await expect(earlier.locator(".ub-chart").filter({ has: page.getByRole("img", { name: "Historical latency", exact: true }) })
        .locator(".ub-chart-description")).toContainText("Latest values: Latency: 20 ms.");
    }
    await previous(page);
    await expect(table.locator("tbody tr")).toHaveText(["2026-10-2010 ms", "2026-10-2120 ms"]);
    await expect(chart).toHaveAttribute("data-draw-state", "success");
    await expect(chart.locator(".ub-chart-description")).toContainText("Latest values: Latency: 20 ms.");
    await expect(view.locator(".ub-revision-fields")).toHaveCount(0);
    await backToNow(page);
    await expect(editor(page).locator(".ub-chart")).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });

  for (const [reason, message] of [
    ["unreachable", "History is unavailable: the hub cannot be reached."],
    ["sign-in-required", "History is unavailable: sign in to the hub on this computer."],
    ["forbidden", "History is unavailable: the hub refused access."],
    ["unsupported", "History is unavailable: this hub does not serve revisions."],
  ] as const) {
    test(`unavailable history explains ${reason} and can be retried`, async ({ browser }) => {
      const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
      await page.route("**/api/revisions?**", route => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: "history_unavailable", reason }),
      }));
      await newDocument(page, docTitle(`Unavailable ${reason}`));
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await previous(page);
      const state = page.locator(".ub-revision-pane").getByRole("status");
      await expect(state).toHaveText(message);
      await expect(historicalEditor(page)).toHaveCount(0);
      await page.unroute("**/api/revisions?**");
      await serveHistory(page, [], {});
      await activateControl(page.locator(".ub-revision-pane").getByRole("button", { name: "Try again", exact: true }));
      await expect(state).toHaveText("No revisions yet");
      await backToNow(page);
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    });
  }
});

test.describe("local-only document history", () => {
  const { openApp } = setupHarness({ accessRole: "admin", localWorkspace: true });

  test("a local-only workspace shows no time-travel control", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await newDocument(page, docTitle("Local document"));
    await expect(history(page)).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });
});

function toggleNavigationHistory(uuid: string, title: string, nested: boolean): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    const first = appendBlock(document, { type: "paragraph", text: "First" });
    appendBlock(document, { type: "paragraph", text: "Long context ".repeat(50) });
    appendBlock(document, { type: "heading", level: 2, text: "> Details" });
    if (nested) appendBlock(document, { type: "heading", level: 3, text: "> Nested details" });
    const inside = appendBlock(document, { type: "paragraph", text: "Inside section" });
    appendBlock(document, { type: "heading", level: 2, text: "End" });
    appendBlock(document, { type: "paragraph", text: "Tail ".repeat(400) });
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    editBlock(document, first, "First", "First changed");
    editBlock(document, inside, "Inside section", "Inside section changed");
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

test.describe("change navigation through authored toggles", () => {
  const { openApp } = setupHarness({ accessRole: "admin" });

  for (const nested of [false, true]) {
    test(`change navigation reveals ${nested ? "nested " : ""}toggle content in both directions and comparison sides`, { tag: "@webkit" }, async ({ browser }) => {
      const page = await openApp(browser, "/", { readySelector: ".ub-pane",
        contextOptions: { viewport: { width: 1440, height: 640 }, reducedMotion: "reduce" } });
      const title = docTitle("Change inside authored toggles");
      const uuid = await newDocument(page, title);
      await serveHistory(page, [
        { id: "latest", author: null, startedAt: 2_000, endedAt: null },
        { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
      ], toggleNavigationHistory(uuid, title, nested));
      await previous(page);
      const sides = [earlierSide(page), historicalEditor(page)];
      await expect(page.locator(".ub-revision-fold-button")).toHaveCount(0);
      for (const side of sides) {
        await expect(side.locator(":scope > p").filter({ hasText: "Inside section" })).toBeHidden();
      }
      const nextChange = page.getByRole("button", { name: "Next change", exact: true });
      const previousChange = page.getByRole("button", { name: "Previous change", exact: true });
      const assertDestination = async (): Promise<void> => {
        for (const side of sides) {
          const destination = side.locator(":scope > p").filter({ hasText: "Inside section" });
          await expect(destination).toBeVisible();
          await expect(side.getByRole("button", { name: "Collapse Details", exact: true })).toHaveAttribute("aria-expanded", "true");
          if (nested) await expect(side.getByRole("button", { name: "Collapse Nested details", exact: true })).toHaveAttribute("aria-expanded", "true");
          await expect.poll(async () => {
            const line = await page.locator(".ub-revision-header").evaluate(element => element.getBoundingClientRect().bottom);
            const top = await destination.evaluate(element => element.getBoundingClientRect().top);
            return top >= line + 6 && top < line + 80;
          }).toBe(true);
        }
        await expect.poll(() => page.evaluate(() => {
          const rows = [...document.querySelectorAll<HTMLElement>(".ub-revision-split .ProseMirror")]
            .map(side => [...side.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-start")].map(row => row.getBoundingClientRect().top));
          const [before = [], after = []] = rows;
          return before.length === after.length && before.every((top, index) => Math.abs(top - (after[index] ?? Number.NaN)) <= 1);
        })).toBe(true);
      };
      await expect(nextChange).toBeEnabled();
      await activateControl(nextChange);
      await assertDestination();
      // Close both views again, then approach the same hidden change from below.
      for (const side of sides) {
        if (nested) await side.getByRole("button", { name: "Collapse Nested details", exact: true }).evaluate((element: HTMLButtonElement) => element.click());
        await side.getByRole("button", { name: "Collapse Details", exact: true }).evaluate((element: HTMLButtonElement) => element.click());
        await expect(side.locator(":scope > p").filter({ hasText: "Inside section" })).toBeHidden();
      }
      await page.locator(".ub-revision-pane").evaluate(element => element.scrollTo(0, element.scrollHeight));
      await expect(previousChange).toBeEnabled();
      await activateControl(previousChange);
      await assertDestination();
    });
  }
});
