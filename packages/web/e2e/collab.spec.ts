/**
 * The three proof points of issue #46, in a real browser against a real hub.
 *
 * Each one is here because jsdom structurally cannot host it: two live clients
 * on one document, cursor decorations rendered by a browser, and an IndexedDB
 * replica that survives a reload. Nothing else belongs in this file — Tiptap
 * typing characters, Yjs merging updates and vite serving modules are other
 * people's tests, and the contracts already pinned by `test/` (golden
 * round-trip, block ids, the palette gate) are not re-tested here.
 *
 * The file is serial and shares one harness: the hub's port has to be known
 * before the dev server starts, and the third test stops the hub while the
 * browser stays up.
 */

import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

let started: Harness | null = null;
const contexts: BrowserContext[] = [];

/**
 * The running harness.
 *
 * A function, not a bare variable: if `beforeAll` failed there is nothing to
 * dereference, and a `TypeError` here would bury the real bootstrap error.
 */
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
  // Tolerates a failed bootstrap: `startHarness` cleans up after itself, so
  // there is nothing left to stop.
  const running = started;
  started = null;
  await running?.stop();
});

/** A fresh context: its own IndexedDB, its own awareness identity, its own tab. */
async function openApp(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  return page;
}

/** Unique per run: every test in the file shares one workspace directory. */
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
  // Pinned, because the sidebar lists what is pinned and nothing else (#115) —
  // and this is how the *other* context navigates to it.
  await page.locator(".ub-pin-toggle").click();
  // The sidebar doc carries the pin and the directory stub carries the title,
  // and both are what the *other* context navigates by.
  await expect(docButton(page, title)).toBeVisible();
}

/** Open a document the way a second client has to: from the sidebar. */
async function openDoc(page: Page, title: string): Promise<void> {
  await docButton(page, title).click();
  await expect(editor(page)).toBeVisible();
}

/**
 * The open document's first block, with remote-cursor widgets stripped.
 *
 * y-prosemirror renders a peer's cursor as a `<span>` *inside* the block —
 * label text and word joiners included — so plain `textContent` would compare
 * the peer's name along with the document's own text.
 */
function blockText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const block = document.querySelector(".ub-editor .ProseMirror > *");
    if (block === null) return null;
    const copy = block.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) {
      cursor.remove();
    }
    return copy.textContent;
  });
}

/**
 * Put the caret at one end of the first block, by clicking there.
 *
 * A click, not a keyboard shortcut: Home/End mean different things on macOS and
 * Linux, and select-all-then-arrow leaves ProseMirror holding an `AllSelection`
 * the arrow key does not collapse — the next keystroke then replaces the whole
 * document. Clicking inside a block's box always resolves to the nearest text
 * position, so the left edge is offset 0 and the right edge, past the end of
 * the text, is the end of the line.
 */
async function caretTo(page: Page, edge: "start" | "end"): Promise<void> {
  const block = page.locator(".ub-editor .ProseMirror > *").first();
  const box = await block.boundingBox();
  if (box === null) throw new Error("e2e: the first block has no box to click");
  const x = edge === "start" ? box.x + 1 : box.x + box.width - 1;
  await page.mouse.click(x, box.y + box.height / 2);
}

async function type(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 15 });
}

test("two contexts typing into different ranges of one block converge byte-identically", async ({
  browser,
}) => {
  const title = docTitle("converge");
  const seed = "middle";
  const left = "left-left-left-left-";
  const right = "-right-right-right-right";

  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(a, title);
  await caretTo(a, "end");
  await type(a, seed);

  await openDoc(b, title);
  await expect.poll(() => blockText(b)).toBe(seed);

  // Different ranges of the same block, at the same time. Yjs pins each side's
  // insertions to where they were made, so the converged string is knowable in
  // advance — which is what makes "no lost keystrokes" an assertion rather than
  // a character count.
  await caretTo(a, "start");
  await caretTo(b, "end");
  await Promise.all([type(a, left), type(b, right)]);

  const converged = `${left}${seed}${right}`;
  await expect.poll(() => blockText(a)).toBe(converged);
  await expect.poll(() => blockText(b)).toBe(converged);
});

test("a peer's cursor renders in the other context with its name and colour", async ({
  browser,
}) => {
  const title = docTitle("cursor");

  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(a, title);
  await caretTo(a, "end");
  await type(a, "watch this");

  await openDoc(b, title);
  await expect.poll(() => blockText(b)).toBe("watch this");

  // Awareness only carries a cursor while that editor has focus, so A's caret
  // has to be in the block for there to be anything to render.
  await caretTo(a, "end");

  const identity = a.locator(".ub-me");
  const name = (await identity.innerText()).trim();
  // Only the peer's cursor is ever decorated; a client never renders its own.
  const label = b.locator(".ub-editor .ProseMirror-yjs-cursor > div");
  await expect(label).toHaveText(name);
  await expect(label).toBeVisible();

  // The colour travels in the same awareness payload as the name, and reaches
  // the label only through y-prosemirror's cursor builder.
  const color = await identity.evaluate(
    (element) => getComputedStyle(element).borderTopColor,
  );
  await expect(label).toHaveCSS("background-color", color);

  // And when A picks a different presence colour (#74), B's copy of A's cursor
  // follows it live — the choice is an awareness republish, not something that
  // waits for a reconnect. The colour is read back off A's own chip, so this
  // asserts the two ends agree rather than pinning a hex.
  await a.locator(".ub-user-card").click();
  // Anything but the one it was dealt, which is random per tab.
  const dealt = await a
    .locator('.ub-swatch[aria-pressed="true"]')
    .getAttribute("aria-label");
  await a
    .getByRole("button", { name: dealt === "teal" ? "violet" : "teal", exact: true })
    .click();
  const chosen = await identity.evaluate(
    (element) => getComputedStyle(element).borderTopColor,
  );
  expect(chosen).not.toBe(color);
  // Back into the block: awareness only carries a cursor while the editor has
  // focus, and opening the panel took it.
  await a.keyboard.press("Escape");
  await caretTo(a, "end");
  await expect(label).toHaveCSS("background-color", chosen);
});

test("a reload with the hub stopped renders from the local cache, and the offline edit converges on restart", async ({
  browser,
}) => {
  const title = docTitle("offline");

  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(a, title);
  await caretTo(a, "end");
  await type(a, "before");

  await openDoc(b, title);
  await expect.poll(() => blockText(b)).toBe("before");
  await expect(a.locator(".ub-status")).toContainText("synced");
  await expect(a.locator(".ub-status")).toContainText("local cache");

  await harness().stopHub();
  await expect(a.locator(".ub-status")).toContainText("offline");

  // Reload with nowhere to sync from. Both the document list and the document
  // can only be coming out of IndexedDB.
  await a.reload();
  await openDoc(a, title);
  await expect.poll(() => blockText(a)).toBe("before");
  await expect(a.locator(".ub-status")).toContainText("offline");
  await expect(a.locator(".ub-status")).toContainText("local cache");

  await caretTo(a, "end");
  await type(a, "-offline");

  await harness().startHub();
  await expect
    .poll(() => blockText(b), { timeout: 40_000 })
    .toBe("before-offline");
});
