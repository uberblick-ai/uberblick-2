/**
 * Deep links, in a real browser (#68).
 *
 * One spec, because only two of this feature's claims are out of jsdom's reach
 * and both are in the same story:
 *
 * - **A fresh browser opens a link.** Empty IndexedDB, no prior visit, straight
 *   to `/<workspace>/<uuid>`. That exercises the server's SPA fallback (a deep path has
 *   no file behind it, so something has to answer with index.html), the
 *   hydration of a replica that starts with nothing, and the waiting state
 *   resolving into the document — none of which a stubbed connection can show.
 * - **Back and Forward are the browser's, not ours.** jsdom queues `popstate`
 *   and the unit test drives it directly; whether a real session history holds
 *   the entries the sidebar pushed is a claim about a browser.
 *
 * Everything else the feature does — what an address parses to, an unknown
 * workspace, a malformed link, the waiting-state copy — is pinned in
 * `test/route.test.tsx` against no browser at all, and is not repeated here.
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

/** A fresh context: its own IndexedDB, its own history, its own tab. */
async function openApp(browser: Browser, path = "/"): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(new URL(path, harness().appUrl).href);
  return page;
}

/** Unique per run: every test in the file shares one workspace directory. */
function docTitle(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

function editor(page: Page) {
  return page.locator(".ub-editor .ProseMirror");
}

function docButton(page: Page, title: string) {
  return page.locator(".ub-list").getByRole("button", { name: title, exact: true });
}

function openPath(page: Page): string {
  return new URL(page.url()).pathname;
}

/** The workspace segment the bundle was built with — what `/` redirects to. */
function ws(): string {
  return harness().workspace;
}

/**
 * A new document, titled and listed. Its uuid comes from the address bar.
 *
 * Both waits before the title is typed are load-bearing when a document is
 * already open, because then the editor is *already* visible and waiting for it
 * proves nothing: the address has to have changed, and the title field has to
 * have emptied, or the title lands on the document that was open a moment ago.
 */
async function createDoc(page: Page, title: string): Promise<string> {
  const before = openPath(page);
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect.poll(() => openPath(page)).not.toBe(before);
  await expect(page.locator(".ub-title")).toHaveValue("");
  await expect(editor(page)).toBeVisible();

  const uuid = openPath(page).split("/")[2];
  if (uuid === undefined || uuid === "") {
    throw new Error(`e2e: creating a document left the address at ${openPath(page)}`);
  }

  await page.locator(".ub-title").fill(title);
  await expect(docButton(page, title)).toBeVisible();
  return uuid;
}

/**
 * Start recording whether `selector` is ever inserted into the page.
 *
 * The mutation records are inspected rather than the live DOM, because the
 * thing being ruled out is precisely an element that appears and is gone again
 * before anyone could query for it.
 */
async function watchForInsertion(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const w = window as unknown as Record<string, unknown>;
    w.__flashSeen = document.querySelector(sel) !== null;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(sel) || node.querySelector(sel) !== null) {
            w.__flashSeen = true;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    w.__flashStop = () => observer.disconnect();
  }, selector);
}

async function wasEverInserted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    (w.__flashStop as (() => void) | undefined)?.();
    return w.__flashSeen === true;
  });
}

/** Set on the window, and gone the moment anything reloads the page. */
const KEEPALIVE = "__uberblickSameDocument";

async function markSession(page: Page): Promise<void> {
  await page.evaluate((key) => {
    (window as unknown as Record<string, unknown>)[key] = true;
  }, KEEPALIVE);
}

async function sessionSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key] === true,
    KEEPALIVE,
  );
}

test("a workspace answers to both its spellings, and to neither of somebody else's", async ({
  browser,
}) => {
  // The slug is display: `<slug>-<uuid>` and `<uuid>` are one workspace, so
  // both addresses open one document — from a browser that has never seen
  // either, over the real transport.
  const author = await openApp(browser);
  const title = docTitle("both-spellings");
  const uuid = await createDoc(author, title);

  const bare = await openApp(browser, `/${harness().workspaceUuid}/${uuid}`);
  await expect(bare.locator(".ub-title")).toHaveValue(title);
  await expect(editor(bare)).toBeVisible();
  // Kept as typed — a link travels with the spelling it was written with.
  expect(openPath(bare)).toBe(`/${harness().workspaceUuid}/${uuid}`);

  const decorated = await openApp(browser, `/${ws()}/${uuid}`);
  await expect(decorated.locator(".ub-title")).toHaveValue(title);
  expect(openPath(decorated)).toBe(`/${ws()}/${uuid}`);

  // And a first segment that is no workspace id opens nothing at all.
  const wrong = await openApp(browser, `/main/${uuid}`);
  await expect(wrong.locator(".ub-notice")).toContainText("Not a document link");
  expect(openPath(wrong)).toBe(`/main/${uuid}`);
});

test("a document's URL is its address: the sidebar writes it, history walks it, a fresh browser opens it", async ({
  browser,
}) => {
  const author = await openApp(browser);
  await expect(author.locator(".ub-list-head")).toBeVisible();

  // `/` is not an address; the workspace is. The redirect comes from the
  // build-time `WORKSPACE_ID`, which is the only thing that answers `/`.
  await expect(author).toHaveURL(new RegExp(`/${ws()}$`));

  const firstTitle = docTitle("first");
  const secondTitle = docTitle("second");
  const first = await createDoc(author, firstTitle);
  const second = await createDoc(author, secondTitle);
  expect(openPath(author)).toBe(`/${ws()}/${second}`);

  // ---- the sidebar writes the address, without reloading ----
  await markSession(author);
  // Moving between two documents this replica already holds must be a quiet
  // swap. The connection is paired with its room one render after the address
  // changes, and that render must not put "waiting for sync" on the screen.
  await watchForInsertion(author, ".ub-notice");
  await docButton(author, firstTitle).click();
  await expect(author).toHaveURL(new RegExp(`/${ws()}/${first}$`));
  await expect(author.locator(".ub-title")).toHaveValue(firstTitle);
  expect(await sessionSurvived(author)).toBe(true);
  expect(await wasEverInserted(author)).toBe(false);

  // ---- Back and Forward re-open what was viewed ----
  await author.goBack();
  await expect(author.locator(".ub-title")).toHaveValue(secondTitle);
  expect(openPath(author)).toBe(`/${ws()}/${second}`);

  await author.goForward();
  await expect(author.locator(".ub-title")).toHaveValue(firstTitle);
  expect(openPath(author)).toBe(`/${ws()}/${first}`);
  // Still the same document instance: pushState navigation all the way.
  expect(await sessionSurvived(author)).toBe(true);

  // ---- reload restores the same document ----
  await author.reload();
  await expect(author.locator(".ub-title")).toHaveValue(firstTitle);
  expect(openPath(author)).toBe(`/${ws()}/${first}`);

  const shareable = new URL(`/${ws()}/${first}`, harness().appUrl).href;

  // ---- a fresh browser session opens the link, with no navigation of its own ----
  // Its own context, so: empty IndexedDB, no history, nothing cached. The
  // server has no file at this path — only the SPA fallback answers it — and
  // the replica knows no documents until the directory and the room sync in.
  const reader = await openApp(browser, `/${ws()}/${first}`);
  await expect(reader.locator(".ub-title")).toHaveValue(firstTitle);
  await expect(editor(reader)).toBeVisible();
  expect(openPath(reader)).toBe(`/${ws()}/${first}`);
  // The link the author would have copied is the one that just worked.
  expect(reader.url()).toBe(shareable);
});
