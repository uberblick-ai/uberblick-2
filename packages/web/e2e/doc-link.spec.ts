/**
 * Inline document references, in a real browser (#444, #532).
 *
 * Two routes through real editor input and transport, with navigation and
 * caret-relative layout that jsdom cannot observe.
 *
 * 1. **Typed.** A person types a reference into a document and clicks through
 *    to its target address, with browser Back returning to the source. This runs
 *    through real key events reaching an input rule, a real anchor inside a
 *    `contenteditable` (where a browser's own click handling is what makes the
 *    interception necessary), and real session history.
 * 2. **Picked.** A person types `@`, and the card has a measured position past
 *    the editor frame's origin over a directory synced from another browser;
 *    ArrowDown and Enter reach it through a real contenteditable and leave the
 *    chosen reference.
 *
 * Everything else is pinned without a browser in `test/doc-links.test.tsx` and
 * `test/mention-menu.test.tsx`: what the doors accept and refuse, the
 * shorthand's label, the unresolved/archived states, the trigger's exact shape,
 * and that a reference inside a comment highlight is one action rather than two.
 * The browser keeps one resulting link as its witness that editor input
 * landed; it does not replay the document and ARIA state sequences.
 */

import { expect, test } from "@playwright/test";
import { createDoc, docTitle, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { openApp, ws } = setupHarness();

test("a typed reference is a link to the document it names, and Back comes home", async ({
  browser,
}) => {
  const [author, page] = await Promise.all([
    openApp(browser, "/", { upstream: true }),
    openApp(browser),
  ]);
  const targetTitle = docTitle("target");
  const target = await createDoc(author, targetTitle);
  const sourceTitle = docTitle("source");
  const source = await createDoc(page, sourceTitle);

  // ---- typed, as a person types it ----
  await placeCaret(page);
  await page.keyboard.type(`see [the target](${target}) today`);

  const link = page.locator(".ub-editor a.ub-doclink");
  // A rendered reference is the one end state witnessing the real typing
  // route. Its label, href and availability state are covered in jsdom.
  await expect(link).toBeVisible();

  // ---- a real click reaches the target address ----
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${target}$`));
  // This target was made on the upstream hub, so hydration witnesses transport.
  await expect(page.locator(".ub-title")).toHaveValue(targetTitle);

  // ---- and browser Back returns to the source address ----
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${source}$`));
});

test("the @ picker offers a synced document and writes the same reference", async ({
  browser,
}) => {
  const [author, page] = await Promise.all([
    openApp(browser, "/", { upstream: true }),
    openApp(browser),
  ]);
  // Two candidates sharing a prefix, so one query leaves two rows and the arrow
  // key has somewhere to go; the picker lists by title, so the second row is the
  // lexicographically later of the two.
  const first = docTitle("pick");
  const second = docTitle("pick");
  const made = new Map<string, string>();
  made.set(first, await createDoc(author, first));
  made.set(second, await createDoc(author, second));
  const [, wanted] = [first, second].sort();
  await createDoc(page, docTitle("writing"));

  await placeCaret(page);
  await page.keyboard.type("see @pick");

  const picker = page.getByRole("listbox", { name: "Documents" });
  await expect(picker).toBeVisible();
  // Wait for the two remote candidates before sending input; their sorted
  // rows and selection state are the jsdom test's contract.
  await picker.getByRole("option", { name: first, exact: true }).waitFor({ state: "visible" });
  await picker.getByRole("option", { name: second, exact: true }).waitFor({ state: "visible" });
  // The card is measured against a live layout, which jsdom does not have: it
  // sits below the caret's line and to the right of the frame's edge, past the
  // "see " already typed. The origin is what a failed measurement produces, so
  // both bounds fail loudly rather than reading as a position.
  const card = await picker.boundingBox();
  const frame = await page.locator(".ub-editor-frame").boundingBox();
  expect(card?.y ?? 0).toBeGreaterThan(frame?.y ?? 0);
  expect(card?.x ?? 0).toBeGreaterThan(frame?.x ?? 0);

  // One resulting target shows that both real keys reached the picker.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  const link = page.locator(".ub-editor a.ub-doclink");
  await expect(link).toHaveAttribute("data-doc-id", made.get(wanted ?? "") ?? "");

  // And it is a real reference, not a look-alike: it navigates.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${made.get(wanted ?? "")}$`));
});
