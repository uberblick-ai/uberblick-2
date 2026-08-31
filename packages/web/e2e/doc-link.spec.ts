/**
 * Inline document references, in a real browser (#444, #532).
 *
 * Two cases, because exactly two claims are out of jsdom's reach and each is a
 * whole door end to end.
 *
 * 1. **Typed.** A person types a reference into a document, clicks it, and the
 *    app is on the other document — with Back returning them. That chain runs
 *    through real key events reaching an input rule, a real anchor inside a
 *    `contenteditable` (where a browser's own click handling is what makes the
 *    interception necessary), and real session history.
 * 2. **Picked.** A person types `@`, and a card appears *at the caret* over a
 *    directory that really synced; arrowing and Enter reach it through a real
 *    contenteditable, where an Enter the picker failed to claim would split the
 *    paragraph instead of writing a reference.
 *
 * Everything else is pinned without a browser in `test/doc-links.test.tsx` and
 * `test/mention-menu.test.tsx`: what the doors accept and refuse, the
 * shorthand's label, the unresolved/archived states, the trigger's exact shape,
 * and that a reference inside a comment highlight is one action rather than two.
 * What is asserted here beyond that is only what the browser adds.
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

test("the @ picker offers a synced document and writes the same reference", async ({
  browser,
}) => {
  const page = await openApp(browser);
  // Two candidates sharing a prefix, so one query leaves two rows and the arrow
  // key has somewhere to go; the picker lists by title, so the second row is the
  // lexicographically later of the two.
  const first = docTitle("pick");
  const second = docTitle("pick");
  const made = new Map<string, string>();
  made.set(first, await createDoc(page, first));
  made.set(second, await createDoc(page, second));
  const [, wanted] = [first, second].sort();
  await createDoc(page, docTitle("writing"));

  await editor(page).click();
  await page.keyboard.type("see @pick");

  const picker = page.locator(".ub-mentionmenu");
  await expect(picker).toBeVisible();
  const rows = picker.locator(".ub-blockmenu-entry");
  await expect(rows).toHaveCount(2);
  // The card is measured against a live layout, which jsdom does not have: it
  // sits below the caret's line and to the right of the frame's edge, past the
  // "see " already typed. The origin is what a failed measurement produces, so
  // both bounds fail loudly rather than reading as a position.
  const card = await picker.boundingBox();
  const frame = await page.locator(".ub-editor-frame").boundingBox();
  expect(card?.y ?? 0).toBeGreaterThan(frame?.y ?? 0);
  expect(card?.x ?? 0).toBeGreaterThan(frame?.x ?? 0);

  // The first row is highlighted; one arrow moves to the second, and Enter
  // commits it rather than splitting the paragraph.
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");

  await expect(picker).toHaveCount(0);
  const link = page.locator(".ub-editor a.ub-doclink");
  await expect(link).toHaveText(wanted ?? "");
  await expect(link).toHaveAttribute("data-doc-link-state", "resolved");
  await expect(link).toHaveAttribute("href", `/${ws()}/${made.get(wanted ?? "")}`);
  // The typed `@query` is gone and the paragraph was never split.
  await expect(editor(page)).toHaveText(`see ${wanted}`);
  await expect(page.locator(".ub-editor .ProseMirror > *")).toHaveCount(1);

  // And it is a real reference, not a look-alike: it navigates.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${made.get(wanted ?? "")}$`));
  await expect(page.locator(".ub-title")).toHaveValue(wanted ?? "");
});
