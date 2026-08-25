/**
 * The three block-creation paths, in a real browser.
 *
 * Only what jsdom structurally cannot answer belongs here. The document
 * outcomes — what a conversion does to a block id, what an insertion does to
 * the fragment, what Esc leaves behind — are pinned in `test/block-menu.test.tsx`
 * and `test/input-rules.test.ts` against a real Y.Doc and are not repeated. What
 * is left needs layout and real key events:
 *
 * - the gutter `+` revealing on hover *without moving the prose*, which is a
 *   claim about pixels and can only be measured where there are pixels;
 * - the three gestures end to end through the browser's own event plumbing —
 *   typed keys reaching ProseMirror, a click reaching the menu, and a markdown
 *   prefix reaching `handleTextInput`, which only a real keystroke does.
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

let started: Harness | null = null;

test.beforeAll(async () => {
  started = await startHarness();
});

test.afterAll(async () => {
  const running = started;
  started = null;
  await running?.stop();
});

/** A fresh document, open and focused, with one paragraph of prose in it. */
async function openDoc(page: Page, seed: string): Promise<void> {
  if (started === null) throw new Error("e2e: the harness is not running");
  await page.goto(started.appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  await page.locator(".ub-title").fill("block menu");

  const block = page.locator(".ub-editor .ProseMirror > *").first();
  const box = await block.boundingBox();
  if (box === null) throw new Error("e2e: the first block has no box to click");
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
  await page.keyboard.type(seed, { delay: 15 });
}

function blocks(page: Page) {
  return page.locator(".ub-editor .ProseMirror > *");
}

test("hovering a block reveals the gutter + without moving the prose", async ({
  page,
}) => {
  await openDoc(page, "hover me");

  const block = blocks(page).first();
  const button = page.locator(".ub-gutter-add");
  // Away from the prose: the caret was placed with a click, which leaves the
  // pointer inside the block it clicked.
  await page.mouse.move(0, 0);
  await expect(button).toHaveCSS("opacity", "0");

  const before = await block.boundingBox();
  await block.hover();
  await expect(button).toHaveCSS("opacity", "1");
  const after = await block.boundingBox();

  // The gutter is reserved for good, so revealing the button is a change of
  // opacity and nothing else: the prose does not move by a pixel.
  expect(after).toEqual(before);
});

test("the gutter + inserts the chosen block below, with the caret in it", async ({
  page,
}) => {
  await openDoc(page, "first");

  await blocks(page).first().hover();
  await page.locator(".ub-gutter-add").click();
  await page.getByRole("option", { name: "Heading 2" }).click();

  await expect(blocks(page)).toHaveCount(2);
  // The caret landed in the new block: typing goes there and nowhere else.
  await page.keyboard.type("second", { delay: 15 });
  await expect(blocks(page).nth(0)).toHaveText("first");
  await expect(blocks(page).nth(1)).toHaveText("second");
  expect(await blocks(page).nth(1).evaluate((node) => node.tagName)).toBe("H2");
});

test("typing / on an empty block filters, and Enter converts it", async ({
  page,
}) => {
  await openDoc(page, "first");

  // A second block, empty, the way a reader gets one.
  await page.keyboard.press("Enter");
  await page.keyboard.type("/he", { delay: 15 });
  await expect(page.getByRole("option")).toHaveCount(3);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.locator(".ub-blockmenu")).toHaveCount(0);
  await expect(blocks(page)).toHaveCount(2);
  expect(await blocks(page).nth(1).evaluate((node) => node.tagName)).toBe("H2");
  // The slash was consumed, not saved.
  await expect(blocks(page).nth(1)).toHaveText("");

  await page.keyboard.type("a heading", { delay: 15 });
  await expect(blocks(page).nth(1)).toHaveText("a heading");
});

/**
 * The third path. This one is here rather than only in jsdom because the rule
 * hangs off `handleTextInput`, which is reached from the browser's own
 * `beforeinput`/`keypress` plumbing — a dispatched transaction never gets near
 * it, so a real keyboard is the only honest proof that a reader typing `## `
 * gets a heading.
 */
test("typing ## converts the block in place, and one undo gives it back", async ({
  page,
}) => {
  await openDoc(page, "first");
  await page.keyboard.press("Enter");

  const second = blocks(page).nth(1);
  const id = await second.getAttribute("id");
  expect(id).not.toBeNull();

  await page.keyboard.type("## ", { delay: 15 });
  expect(await second.evaluate((node) => node.tagName)).toBe("H2");
  // The same block, not a new one wearing the same place: the id is the
  // invariant, and a node-replacing input rule would have churned it.
  await expect(second).toHaveAttribute("id", id ?? "");
  await expect(second).toHaveText("");

  // Undo is one step, and it lands on the typing rather than on an empty block:
  // this is how a reader writes a literal "## ".
  await page.keyboard.press("ControlOrMeta+z");
  expect(await second.evaluate((node) => node.tagName)).toBe("P");
  // `textContent`, not `toHaveText`: the trailing space is the whole point, and
  // `toHaveText` normalises whitespace away.
  expect(await second.textContent()).toBe("## ");
  await expect(second).toHaveAttribute("id", id ?? "");
});
