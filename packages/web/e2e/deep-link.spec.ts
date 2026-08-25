/**
 * Deep links, in a real browser (#68).
 *
 * One spec, because only two of this feature's claims are out of jsdom's reach
 * and both are in the same story:
 *
 * - **A fresh browser opens a link.** Empty IndexedDB, no prior visit, straight
 *   to `/main/<uuid>`. That exercises the server's SPA fallback (a deep path has
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

test("a document's URL is its address: the sidebar writes it, history walks it, a fresh browser opens it", async ({
  browser,
}) => {
  const author = await openApp(browser);
  await expect(author.locator(".ub-list-head")).toBeVisible();

  // `/` is not an address; the workspace is.
  await expect(author).toHaveURL(/\/main$/);

  const firstTitle = docTitle("first");
  const secondTitle = docTitle("second");
  const first = await createDoc(author, firstTitle);
  const second = await createDoc(author, secondTitle);
  expect(openPath(author)).toBe(`/main/${second}`);

  // ---- the sidebar writes the address, without reloading ----
  await markSession(author);
  await docButton(author, firstTitle).click();
  await expect(author).toHaveURL(new RegExp(`/main/${first}$`));
  await expect(author.locator(".ub-title")).toHaveValue(firstTitle);
  expect(await sessionSurvived(author)).toBe(true);

  // ---- Back and Forward re-open what was viewed ----
  await author.goBack();
  await expect(author.locator(".ub-title")).toHaveValue(secondTitle);
  expect(openPath(author)).toBe(`/main/${second}`);

  await author.goForward();
  await expect(author.locator(".ub-title")).toHaveValue(firstTitle);
  expect(openPath(author)).toBe(`/main/${first}`);
  // Still the same document instance: pushState navigation all the way.
  expect(await sessionSurvived(author)).toBe(true);

  // ---- reload restores the same document ----
  await author.reload();
  await expect(author.locator(".ub-title")).toHaveValue(firstTitle);
  expect(openPath(author)).toBe(`/main/${first}`);

  const shareable = new URL(`/main/${first}`, harness().appUrl).href;

  // ---- a fresh browser session opens the link, with no navigation of its own ----
  // Its own context, so: empty IndexedDB, no history, nothing cached. The
  // server has no file at this path — only the SPA fallback answers it — and
  // the replica knows no documents until the directory and the room sync in.
  const reader = await openApp(browser, `/main/${first}`);
  await expect(reader.locator(".ub-title")).toHaveValue(firstTitle);
  await expect(editor(reader)).toBeVisible();
  expect(openPath(reader)).toBe(`/main/${first}`);
  // The link the author would have copied is the one that just worked.
  expect(reader.url()).toBe(shareable);
});
