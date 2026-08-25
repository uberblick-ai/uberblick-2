/**
 * The two halves of #121 that only a real browser can prove.
 *
 * The queue, the pacing, the splice and the suppression rules are pinned by
 * `test/typing-theater.test.ts`, which drives the same plugin against a real
 * Y.Doc under jsdom and does not need a browser to do it. Nothing from there is
 * repeated here. What is left is the part jsdom structurally cannot answer,
 * because both halves of it are questions about *layout*:
 *
 * 1. **Text hidden by the veil really is hidden.** The veil is
 *    `display: none` on an inline decoration inside a `contenteditable`, and
 *    jsdom applies no CSS at all — it would report the same DOM whether the
 *    stylesheet loaded, the class matched, or ProseMirror had quietly refused
 *    to render a decoration over hidden text. Only a browser that has done
 *    layout can say the reader is being shown less than the document holds, and
 *    that is the entire feature.
 *
 * 2. **`prefers-reduced-motion` reaches the plugin.** The preference is read
 *    through `matchMedia` with a query written as a string. A typo in that
 *    string passes every unit test in the repo — the injected predicate the
 *    jsdom suite uses is exactly the part a typo would bypass. A browser
 *    context launched with the preference set is the only thing that reads the
 *    real query.
 */

import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

let started: Harness | null = null;
const contexts: BrowserContext[] = [];

function harness(): Harness {
  if (started === null) {
    throw new Error("e2e: the harness is not running — its bootstrap failed");
  }
  return started;
}

test.beforeAll(async () => {
  started = await startHarness();
});

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

test.afterAll(async () => {
  const running = started;
  started = null;
  await running?.stop();
});

async function openApp(
  browser: Browser,
  motion: "reduce" | "no-preference",
): Promise<Page> {
  // Explicit on both sides: the default is the host's preference, and a test
  // whose result depends on the developer's accessibility settings is not a
  // test.
  const context = await browser.newContext({ reducedMotion: motion });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  return page;
}

function docTitle(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

function docButton(page: Page, title: string) {
  return page.locator(".ub-list").getByRole("button", { name: title, exact: true });
}

function editor(page: Page) {
  return page.locator(".ub-editor .ProseMirror");
}

async function createDoc(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(editor(page)).toBeVisible();
  await page.locator(".ub-title").fill(title);
  await expect(docButton(page, title)).toBeVisible();
}

async function openDoc(page: Page, title: string): Promise<void> {
  await docButton(page, title).click();
  await expect(editor(page)).toBeVisible();
}

/**
 * What the first block holds, and what of it the reader can see.
 *
 * `held` is every character in the block: the document's own text, cursor
 * widgets stripped the way collab.spec.ts strips them. `shown` is the same walk
 * with anything the browser has laid out as `display: none` left behind — so
 * the two differ by exactly what the veil is hiding, and by nothing else.
 * Computed styles rather than `innerText`, which normalises whitespace and
 * would make the comparison a different one.
 */
function blockText(page: Page): Promise<{ held: string; shown: string }> {
  return page.evaluate(() => {
    const block = document.querySelector(".ub-editor .ProseMirror > *");
    if (block === null) return { held: "", shown: "" };
    let held = "";
    let shown = "";
    const walk = (node: Node, visible: boolean): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        held += node.nodeValue ?? "";
        if (visible) shown += node.nodeValue ?? "";
        return;
      }
      if (node instanceof HTMLElement) {
        // A peer's cursor is a widget inside the block, label text included.
        if (node.classList.contains("ProseMirror-yjs-cursor")) return;
        if (getComputedStyle(node).display === "none") visible = false;
      }
      for (const child of Array.from(node.childNodes)) walk(child, visible);
    };
    walk(block, true);
    return { held, shown };
  });
}

/** Put the caret at the end of the first block, by clicking past its text. */
async function caretToEnd(page: Page): Promise<void> {
  const block = page.locator(".ub-editor .ProseMirror > *").first();
  const box = await block.boundingBox();
  if (box === null) throw new Error("e2e: the first block has no box to click");
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
}

const SEED = "Seed.";

/**
 * Long enough that the typing phase lasts many seconds at 400wpm, so the gap
 * between "arrived" and "shown" is wide rather than a frame the poll has to
 * catch.
 */
const ARRIVAL = ` ${"The agent writes another clause. ".repeat(12)}`;

test("a remote edit is fully in the document while only part of it is on screen", async ({
  browser,
}) => {
  const title = docTitle("typing");
  const [agent, reader] = await Promise.all([
    openApp(browser, "no-preference"),
    openApp(browser, "no-preference"),
  ]);

  await createDoc(agent, title);
  await caretToEnd(agent);
  await agent.keyboard.type(SEED, { delay: 15 });

  await openDoc(reader, title);
  await expect.poll(() => blockText(reader).then((text) => text.held)).toBe(SEED);

  // One transaction carrying the whole edit — `insertText` is a single input
  // event, so it reaches the reader as one remote change rather than as the
  // stream of keystrokes `type` would send.
  await caretToEnd(agent);
  await agent.keyboard.insertText(ARRIVAL);

  const arrived = `${SEED}${ARRIVAL}`;
  await expect.poll(() => blockText(reader).then((text) => text.held)).toBe(arrived);

  // The document is complete and the reader is still being shown less of it.
  // This is the whole claim of #121, and the assertion the jsdom suite cannot
  // make: `shown` is what survived a real layout pass.
  const midway = await blockText(reader);
  expect(midway.held).toBe(arrived);
  expect(midway.shown.length).toBeLessThan(arrived.length);
  expect(arrived.startsWith(midway.shown)).toBe(true);

  // ...and it catches up on its own, with nothing left hidden.
  await expect
    .poll(() => blockText(reader).then((text) => text.shown), { timeout: 30_000 })
    .toBe(arrived);
});

test("prefers-reduced-motion shows the whole edit at once", async ({
  browser,
}) => {
  const title = docTitle("reduced");
  const [agent, reader] = await Promise.all([
    openApp(browser, "no-preference"),
    openApp(browser, "reduce"),
  ]);

  await createDoc(agent, title);
  await caretToEnd(agent);
  await agent.keyboard.type(SEED, { delay: 15 });

  await openDoc(reader, title);
  await expect.poll(() => blockText(reader).then((text) => text.held)).toBe(SEED);

  await caretToEnd(agent);
  await agent.keyboard.insertText(ARRIVAL);

  const arrived = `${SEED}${ARRIVAL}`;
  // Nothing is ever hidden: the edit that took seconds to play in the test
  // above is on screen the moment it lands.
  await expect.poll(() => blockText(reader).then((text) => text.shown)).toBe(arrived);
});
