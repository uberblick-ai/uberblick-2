/**
 * Inline document references, in a real browser (#444).
 *
 * One spec, because exactly one claim is out of jsdom's reach and it is the
 * whole feature end to end: a person types a reference into a document, clicks
 * it, and the app is on the other document — with Back returning them. That
 * chain runs through real key events reaching an input rule, a real anchor
 * inside a `contenteditable` (where a browser's own click handling is what
 * makes the interception necessary), and real session history.
 *
 * Everything else is pinned without a browser in `test/doc-links.test.tsx`: what
 * the doors accept and refuse, the shorthand's label, the unresolved/archived
 * states, and that a reference inside a comment highlight is one action rather
 * than two. What is asserted here beyond the click is only what the browser
 * adds: that the reference resolved against a directory that really synced over
 * a real hub, from a document created in this session.
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

async function openApp(browser: Browser, path = "/"): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(new URL(path, harness().appUrl).href);
  return page;
}

function editor(page: Page) {
  return page.locator(".ub-editor .ProseMirror");
}

function openPath(page: Page): string {
  return new URL(page.url()).pathname;
}

/** The workspace segment the bundle was built with — what `/` redirects to. */
function ws(): string {
  return harness().workspace;
}

/** Unique per run: every test in the file shares one workspace directory. */
function docTitle(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A new, titled document. Its uuid comes from the address bar. */
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
  return uuid;
}

test("a typed reference is a link to the document it names, and Back comes home", async ({
  browser,
}) => {
  const page = await openApp(browser);
  const targetTitle = docTitle("target");
  const target = await createDoc(page, targetTitle);
  const sourceTitle = docTitle("source");
  const source = await createDoc(page, sourceTitle);

  // ---- typed, as a person types it ----
  await editor(page).click();
  await page.keyboard.type(`see [the target](${target}) today`);

  const link = page.locator(".ub-editor a.ub-doclink");
  await expect(link).toHaveText("the target");
  // The target is a document this workspace's directory really knows — over a
  // real hub, from a document made a moment ago in this same session.
  await expect(link).toHaveAttribute("data-doc-link-state", "resolved");
  // A real anchor with a real address: what makes cmd-click a new tab, and what
  // the click below has to intercept rather than inherit.
  await expect(link).toHaveAttribute("href", `/${ws()}/${target}`);
  // The label is the text; the uuid is not in the prose.
  await expect(editor(page)).toHaveText("see the target today");

  // ---- clicking it opens the other document, in-app ----
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${target}$`));
  await expect(page.locator(".ub-title")).toHaveValue(targetTitle);

  // ---- and Back returns to the document the reference was written in ----
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${source}$`));
  await expect(page.locator(".ub-title")).toHaveValue(sourceTitle);
  await expect(page.locator(".ub-editor a.ub-doclink")).toHaveText("the target");
});
