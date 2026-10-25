import { createHash, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { appendBlock, applyDocData, deleteBlock, editBlock, getBlock, getBlocksFragment, initDoc, insertBlock, setKind, setStatus, setTitle, snapshotRevision, tableRows } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import * as Y from "yjs";
import { activateControl, createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import { assertNoViolations, WCAG_TAGS } from "./accessibility-assertions.js";
import { waitForAcknowledged } from "./settle.js";
import { setPointerSelection } from "./native-selection.js";
import { mockFigmaLookup } from "./figma-fixtures.js";
import { renderedText } from "./contrast-helpers.js";
import { alphaOf } from "../test/colour.js";

function history(page: Page): Locator {
  return page.getByRole("group", { name: "Document history", exact: true });
}

/** The selected revision: the right side of a side-by-side comparison, or the single column. */
function historicalEditor(page: Page): Locator {
  return page.locator('.ub-revision-pane .ProseMirror:not([aria-label="Before this revision"])');
}

async function liveText(page: Page): Promise<string> {
  return editor(page).evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.textContent);
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

/** Readable fixture names become the same UUID-shaped identities the hub serves. */
function revisionId(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function serveHistory(page: Page, revisions: RevisionEntry[], states: Record<string, string>): Promise<string[]> {
  const snapshotReads: string[] = [];
  await page.route("**/api/revisions?**", async route => {
    const revision = new URL(route.request().url()).searchParams.get("revision");
    const name = revision === null ? null : Object.keys(states).find(name => revisionId(name) === revision) ?? revision;
    if (name !== null) snapshotReads.push(name);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(name === null ? { revisions: revisions.map(entry => ({ ...entry, id: revisionId(entry.id) })) }
        : { state: states[name] }),
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

function rowEdgesHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    const paragraph = appendBlock(document, { type: "paragraph", text: "The amber paragraph changes." });
    const removed = appendBlock(document, { type: "paragraph", text: "A removed paragraph." });
    const bullet = appendBlock(document, { type: "list-item", text: "The amber bullet changes." });
    appendBlock(document, { type: "list-item", text: "An unchanged bullet." });
    const ordered = appendBlock(document, { type: "list-item", list: "ordered", text: "The amber numbered item changes." });
    appendBlock(document, { type: "list-item", list: "ordered", text: "An unchanged numbered item." });
    for (let index = 1; index <= 6; index += 1) {
      appendBlock(document, { type: "paragraph", text: `Unchanged context ${index}.` });
    }
    const table = appendBlock(document, { type: "table", text: "| Day | Latency |\n| --- | --- |\n| Mon | 10 |" });
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    editBlock(document, paragraph, "The amber paragraph changes.", "The blue paragraph changes.");
    editBlock(document, bullet, "The amber bullet changes.", "The blue bullet changes.");
    editBlock(document, ordered, "The amber numbered item changes.", "The blue numbered item changes.");
    deleteBlock(document, removed);
    insertBlock(document, paragraph, { type: "paragraph", text: "An added paragraph." });
    const rows = getBlock(document, table)?.text ?? "";
    editBlock(document, table, rows, rows.replace("10", "12"));
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

function tableWidthHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    const only = appendBlock(document, { type: "table", text: "| Day | Latency |\n| --- | --- |\n| Mon | 10 |" });
    for (let index = 1; index <= 18; index += 1) {
      appendBlock(document, { type: "paragraph", text: `Unchanged context ${index} separates the two table changes.` });
    }
    const mixed = appendBlock(document, { type: "table", text: "| Stage | Duration |\n| --- | --- |\n| Build | 10 |" });
    appendBlock(document, { type: "paragraph", text: "The closing context stays." });
    const widths = (id: string, values: number[]): void => {
      const table = getBlocksFragment(document).toArray().find(node => node instanceof Y.XmlElement && node.getAttribute("id") === id);
      if (!(table instanceof Y.XmlElement)) throw new Error("The width comparison fixture table is missing");
      for (const row of tableRows(table)) {
        for (const [column, width] of values.entries()) {
          const cell = row[column];
          if (cell === undefined) throw new Error("The width comparison fixture cell is missing");
          (cell as unknown as { setAttribute(name: string, value: unknown): void }).setAttribute("colwidth", [width]);
        }
      }
    };
    widths(only, [160, 180]);
    widths(mixed, [160, 180]);
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    widths(only, [240, 180]);
    const source = getBlock(document, mixed)?.text ?? "";
    editBlock(document, mixed, source, source.replace("10", "12"));
    widths(mixed, [240, 180]);
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

/** The first block is removed, then a tall wireframe is added before the same long tail. */
function coveredHeaderHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    const first = appendBlock(document, { type: "paragraph", text: "Removed opening content. ".repeat(40) });
    appendBlock(document, { type: "paragraph", text: "Unchanged trailing content leaves room to scroll. ".repeat(100) });
    const baseline = Buffer.from(snapshotRevision(document).state).toString("base64");
    deleteBlock(document, first);
    const removed = Buffer.from(snapshotRevision(document).state).toString("base64");
    insertBlock(document, null, { type: "code", language: "wireframe", text:
      "dialog Added opening wireframe\n  text First field\n  text Second field\n  text Third field\n  text Fourth field\n  text Fifth field\n  text Sixth field\n  row.end\n    button Continue" });
    return { baseline, removed, added: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

/** A json-tree block whose items move, gain one entry and change a version string. */
function jsonHistory(uuid: string, title: string, sources?: { before: string; after: string }): Record<string, string> {
  const document = new Y.Doc();
  const agents = (entries: { id: string; image: string }[]) => JSON.stringify({ service: "planner", agents: entries,
    limits: { tokens: 4096, price: 1.5, retries: 3, timeout: 30, region: "eu" }, owner: "platform", tier: "standard", zone: "eu-central" }, null, 2);
  const before = sources?.before ?? agents([{ id: "implementer", image: "ub-hub:0.4.8" }, { id: "reviewer", image: "ub-hub:0.4.8" }]);
  const after = sources?.after ?? agents([{ id: "reviewer", image: "ub-hub:0.4.8" }, { id: "implementer", image: "ub-hub:0.4.9" }, { id: "preparer", image: "ub-hub:0.4.9" }]);
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

function ablaufHistory(uuid: string, title: string, drawings: { before?: string; after?: string }[]): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    const blocks = drawings.map(({ before }) => before === undefined ? null
      : appendBlock(document, { type: "code", language: "ablauf", text: before }));
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    drawings.forEach(({ before, after }, index) => {
      const block = blocks[index];
      if (block == null && after !== undefined) appendBlock(document, { type: "code", language: "ablauf", text: after });
      else if (block != null && after === undefined) deleteBlock(document, block);
      else if (block != null && before !== undefined && after !== undefined && before !== after) editBlock(document, block, before, after);
    });
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally { document.destroy(); }
}

function historyFlow(columns: number, rows: number): string {
  return `flow v0\ncolumns ${Array.from({ length: columns }, (_, index) => `c${index}`).join(" ")}\n${
    Array.from({ length: columns }, (_, index) => `box n${index} col=c${index}${index === 0 ? "" : " row=n0"} "Step ${index + 1}"`).join("\n")}\n${
    Array.from({ length: rows }, (_, index) => `box tail${index} col=c0 "Later step ${index + 1}"`).join("\n")}\n${
    Array.from({ length: columns - 1 }, (_, index) => `n${index} --> n${index + 1}`).join("\n")}`;
}

function ablaufViewer(page: Page): Locator { return page.getByRole("dialog", { name: "Ablauf diagram", exact: true }); }

async function diagramTransform(viewer: Locator): Promise<{ a: number; d: number; e: number; f: number }> {
  return viewer.locator("svg").evaluate(element => {
    const matrix = (element as SVGSVGElement).getScreenCTM();
    if (matrix === null) throw new Error("The displayed diagram has no screen transform");
    return { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f };
  });
}

async function expectDiagramAt(viewer: Locator, before: Awaited<ReturnType<typeof diagramTransform>>): Promise<void> {
  await expect.poll(async () => {
    const after = await diagramTransform(viewer);
    return Math.max(...Object.keys(before).map(key => Math.abs(after[key as keyof typeof after] - before[key as keyof typeof before])));
  }).toBeLessThan(0.1);
}

async function expectDiagramFits(viewer: Locator): Promise<void> {
  await expect.poll(async () => {
    const viewport = await viewer.locator(".ub-ablauf-viewer-viewport").boundingBox();
    const svg = await viewer.locator("svg").boundingBox();
    return viewport !== null && svg !== null && svg.x >= viewport.x - 1 && svg.y >= viewport.y - 1
      && svg.x + svg.width <= viewport.x + viewport.width + 1 && svg.y + svg.height <= viewport.y + viewport.height + 1
      && Math.abs(svg.x + svg.width / 2 - viewport.x - viewport.width / 2) <= 1
      && Math.abs(svg.y + svg.height / 2 - viewport.y - viewport.height / 2) <= 1;
  }).toBe(true);
}

/** A long json-tree block with a change at each end and one inside a nested object in the middle, then a changed paragraph. */
function longJsonHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  const keys = (from: number) => Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`k${String(from + index).padStart(2, "0")}`, `value ${from + index}`]));
  const settings = (first: string, deep: number, last: number) => JSON.stringify({
    first, ...keys(1), nested: { deep: { level: deep, label: "steady" }, other: "steady" }, ...keys(16), last,
  }, null, 2);
  try {
    initDoc(document, { uuid, title });
    appendBlock(document, { type: "paragraph", text: "The planner's long settings." });
    const block = appendBlock(document, { type: "code", language: "json-tree", text: settings("draft", 1, 1) });
    const closing = appendBlock(document, { type: "paragraph", text: "The closing paragraph stays." });
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    editBlock(document, block, settings("draft", 1, 1), settings("final", 2, 2));
    editBlock(document, closing, "The closing paragraph stays.", "The closing paragraph changed.");
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

/** A drawing stays above a long folded run, where rebuilding can clamp the pane's scroll. */
function drawnFoldHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    const first = appendBlock(document, { type: "paragraph", text: "The opening line changes." });
    appendBlock(document, { type: "code", language: "wireframe", text:
      "dialog Opening wireframe\n  text First field\n  text Second field\n  text Third field\n  text Fourth field\n  row.end\n    button Continue" });
    for (let index = 1; index <= 20; index += 1) {
      appendBlock(document, { type: "paragraph", text: `Unchanged context ${index} stays exactly as it was.` });
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

/** Opening the first run puts all four embed types above the second one. */
function embeddedFoldHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  const directory = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    applyDocData(document, directory, [{ collection: "values", schema: { version: 1, schema: { type: "object" } },
      upsert: [{ id: "one", value: { day: "2026-10-20", count: 7 } }] }]);
    const embeds: Parameters<typeof appendBlock>[1][] = [
      { type: "code", language: "wireframe", text: "page\n  text.title Context drawing\n  text A steady wireframe" },
      { type: "code", language: "ablauf", text: 'flow v0\ncolumns main\nbox first "Start"\nend last "Done"\nfirst --> last' },
      { type: "chart", text: JSON.stringify({ version: 1, type: "line", collection: "values", title: "Context chart",
        x: { field: "day", type: "date" }, y: [{ field: "count", label: "Count" }] }) },
      { type: "figma", text: "url: https://www.figma.com/design/foldFixture/Context\ntitle: Context design\nheight: 240" },
    ];
    const changed: string[] = [];
    for (let run = 1; run <= 2; run += 1) {
      for (const embed of embeds) {
        // Initial Figma node views cannot read an editor that is still mounting.
        if (embed.type === "figma") continue;
        changed.push(appendBlock(document, { type: "paragraph", text: "Draft marker" }));
        appendBlock(document, embed);
      }
      appendBlock(document, { type: "paragraph", text: `Opened run ${run} begins here.` });
      for (const embed of embeds) appendBlock(document, embed);
      for (let row = 1; row <= 8; row += 1) appendBlock(document, { type: "paragraph", text: `Run ${run} context ${row}.` });
      changed.push(appendBlock(document, { type: "paragraph", text: "Draft marker" }));
      appendBlock(document, { type: "paragraph", text: "Context after the change." });
    }
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    for (const id of changed) editBlock(document, id, "Draft marker", "Final marker");
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
    directory.destroy();
  }
}

async function comparisonDrawn(page: Page): Promise<void> {
  const blocks = page.locator(".ub-revision-pane .ub-wireframe, .ub-revision-pane .ub-ablauf, .ub-revision-pane .ub-chart");
  await expect.poll(() => blocks.evaluateAll(elements => elements.every(element => element.getAttribute("data-draw-state") === "success"))).toBe(true);
  await expect.poll(() => page.locator(".ub-revision-pane .ub-wireframe-fit").evaluateAll(elements =>
    elements.every(element => element.getBoundingClientRect().height > 0))).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => runningMotion(page)).toBe(0);
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

  test("history controls add shareable addresses and browser Back and Forward retrace every view", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Addressed history navigation");
    const uuid = await newDocument(page, title);
    const path = new URL(page.url()).pathname;
    const person = { githubUsername: "browser-person", surface: { kind: "browser" as const, name: "Browser" } };
    await serveHistory(page, [
      { id: "latest", title, author: null, startedAt: 3_000, endedAt: null },
      { id: "middle", title, author: null, startedAt: 2_000, endedAt: 3_000 },
      { id: "baseline", title, author: person, startedAt: 1_000, endedAt: 2_000,
        name: { text: "Kickoff", namer: person, namedAt: 2_000, canManage: true } },
    ], {
      latest: savedState(uuid, title, "Latest content."),
      middle: savedState(uuid, title, "Middle content."),
      baseline: savedState(uuid, title, "Baseline content."),
    });
    const latest = `${path}/rev/${revisionId("latest")}`;
    const middle = `${path}/rev/${revisionId("middle")}`;
    const baseline = `${path}/rev/${revisionId("baseline")}`;
    const comparison = `${latest}/since/${revisionId("baseline")}`;
    const assertView = async (address: string, text: string | null): Promise<void> => {
      await expect(page).toHaveURL(new URL(address, harness().appUrl).href);
      if (text === null) {
        await expect(historicalEditor(page)).toHaveCount(0);
        await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      } else {
        await expect(historicalEditor(page)).toContainText(text);
      }
    };
    await previous(page);
    await assertView(latest, "Latest content.");
    await previous(page);
    await assertView(middle, "Middle content.");
    let drawer = await showHistoryList(page);
    await activateControl(historyList(page).getByRole("button", { name: /Kickoff/ }));
    await closeHistoryList(page, drawer);
    await assertView(baseline, "Baseline content.");
    drawer = await showHistoryList(page);
    await activateControl(historyList(page).getByRole("button", { name: "Changes since this name", exact: true }));
    await closeHistoryList(page, drawer);
    await assertView(comparison, "Latest content.");
    await expect(history(page)).toContainText("compared with “Kickoff”");
    await backToNow(page);
    await assertView(path, null);
    await previous(page);
    await assertView(latest, "Latest content.");
    await activateControl(history(page).getByRole("button", { name: "Next revision", exact: true }));
    await assertView(path, null);

    const visited = [
      [path, null], [latest, "Latest content."], [middle, "Middle content."],
      [baseline, "Baseline content."], [comparison, "Latest content."], [path, null],
      [latest, "Latest content."], [path, null],
    ] as const;
    for (const [address, text] of visited.slice(0, -1).reverse()) {
      await page.goBack();
      await assertView(address, text);
    }
    for (const [address, text] of visited.slice(1)) {
      await page.goForward();
      await assertView(address, text);
    }
  });

  test("copied revision and comparison addresses survive reload and newer revisions with both ends fixed", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Shared history views");
    const uuid = await newDocument(page, title);
    const path = new URL(page.url()).pathname;
    expect(path).toBe(`/${harness().workspace}/${uuid}`);
    const person = { githubUsername: "browser-person", surface: { kind: "browser" as const, name: "Browser" } };
    const revisions: RevisionEntry[] = [
      { id: "latest", title, author: null, startedAt: 4_000, endedAt: null },
      { id: "middle", title, author: null, startedAt: 3_000, endedAt: 4_000 },
      { id: "earlier", title, author: null, startedAt: 2_000, endedAt: 3_000 },
      { id: "baseline", title, author: person, startedAt: 1_000, endedAt: 2_000,
        name: { text: "Reviewed", namer: person, namedAt: 2_000, canManage: true } },
    ];
    const states = {
      newer: savedState(uuid, title, "Newer content."),
      latest: savedState(uuid, title, "Selected content."),
      middle: savedState(uuid, title, "Predecessor content."),
      earlier: savedState(uuid, title, "Unnamed baseline content."),
      baseline: savedState(uuid, title, "Named baseline content."),
    };
    await serveHistory(page, revisions, states);
    await previous(page);
    await expect(historicalEditor(page)).toContainText("Selected content.");
    const copiedRevision = new URL(page.url()).pathname;
    expect(copiedRevision).toBe(`${path}/rev/${revisionId("latest")}`);
    const drawer = await showHistoryList(page);
    await activateControl(historyList(page).getByRole("button", { name: "Changes since this name", exact: true }));
    await closeHistoryList(page, drawer);
    await expect(history(page)).toContainText("compared with “Reviewed”");
    const copiedComparison = new URL(page.url()).pathname;
    expect(copiedComparison).toBe(`${copiedRevision}/since/${revisionId("baseline")}`);
    revisions.unshift({ id: "newer", title, author: null, startedAt: 5_000, endedAt: null });

    const assertComparison = async (shared: Page, before: string): Promise<void> => {
      await expect(historicalEditor(shared)).toContainText("Selected content.");
      await expect(historicalEditor(shared)).not.toContainText("Newer content.");
      await expect(earlierSide(shared)).toContainText(before);
    };
    const shared = await openApp(browser, copiedRevision, {
      contextOptions: { viewport: { width: 1440, height: 900 } },
      beforeNavigate: async opened => { await serveHistory(opened, revisions, states); },
      readySelector: ".ub-revision-pane",
    });
    await assertComparison(shared, "Predecessor content.");
    await shared.reload();
    await assertComparison(shared, "Predecessor content.");
    await expect(shared).toHaveURL(new URL(copiedRevision, harness().appUrl).href);
    await shared.goto(new URL(copiedComparison, harness().appUrl).href);
    await assertComparison(shared, "Named baseline content.");
    await expect(history(shared)).toContainText("compared with “Reviewed”");
    await expect(historyList(shared).getByRole("button", { name: "Changes since this name", exact: true }))
      .not.toHaveAttribute("aria-current");
    await shared.reload();
    await assertComparison(shared, "Named baseline content.");
    await expect(shared).toHaveURL(new URL(copiedComparison, harness().appUrl).href);
    const unnamedComparison = `${copiedRevision}/since/${revisionId("earlier")}`;
    await shared.goto(new URL(unnamedComparison, harness().appUrl).href);
    await assertComparison(shared, "Unnamed baseline content.");
    await expect(history(shared)).not.toContainText("compared with");
    await expect(shared.locator(".ub-revision-side-label").first()
      .getByRole("button", { name: "Restore this version", exact: true })).toBeEnabled();
    await expect(shared.locator(".ub-revision-side-label").last().getByRole("button")).toHaveCount(0);
    await shared.reload();
    await assertComparison(shared, "Unnamed baseline content.");
    await expect(shared).toHaveURL(new URL(unnamedComparison, harness().appUrl).href);
  });

  test("missing and reversed history addresses show a recoverable history error", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Invalid history view");
    const uuid = await newDocument(page, title);
    const path = new URL(page.url()).pathname;
    await serveHistory(page, [
      { id: "latest", title, author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", title, author: null, startedAt: 1_000, endedAt: 2_000 },
    ], {
      latest: savedState(uuid, title, "Latest content."),
      earlier: savedState(uuid, title, "Earlier content."),
    });
    for (const suffix of [
      `rev/${revisionId("missing")}`,
      `rev/${revisionId("latest")}/since/${revisionId("missing")}`,
      `rev/${revisionId("earlier")}/since/${revisionId("latest")}`,
      `rev/${revisionId("latest")}/since/${revisionId("latest")}`,
    ]) {
      const address = new URL(`${path}/${suffix}`, harness().appUrl).href;
      await page.goto(address);
      await expect(page.locator(".ub-revision-pane").getByRole("status")).toContainText("History is unavailable");
      await expect(historicalEditor(page)).toHaveCount(0);
      await expect(editor(page)).toBeHidden();
      await expect(page).toHaveURL(address);
      await backToNow(page);
      await expect(page).toHaveURL(new URL(path, harness().appUrl).href);
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    }
  });

  test("a decision topic history address opens the live topic at its plain address", async ({ browser }) => {
    const uuid = randomUUID();
    const document = new Y.Doc();
    try {
      initDoc(document, { uuid, title: docTitle("Decision without document history") });
      appendBlock(document, { type: "paragraph", text: "The proposal remains on the live topic." });
      setKind(document, "decision");
      setStatus(document, "open");
      await harness().seedDocument(document);
    } finally { document.destroy(); }
    const path = `/${harness().workspace}/${uuid}`;
    const shared = await openApp(browser, `${path}/rev/${revisionId("latest")}/since/${revisionId("earlier")}`, {
      readySelector: ".ub-decision-answer",
    });
    await expect(shared).toHaveURL(new URL(path, harness().appUrl).href);
    await expect(history(shared)).toHaveCount(0);
    await expect(shared.locator(".ub-revision-pane")).toHaveCount(0);
  });

  test("names the reviewed state, compares since it, and renames or removes it inline", { tag: "@webkit" }, async ({ browser, browserName }, info) => {
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

  test("a writer renames another account's revision name from the history header", { tag: "@webkit" }, async ({ browser, browserName }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await page.emulateMedia({ colorScheme: browserName === "webkit" ? "dark" : "light" });
    const uuid = await newDocument(page, docTitle("Teammate review name"));
    await activateControl(editor(page));
    await page.keyboard.type("A state reviewed by another teammate.");
    await expect.poll(() => harness().hubText(`${harness().workspaceUuid}/${uuid}`)).toBe("A state reviewed by another teammate.");
    const named = await harness().nameRevisionAsOther(uuid, "Reviewed by teammate");
    expect(named.name?.namer).toMatchObject({ githubUsername: "other-admin", surface: { kind: "mcp", name: "Review client" } });
    await previous(page);
    await expect(history(page)).toContainText("“Reviewed by teammate”, named by other-admin via Review client at ");
    const trigger = history(page).getByRole("button", { name: "Rename revision", exact: true });
    const input = history(page).getByRole("textbox", { name: "Revision name", exact: true });
    await activateControl(trigger);
    await expect(input).toHaveValue("Reviewed by teammate");
    await input.fill("Cancelled rename");
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(history(page)).toContainText("“Reviewed by teammate”, named by other-admin via Review client at ");
    await trigger.press("Enter");
    await expect(input).toHaveValue("Reviewed by teammate");
    await input.fill("Reviewed together");
    await input.press("Enter");
    await expect(input).toHaveCount(0);
    await expect(history(page)).toContainText("“Reviewed together”, named by browser-person in the browser at ");
    await expect(history(page)).not.toContainText("named by other-admin");
    await activateControl(trigger);
    await input.fill("");
    await input.press("Enter");
    await expect(input).toHaveCount(0);
    await expect(history(page)).not.toContainText("Reviewed together");
    await expect(trigger).toHaveCount(0);
    await expect(historicalEditor(page)).toContainText("A state reviewed by another teammate.");
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

  test("restores a past version, syncs open clients, reports no-op and restores the pre-restore state", { tag: "@webkit-touch" }, async ({ browser, browserName }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await page.emulateMedia({ colorScheme: browserName === "webkit" ? "dark" : "light" });
    const title = docTitle("Restore baseline");
    const uuid = await newDocument(page, title);
    const room = `${harness().workspaceUuid}/${uuid}`;
    const nameCurrent = async (name: string): Promise<void> => {
      await activateControl(history(page).getByRole("button", { name: "Name current revision", exact: true }));
      const input = history(page).getByRole("textbox", { name: "Revision name", exact: true });
      await input.fill(name);
      await input.press("Enter");
      await expect(input).toHaveCount(0);
    };
    await activateControl(editor(page));
    await page.keyboard.type("The earlier document content.");
    await expect.poll(() => harness().hubText(room)).toBe("The earlier document content.");
    await nameCurrent("Baseline to restore");
    await page.locator(".ub-title").fill(`${title} newer`);
    await selectPositions(editor(page), 1, 30);
    await page.keyboard.type("The newer document content.");
    await expect.poll(() => harness().hubText(room)).toBe("The newer document content.");
    await nameCurrent("Before the restore");
    const peer = await openApp(browser, new URL(page.url()).pathname, { readySelector: ".ub-editor .ProseMirror" });
    await expect.poll(() => liveText(peer)).toBe("The newer document content.");
    await previous(page);
    const restore = page.getByRole("button", { name: "Restore this version", exact: true });
    await expect(restore).toBeDisabled();
    await expect(restore).toHaveAccessibleDescription("This is the current version.");
    const sinceDrawer = await showHistoryList(page);
    await activateControl(historyList(page).getByRole("listitem").filter({ hasText: "Baseline to restore" })
      .getByRole("button", { name: "Changes since this name", exact: true }));
    await closeHistoryList(page, sinceDrawer);
    await expect(history(page)).toContainText("compared with “Baseline to restore”");
    const restoreBaseline = page.getByRole("button", { name: "Restore “Baseline to restore”", exact: true });
    await expect(restoreBaseline).toBeEnabled();
    await expect(restoreBaseline).toHaveText("Restore “Baseline to restore”");
    if (await page.locator(".ub-revision-split").isVisible()) {
      await expect(page.locator(".ub-revision-side-label").first().getByRole("button")).toHaveAccessibleName("Restore “Baseline to restore”");
      await expect(page.locator(".ub-revision-side-label").last().getByRole("button")).toHaveCount(0);
    } else {
      await expect(page.locator(".ub-revision-header").getByRole("button", { name: "Restore “Baseline to restore”", exact: true })).toBeEnabled();
    }
    const fixedComparison = new URL(page.url()).pathname;
    const selectedAfter = fixedComparison.split("/since/")[0] ?? "";
    if (browserName === "chromium") {
      await restoreBaseline.focus();
      await page.keyboard.press("Enter");
    } else await activateControl(restoreBaseline);
    await expect(page.getByText("Document restored to this version", { exact: true })).toBeVisible();
    await expect.poll(() => liveText(peer)).toBe("The earlier document content.");
    await expect(peer.locator(".ub-title")).toHaveValue(title);
    await backToNow(page);
    await expect.poll(() => liveText(page)).toBe("The earlier document content.");
    await expect(page.locator(".ub-title")).toHaveValue(title);
    await previous(page);
    await expect(history(page)).toContainText("browser-person in the browser");
    await expect(restore).toBeDisabled();
    await expect(restore).toHaveAccessibleDescription("This is the current version.");
    const drawer = await showHistoryList(page);
    const count = await historyList(page).getByRole("listitem").count();
    await activateControl(historyList(page).getByRole("button", { name: /Baseline to restore/ }));
    await closeHistoryList(page, drawer);
    await expect(restore).toBeEnabled();
    await activateControl(restore);
    await expect(page.getByText("The document already has this version. Nothing changed.", { exact: true })).toBeVisible();
    const noOpDrawer = await showHistoryList(page);
    await expect(historyList(page).getByRole("listitem")).toHaveCount(count);
    await closeHistoryList(page, noOpDrawer);
    // This shared comparison still names its original After, even after the restore added a newer revision.
    await page.goto(new URL(fixedComparison, harness().appUrl).href);
    await expect(history(page).getByRole("button", { name: /Copy revision/ })).toHaveText("Before the restore");
    await expect(history(page)).toContainText("compared with “Baseline to restore”");
    await expect(historicalEditor(page).locator('[data-revision-change="added"]').filter({ hasText: "newer" })).toHaveText("newer");
    await expect(earlierSide(page).locator('[data-revision-change="removed"]').filter({ hasText: "earlier" })).toHaveText("earlier");
    await expect(restoreBaseline).toBeEnabled();
    // Step to the original After itself to restore the state just before the first restore.
    await page.goto(new URL(selectedAfter, harness().appUrl).href);
    await expect(history(page).getByRole("button", { name: /Copy revision/ })).toHaveText("Before the restore");
    await expect(restore).toBeEnabled();
    await activateControl(restore);
    await expect.poll(() => liveText(peer)).toBe("The newer document content.");
    await expect(peer.locator(".ub-title")).toHaveValue(`${title} newer`);
    await backToNow(page);
    await expect.poll(() => liveText(page)).toBe("The newer document content.");
    // Archived history remains readable, with an explanation on the visible restore control.
    await activateControl(page.getByRole("button", { name: "Document actions", exact: true }));
    await activateControl(page.getByRole("menuitem", { name: "Archive document", exact: true }));
    await activateControl(page.getByRole("alertdialog", { name: `Archive “${title} newer”?` }).getByRole("button", { name: "Archive", exact: true }));
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await previous(page);
    await expect(restore).toBeDisabled();
    await expect(restore).toHaveAccessibleDescription("This document is archived. Restore the document first, then restore a revision.");
    const reason = page.getByText("This document is archived. Restore the document first, then restore a revision.", { exact: true });
    await expect(reason).toBeVisible();
    expect((await reason.boundingBox())?.height).toBeGreaterThan(10);
  });

  test("refuses restore after a collaborator changes the live document and refreshes the history list", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Stale restore");
    const uuid = await newDocument(page, title);
    const room = `${harness().workspaceUuid}/${uuid}`;
    await activateControl(editor(page));
    await page.keyboard.type("State reviewed when history opens.");
    await expect.poll(() => harness().hubText(room)).toBe("State reviewed when history opens.");
    await activateControl(history(page).getByRole("button", { name: "Name current revision", exact: true }));
    const name = history(page).getByRole("textbox", { name: "Revision name", exact: true });
    await name.fill("Reviewed restore target");
    await name.press("Enter");
    await expect(name).toHaveCount(0);
    await selectPositions(editor(page), 1);
    await page.keyboard.type("Current state: ");
    await expect.poll(() => harness().hubText(room)).toBe("Current state: State reviewed when history opens.");
    const peer = await openApp(browser, new URL(page.url()).pathname, { readySelector: ".ub-editor .ProseMirror" });
    await expect.poll(() => liveText(peer)).toBe("Current state: State reviewed when history opens.");
    await previous(page);
    await previous(page);
    await expect(history(page).getByRole("button", { name: /Copy revision/ })).toHaveText("Reviewed restore target");
    await expect(page.getByRole("button", { name: "Restore this version", exact: true })).toBeEnabled();
    await peer.locator(".ub-title").fill(`${title} collaborator`);
    await selectPositions(editor(peer), 1);
    await peer.keyboard.type("Newer changes: ");
    await expect.poll(() => harness().hubText(room)).toBe("Newer changes: Current state: State reviewed when history opens.");
    await activateControl(page.getByRole("button", { name: "Restore this version", exact: true }));
    await expect(page.getByText("This document changed. Review the newer changes in history and try again.", { exact: true })).toBeVisible();
    const drawer = await showHistoryList(page);
    const current = historyList(page).getByRole("button", { name: /Current version/ });
    await activateControl(current);
    await expect(current).toHaveAttribute("aria-current", "true");
    await closeHistoryList(page, drawer);
    await expect(historicalEditor(page)).toContainText("Newer changes: Current state: State reviewed when history opens.");
    await expect(page.locator(".ub-revision-title")).toHaveText(`${title} collaborator`);
    await backToNow(page);
    await expect.poll(() => liveText(page)).toBe("Newer changes: Current state: State reviewed when history opens.");
    await expect(page.locator(".ub-title")).toHaveValue(`${title} collaborator`);
  });

  test("restore follows its column with compact geometry, touch reach and native keyboard order", { tag: "@webkit-touch" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane",
      contextOptions: { viewport: { width: 1440, height: 640 }, reducedMotion: "reduce" } });
    const title = docTitle("Restore comparison placement");
    const uuid = await newDocument(page, title);
    const person = { githubUsername: "browser-person", surface: { kind: "browser" as const, name: "Browser" } };
    const baselineName = "Reviewed after the auth rewrite with Lena and the entire release team before the final launch review";
    await serveHistory(page, [
      { id: "newest", title, author: null, startedAt: 3_000, endedAt: null },
      { id: "latest", title, author: { ...person, githubUsername: "W".repeat(39) }, startedAt: 2_000, endedAt: 3_000 },
      { id: "earlier", title, author: null, startedAt: 1_000, endedAt: 2_000,
        name: { text: baselineName, namer: person, namedAt: 2_000, canManage: true } },
    ], { ...toggleNavigationHistory(uuid, title, false), newest: savedState(uuid, title, "Current live version.") });
    await previous(page);
    const restore = page.getByRole("button", { name: "Restore this version", exact: true });
    const header = page.locator(".ub-revision-header");
    const split = page.locator(".ub-revision-split");
    await expect(split).toBeVisible();
    await expect(split.getByRole("button", { name: "Restore this version", exact: true })).toBeDisabled();
    await expect(restore).toHaveAccessibleDescription("This is the current version.");
    await expect(header.getByRole("button", { name: "Restore this version", exact: true })).toHaveCount(0);
    const currentReason = page.getByText("This is the current version.", { exact: true });
    expect((await currentReason.boundingBox())?.height).toBeLessThanOrEqual(1);
    const currentHeaderHeight = (await header.boundingBox())?.height;
    // Disabling the current version also holds in the one-column header fallback.
    await page.setViewportSize({ width: 860, height: 640 });
    await expect(split).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Restore this version", exact: true })).toBeDisabled();
    await expect(restore).toHaveAccessibleDescription("This is the current version.");
    expect((await currentReason.boundingBox())?.height).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 640 });
    await expect(split).toBeVisible();
    await previous(page);
    await expect(restore).toBeEnabled();
    expect((await header.boundingBox())?.height).toBeCloseTo(currentHeaderHeight ?? 0, 0);
    const drawer = await showHistoryList(page);
    const collapse = historyList(page).getByRole("switch", { name: "Collapse unchanged", exact: true });
    if (await collapse.getAttribute("aria-checked") === "true") await activateControl(collapse);
    await closeHistoryList(page, drawer);
    const assertCompactGeometry = async (control: Locator): Promise<void> => {
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const geometry = await control.evaluate(button => {
          const labels = [...document.querySelectorAll<HTMLElement>(".ub-revision-side-label")];
          const [before, after] = labels;
          const sides = [...document.querySelectorAll<HTMLElement>(".ub-revision-split .ProseMirror")];
          if (before === undefined || after === undefined || sides.length !== 2) throw new Error("Both comparison columns must be shown");
          const left = before.getBoundingClientRect();
          const right = after.getBoundingClientRect();
          const box = button.getBoundingClientRect();
          const owner = button.closest(".ub-revision-side-label")?.getBoundingClientRect();
          if (owner === undefined) throw new Error("Restore must belong to a column label");
          const text = getComputedStyle(before);
          const style = getComputedStyle(button);
          return { beforeHeight: left.height, afterHeight: right.height, labelTopDifference: right.top - left.top,
            editorTopDifference: (sides[1]?.getBoundingClientRect().top ?? 0) - (sides[0]?.getBoundingClientRect().top ?? 0),
            rightInset: owner.right - box.right, controlTop: box.top - owner.top, controlBottom: owner.bottom - box.bottom,
            font: style.fontSize, labelFont: text.fontSize, lineHeight: style.lineHeight, labelLineHeight: text.lineHeight,
            touch: matchMedia("(any-pointer: coarse)").matches,
            hitArea: [-21.5, 21.5].map(offset => button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2 + offset))) };
        });
        expect(geometry.afterHeight).toBeCloseTo(geometry.beforeHeight, 1);
        expect(Math.abs(geometry.labelTopDifference)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.editorTopDifference)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.rightInset)).toBeLessThanOrEqual(1);
        expect(geometry.controlTop).toBeGreaterThanOrEqual(-1);
        expect(geometry.controlBottom).toBeGreaterThanOrEqual(-1);
        expect(geometry.font).toBe(geometry.labelFont);
        expect(geometry.lineHeight).toBe(geometry.labelLineHeight);
        if (geometry.touch) expect(geometry.hitArea).toEqual([true, true]);
      }
    };
    await expect(page.locator(".ub-revision-side-label").first().getByRole("button")).toHaveCount(0);
    await expect(page.locator(".ub-revision-side-label").last().getByRole("button")).toHaveAccessibleName("Restore this version");
    await assertCompactGeometry(restore);
    expect(await restore.locator("span").evaluate(label => label.scrollWidth > label.clientWidth)).toBe(false);
    const nextChange = page.getByRole("button", { name: "Next change", exact: true });
    await expect(nextChange).toBeEnabled();
    await nextChange.focus();
    await page.keyboard.press("Tab");
    await expect(restore).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(earlierSide(page)).toBeFocused();
    // Native editor focus may scroll its selection into view; start this proof at the pinned header.
    await page.locator(".ub-revision-pane").evaluate(pane => { pane.scrollTop = 20; });
    const start = await page.locator(".ub-revision-side-label").last().boundingBox();
    const headerStart = await header.boundingBox();
    await page.locator(".ub-revision-pane").evaluate(pane => { pane.scrollTop = 170; });
    await expect.poll(async () => (await page.locator(".ub-revision-side-label").last().boundingBox())?.y ?? 0)
      .toBeLessThan((start?.y ?? 0) - 100);
    expect((await header.boundingBox())?.y).toBeCloseTo(headerStart?.y ?? 0, 0);
    const selectedAddress = new URL(page.url()).pathname;
    await page.goto(new URL(`${selectedAddress}/since/${revisionId("earlier")}`, harness().appUrl).href);
    const restoreNamed = page.getByRole("button", { name: `Restore “${baselineName}”`, exact: true });
    await expect(split).toBeVisible();
    await expect(restoreNamed).toBeEnabled();
    await expect(page.locator(".ub-revision-side-label").first().getByRole("button")).toHaveAccessibleName(`Restore “${baselineName}”`);
    await expect(page.locator(".ub-revision-side-label").last().getByRole("button")).toHaveCount(0);
    await expect(header.locator(".ub-revision-restore")).toHaveCount(0);
    await assertCompactGeometry(restoreNamed);
    expect(await page.locator(".ub-revision-side-label").first().locator("span").first()
      .evaluate(label => label.scrollWidth > label.clientWidth)).toBe(false);
    await expect(restoreNamed).toHaveText(`Restore “${baselineName}”`);
    const clipped = await restoreNamed.locator("span").evaluate(label => ({
      overflow: getComputedStyle(label).textOverflow, clipped: label.scrollWidth > label.clientWidth,
    }));
    expect(clipped).toEqual({ overflow: "ellipsis", clipped: true });
    await expect(nextChange).toBeEnabled();
    await nextChange.focus();
    await page.keyboard.press("Tab");
    await expect(restoreNamed).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(earlierSide(page)).toBeFocused();
    await page.setViewportSize({ width: 860, height: 640 });
    await expect(split).toHaveCount(0);
    await expect(header.getByRole("button", { name: `Restore “${baselineName}”`, exact: true })).toBeEnabled();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const geometry = await header.locator(".ub-revision-heading").evaluate(heading => {
        const title = heading.querySelector(".ub-revision-title-text:not([aria-hidden])");
        const button = heading.querySelector("button");
        const label = button?.querySelector("span");
        if (title === null || button === null || label == null) throw new Error("Revision title and restore must be shown");
        const titleBox = title.getBoundingClientRect();
        const buttonBox = button.getBoundingClientRect();
        return { headingWidth: heading.getBoundingClientRect().width, titleWidth: titleBox.width,
          titleRight: titleBox.right, buttonLeft: buttonBox.left,
          clipped: label.scrollWidth > label.clientWidth, overflow: getComputedStyle(label).textOverflow };
      });
      expect(geometry.titleWidth).toBeGreaterThan(geometry.headingWidth * 0.4);
      expect(geometry.titleRight).toBeLessThanOrEqual(geometry.buttonLeft);
      expect(geometry.clipped).toBe(true);
      expect(geometry.overflow).toBe("ellipsis");
      await expect(restoreNamed).toHaveAccessibleName(`Restore “${baselineName}”`);
    }
    // Ordinary revision views keep their generic header action when narrow or without a predecessor.
    await page.goto(new URL(selectedAddress, harness().appUrl).href);
    await expect(split).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Restore this version", exact: true })).toBeEnabled();
    await page.setViewportSize({ width: 1440, height: 640 });
    await expect(split).toBeVisible();
    await previous(page);
    await expect(split).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Restore this version", exact: true })).toBeEnabled();
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
    await expect(page).toHaveURL(new RegExp(`${path}/rev/[0-9a-f-]+$`));
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
    await expect(restore).toBeEnabled();
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

  test("Named history compares anchors, steps between them and keeps addressed comparisons fixed", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Named history anchors");
    const uuid = await newDocument(page, title);
    const path = new URL(page.url()).pathname;
    const reviewer = { githubUsername: "review-person", surface: { kind: "browser" as const, name: "Browser" } };
    const kickoffAuthor = { ...reviewer, githubUsername: "kickoff-person" };
    const revisions: RevisionEntry[] = [
      { id: "latest", title, author: null, startedAt: 5_000, endedAt: null },
      { id: "reviewed", title, author: reviewer, startedAt: 4_000, endedAt: 5_000,
        name: { text: "Reviewed", namer: reviewer, namedAt: 5_000, canManage: true } },
      { id: "draft", title, author: { ...reviewer, githubUsername: "draft-person" }, startedAt: 3_000, endedAt: 4_000 },
      { id: "kickoff", title, author: kickoffAuthor, startedAt: 2_000, endedAt: 3_000,
        name: { text: "Kickoff", namer: reviewer, namedAt: 3_000, canManage: true } },
      { id: "earliest", title, author: null, startedAt: null, endedAt: 2_000 },
    ];
    const states = Object.fromEntries(revisions.map(entry => [entry.id, savedState(uuid, title, `${entry.id} content.`)]));
    await serveHistory(page, revisions, states);
    const latestAddress = `${path}/rev/${revisionId("latest")}`;
    const reviewedAddress = `${path}/rev/${revisionId("reviewed")}`;
    const namedAddress = `${reviewedAddress}/since/${revisionId("kickoff")}`;
    const kickoffAddress = `${path}/rev/${revisionId("kickoff")}/since/${revisionId("earliest")}`;
    const sinceAddress = `${path}/rev/${revisionId("latest")}/since/${revisionId("kickoff")}`;
    const list = historyList(page);
    const reviewed = list.getByRole("button", { name: /Reviewed.*review-person/ });
    const kickoff = list.getByRole("button", { name: /Kickoff.*kickoff-person/ });
    const back = history(page).getByRole("button", { name: "Previous revision", exact: true });
    const forward = history(page).getByRole("button", { name: "Next revision", exact: true });
    const assertView = async (address: string, after: string, before: string): Promise<void> => {
      await expect(page).toHaveURL(new URL(address, harness().appUrl).href);
      await expect(historicalEditor(page)).toContainText(`${after} content.`);
      await expect(earlierSide(page)).toContainText(`${before} content.`);
    };
    const setFilter = async (filter: "All" | "Named"): Promise<void> => {
      const drawer = await showHistoryList(page);
      await activateControl(list.getByRole("button", { name: filter, exact: true }));
      await expect(list.getByRole("button", { name: filter, exact: true })).toHaveAttribute("aria-pressed", "true");
      await closeHistoryList(page, drawer);
    };

    await previous(page);
    await assertView(latestAddress, "latest", "reviewed");
    let drawer = await showHistoryList(page);
    await reviewed.focus();
    await page.keyboard.press("Enter");
    await assertView(reviewedAddress, "reviewed", "draft");
    await expect(reviewed).toBeFocused();
    const namedFilter = list.getByRole("button", { name: "Named", exact: true });
    await namedFilter.focus();
    await page.keyboard.press("Enter");
    await assertView(namedAddress, "reviewed", "kickoff");
    await expect(namedFilter).toBeFocused();
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(reviewed).toHaveAttribute("aria-current", "true");
    await expect(list.locator('[aria-current="true"]')).toHaveCount(1);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const scan = await new AxeBuilder({ page }).include(".ub-history-sidebar").include(".ub-revision-pane").withTags(WCAG_TAGS).analyze();
      assertNoViolations(scan.violations);
    }
    // Native Tab reaches the other anchor and leaves the revision list for the sidebar footer.
    await kickoff.focus();
    await page.keyboard.press("Tab");
    await expect(kickoff.locator("..").getByRole("button", { name: "Changes since this name", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Workspace settings", exact: true })).toBeFocused();
    await closeHistoryList(page, drawer);
    await assertView(namedAddress, "reviewed", "kickoff");
    await expect(history(page)).toContainText("review-person");
    await expect(history(page)).toContainText("compared with “Kickoff”");
    if (await page.locator(".ub-revision-split").count() > 0) {
      await expect(page.locator(".ub-revision-side-label").first()).toContainText("kickoff-person");
      await expect(page.locator(".ub-revision-side-label").first()).toContainText("Kickoff");
      await expect(page.locator(".ub-revision-side-label").last()).toContainText("review-person");
      await expect(page.locator(".ub-revision-side-label").last()).toContainText("Reviewed");
    }
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();
    await activateControl(back);
    await assertView(kickoffAddress, "kickoff", "earliest");
    await expect(back).toBeDisabled();
    await expect(forward).toBeEnabled();
    if (await page.locator(".ub-revision-split").count() > 0) {
      await expect(page.locator(".ub-revision-side-label").first()).toContainText("Earlier content");
    }
    await activateControl(forward);
    await assertView(namedAddress, "reviewed", "kickoff");

    drawer = await showHistoryList(page);
    const allFilter = list.getByRole("button", { name: "All", exact: true });
    await allFilter.focus();
    await page.keyboard.press("Enter");
    await assertView(reviewedAddress, "reviewed", "draft");
    await expect(allFilter).toBeFocused();
    await closeHistoryList(page, drawer);
    await page.goBack();
    await assertView(namedAddress, "reviewed", "kickoff");
    await page.goForward();
    await assertView(reviewedAddress, "reviewed", "draft");
    await setFilter("Named");
    await assertView(namedAddress, "reviewed", "kickoff");
    drawer = await showHistoryList(page);
    await activateControl(kickoff.locator("..").getByRole("button", { name: "Changes since this name", exact: true }));
    await closeHistoryList(page, drawer);
    await assertView(sinceAddress, "latest", "kickoff");
    await setFilter("All");
    await assertView(sinceAddress, "latest", "kickoff");
    await setFilter("Named");
    await assertView(sinceAddress, "latest", "kickoff");

    await page.goto(new URL(namedAddress, harness().appUrl).href);
    await assertView(namedAddress, "reviewed", "kickoff");
    await page.reload();
    await assertView(namedAddress, "reviewed", "kickoff");
    drawer = await showHistoryList(page);
    await expect(list.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(reviewed).not.toHaveAttribute("aria-current");
    await closeHistoryList(page, drawer);

    for (const entry of revisions) {
      if (entry.name != null) entry.name = { ...entry.name, text: entry.name.text.repeat(12) };
    }
    await page.goto(new URL(namedAddress, harness().appUrl).href);
    await assertView(namedAddress, "reviewed", "kickoff");
    const copyRevision = history(page).getByRole("button", { name: `Copy revision ${revisionId("reviewed")}`, exact: true });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(copyRevision.locator("span")).toHaveCSS("text-overflow", "ellipsis");
      expect(await copyRevision.locator("span").evaluate(label => label.scrollWidth > label.clientWidth)).toBe(true);
      const labels = page.locator(".ub-revision-side-label > span");
      for (const label of await labels.all()) {
        await expect(label).toHaveCSS("text-overflow", "ellipsis");
        const geometry = await label.evaluate(element => {
          const owner = element.parentElement;
          if (owner === null) throw new Error("The comparison label has no column");
          const box = element.getBoundingClientRect();
          const bounds = owner.getBoundingClientRect();
          const restore = owner.querySelector("button")?.getBoundingClientRect();
          return { clipped: element.scrollWidth > element.clientWidth, rightInset: bounds.right - box.right,
            buttonGap: restore === undefined ? null : restore.left - box.right };
        });
        expect(geometry.clipped).toBe(true);
        expect(geometry.rightInset).toBeGreaterThanOrEqual(-1);
        if (geometry.buttonGap !== null) expect(geometry.buttonGap).toBeGreaterThanOrEqual(0);
      }
    }

    for (const entry of revisions) {
      if (entry.id === "kickoff") entry.name = null;
    }
    await page.goto(new URL(latestAddress, harness().appUrl).href);
    await assertView(latestAddress, "latest", "reviewed");
    await setFilter("Named");
    await back.focus();
    await page.keyboard.press("Enter");
    await assertView(`${reviewedAddress}/since/${revisionId("earliest")}`, "reviewed", "earliest");
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();
    await expect(copyRevision).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(copyRevision).not.toBeFocused();
    await expect(page.locator(":focus")).toBeVisible();
  });

  for (const width of [1440, 1200, 860]) {
    test(`the sticky history header covers comparison paint at both outer edges at ${width}px`, { tag: "@webkit" }, async ({ browser }, info) => {
      const page = await openApp(browser, "/", { readySelector: ".ub-pane",
        contextOptions: { viewport: { width, height: 640 }, reducedMotion: "reduce" } });
      const title = docTitle("Covered comparison header");
      const uuid = await newDocument(page, title);
      await serveHistory(page, [
        { id: "added", author: null, startedAt: 3_000, endedAt: null },
        { id: "removed", author: null, startedAt: 2_000, endedAt: 3_000 },
        { id: "baseline", author: null, startedAt: 1_000, endedAt: 2_000 },
      ], coveredHeaderHistory(uuid, title));
      const split = width >= 900;
      const pane = page.locator(".ub-revision-pane");
      const header = page.locator(".ub-revision-header");
      for (const change of ["added", "removed"] as const) {
        await previous(page);
        await expect(page.locator(".ub-revision-split")).toHaveCount(Number(split));
        const row = change === "added" ? historicalEditor(page).locator(".ub-wireframe") : earlierSide(page).locator(":scope > p").first();
        await expect(row).toBeVisible();
        if (change === "added") await expect(row.locator(".wf-root")).toBeVisible();
        if (split) {
          await expect(row).toHaveClass(new RegExp(`ub-revision-row-${change}`));
          await expect(page.locator(".ub-revision-row-filler")).toHaveCount(1);
          await expect(page.getByTestId("revision-ruler")).toBeVisible();
        }
        await expect(page.locator(".ub-revision-title")).toHaveText(title);
        await expect(history(page)).toContainText(change === "added" ? "1 of 3" : "2 of 3");
        await expect(header).toHaveCSS("position", "sticky");
        for (const scheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await expect.poll(() => runningMotion(page)).toBe(0);
          await row.evaluate(element => {
            const pane = element.closest<HTMLElement>(".ub-revision-pane");
            const header = pane?.querySelector(".ub-revision-header");
            if (pane == null || header == null) throw new Error("The revision pane or header is missing");
            pane.scrollTop += element.getBoundingClientRect().top - Math.max(header.getBoundingClientRect().top, pane.getBoundingClientRect().top) - 4;
          });
          await expect.poll(() => row.evaluate(element => {
            const pane = element.closest(".ub-revision-pane");
            const header = pane?.querySelector(".ub-revision-header");
            if (pane == null || header == null) return false;
            const row = element.getBoundingClientRect(), band = header.getBoundingClientRect();
            return row.top < band.bottom - 8 && row.bottom > band.bottom && pane.scrollTop > 0;
          })).toBe(true);
          if (split) {
            // Geometry settles before the controls' frame update; the only change now starts behind the header.
            await expect(header.getByRole("button", { name: "Previous change", exact: true })).toBeEnabled();
            await expect(header.getByRole("button", { name: "Next change", exact: true })).toBeDisabled();
          }
          const geometry = () => header.evaluate(element => {
            const rect = (target: Element) => {
              const box = target.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height };
            };
            return { header: rect(element), parts: [...element.querySelectorAll(".ub-revision-title, .ub-history-controls, .ub-change-nav, .ub-revision-ruler")].map(rect),
              body: element.nextElementSibling?.className };
          });
          const before = await geometry();
          expect(before.body).toContain(split ? "ub-revision-split" : "ub-revision-view");
          const clip = await header.evaluate(element => {
            const box = element.getBoundingClientRect();
            const pane = element.closest(".ub-revision-pane");
            const column = element.parentElement;
            if (pane === null || column === null) throw new Error("The revision pane or column is missing");
            const gutter = Number.parseFloat(getComputedStyle(column).paddingLeft);
            const x = Math.floor(box.left - gutter), y = Math.ceil(Math.max(box.top, pane.getBoundingClientRect().top));
            return { x, y, width: Math.ceil(box.right + 8) - x, height: Math.floor(box.bottom) - y };
          });
          const name = `covered-header-${width}-${change}-${scheme}`;
          const visible = await page.screenshot({ clip, animations: "disabled", caret: "hide", scale: "css" });
          const hidden = await page.addStyleTag({ content: ".ub-revision-header + :is(.ub-revision-split, .ub-revision-view) { visibility: hidden; }" });
          const covered = await page.screenshot({ clip, animations: "disabled", caret: "hide", scale: "css" });
          expect(await geometry()).toEqual(before);
          await hidden.evaluate(element => element.parentNode?.removeChild(element));
          await info.attach(name, { body: visible, contentType: "image/png" });
          if (!visible.equals(covered)) await info.attach(`${name}-without-comparison`, { body: covered, contentType: "image/png" });
          expect(visible.equals(covered), "Comparison paint must be invisible throughout the header band, including its gutter and tint overhang").toBe(true);
        }
        await pane.evaluate(element => element.scrollTo(0, 0));
      }
    });
  }

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
      await expect.poll(() => runningMotion(page)).toBe(0);
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

  test("comparison tints, fillers and folds share text edges and list markers keep document styling", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane",
      contextOptions: { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" } });
    const title = docTitle("Comparison row edges");
    const uuid = await newDocument(page, title);
    await editor(page).evaluate(element => {
      (element as HTMLElement & { editor: Editor }).editor.commands.setContent({ type: "doc", content: [
        ...["bullet", "ordered"].flatMap(list => [1, 2].map(number => ({
          type: "list-item", attrs: { list }, content: [{ type: "text", text: `${list} item ${number}` }],
        }))),
      ] });
    });
    const markerStyles = (view: Locator) => view.locator(":scope > .ub-list-item").evaluateAll(items => items.map(item => {
      const style = getComputedStyle(item, "::before");
      return { content: style.content, color: style.color, font: style.font, left: style.left, width: style.width };
    }));
    const documentMarkers = new Map<"light" | "dark", Awaited<ReturnType<typeof markerStyles>>>();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const markers = await markerStyles(editor(page));
      expect(markers).toHaveLength(4);
      expect(markers[0]?.content).toContain("•");
      expect(markers[1]?.content).toContain("•");
      expect(markers[2]?.content).toMatch(/1.*\./);
      expect(markers[3]?.content).toMatch(/2.*\./);
      documentMarkers.set(scheme, markers);
    }
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], rowEdgesHistory(uuid, title));
    await previous(page);
    await expect(page.locator(".ub-revision-split")).toBeVisible();
    const before = earlierSide(page), after = historicalEditor(page);
    const collapse = historyList(page).getByRole("switch", { name: "Collapse unchanged", exact: true });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const folding of [true, false]) {
        await collapse.setChecked(folding);
        await expect(page.locator(".ub-revision-ghost")).toHaveCount(0);
        for (const [side, tint] of [[before, "removed"], [after, "added"]] as const) {
          await expect(side.locator(".ub-revision-fold-button")).toHaveCount(Number(folding));
          await expect(side.locator("[data-revision-mark]")).toHaveCount(0);
          await expect(side.locator(`:scope > p.ub-revision-row-${tint}`)).toHaveCount(1);
          await expect(side.locator(".ub-revision-fields")).toContainText(tint === "removed" ? "Removed block" : "Added block");
          const geometry = await side.evaluate((element, kind) => {
            const edges = (target: Element) => {
              const box = target.getBoundingClientRect();
              return { left: box.left, right: box.right };
            };
            const filler = element.querySelector(".ub-revision-row-end.ub-revision-row-filler");
            const paragraph = element.querySelector("p.ub-revision-row-changed");
            if (filler === null || paragraph?.firstChild == null) throw new Error("The comparison geometry fixture is missing");
            const text = document.createRange();
            text.setStart(paragraph.firstChild, 0);
            text.setEnd(paragraph.firstChild, 1);
            const rows = [...element.querySelectorAll(`:scope > .ub-revision-row-${kind}, :scope > .ub-revision-row-changed`)];
            const fold = element.querySelector(".ub-revision-fold-button");
            return { filler: edges(filler), fold: fold === null ? null : edges(fold), text: text.getBoundingClientRect().left,
              rows: rows.map(row => ({ ...edges(row), shadow: getComputedStyle(row).boxShadow,
                tint: getComputedStyle(row).backgroundColor, mark: getComputedStyle(row, "::before").content,
                list: row.classList.contains("ub-list-item") })) };
          }, tint);
          expect(geometry.rows.length).toBeGreaterThan(3);
          for (const row of geometry.rows) {
            expect(row.left).toBeCloseTo(geometry.filler.left, 0);
            expect(row.right).toBeCloseTo(geometry.filler.right, 0);
            // Box geometry alone cannot detect paint extending through a shadow.
            expect(row.shadow).toBe("none");
            expect(alphaOf(row.tint)).toBeGreaterThan(0);
            if (!row.list) expect(["none", "normal"]).toContain(row.mark);
          }
          expect(geometry.text).toBeCloseTo(geometry.filler.left, 0);
          if (geometry.fold !== null) {
            expect(geometry.fold.left).toBeCloseTo(geometry.filler.left, 0);
            expect(geometry.fold.right).toBeCloseTo(geometry.filler.right, 0);
          }
          expect(await markerStyles(side)).toEqual(documentMarkers.get(scheme));
          await expect(side.locator('.ub-list-item[data-revision-row="changed"]')).toHaveCount(2);
          await expect(side.locator('.ub-list-item[data-revision-row="unchanged"]')).toHaveCount(2);
        }
      }
    }
  });

  test("opaque drawings retain visible row tint inside comparison edges", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane",
      contextOptions: { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" } });
    const title = docTitle("Opaque comparison surfaces");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], ablaufHistory(uuid, title, [
      { before: historyFlow(6, 0), after: historyFlow(7, 0) },
      { before: historyFlow(3, 0) },
      { after: historyFlow(4, 0) },
      { before: historyFlow(2, 0), after: historyFlow(2, 0) },
    ]));
    await previous(page);
    await expect(page.locator(".ub-revision-split")).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const side of [earlierSide(page), historicalEditor(page)]) {
        const rows = side.locator(":scope > .ub-ablauf:is(.ub-revision-row-changed, .ub-revision-row-added, .ub-revision-row-removed)");
        await expect(rows).toHaveCount(2);
        for (const row of await rows.all()) {
          const tint = await row.evaluate(element => getComputedStyle(element).backgroundColor);
          expect(alphaOf(tint)).toBe(1);
          await expect(row).toHaveCSS("box-shadow", "none");
          await expect(row.locator(".ub-ablauf-viewport")).toHaveCSS("background-color", tint);
          await expect(row.locator("svg")).toHaveCSS("background-color", tint);
          const screenshot = await row.screenshot({ animations: "disabled", scale: "css" });
          const paint = await page.evaluate(async ({ bytes, tint }) => {
            const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
            const canvas = document.createElement("canvas");
            canvas.width = image.width; canvas.height = image.height;
            const context = canvas.getContext("2d");
            if (context === null) throw new Error("Canvas pixel readback is unavailable");
            context.fillStyle = tint; context.fillRect(0, 0, 1, 1);
            const expected = context.getImageData(0, 0, 1, 1).data;
            context.drawImage(image, 0, 0);
            image.close();
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let tinted = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
              if (expected.every((value, channel) => Math.abs(value - (pixels[offset + channel] ?? -255)) <= 1)) tinted += 1;
            }
            return { tinted, width: canvas.width };
          }, { bytes: [...screenshot], tint });
          expect(paint.tinted, "The row tint must be visible inside the block, even when its content has an opaque surface").toBeGreaterThan(paint.width);
        }
        const unchanged = side.locator(":scope > .ub-ablauf.ub-revision-row-unchanged .ub-ablauf-viewport");
        await expect(unchanged).not.toHaveCSS("background-color", await rows.first().evaluate(element => getComputedStyle(element).backgroundColor));
      }
    }
  });

  test("table width changes explain themselves while keeping widths, tint and change navigation", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 640 } } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const title = docTitle("Table column widths in history");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], tableWidthHistory(uuid, title));
    await previous(page);
    await expect(page.locator(".ub-revision-split")).toBeVisible();
    const before = earlierSide(page);
    const after = historicalEditor(page);
    const note = after.getByText("Only column widths changed", { exact: true });
    await expect(note).toBeVisible();
    await expect(before.locator(".ub-revision-fields")).toHaveText("Changed: column widths");
    await expect(after.locator(".ub-revision-fields")).toHaveText(["Only column widths changed", "Changed: column widths"]);
    await expect(page.locator(".ub-revision-pane")).not.toContainText("columnWidths");
    const widthTable = (side: Locator): Locator => side.locator(".ub-table").filter({ hasText: "Latency" });
    const mixedTable = (side: Locator): Locator => side.locator(".ub-table").filter({ hasText: "Duration" });
    await expect(widthTable(before).locator("[data-revision-change]")).toHaveCount(0);
    await expect(widthTable(after).locator("[data-revision-change]")).toHaveCount(0);
    await expect(mixedTable(before).locator('[data-revision-change="removed"]')).toHaveText("10");
    await expect(mixedTable(after).locator('[data-revision-change="added"]')).toHaveText("12");
    for (const [side, expected] of [[before, [160, 180]], [after, [240, 180]]] as const) {
      await expect.poll(() => widthTable(side).locator("th").evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().width))))
        .toEqual(expected);
      await expect(side.locator("[data-revision-mark]")).toHaveCount(0);
    }
    // The widths-only table remains visible with the unchanged middle folded.
    await expect(after.locator(".ub-revision-fold-button")).toHaveCount(1);
    await expect(after.locator(".ub-table")).toHaveCount(2);
    const changeMarks = async () => (await rulerGeometry(page)).marks.filter(mark => mark.kind !== "same" && mark.kind !== "fold");
    await expect.poll(async () => (await changeMarks()).length).toBe(2);
    await activateControl(historyList(page).getByRole("switch", { name: "Collapse unchanged", exact: true }));
    await expect(after.locator(".ub-revision-fold-button")).toHaveCount(0);
    await expect.poll(async () => (await changeMarks()).length).toBe(2);
    const nextChange = page.getByRole("button", { name: "Next change", exact: true });
    const previousChange = page.getByRole("button", { name: "Previous change", exact: true });
    await expect(nextChange).toBeEnabled();
    await activateControl(nextChange);
    const pane = page.locator(".ub-revision-pane");
    await expect.poll(() => pane.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
    await expect(previousChange).toBeEnabled();
    await activateControl(previousChange);
    await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeLessThan(40);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const paints = [];
      for (const side of [before, after]) {
        const row = side.locator(':scope > [data-revision-row="changed"]').first();
        const paint = await row.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, mark: getComputedStyle(element, "::before").content }));
        expect(alphaOf(paint.background)).toBeGreaterThan(0);
        expect(["none", "normal"]).toContain(paint.mark);
        paints.push(paint.background);
      }
      expect(paints[0]).not.toBe(paints[1]);
      const typography = await after.locator(".ub-revision-fields").evaluateAll(labels => labels.map(label => {
        const style = getComputedStyle(label);
        return [style.fontFamily, style.fontSize, style.lineHeight, style.color];
      }));
      expect(typography[0]).toEqual(typography[1]);
      const readings = await renderedText(page, ".ub-revision-side-after .ub-revision-fields");
      expect(readings.length).toBeGreaterThan(0);
      for (const reading of readings) expect(reading.ratio, reading.where).toBeGreaterThanOrEqual(4.5);
      await expect.poll(async () => {
        const label = await note.boundingBox();
        const table = await widthTable(after).boundingBox();
        return label !== null && table !== null && label.y + label.height <= table.y
          && Math.abs(label.x + label.width - table.x - table.width) <= 1;
      }).toBe(true);
    }
    expect(await after.ariaSnapshot()).toContain("Only column widths changed");
    expect(await note.evaluate(element => [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent === "Only column widths changed"))).toBe(true);
    // The same label and marked words survive the one-column projection.
    await page.setViewportSize({ width: 860, height: 640 });
    await expect(page.locator(".ub-revision-split")).toHaveCount(0);
    const single = page.getByLabel("Document revision", { exact: true });
    const singleNote = single.getByText("Only column widths changed", { exact: true });
    await expect(single.locator(".ub-revision-fields")).toHaveText(["Only column widths changed", "Changed: column widths"]);
    await expect(single).not.toContainText("columnWidths");
    await expect(mixedTable(single).locator('[data-revision-change="removed"]')).toHaveText("10");
    await expect(mixedTable(single).locator('[data-revision-change="added"]')).toHaveText("12");
    expect(await single.ariaSnapshot()).toContain("Only column widths changed");
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(singleNote).toBeVisible();
      await expect.poll(async () => {
        const label = await singleNote.boundingBox();
        const table = await widthTable(single).boundingBox();
        return label !== null && table !== null && label.y + label.height <= table.y;
      }).toBe(true);
      const readings = await renderedText(page, ".ub-revision-view .ub-revision-fields");
      expect(readings.length).toBeGreaterThan(0);
      for (const reading of readings) expect(reading.ratio, reading.where).toBeGreaterThanOrEqual(4.5);
    }
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
    await expect(page).toHaveURL(new RegExp(`/${uuid}/rev/${revisionId("latest")}$`));
    const sourceAddress = page.url();
    for (const side of [earlierSide(page), historicalEditor(page)]) {
      const caretInLink = async (label: string): Promise<void> => {
        const paragraph = side.locator(":scope > p").filter({ hasText: `Read ${label}.` });
        // Place the caret before the link with a real click, then enter it with the keyboard.
        await setPointerSelection(paragraph, () => paragraph.click({ position: { x: 2, y: 10 } }));
        for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowRight");
        await expect.poll(() => paragraph.locator("a").evaluate(element => {
          const root = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
          return new Promise<boolean>(resolve => requestAnimationFrame(() => {
            const selection = document.getSelection();
            if (selection?.anchorNode == null || selection.focusNode === null || !selection.isCollapsed ||
              !element.contains(selection.anchorNode) || !root.contains(document.activeElement)) { resolve(false); return; }
            const view = root.editor.view;
            resolve(view.state.selection.anchor === view.posAtDOM(selection.anchorNode, selection.anchorOffset) &&
              view.state.selection.head === view.posAtDOM(selection.focusNode, selection.focusOffset));
          }));
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
        await expect(page).toHaveURL(sourceAddress);
        await expect(page.locator(".ub-revision-title")).toHaveText(title);
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

  test("changed Ablauf viewers open either state and keep diagram coordinates when switching after zoom and pan", { tag: "@webkit" }, async ({ browser }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: {
      viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false,
    }, beforeNavigate: async page => { await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true,
        value: { writeText: async (text: string) => document.documentElement.setAttribute("data-copied-source", text) } });
    }); } });
    const title = docTitle("Ablauf history coordinates");
    const uuid = await newDocument(page, title);
    const sources = { before: historyFlow(6, 0), after: historyFlow(12, 50) };
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], ablaufHistory(uuid, title, [sources]));
    await previous(page);
    await expect(page).toHaveURL(/\/rev\//);
    const dialog = ablaufViewer(page);
    const address = page.url();
    const sides = [[earlierSide(page), "Before", sources.before], [historicalEditor(page), "After", sources.after]] as const;
    // The scaled drawing and Expand share the comparison behavior from either side.
    for (const [side, state, source] of sides) {
      const preview = side.getByRole("region", { name: "Ablauf preview", exact: true });
      await expect(preview.locator("svg")).toBeVisible();
      await expect(preview).toHaveAttribute("data-zoomable", "true");
      for (const opening of ["drawing", "Expand", "keyboard"] as const) {
        if (opening === "drawing") await preview.click();
        else {
          const expand = side.getByRole("button", { name: "Expand ablauf diagram", exact: true });
          await expand.focus();
          if (opening === "keyboard") await page.keyboard.press("Enter");
          else await expand.click();
        }
        await expect(dialog.getByRole("tab", { name: state, exact: true })).toHaveAttribute("aria-selected", "true");
        await expectDiagramFits(dialog);
        await dialog.getByRole("button", { name: "Copy ablauf source", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-copied-source", source);
        await expect(dialog.getByRole("button", { name: "Open ablauf source", exact: true })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(preview).toBeFocused();
        await expect(page).toHaveURL(address);
      }
    }
    const preview = earlierSide(page).getByRole("region", { name: "Ablauf preview", exact: true });
    await preview.click();
    await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(dialog.getByLabel("Zoom level", { exact: true })).toHaveText("125%");
    const viewport = await dialog.locator(".ub-ablauf-viewer-viewport").boundingBox();
    if (viewport === null) throw new Error("The diagram viewport is missing");
    const beforePan = await diagramTransform(dialog);
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    await page.mouse.down();
    await page.mouse.move(viewport.x + viewport.width / 2 + 80, viewport.y + viewport.height / 2 + 45, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await diagramTransform(dialog)).e).not.toBe(beforePan.e);
    const position = await diagramTransform(dialog);
    const zoom = await dialog.getByLabel("Zoom level", { exact: true }).textContent();
    const before = dialog.getByRole("tab", { name: "Before", exact: true });
    const after = dialog.getByRole("tab", { name: "After", exact: true });
    await before.focus();
    await page.keyboard.press("ArrowRight");
    await expect(after).toHaveAttribute("aria-selected", "true");
    await expect(after).toBeFocused();
    await expect(dialog.locator("svg")).toContainText("Later step 50");
    await expectDiagramAt(dialog, position);
    await expect(dialog.getByLabel("Zoom level", { exact: true })).toHaveText(zoom ?? "");
    await page.keyboard.press("ArrowLeft");
    await expect(before).toHaveAttribute("aria-selected", "true");
    await expect(before).toBeFocused();
    await expect(dialog.locator("svg")).not.toContainText("Later step 50");
    await expectDiagramAt(dialog, position);
    await after.click();
    await dialog.getByRole("button", { name: "Copy ablauf source", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-copied-source", sources.after);
    await dialog.getByRole("button", { name: "Fit", exact: true }).click();
    await expectDiagramFits(dialog);
    await expect.poll(async () => Number((await dialog.getByLabel("Zoom level", { exact: true }).textContent())?.replace("%", ""))).toBeLessThan(25);
    const fitted = await diagramTransform(dialog);
    await before.click();
    await expectDiagramAt(dialog, fitted);
    await dialog.getByRole("button", { name: "Fit", exact: true }).click();
    await expectDiagramFits(dialog);
    await expect(dialog.getByLabel("Zoom level", { exact: true })).toHaveText("100%");
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const screenshot = info.outputPath(`ablauf-comparison-viewer-${scheme}.png`);
      await dialog.screenshot({ path: screenshot });
      await info.attach(`ablauf-comparison-viewer-${scheme}`, { path: screenshot, contentType: "image/png" });
    }
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(preview).toBeFocused();
    await expect(page).toHaveURL(address);
  });

  test("iPad taps open either fan-out state and switch without losing its position", { tag: "@webkit-touch" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: {
      ...devices["iPad Pro 11"], viewport: { width: 1366, height: 1024 },
    } });
    const title = docTitle("Touch fan-out comparison");
    const uuid = await newDocument(page, title);
    const before = 'fan-out v0\nstep "Before approval"\noutcome "Accepted" reason="Approved" destination="Start" tone="done"';
    const after = before.replace("Before approval", "After approval")
      + '\noutcome "Deferred" reason="Needs review" destination="Wait" tone="stop"';
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], ablaufHistory(uuid, title, [{ before, after }]));
    await previous(page);
    const dialog = ablaufViewer(page);
    for (const [side, state, opposite] of [[earlierSide(page), "Before", "After"], [historicalEditor(page), "After", "Before"]] as const) {
      const preview = side.getByRole("region", { name: "Ablauf preview", exact: true });
      await expect(preview.locator("svg")).toBeVisible();
      await preview.tap({ position: { x: 30, y: 30 } });
      await expect(dialog.getByRole("tab", { name: state, exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(dialog.locator("svg")).toContainText(`${state} approval`);
      const fitted = await diagramTransform(dialog);
      await dialog.getByRole("button", { name: "Zoom in", exact: true }).tap();
      await expect.poll(async () => (await diagramTransform(dialog)).a).toBeGreaterThan(fitted.a);
      const position = await diagramTransform(dialog);
      const other = dialog.getByRole("tab", { name: opposite, exact: true });
      const bounds = await other.boundingBox();
      if (bounds === null) throw new Error("The comparison switch is missing");
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      await other.tap();
      await expect(other).toHaveAttribute("aria-selected", "true");
      await expect(dialog.locator("svg")).toContainText(`${opposite} approval`);
      await expectDiagramAt(dialog, position);
      await dialog.getByRole("button", { name: "Close diagram viewer", exact: true }).tap();
      await expect(dialog).toHaveCount(0);
      await expect(preview).toBeFocused();
    }
  });

  test("unchanged, added, removed and unrenderable comparison drawings keep the ordinary viewer, as does one column", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 900 } },
      beforeNavigate: async page => { await page.addInitScript(() => {
        const measure = CanvasRenderingContext2D.prototype.measureText;
        CanvasRenderingContext2D.prototype.measureText = function (text) {
          if (text.includes("Unrenderable")) throw new Error("Injected text measurement failure");
          return measure.call(this, text);
        };
      }); } });
    const title = docTitle("Ordinary history drawing viewers");
    const uuid = await newDocument(page, title);
    const drawing = (name: string) => `flow v0\ncolumns main\nbox first title="${name}"`;
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], ablaufHistory(uuid, title, [
      { before: drawing("Unchanged drawing"), after: drawing("Unchanged drawing") },
      { before: drawing("Removed drawing") },
      { after: drawing("Added drawing") },
      { before: drawing("Invalid after drawing"), after: drawing("Unrenderable drawing") },
      { before: drawing("Unrenderable drawing"), after: drawing("Invalid before drawing") },
      { before: drawing("Changed before drawing"), after: drawing("Changed after drawing") },
    ]));
    await previous(page);
    const drawer = await showHistoryList(page);
    await historyList(page).getByRole("switch", { name: "Collapse unchanged" }).uncheck();
    await closeHistoryList(page, drawer);
    const dialog = ablaufViewer(page);
    for (const side of [earlierSide(page), historicalEditor(page)]) {
      await expect(side.locator(".ub-ablauf-diagnostics").filter({ hasText: "Injected text measurement failure" })).toBeVisible();
    }
    for (const [side, name] of [[earlierSide(page), "Unchanged drawing"], [historicalEditor(page), "Unchanged drawing"],
      [earlierSide(page), "Removed drawing"], [historicalEditor(page), "Added drawing"],
      [earlierSide(page), "Invalid after drawing"], [historicalEditor(page), "Invalid before drawing"]] as const) {
      const block = side.locator(".ub-ablauf").filter({ hasText: name });
      await expect(block.locator("svg")).toBeVisible();
      const expand = block.getByRole("button", { name: "Expand ablauf diagram", exact: true });
      await expand.focus();
      await page.keyboard.press("Enter");
      await expect(dialog.locator("svg")).toContainText(name);
      await expect(dialog.getByRole("tab", { name: /Before|After/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
    await page.setViewportSize({ width: 860, height: 900 });
    await expect(page.locator(".ub-revision-split")).toHaveCount(0);
    const changed = historicalEditor(page).locator(".ub-ablauf").filter({ hasText: "Changed after drawing" });
    await expect(changed.locator("svg")).toBeVisible();
    await changed.getByRole("button", { name: "Expand ablauf diagram", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog.locator("svg")).toContainText("Changed after drawing");
    await expect(dialog.getByRole("tab", { name: /Before|After/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
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
    expect(await compare.evaluate((element) => {
      const left = [...element.querySelectorAll(".ub-json-compare-before")];
      const right = [...element.querySelectorAll(".ub-json-compare-after")];
      return left.length > 0 && left.length === right.length && left.every((cell, index) =>
        Math.abs(cell.getBoundingClientRect().top - (right[index]?.getBoundingClientRect().top ?? Number.NaN)) <= 1);
    })).toBe(true);
  });

  test("JSON comparison selection, copying and folding work independently in either pane", { tag: "@webkit" }, async ({ browser }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 1000 } } });
    const title = docTitle("JSON comparison interactions");
    const uuid = await newDocument(page, title);
    const oldValue = "Earlier version with a long value that wraps within the JSON pane. ".repeat(4);
    const sources = {
      before: JSON.stringify({ version: oldValue, nested: { a: 1, b: 2 }, tail: "same" }, null, 2),
      after: JSON.stringify({ version: "new", nested: { a: 1, b: 2 }, tail: "same" }, null, 2),
    };
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], jsonHistory(uuid, title, sources));
    await previous(page);
    const compare = page.locator(".ub-json-compare");
    const before = compare.getByRole("textbox", { name: "Before JSON", exact: true });
    const after = compare.getByRole("textbox", { name: "After JSON", exact: true });
    await expect(compare).toBeVisible();
    const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
    const copyText = async () => {
      await page.keyboard.press(`${modifier}+c`);
      const target = page.locator("textarea[data-copy-target]");
      await page.evaluate(() => {
        const textarea = document.createElement("textarea");
        textarea.dataset.copyTarget = "true";
        document.body.append(textarea);
        textarea.focus();
      });
      await page.keyboard.press(`${modifier}+v`);
      const text = await target.inputValue();
      await target.evaluate(element => element.remove());
      return text;
    };
    // Select all from surrounding prose, then paste the native clipboard into a plain-text target.
    for (const [side, source] of [[earlierSide(page), sources.before], [historicalEditor(page), sources.after]] as const) {
      const paragraph = side.locator(":scope > p").first();
      await setPointerSelection(paragraph, () => paragraph.click());
      await page.keyboard.press(`${modifier}+a`);
      expect(await copyText()).toBe(`The planner's settings, as the hub reports them.\n\n${source}\n\nAn unchanged closing paragraph.`);
    }
    const aligned = () => compare.evaluate(element => {
      const left = [...element.querySelectorAll(".ub-json-compare-before")];
      const right = [...element.querySelectorAll(".ub-json-compare-after")];
      return left.length > 0 && left.length === right.length && left.every((cell, index) =>
        Math.abs(cell.getBoundingClientRect().top - (right[index]?.getBoundingClientRect().top ?? Number.NaN)) <= 1);
    });
    await expect.poll(aligned).toBe(true);
    for (const [own, other, side] of [[before, after, "before"], [after, before, "after"]] as const) {
      // Tab reaches both container buttons; Enter and Space update both panes and keep focus.
      await own.focus();
      await page.keyboard.press("Tab");
      await expect(own.locator(".ub-json-toggle").first()).toBeFocused();
      await page.keyboard.press("Tab");
      const nested = own.locator(".ub-json-toggle").nth(1);
      await expect(nested).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(nested).toHaveAttribute("aria-expanded", "true");
      await expect(other.locator(".ub-json-toggle").nth(1)).toHaveAttribute("aria-expanded", "true");
      await expect(nested).toBeFocused();
      await page.keyboard.press("Space");
      await expect(nested).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("Enter");
      await expect(own.getByRole("button", { name: "2 unchanged keys", exact: true })).toBeVisible();
      await expect.poll(aligned).toBe(true);
      for (const endPane of [own, other]) {
        // Clipboard focus can scroll the pane, so each drag needs its current endpoints.
        const start = await own.locator(".ub-json-key").filter({ hasText: '"version"' }).boundingBox();
        const end = await endPane.locator(".ub-json-key").filter({ hasText: '"tail"' }).boundingBox();
        if (start === null || end === null) throw new Error("Missing JSON selection endpoints");
        await page.mouse.move(start.x, start.y + start.height / 2);
        await page.mouse.down();
        await page.mouse.move(end.x + end.width, end.y + end.height / 2, { steps: 12 });
        await page.mouse.up();
        await expect.poll(() => own.evaluate(element => {
          const selection = document.getSelection();
          return selection !== null && !selection.isCollapsed && element.contains(selection.anchorNode) && element.contains(selection.focusNode);
        })).toBe(true);
        const selected = await page.evaluate(() => document.getSelection()?.toString() ?? "");
        expect(selected.match(/"version"/g)).toHaveLength(1);
        expect(selected).toContain(side === "before" ? "Earlier version" : '"new"');
        expect(selected).not.toContain(side === "before" ? '"new"' : "Earlier version");
        const copied = await copyText();
        expect(copied).toContain('"version"');
        expect(copied).not.toMatch(/unchanged keys|▾|▸/);
      }
      // Native input and clipboard actions cannot mutate the read-only selection host.
      // Select-all from a caret in a pane selects that pane only.
      await own.click();
      await page.keyboard.press(`${modifier}+a`);
      expect(await own.evaluate(element => {
        const selection = document.getSelection();
        return selection !== null && !selection.isCollapsed && element.contains(selection.anchorNode) && element.contains(selection.focusNode);
      })).toBe(true);
      const paneCopy = await copyText();
      expect(paneCopy.match(/"version"/g)).toHaveLength(1);
      expect(paneCopy).toContain(side === "before" ? "Earlier version" : '"new"');
      expect(paneCopy).not.toContain(side === "before" ? '"new"' : "Earlier version");
      expect(paneCopy).not.toMatch(/unchanged keys|▾|▸|planner's settings|closing paragraph/);
      await own.click();
      await page.keyboard.press(`${modifier}+a`);
      const original = await own.innerHTML();
      await page.keyboard.type("mutation");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Enter");
      await page.keyboard.press(`${modifier}+x`);
      await page.keyboard.press(`${modifier}+v`);
      expect(await own.innerHTML()).toBe(original);
      await nested.click();
    }
    await info.attach("JSON comparison interactions", { body: await compare.screenshot(), contentType: "image/png" });
  });

  test("JSON comparison rejects IME text inline and full screen while search accepts it", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 1000 } } });
    const title = docTitle("Read-only JSON composition");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], jsonHistory(uuid, title, {
      before: JSON.stringify({ version: "日本 old", nested: { a: 1 } }),
      after: JSON.stringify({ version: "日本 new", nested: { a: 2 } }),
    }));
    await previous(page);
    const compare = page.locator(".ub-json-compare");
    await expect(compare).toBeVisible();
    const session = await page.context().newCDPSession(page);
    try {
      for (const expanded of [false, true]) {
        if (expanded) await compare.getByRole("button", { name: "Expand JSON comparison" }).click();
        const panel = expanded ? page.getByRole("dialog", { name: "JSON comparison", exact: true }) : compare;
        await expect(panel).toBeVisible();
        for (const side of ["Before", "After"]) {
          const pane = panel.getByRole("textbox", { name: `${side} JSON`, exact: true });
          for (const commit of [true, false]) {
            await pane.focus();
            await pane.evaluate((element, commit) => {
              const text = element.querySelector(".ub-json-string")?.firstChild;
              if (text == null) throw new Error("Missing JSON composition target");
              document.getSelection()?.setBaseAndExtent(text, 1, text, commit ? 1 : (text.textContent?.length ?? 1));
            }, commit);
            const original = await pane.innerHTML();
            await session.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
            expect(await pane.innerHTML()).toBe(original);
            await session.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 });
            expect(await pane.innerHTML()).toBe(original);
            if (commit) await session.send("Input.insertText", { text: "日本" });
            else await session.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
            expect(await pane.innerHTML()).toBe(original);
            if (expanded) await expect(panel.getByRole("searchbox", { name: "Search keys and values" })).toHaveValue("");
          }
        }
      }
      const search = page.getByRole("searchbox", { name: "Search keys and values" });
      await search.focus();
      await session.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 });
      await expect(search).toHaveValue("にほん");
      await session.send("Input.insertText", { text: "日本" });
      await expect(search).toHaveValue("日本");
      await expect(page.locator(".ub-json-tree-count")).toHaveText("1 of 1");
    } finally {
      await session.detach();
    }
  });

  test("JSON comparison copies only selected authored text inline and full screen", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 1000 } } });
    const title = docTitle("Partial JSON copying");
    const uuid = await newDocument(page, title);
    const sources = {
      before: JSON.stringify({ version: "alpha old omega", nested: { a: 1, b: 2 }, tail: "end old" }, null, 2),
      after: JSON.stringify({ version: "alpha new omega", nested: { a: 1, b: 2 }, tail: "end new" }, null, 2),
    };
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], jsonHistory(uuid, title, sources));
    await previous(page);
    const compare = page.locator(".ub-json-compare");
    await expect(compare).toBeVisible();
    const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
    type Endpoint = { key: string; part: "key" | "string"; offset: number };
    const select = async (pane: Locator, from: Endpoint, to: Endpoint) => {
      await pane.focus();
      await pane.evaluate((element, { from, to }) => {
        const point = ({ key, part, offset }: Endpoint): { node: Node; offset: number } => {
          const keyElement = [...element.querySelectorAll(".ub-json-key")].find(each => each.textContent === JSON.stringify(key));
          const row = keyElement?.closest(".ub-json-compare-cell");
          if (row == null) throw new Error(`Missing JSON row ${key}`);
          let remaining = offset;
          for (const piece of row.querySelectorAll(`.ub-json-${part}`)) {
            const walker = document.createTreeWalker(piece, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              const length = node.textContent?.length ?? 0;
              if (remaining <= length) return { node, offset: remaining };
              remaining -= length;
            }
          }
          throw new Error(`Missing JSON text offset ${key}:${offset}`);
        };
        const start = point(from);
        const end = point(to);
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
      }, { from, to });
    };
    const copyText = async (pane: Locator) => {
      await page.keyboard.press(`${modifier}+c`);
      await pane.evaluate(element => {
        const textarea = document.createElement("textarea");
        textarea.dataset.copyTarget = "true";
        (element.closest('[role="dialog"]') ?? document.body).append(textarea);
        textarea.focus();
      });
      const target = page.locator("textarea[data-copy-target]");
      await page.keyboard.press(`${modifier}+v`);
      const text = await target.inputValue();
      await target.evaluate(element => element.remove());
      return text;
    };
    for (const expanded of [false, true]) {
      if (expanded) await compare.getByRole("button", { name: "Expand JSON comparison" }).click();
      const panel = expanded ? page.getByRole("dialog", { name: "JSON comparison", exact: true }) : compare;
      await expect(panel).toBeVisible();
      const nested = panel.getByRole("textbox", { name: "Before JSON", exact: true }).locator('.ub-json-toggle[data-key=".nested"]');
      if (await nested.getAttribute("aria-expanded") === "false") await nested.click();
      await expect(panel.getByRole("textbox", { name: "Before JSON", exact: true }).getByRole("button", { name: "2 unchanged keys", exact: true })).toBeVisible();
      for (const side of ["Before", "After"] as const) {
        const pane = panel.getByRole("textbox", { name: `${side} JSON`, exact: true });
        await select(pane, { key: "version", part: "string", offset: 1 }, { key: "version", part: "string", offset: 6 });
        await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("alpha");
        expect(await copyText(pane)).toBe("alpha");
        await select(pane, { key: "version", part: "key", offset: 1 }, { key: "version", part: "key", offset: 4 });
        await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("ver");
        expect(await copyText(pane)).toBe("ver");
        await select(pane, { key: "version", part: "string", offset: 1 }, { key: "tail", part: "string", offset: 4 });
        const value = side === "Before" ? "old" : "new";
        expect(await copyText(pane)).toBe(`alpha ${value} omega",\n  "nested": {\n  },\n  "tail": "end`);
      }
    }
  });

  test("changes inside a json-tree comparison get their own ruler marks and change steps, and open full screen", async ({ browser }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 640 } } });
    const title = docTitle("Long JSON comparison");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], longJsonHistory(uuid, title));
    await previous(page);
    const compare = page.locator(".ub-json-compare");
    await expect(compare).toBeVisible();
    await expect.poll(() => runningMotion(page)).toBe(0);
    const changeMarks = async () => (await rulerGeometry(page)).marks.filter((mark) => mark.kind !== "same" && mark.kind !== "fold");
    // One ruler mark per changed row inside the block, plus the changed paragraph.
    const innerChanges = () => compare.locator(".ub-json-compare-after[data-change]").count();
    await expect.poll(async () => (await changeMarks()).length).toBe(await innerChanges() + 1);
    // Showing unchanged keys spreads the block; the marks follow, and the nested change is folded away.
    await compare.getByRole("switch", { name: "Collapse unchanged" }).uncheck();
    await expect(compare.locator('.ub-json-compare-after[data-path=".nested"]')).toHaveAttribute("data-folded", "true");
    await expect.poll(async () => (await changeMarks()).length).toBe(await innerChanges() + 1);
    const marks = await changeMarks();
    expect((marks.at(-1)?.top ?? 0) - (marks[0]?.top ?? 0)).toBeGreaterThan(100);
    // Next change visits each change inside the block, opening the folded one, then the paragraph after it.
    const nextChange = page.getByRole("button", { name: "Next change", exact: true });
    const pane = page.locator(".ub-revision-pane");
    // Instant scrolling, so the buttons settle after each step.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const settled = () => page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); }));
    let steps = 0;
    for (; steps < 8 && await nextChange.isEnabled(); steps += 1) {
      const before = await pane.evaluate((element) => element.scrollTop);
      await activateControl(nextChange);
      await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
      await settled();
      if (steps === 0) {
        const screenshot = info.outputPath("json-ruler.png");
        await page.screenshot({ path: screenshot });
        await info.attach("json-ruler", { path: screenshot, contentType: "image/png" });
      }
    }
    // The nested change in the middle, then the end; the first change is already current.
    expect(steps).toBeGreaterThanOrEqual(2);
    await expect(nextChange).toBeDisabled();
    await expect(compare.locator('.ub-json-compare-after[data-path=".nested.deep.level"]')).toBeVisible();
    await expect(compare.locator(".ub-json-compare-after[data-folded]")).toHaveCount(0);
    await expect.poll(() => pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
    // Full screen shows the same rows, searches both panes, and steps between changes.
    const rows = await compare.locator(".ub-json-compare-after").count();
    await compare.getByRole("button", { name: "Expand JSON comparison" }).click();
    const dialog = page.getByRole("dialog", { name: "JSON comparison" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".ub-json-compare-after")).toHaveCount(rows);
    await expect(dialog.getByRole("switch", { name: "Collapse unchanged" })).not.toBeChecked();
    await expect(dialog.getByRole("button", { name: "Previous change" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Next change" }).click();
    await expect.poll(() => dialog.locator(".ub-json-compare-viewer-body").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await dialog.getByRole("searchbox", { name: "Search keys and values" }).fill("value 2");
    await expect(dialog.locator(".ub-json-tree-count")).toHaveText("1 of 11");
    await expect(dialog.locator(".ub-json-compare-before mark.ub-json-match")).toHaveCount(11);
    await expect(dialog.locator(".ub-json-compare-after mark.ub-json-match")).toHaveCount(11);
    await expect(dialog.locator("mark.ub-json-match-current")).toHaveCount(2);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // Buttons ease into the new scheme.
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
      const screenshot = info.outputPath(`json-compare-viewer-${scheme}.png`);
      await page.screenshot({ path: screenshot });
      await info.attach(`json-compare-viewer-${scheme}`, { path: screenshot, contentType: "image/png" });
    }
    await page.emulateMedia({ colorScheme: "light" });
    // Search opens what holds a match, there and back in the block.
    await dialog.getByRole("switch", { name: "Collapse unchanged" }).check();
    await dialog.getByRole("searchbox", { name: "Search keys and values" }).fill("steady");
    await expect(dialog.locator(".ub-json-tree-count")).toHaveText("1 of 2");
    await expect(dialog.locator(".ub-json-compare-after mark.ub-json-match-current")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(compare.getByRole("button", { name: "Expand JSON comparison" })).toBeFocused();
    await expect(compare.getByRole("switch", { name: "Collapse unchanged" })).toBeChecked();
    await expect(compare.locator('.ub-json-compare-after[data-path=".nested.deep.label"]')).toBeVisible();
  });

  test("nearby JSON changes are visited once in either direction, including the last change", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane",
      contextOptions: { viewport: { width: 1440, height: 640 }, reducedMotion: "reduce" } });
    const title = docTitle("Nearby JSON changes");
    const uuid = await newDocument(page, title);
    const context = (prefix: string) => Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`${prefix}${index}`, "steady"]));
    const source = (value: number) => JSON.stringify({
      ...context("prefix"), one: value, betweenOneAndTwo: "steady", two: value, betweenTwoAndThree: "steady", three: value, ...context("suffix"),
    }, null, 2);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], jsonHistory(uuid, title, { before: source(1), after: source(2) }));
    await previous(page);
    const compare = page.locator(".ub-json-compare");
    await expect(compare).toBeVisible();
    await compare.getByRole("switch", { name: "Collapse unchanged" }).uncheck();
    const pane = page.locator(".ub-revision-pane");
    const previousChange = page.getByRole("button", { name: "Previous change", exact: true });
    const nextChange = page.getByRole("button", { name: "Next change", exact: true });
    const offset = (path: string) => compare.locator(`.ub-json-compare-after[data-path=".${path}"]`).evaluate((element) => {
      const header = document.querySelector(".ub-revision-header");
      if (header === null) throw new Error("The revision header is missing");
      return element.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 8;
    });
    await expect.poll(() => runningMotion(page)).toBe(0);
    await pane.evaluate((element) => {
      const first = element.querySelector('.ub-json-compare-after[data-path=".one"]');
      const header = element.querySelector(".ub-revision-header");
      if (first === null || header === null) throw new Error("The first change or header is missing");
      element.scrollBy(0, first.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 8);
    });
    await expect.poll(async () => Math.abs(await offset("one"))).toBeLessThan(2);
    await expect(previousChange).toBeDisabled();
    // Each distinct change is closer than the current-change tolerance.
    expect(await offset("two")).toBeGreaterThan(2);
    expect(await offset("two")).toBeLessThan(64);
    for (const path of ["two", "three"]) {
      await expect(nextChange).toBeEnabled();
      await activateControl(nextChange);
      await expect.poll(async () => Math.abs(await offset(path))).toBeLessThan(2);
    }
    await expect(nextChange).toBeDisabled();
    // The last change is current even though unchanged trailing rows still leave room to scroll.
    expect(await pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100);
    for (const path of ["two", "one"]) {
      await expect(previousChange).toBeEnabled();
      await activateControl(previousChange);
      await expect.poll(async () => Math.abs(await offset(path))).toBeLessThan(2);
    }
    await expect(previousChange).toBeDisabled();
  });

  test("opening a drawn history fold keeps the reading position", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: { viewport: { width: 1440, height: 420 } } });
    const title = docTitle("Drawn fold position");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], drawnFoldHistory(uuid, title));
    await previous(page);
    const pane = page.locator(".ub-revision-pane");
    const after = historicalEditor(page);
    await expect(after.locator(".ub-wireframe-fit")).toHaveCSS("height", /[1-9][0-9]+px/);
    await expect.poll(() => runningMotion(page)).toBe(0);
    const bar = after.locator(".ub-revision-fold-button");
    await bar.scrollIntoViewIfNeeded();
    const start = after.locator('.ub-revision-row-start[data-key="fold-2"]');
    const top = await start.evaluate(element => element.getBoundingClientRect().top);
    const scroll = await pane.evaluate(element => element.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    await bar.click();
    await expect(after).toContainText("Unchanged context 1");
    await expect.poll(() => runningMotion(page)).toBe(0);
    expect(await pane.evaluate(element => element.scrollTop)).toBe(scroll);
    expect(Math.abs(await after.locator('.ub-revision-row-start[data-key="row-2"]').evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(2);
  });

  for (const appearance of ["light", "dark"] as const) {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      test(`drawn folds stay in place on either side — ${appearance}, ${reducedMotion}`, { tag: "@webkit" }, async ({ browser }) => {
        const page = await openApp(browser, "/", { readySelector: ".ub-pane", contextOptions: {
          viewport: { width: 1440, height: 420 }, colorScheme: appearance, reducedMotion,
        }, beforeNavigate: async page => {
          await mockFigmaLookup(page);
          await page.route("https://embed.figma.com/**", route => route.fulfill({ contentType: "text/html", body: "<p>Context design</p>" }));
        } });
        const title = docTitle("Embedded fold position");
        const uuid = await newDocument(page, title);
        await serveHistory(page, [
          { id: "latest", author: null, startedAt: 2_000, endedAt: null },
          { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
        ], embeddedFoldHistory(uuid, title));
        await previous(page);
        const pane = page.locator(".ub-revision-pane");
        await expect(page.locator(".ub-revision-fold-button")).toHaveCount(4);
        for (const [index, side] of [historicalEditor(page), earlierSide(page)].entries()) {
          await comparisonDrawn(page);
          const bar = side.locator(".ub-revision-fold-button").first();
          await bar.scrollIntoViewIfNeeded();
          const run = await bar.getAttribute("data-fold");
          const positions = await Promise.all([historicalEditor(page), earlierSide(page)].map(view =>
            view.locator(`.ub-revision-row-start[data-key="fold-${run}"]`).evaluate(element => element.getBoundingClientRect().top)));
          const above = await side.locator(`.ub-revision-row-start[data-key="fold-${run}"]`).locator("xpath=preceding-sibling::*[2]").elementHandle();
          if (above === null) throw new Error("The context above the fold is missing");
          const aboveTop = await above.evaluate(element => element.getBoundingClientRect().top);
          const scroll = await pane.evaluate(element => element.scrollTop);
          expect(scroll).toBeGreaterThan(0);
          await activateControl(bar);
          await expect(historicalEditor(page)).toContainText(`Opened run ${index + 1} begins here.`);
          expect(await pane.evaluate(element => element.scrollTop)).toBe(scroll);
          if (reducedMotion === "reduce") expect(await runningMotion(page)).toBe(0);
          else expect(await runningMotion(page)).toBeGreaterThan(0);
          await comparisonDrawn(page);
          expect(await pane.evaluate(element => element.scrollTop)).toBe(scroll);
          expect(Math.abs(await above.evaluate(element => element.getBoundingClientRect().top) - aboveTop)).toBeLessThanOrEqual(2);
          for (const [sideIndex, view] of [historicalEditor(page), earlierSide(page)].entries()) {
            const top = await view.locator(`.ub-revision-row-start[data-key="row-${run}"]`).evaluate(element => element.getBoundingClientRect().top);
            expect(Math.abs(top - (positions[sideIndex] ?? 0))).toBeLessThanOrEqual(2);
          }
          if (index === 0) {
            const figma = side.locator(".ub-figma").first();
            await figma.scrollIntoViewIfNeeded();
            await expect(figma.locator("iframe").contentFrame().locator("p")).toHaveText("Context design");
          }
        }
        await expect(page.locator(".ub-revision-fold-button")).toHaveCount(0);
      });
    }
  }

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

  test("rename markers and named comparisons use each revision's immediate predecessor", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const uuid = await newDocument(page, docTitle("Rename attribution"));
    const person = { githubUsername: "browser-person", surface: { kind: "browser" as const, name: "Browser" } };
    const snapshotReads = await serveHistory(page, [
      { id: "latest", title: "Alpha", author: { ...person, githubUsername: "Latest author" }, startedAt: 3_000, endedAt: 4_000 },
      { id: "middle", title: "Beta", author: { ...person, githubUsername: "Middle author" }, startedAt: 2_000, endedAt: 3_000 },
      { id: "renamed", title: "Beta", author: { ...person, githubUsername: "Rename author" }, startedAt: 1_500, endedAt: 2_000 },
      { id: "baseline", title: "Alpha", author: person, startedAt: 1_000, endedAt: 1_500,
        name: { text: "Kickoff", namer: person, namedAt: 2_000, canManage: true } },
    ], {
      latest: savedState(uuid, "Alpha", "Latest content."),
      middle: savedState(uuid, "Beta", "Middle content."),
      renamed: savedState(uuid, "Beta", "Rename content."),
      baseline: savedState(uuid, "Alpha", "Baseline content."),
    });
    await previous(page);
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(history(page).locator(".ub-history-renamed s")).toHaveText("Beta");
    await expect(history(page).locator(".ub-history-when")).toContainText("· current version");
    await expect(history(page).locator(".ub-history-when time")).toHaveAttribute("datetime", new Date(4_000).toISOString());
    let drawer = await showHistoryList(page);
    const list = historyList(page);
    const middle = list.getByRole("button", { name: /Middle author/ });
    const renamed = list.getByRole("button", { name: /Rename author/ });
    await expect(renamed).toContainText("renamed");
    await expect(middle).not.toContainText("renamed");
    expect(snapshotReads).toEqual(["latest", "middle"]);
    await expect(list.getByRole("button", { name: /Latest author/ })).toContainText("renamed");
    await activateControl(middle);
    await expect(historicalEditor(page)).toContainText("Middle content.");
    await closeHistoryList(page, drawer);
    await expect(history(page)).not.toContainText("renamed from");
    drawer = await showHistoryList(page);
    await activateControl(renamed);
    await expect(historicalEditor(page)).toContainText("Rename content.");
    await closeHistoryList(page, drawer);
    await expect(history(page).locator(".ub-history-renamed s")).toHaveText("Alpha");
    drawer = await showHistoryList(page);
    const since = list.getByRole("button", { name: "Changes since this name", exact: true });
    await activateControl(since);
    await expect(since).toHaveAttribute("aria-current", "true");
    await closeHistoryList(page, drawer);
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(history(page)).toContainText("compared with “Kickoff”");
    await expect(history(page).locator(".ub-history-renamed s")).toHaveText("Beta");
    await expect(history(page).locator(".ub-history-when")).toContainText("· current version");
    await expect(history(page).locator(".ub-history-when time")).toHaveAttribute("datetime", new Date(4_000).toISOString());
    await showHistoryList(page);
    await expect(renamed).toContainText("renamed");
    await expect(middle).not.toContainText("renamed");
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
      await expect(earlier.locator(".ub-revision-fields")).toHaveText(["Data changed: measurements", "Data changed: measurements"]);
      await expect(page.locator(".ub-revision-split [data-revision-mark]")).toHaveCount(0);
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

  test("unavailable history retries into an empty state and returns to the live document", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await page.route("**/api/revisions?**", route => route.fulfill({
      status: 503, contentType: "application/json", body: JSON.stringify({ error: "history_unavailable", reason: "unreachable" }),
    }));
    await newDocument(page, docTitle("Unavailable history"));
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await previous(page);
    const state = page.locator(".ub-revision-pane").getByRole("status");
    await expect(state).toHaveText("History is unavailable: the hub cannot be reached.");
    await expect(historicalEditor(page)).toHaveCount(0);
    await page.unroute("**/api/revisions?**");
    await serveHistory(page, [], {});
    await activateControl(page.locator(".ub-revision-pane").getByRole("button", { name: "Try again", exact: true }));
    await expect(state).toHaveText("No revisions yet");
    await expect(historicalEditor(page)).toHaveCount(0);
    await backToNow(page);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });
});

test.describe("local-only document history", () => {
  const { openApp } = setupHarness({ accessRole: "admin", localWorkspace: true });

  test("a local-only workspace shows no time-travel control", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await newDocument(page, docTitle("Local document"));
    await expect(history(page)).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });

  test("a local-only history address opens the live document at its plain address", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await newDocument(page, docTitle("Local history address"));
    const address = page.url();
    for (const suffix of [`/rev/${revisionId("latest")}`, `/rev/${revisionId("latest")}/since/${revisionId("earlier")}`]) {
      const shared = await openApp(browser, `${new URL(address).pathname}${suffix}`, { readySelector: ".ub-editor .ProseMirror" });
      await expect(shared).toHaveURL(address);
      await expect(history(shared)).toHaveCount(0);
      await expect(shared.locator(".ub-revision-pane")).toHaveCount(0);
      await expect(editor(shared)).toHaveAttribute("contenteditable", "true");
    }
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

function toggleJsonNavigationHistory(uuid: string, title: string, precedingChange: boolean): Record<string, string> {
  const document = new Y.Doc();
  const source = (value: number) => JSON.stringify({ one: value, between: "steady", two: value }, null, 2);
  try {
    initDoc(document, { uuid, title });
    const first = appendBlock(document, { type: "paragraph", text: "First" });
    appendBlock(document, { type: "paragraph", text: "Long context ".repeat(50) });
    appendBlock(document, { type: "heading", level: 2, text: "> Details" });
    const inside = appendBlock(document, { type: "code", language: "json-tree", text: source(1) });
    appendBlock(document, { type: "heading", level: 2, text: "End" });
    appendBlock(document, { type: "paragraph", text: "Tail ".repeat(400) });
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    if (precedingChange) editBlock(document, first, "First", "First changed");
    editBlock(document, inside, source(1), source(2));
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
  }
}

test.describe("change navigation through authored toggles", () => {
  const { openApp } = setupHarness({ accessRole: "admin" });

  for (const precedingChange of [false, true]) {
    test(`JSON changes in folded toggles remain marked and reachable ${precedingChange ? "after a preceding change" : "as the only change"}`, { tag: "@webkit" }, async ({ browser }) => {
      const page = await openApp(browser, "/", { readySelector: ".ub-pane",
        contextOptions: { viewport: { width: 1440, height: 640 }, reducedMotion: "reduce" } });
      const title = docTitle("JSON changes inside authored toggles");
      const uuid = await newDocument(page, title);
      await serveHistory(page, [
        { id: "latest", author: null, startedAt: 2_000, endedAt: null },
        { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
      ], toggleJsonNavigationHistory(uuid, title, precedingChange));
      await previous(page);
      const sides = [earlierSide(page), historicalEditor(page)];
      const compare = page.locator(".ub-json-compare");
      const pane = page.locator(".ub-revision-pane");
      const nextChange = page.getByRole("button", { name: "Next change", exact: true });
      const previousChange = page.getByRole("button", { name: "Previous change", exact: true });
      const changeMarks = async () => (await rulerGeometry(page)).marks.filter(mark => mark.kind !== "same" && mark.kind !== "fold");
      const offset = (path: string) => compare.locator(`.ub-json-compare-after[data-path=".${path}"]`).evaluate(element => {
        const header = document.querySelector(".ub-revision-header");
        if (header === null) throw new Error("The revision header is missing");
        return element.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 8;
      });
      const assertFolded = async (): Promise<void> => {
        await expect(page.getByTestId("revision-ruler")).toBeAttached();
        await expect(compare).toBeHidden();
        await expect.poll(async () => (await changeMarks()).length).toBe(1 + Number(precedingChange));
        await expect(previousChange).toBeDisabled();
        await expect(nextChange).toBeEnabled();
      };
      const assertDestination = async (path: string): Promise<void> => {
        await expect(compare).toBeVisible();
        for (const side of sides) {
          await expect(side.getByRole("button", { name: "Collapse Details", exact: true })).toHaveAttribute("aria-expanded", "true");
        }
        await expect.poll(async () => Math.abs(await offset(path))).toBeLessThan(2);
        await expect.poll(async () => (await changeMarks()).length).toBe(2 + Number(precedingChange));
      };
      const stepBack = async (path: string): Promise<void> => {
        const before = await pane.evaluate(element => element.scrollTop);
        await expect(previousChange).toBeEnabled();
        await activateControl(previousChange);
        await assertDestination(path);
        expect(await pane.evaluate(element => element.scrollTop)).toBeLessThan(before);
      };
      await expect.poll(() => runningMotion(page)).toBe(0);
      await assertFolded();
      expect(await pane.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
      await activateControl(nextChange);
      await assertDestination("one");
      if (!precedingChange) await expect(previousChange).toBeDisabled();
      await activateControl(nextChange);
      await assertDestination("two");
      await expect(nextChange).toBeDisabled();
      await stepBack("one");
      if (!precedingChange) await expect(previousChange).toBeDisabled();
      // Closing both sections restores one fallback mark and target before the hidden inner rows.
      for (const side of sides) {
        await side.getByRole("button", { name: "Collapse Details", exact: true }).evaluate((element: HTMLButtonElement) => element.click());
      }
      await pane.evaluate(element => element.scrollTo(0, 0));
      await assertFolded();
      // Approaching from below opens the final inner change, then Previous continues upward.
      await pane.evaluate(element => element.scrollTo(0, element.scrollHeight));
      await expect(previousChange).toBeEnabled();
      await activateControl(previousChange);
      await assertDestination("two");
      await stepBack("one");
      if (precedingChange) {
        const before = await pane.evaluate(element => element.scrollTop);
        await activateControl(previousChange);
        await expect.poll(() => sides[1]?.locator(":scope > .ub-revision-row-start").first().evaluate(element => {
          const header = document.querySelector(".ub-revision-header");
          if (header === null) throw new Error("The revision header is missing");
          return Math.abs(element.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 8);
        })).toBeLessThan(2);
        expect(await pane.evaluate(element => element.scrollTop)).toBeLessThan(before);
      }
      await expect(previousChange).toBeDisabled();
    });
  }

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
