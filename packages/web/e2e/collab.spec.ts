/**
 * The collaboration proof points, in a real browser against a real hub.
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
import { openUpstreamApp, placeCaret, startHarness } from "./harness.js";
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
async function openApp(browser: Browser, path = "/"): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(new URL(path, harness().appUrl).href);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  return page;
}

/** Read through the upstream hub, bypassing `ub open`'s loopback server. */
async function openUpstream(browser: Browser, path: string): Promise<Page> {
  const { context, page } = await openUpstreamApp(browser, harness(), path);
  contexts.push(context);
  return page;
}

function localCopyFact(page: Page) {
  return page.locator('.ub-sync-fact:has(dt:text-is("Local copy")) dd');
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
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Pin to sidebar" }).click();
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
  await placeCaret(a);
  await type(a, seed);

  await openDoc(b, title);
  await expect.poll(() => blockText(b)).toBe(seed);

  // Different ranges of the same block, at the same time. Yjs pins each side's
  // insertions to where they were made, so the converged string is knowable in
  // advance — which is what makes "no lost keystrokes" an assertion rather than
  // a character count.
  await placeCaret(a, "start");
  await placeCaret(b);
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
  await placeCaret(a);
  await type(a, "watch this");

  await openDoc(b, title);
  await expect.poll(() => blockText(b)).toBe("watch this");

  // Awareness only carries a cursor while that editor has focus, so A's caret
  // has to be in the block for there to be anything to render.
  await placeCaret(a);

  const name = (await a.locator(".ub-user-name").innerText()).trim();
  const identity = a.locator(".ub-user-tile");
  // Only the peer's cursor is ever decorated; a client never renders its own.
  const label = b.locator(".ub-editor .ProseMirror-yjs-cursor > div");
  await expect(label).toHaveText(name);
  await expect(label).toBeVisible();

  // The colour travels in the same awareness payload as the name, and reaches
  // the label only through y-prosemirror's cursor builder.
  const color = await identity.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await expect(label).toHaveCSS("background-color", color);

  // And when A picks a different presence colour (#74), B's copy of A's cursor
  // follows it live — the choice is an awareness republish, not something that
  // waits for a reconnect. The colour is read back off A's own tile, so this
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
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(chosen).not.toBe(color);
  // Back into the block: awareness only carries a cursor while the editor has
  // focus, and opening the panel took it.
  await a.keyboard.press("Escape");
  await placeCaret(a);
  await expect(label).toHaveCSS("background-color", chosen);
});

test("the open document's last-updated reading follows its stub through status and archive changes", async ({
  browser,
}) => {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  const title = docTitle("freshness");
  const realNow = Date.now();

  // Install at the real time before loading, so every room authenticates with a
  // valid token. One minute is enough to prove the shared clock repaints this
  // surface without pushing a freshly minted token outside its valid window.
  await page.clock.install({ time: realNow });
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await createDoc(page, title);

  const reading = page.locator(".ub-last-updated");
  const time = reading.locator("time");
  await page.clock.fastForward(60_000);
  await expect(reading).toContainText("last updated 1 minute ago");
  const firstDateTime = await time.getAttribute("dateTime");
  expect(firstDateTime).not.toBeNull();
  expect(Number.isFinite(Date.parse(firstDateTime ?? ""))).toBe(true);
  await expect(time).toHaveAttribute("title", /.+/);

  const status = page.locator(".ub-status");
  const firstBlock = editor(page).locator(":scope > *").first();
  const word = status.locator(".ub-status-word");
  const wordText = await word.textContent();
  const geometry = async () => ({
    status: await status.boundingBox(),
    prose: await firstBlock.boundingBox(),
  });
  const withFreshness = await geometry();
  await page.evaluate(() => {
    document.querySelector(".ub-status-word")?.replaceChildren();
    const updated = document.querySelector<HTMLElement>(".ub-last-updated");
    if (updated !== null) updated.style.display = "none";
  });
  expect(await geometry()).toEqual(withFreshness);
  await word.evaluate((element, text) => {
    element.textContent = text;
  }, wordText);
  await reading.evaluate((element) => element.style.removeProperty("display"));

  const renamed = `${title} fresh`;
  await page.locator(".ub-title").fill(renamed);
  await expect(reading).toContainText("last updated just now");
  await expect(time).not.toHaveAttribute("dateTime", firstDateTime ?? "");
  const currentDateTime = await time.getAttribute("dateTime");
  expect(currentDateTime).not.toBeNull();

  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive document" })
    .click();
  const restore = page.getByRole("button", { name: "Restore" });
  await expect(restore).toBeVisible();
  // Archive completion deliberately transfers focus to the surviving action.
  // That focus may scroll the pane, so it is the settle boundary before the
  // position this test expects the later upstream outage to preserve.
  await expect(restore).toBeFocused();
  await expect(reading).toContainText("last updated just now");
  await expect(time).toHaveAttribute("dateTime", currentDateTime ?? "");

  // `Restore` is painted from this tab's local Y.Doc before its directory
  // update has necessarily completed the local server round trip. A fresh tab
  // seeing the tombstone proves that durable apply and broadcast completed;
  // the upstream can now be stopped without racing the archive itself.
  const archiveObserver = await openApp(browser, new URL(page.url()).pathname);
  await expect(
    archiveObserver.getByRole("button", { name: "Restore" }),
  ).toBeVisible();
  const stablePosition = await reading.boundingBox();
  expect(stablePosition).not.toBeNull();

  await harness().stopHub();
  try {
    // The browser remains connected to `ub open`; only its silent upstream
    // replica is offline, so the local durability boundary stays synced. The
    // awaited stop is the upstream-down signal; the focus assertion above is
    // the page-settle signal, before the baseline is captured.
    await expect(page.locator(".ub-status")).toContainText("synced");
    await expect(reading).toContainText("last updated just now");
    await expect(time).toHaveAttribute("dateTime", currentDateTime ?? "");
    expect(await reading.boundingBox()).toEqual(stablePosition);
  } finally {
    await harness().startHub();
  }
  await expect(page.locator(".ub-status")).toContainText("synced", {
    timeout: 40_000,
  });
  await expect(reading).toContainText("last updated just now");
  await expect(time).toHaveAttribute("dateTime", currentDateTime ?? "");
  expect(await reading.boundingBox()).toEqual(stablePosition);
});

test("a fresh browser hydrates from the ub open store while the upstream is offline", async ({
  browser,
}) => {
  const seeded = await openApp(browser);
  await createDoc(seeded, docTitle("checkpoint"));
  const path = new URL(seeded.url()).pathname;

  await harness().stopHub();
  try {
    // A fresh browser has no IndexedDB. The document and directory therefore
    // come from `ub open`'s store-backed rooms, not from browser cache or the
    // unavailable upstream.
    const fresh = await openApp(browser, path);
    await expect(editor(fresh)).toBeVisible();
    await expect(fresh.locator(".ub-status")).toContainText("synced");
    await fresh.locator(".ub-sync-toggle").click();
    await expect(localCopyFact(fresh)).toHaveText("available");

    // Reload is another store hydration while upstream remains unavailable.
    await fresh.reload();
    await expect(editor(fresh)).toBeVisible();
    await expect(fresh.locator(".ub-status")).toContainText("synced");
  } finally {
    await harness().startHub();
  }
});

test("a multi-author block survives upstream loss and converges back without duplication", async ({
  browser,
}) => {
  const title = docTitle("offline");

  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(a, title);
  await placeCaret(a);
  await type(a, "before");

  await openDoc(b, title);
  await expect.poll(() => blockText(b)).toBe("before");
  // The outage starts from a block with text authored by both clients. The
  // writer must keep both contributions when it adds the offline suffix.
  await placeCaret(b);
  await type(b, "-peer");
  await expect.poll(() => blockText(a)).toBe("before-peer");
  await expect(a.locator(".ub-status")).toContainText("synced");
  // Nothing about the local copy while the hub is acking: it is a promise
  // nobody is waiting on, and it stood here permanently before #535.
  await expect(a.locator(".ub-status .ub-local-copy")).toHaveCount(0);

  await harness().stopHub();
  await expect(a.locator(".ub-status")).toContainText("synced");

  // Reload with no upstream. Both rooms hydrate from the process-local store,
  // and the browser still has a real durability boundary to acknowledge it.
  await a.reload();
  await openDoc(a, title);
  await expect.poll(() => blockText(a)).toBe("before-peer");
  await expect(a.locator(".ub-status")).toContainText("synced");

  await placeCaret(a);
  await type(a, "-offline");
  await expect.poll(() => blockText(b)).toBe("before-peer-offline");

  await harness().startHub();
  // A browser connected directly to the restarted upstream sees the update
  // once the silent replica drains its pending row. Exact text rules out a
  // duplicate replay as well as a missing write.
  const upstream = await openUpstream(browser, new URL(a.url()).pathname);
  await expect
    .poll(() => blockText(upstream), { timeout: 40_000 })
    .toBe("before-peer-offline");
});
