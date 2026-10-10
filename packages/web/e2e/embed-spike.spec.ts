/**
 * SPIKE ONLY (spikes/embeds, never merged). Seeds a document with prose and
 * two `embed` code blocks, then counts iframe loads and node view lifetimes
 * (window.__embedSpike, see src/editor/embed-spike.ts) across ordinary edits,
 * and lists the report-only CSP violations the app raises under `ub open`.
 *
 *   pnpm --filter ./packages/web exec playwright test e2e/embed-spike.spec.ts --project=chromium
 *
 * Writes spikes/embeds/results/phase2/*.json and screenshots.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../spikes/embeds/results/phase2");
const FIGMA = "https://www.figma.com/proto/nrPSsILSYjesyc5UHjYYa4/Embed-Kit-2.0-examples?node-id=5-3&starting-point-node-id=5%3A3";
const YOUTUBE = "https://www.youtube.com/watch?v=y9lZ5GMXNyU";
const SETTLE = 6000;

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-embed-spike-${process.env.UB_AGENTS_RUN ?? "local"}-`,
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface Probe {
  created: { instance: number; block: string }[];
  destroyed: { instance: number; block: string }[];
  loads: { instance: number; block: string; src: string }[];
  srcChanges: { instance: number; block: string }[];
  domMoves: { instance: number; block: string }[];
}

async function snapshot(page: Page): Promise<Record<string, number | string>> {
  const probe = await page.evaluate(() => (window as unknown as { __embedSpike?: Probe }).__embedSpike);
  const live = await page.$$eval(".ub-embed-spike iframe", (els) => els.map((el) => (el as HTMLElement).dataset.instance));
  return {
    created: probe?.created.length ?? 0,
    destroyed: probe?.destroyed.length ?? 0,
    loads: probe?.loads.length ?? 0,
    srcChanges: probe?.srcChanges.length ?? 0,
    domAttaches: probe?.domMoves.length ?? 0,
    liveIframes: live.length,
    liveInstances: live.join(","),
    order: await page.$$eval(".ub-editor .ProseMirror > *", (els) => els.map((el) =>
      el.classList.contains("ub-embed-spike") ? (el.querySelector("strong")?.textContent ?? "E") : el.tagName.toLowerCase()).join(" ")),
  };
}

function diff(before: Record<string, number | string>, after: Record<string, number | string>): Record<string, number | string> {
  const d: Record<string, number | string> = {};
  for (const key of ["created", "destroyed", "loads", "srcChanges", "domAttaches"]) d[key] = Number(after[key] ?? 0) - Number(before[key] ?? 0);
  d.liveInstancesBefore = String(before.liveInstances);
  d.liveInstancesAfter = String(after.liveInstances);
  d.orderAfter = String(after.order);
  return d;
}

/** Run the editor's own transaction through Tiptap's mounted editor reference. */
async function moveFirstEmbedDown(page: Page): Promise<void> {
  await page.evaluate(() => {
    type PMNodeLike = { type: { name: string }; attrs: Record<string, unknown>; nodeSize: number };
    type Editor = { state: { doc: { forEach(f: (n: PMNodeLike, offset: number) => void): void }; tr: {
      delete(from: number, to: number): unknown; insert(pos: number, node: PMNodeLike): unknown; } };
      view: { dispatch(tr: unknown): void } };
    const mounted = document.querySelector(".ub-editor .ProseMirror") as HTMLElement & { editor: Editor };
    const { state, view } = mounted.editor;
    const blocks: { node: PMNodeLike; pos: number }[] = [];
    state.doc.forEach((node, pos) => { blocks.push({ node, pos }); });
    const index = blocks.findIndex((b) => b.node.type.name === "code" && b.node.attrs.language === "embed");
    const embed = blocks[index], next = blocks[index + 1];
    if (embed === undefined || next === undefined) throw new Error("spike: nothing to move");
    // A drag-and-drop move is the same delete-then-insert ProseMirror does.
    const tr = state.tr as unknown as { delete(a: number, b: number): typeof tr; insert(p: number, n: PMNodeLike): typeof tr };
    tr.delete(embed.pos, embed.pos + embed.node.nodeSize);
    tr.insert(embed.pos + next.node.nodeSize, embed.node);
    view.dispatch(tr);
  });
}

test("embed blocks keep their iframes across edits", async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(out, { recursive: true });
  if (agent === null) throw new Error("spike: MCP agent is not configured");
  const session = agent.open({ name: "embed-spike" });
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Embeds spike", description: "Two embed blocks between prose.",
    blocks: [
      { type: "paragraph", text: "Above the embeds." },
      { type: "code", language: "embed", text: FIGMA },
      { type: "paragraph", text: "Between the embeds." },
      { type: "code", language: "embed", text: YOUTUBE },
      { type: "paragraph", text: "Below the embeds." },
    ],
  });

  const violations: string[] = [];
  const consoleLines: string[] = [];
  const csp = async (page: Page): Promise<void> => {
    await page.addInitScript(() => {
      const list: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = list;
      document.addEventListener("securitypolicyviolation", (e) => {
        list.push(`${e.disposition} ${e.effectiveDirective} ${e.blockedURI || "(inline)"} ${e.sourceFile ? `${e.sourceFile.split("/").pop()}:${e.lineNumber}` : ""} ${e.sample ?? ""}`.trim());
      });
    });
    page.on("console", (m) => { if (/Content.Security.Policy|Refused|CSP/i.test(m.text())) consoleLines.push(m.text().slice(0, 300)); });
  };
  const path = `/${harness().workspace}/${uuid}`;
  const a = await openApp(browser, path, { beforeNavigate: csp, contextOptions: { viewport: { width: 1280, height: 1400 } } });
  await expect(a.locator(".ub-embed-spike iframe")).toHaveCount(2);
  await a.waitForTimeout(SETTLE * 2);
  await a.screenshot({ path: join(out, "a-seeded.png"), fullPage: true });

  const steps: { step: string; a: Record<string, number | string>; b?: Record<string, number | string> }[] = [];
  let b: Page | null = null;
  const measure = async (step: string, action: () => Promise<void>): Promise<void> => {
    const beforeA = await snapshot(a);
    const beforeB = b === null ? null : await snapshot(b);
    await action();
    await a.waitForTimeout(SETTLE);
    const entry: (typeof steps)[number] = { step, a: diff(beforeA, await snapshot(a)) };
    if (b !== null && beforeB !== null) entry.b = diff(beforeB, await snapshot(b));
    steps.push(entry);
  };

  const paragraphs = editor(a).locator(":scope > p");
  await measure("type in the paragraph above (A)", async () => {
    await placeCaretIn(paragraphs.first());
    await a.keyboard.type(" Typing next to an embed.", { delay: 20 });
  });
  await measure("type in the paragraph between the embeds (A)", async () => {
    await placeCaretIn(paragraphs.nth(1));
    await a.keyboard.type(" More typing.", { delay: 20 });
  });

  b = await openApp(browser, path, { beforeNavigate: csp });
  await expect(b.locator(".ub-embed-spike iframe")).toHaveCount(2);
  await b.waitForTimeout(SETTLE * 2);
  await measure("second client types below the embeds (B)", async () => {
    if (b === null) return;
    await placeCaretIn(editor(b).locator(":scope > p").last());
    await b.keyboard.type(" Remote edit.", { delay: 20 });
  });
  await measure("MCP agent edits a paragraph", async () => {
    const doc = await session.call<{ blocks: { id: string; type: string; text: string; rev: string }[] }>("get_doc", { uuid });
    const p = doc.blocks.find((x) => x.type === "paragraph");
    if (p === undefined) throw new Error("spike: no paragraph");
    await session.call("edit_block", { uuid, block_id: p.id, old_text: p.text, new_text: `${p.text} Agent edit.`, rev: p.rev });
  });
  await measure("move the Figma block below the next paragraph (A)", () => moveFirstEmbedDown(a));
  await measure("undo the move (A, Mod+z)", async () => {
    await placeCaretIn(paragraphs.last());
    await a.keyboard.press("ControlOrMeta+z");
  });
  await measure("switch theme to dark (A, data-theme)", async () => {
    await a.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  });
  await measure("edit the YouTube URL (A, expected reload)", async () => {
    await a.evaluate(() => {
      type Editor = { state: { doc: { descendants(f: (n: { type: { name: string }; attrs: Record<string, unknown>; textContent: string; nodeSize: number }, pos: number) => boolean): void }; tr: { insertText(t: string, from: number, to: number): unknown } }; view: { dispatch(tr: unknown): void } };
      const mounted = document.querySelector(".ub-editor .ProseMirror") as HTMLElement & { editor: Editor };
      const { state, view } = mounted.editor;
      state.doc.descendants((node, pos) => {
        if (node.type.name === "code" && node.textContent.includes("youtube")) {
          view.dispatch(state.tr.insertText(`${node.textContent}&t=30`, pos + 1, pos + node.nodeSize - 1));
          return false;
        }
        return true;
      });
    });
  });
  await a.screenshot({ path: join(out, "a-after-edits.png"), fullPage: true });

  const aViolations = await a.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  const bViolations = await b.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  violations.push(...aViolations, ...bViolations);
  const counts = new Map<string, number>();
  for (const v of violations) counts.set(v, (counts.get(v) ?? 0) + 1);
  const probe = await a.evaluate(() => (window as unknown as { __embedSpike: Probe }).__embedSpike);
  writeFileSync(join(out, "reloads.json"), JSON.stringify({ steps, probeA: probe }, null, 2));
  writeFileSync(join(out, "csp-report-only.json"), JSON.stringify({
    violations: [...counts].map(([v, n]) => ({ violation: v, count: n })), console: [...new Set(consoleLines)],
  }, null, 2));
  console.log(JSON.stringify(steps, null, 2));
});
