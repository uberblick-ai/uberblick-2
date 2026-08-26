/**
 * "All docs" in a real browser (#118).
 *
 * One spec, and only for the claims jsdom cannot make: that the fixed entry is
 * on a real page beside a real sidebar, that clicking it navigates a real
 * history to `/<workspace>/all`, and that the listing there is fed by a
 * directory that travelled the hub — the documents were created in another
 * browser context, and nothing told this one about them.
 *
 * Everything else — the three sorts, the missing-stamp rule, the persisted
 * choice, the pin affordance, live remote renames — is pinned in
 * `test/all-docs.test.tsx` over shared Y.Docs, and is not repeated here. The
 * one sort exercised is the one whose result a second browser can predict.
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

/** The titles the listing shows, top to bottom. */
function listedTitles(page: Page): Locator {
  return page.locator(".ub-all-title");
}

async function createDoc(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  await page.locator(".ub-title").fill(title);
}

test("the entry opens the listing, and it holds what another browser created", async ({
  browser,
}) => {
  // Two titles that sort the other way round from the order they are made in,
  // so A–Z is a claim and not a coincidence.
  const later = docTitle("aardvark");
  const earlier = docTitle("zebra");

  const [author, reader] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(author, earlier);
  await createDoc(author, later);

  // The second browser was told nothing: the directory is a synced document,
  // and the listing is that document.
  const entry = reader.getByRole("button", { name: "All docs" });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}/all$`));
  await expect(listedTitles(reader)).toHaveText([later, earlier]);

  // And the address is a link: a fresh browser goes straight there.
  const linked = await openApp(browser);
  await linked.goto(new URL(`/${harness().workspace}/all`, harness().appUrl).href);
  await expect(listedTitles(linked)).toHaveText([later, earlier]);

  // Opening a row is opening the document.
  await listedTitles(linked).first().click();
  await expect(linked.locator(".ub-title")).toHaveValue(later);
});
