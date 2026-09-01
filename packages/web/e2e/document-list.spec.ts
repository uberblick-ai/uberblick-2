/**
 * The document list in a real browser (#406).
 *
 * One spec, and only for the claims jsdom cannot make: that the workspace's own
 * address is the list — the first screen of a session, in a real bundle beside
 * a real sidebar — that the sidebar's fixed entry navigates a real history to
 * `/<workspace>/all` and finds the same list there, and that what both show is
 * a directory which travelled the hub: the documents were created in another
 * browser context, and nothing told this one about them.
 *
 * Everything else — the order and its missing-stamp rule, tag and description
 * matching, the pinned group, the empty-state wording — is pinned in
 * `test/document-list.test.tsx` over shared Y.Docs, and is not repeated here.
 * The one filter exercised is the one a second browser can predict.
 */

import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
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
async function openApp(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  return page;
}

/** Unique per run: every test in the file shares one workspace. */
function docTitle(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The titles the list shows, top to bottom. */
function listedTitles(page: Page): Locator {
  return page.locator(".ub-docs-title");
}

async function createDoc(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  await page.locator(".ub-title").fill(title);
}

test("the workspace address is the list, and it holds what another browser created", async ({
  browser,
}) => {
  const first = docTitle("zebra");
  const second = docTitle("aardvark");

  const [author, reader] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(author, first);
  await createDoc(author, second);

  // The second browser was told nothing: the directory is a synced document,
  // and the list is that document. `/` resolves to the workspace's own address,
  // which is where a session starts.
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}$`));
  // Most recently changed first — the second document was created last.
  await expect(listedTitles(reader)).toHaveText([second, first]);
  // The scope is on the page, not assumed: this filters titles alone, not bodies.
  await expect(reader.locator(".ub-docs-scope")).toContainText("titles alone");

  // Typing filters what is already here — no request, no room.
  await reader.locator(".ub-docs-search").fill(first);
  await expect(listedTitles(reader)).toHaveText([first]);
  await reader.locator(".ub-docs-search").fill("");

  // The sidebar's fixed entry is the same list at its own address.
  const entry = reader.getByRole("button", { name: "All docs" });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}/all$`));
  await expect(listedTitles(reader)).toHaveText([second, first]);
  // Named after its own row, so the two pins are two different controls.
  const pin = reader.getByRole("button", { name: `Pin ${second} to the sidebar` });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect(pin.locator("svg")).toBeVisible();

  // And the address is a link: a fresh browser goes straight there.
  const linked = await openApp(browser);
  await linked.goto(new URL(`/${harness().workspace}/all`, harness().appUrl).href);
  await expect(listedTitles(linked)).toHaveText([second, first]);

  // Opening a row is opening the document.
  await listedTitles(linked).first().click();
  await expect(linked.locator(".ub-title")).toHaveValue(second);
});
