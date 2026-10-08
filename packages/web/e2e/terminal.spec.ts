/**
 * A terminal block playing itself, in a real browser (#843).
 *
 * Only what jsdom structurally cannot answer is here. `test/terminal.test.ts`
 * pins everything about the document and the frames — that playing writes
 * nothing, the grammar, the loop, the pause control's own contract, the cancel
 * on an edit, and the release of scheduled work. What is left needs a real
 * engine:
 *
 * - **which representation a reader actually sees.** The switch is CSS, and
 *   only a browser applies CSS: the panel visible with the transcript hidden,
 *   and the two swapping the moment the caret lands in the block.
 * - **that scrolling the demonstration into view reaches the real observer.**
 *   jsdom drives a stub; this checks the browser's `IntersectionObserver`
 *   delivery, with playback starting as its one end-state witness.
 * - **the pause control by keyboard**, which is the WCAG 2.2.2 mechanism. Tab
 *   has to reach it and Enter has to work it — a control only a mouse can
 *   operate satisfies nothing.
 * - **the reduced-motion preference**, which is a real media query, and the
 *   control's painted visibility under it and with an empty transcript.
 *
 * Transcript, frame, pause/resume and accessibility state stay in jsdom.
 */

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createDoc, setupHarness } from "./app-helpers.js";

const { harness } = setupHarness();

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

const TRANSCRIPT = "$ ub init\nworkspace ready";

function panel(page: Page): Locator {
  return page.locator(".ub-terminal-screen");
}

function frame(page: Page): Locator {
  return page.locator(".ub-terminal-frame");
}

function source(page: Page): Locator {
  return page.locator(".ub-terminal-source");
}

function control(page: Page): Locator {
  return page.getByRole("button", { name: /^(Pause|Play)$/ });
}

/**
 * The control as the *cascade* leaves it, which is the only way to see it.
 * `getByRole` honours the `hidden` attribute whatever the stylesheet computes,
 * so a control the attribute hides and CSS still paints counts as absent to it
 * while a reader sees and tabs to a blank button (#906).
 */
function toggle(page: Page): Locator {
  return page.locator(".ub-terminal-toggle");
}

/** Move the caret out of the terminal block, into the prose above it. */
async function caretAway(page: Page): Promise<void> {
  await page.locator(".ub-editor .ProseMirror > *").first().click();
}

/** The panel's text as the DOM holds it — never whitespace-normalised. */
async function frameText(page: Page): Promise<string> {
  return (await frame(page).textContent()) ?? "";
}

/**
 * A document whose last block is a terminal demonstration, with the caret left
 * in it. `fillerLines` paragraphs go in front of it, for the one test that
 * needs the block to be scrollable out of the viewport.
 */
async function writeDemo(
  page: Page,
  url: string,
  fillerLines = 0,
  transcript = TRANSCRIPT,
): Promise<void> {
  await page.goto(url);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await createDoc(page, "demos");

  const blocks = page.locator(".ub-editor .ProseMirror > *");
  await blocks.first().click();
  if (fillerLines > 0) {
    for (let i = 0; i < fillerLines; i += 1) {
      await page.keyboard.type("filler", { delay: 0 });
      await page.keyboard.press("Enter");
    }
  } else {
    // Give caretAway prose to target: clicking a wholly empty paragraph can
    // leave the native range at the editor boundary while focus settles.
    await page.keyboard.type("before", { delay: 0 });
  }

  await blocks.last().hover();
  await page.getByRole("button", { name: "Insert block below" }).click();
  await page.getByRole("option", { name: "Terminal demo" }).click();
  const lines = transcript === "" ? [] : transcript.split("\n");
  for (const [index, line] of lines.entries()) {
    // Enter inside a source block is a newline, so these are the transcript's
    // own lines rather than further blocks.
    if (index > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(line, { delay: 10 });
  }
}

test("the panel swaps with the source, and real Tab reaches its pause control", async ({
  page,
}) => {
  await writeDemo(page, harness().appUrl);

  // CSS shows the source while the caret is in the block.
  await expect(source(page)).toBeVisible();
  await expect(panel(page)).toBeHidden();

  // CSS shows the panel instead when the caret leaves.
  await caretAway(page);
  await expect(panel(page)).toBeVisible();
  await expect(source(page)).toBeHidden();
  // Clicking the panel is how a reader gets back to the transcript.
  await panel(page).click();
  await expect(source(page)).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await caretAway(page);
  await expect(panel(page)).toBeVisible();

  // Browser Tab order reaches the panel, then the pause control from the prose.
  // Native Enter must survive ProseMirror's event boundary; the new label is
  // the one end-state witness. jsdom holds the pause/resume sequence.
  await page.keyboard.press("Tab");
  await expect(panel(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(control(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(control(page)).toHaveText("Play");
});

test("scrolling the demonstration into view delivers the real observer", async ({ page }) => {
  await page.setViewportSize({ width: 1_000, height: 400 });
  // Enough document in front of the block to scroll it off the screen.
  await writeDemo(page, harness().appUrl, 40);
  // The caret goes to the top of the document, which takes the panel with it.
  await caretAway(page);
  await expect(panel(page)).not.toBeInViewport();
  // Freeze scheduled frames so only the native viewport observation can change
  // the frame. A panel that plays regardless of its viewport cannot pass by looping.
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  const beforeScroll = await frameText(page);

  // The changed frame witnesses native delivery. jsdom owns the exact first
  // frame and the off-screen cancellation/restart sequence.
  await panel(page).scrollIntoViewIfNeeded();
  await expect.poll(() => frameText(page)).not.toBe(beforeScroll);
});

test("the real reduced-motion preference stops the control being painted", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await writeDemo(page, harness().appUrl);
  await caretAway(page);

  await expect(panel(page)).toBeVisible();
  // Computed visibility catches a cascade that paints the control despite its
  // hidden attribute. Transcript and playback state stay in jsdom.
  await expect(toggle(page)).toBeHidden();

  // The live media query changes computed visibility without a reload.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(toggle(page)).toBeVisible();

  // Switching the preference on again hides the painted control.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(toggle(page)).toBeHidden();
});

test("an empty transcript leaves the panel visible and its control unpainted", async ({ page }) => {
  await writeDemo(page, harness().appUrl, 0, "");
  await caretAway(page);

  // Empty content is a separate path through the control's computed visibility;
  // jsdom holds its idle frame and hidden-control state.
  await expect(panel(page)).toBeVisible();
  await expect(toggle(page)).toBeHidden();
});
