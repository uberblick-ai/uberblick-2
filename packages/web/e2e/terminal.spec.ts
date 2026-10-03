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
 * - **that the demonstration starts by itself and stops when it scrolls away.**
 *   The wiring is a real `IntersectionObserver`; jsdom has none, so the suite
 *   there drives a stub and this is the only proof that the real one is
 *   attached to the right element.
 * - **the pause control by keyboard**, which is the WCAG 2.2.2 mechanism. Tab
 *   has to reach it and Enter has to work it — a control only a mouse can
 *   operate satisfies nothing.
 * - **the reduced-motion preference**, which is a media query the browser owns.
 * - **what assistive technology is offered**: the animation out of the
 *   accessibility tree, the complete transcript in it, and no live region.
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

/** Advance scheduled playback while observing every part of the original proof. */
async function advancePlayback(page: Page): Promise<string> {
  await page.clock.runFor(100);
  return frameText(page);
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
  if (fillerLines > 0) {
    await blocks.first().click();
    for (let i = 0; i < fillerLines; i += 1) {
      await page.keyboard.type("filler", { delay: 0 });
      await page.keyboard.press("Enter");
    }
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

test("a transcript plays on screen, opens under the caret, and stops on its control", async ({
  page,
}) => {
  await writeDemo(page, harness().appUrl);

  // The caret is in the block, so the reader is looking at what they typed and
  // nothing is playing behind it.
  await expect(source(page)).toBeVisible();
  await expect(panel(page)).toBeHidden();

  // Caret away, and the block is a terminal playing what they wrote.
  await caretAway(page);
  await expect(panel(page)).toBeVisible();
  await expect(source(page)).toBeHidden();
  await expect.poll(() => advancePlayback(page), { intervals: [0] }).toContain("$ ub init");
  await expect.poll(() => advancePlayback(page), { intervals: [0] }).toContain("workspace ready");

  // It loops: the panel clears and the first prompt comes round again.
  await expect
    .poll(() => advancePlayback(page), { intervals: [0], timeout: 20_000 })
    .not.toContain("workspace ready");

  // Clicking the panel is how a reader gets back to the transcript.
  await panel(page).click();
  await expect(source(page)).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await caretAway(page);
  await expect(panel(page)).toBeVisible();

  // The control is reachable and operable by keyboard, which is the mechanism
  // WCAG 2.2.2 asks for — not the caret, and not the mouse alone.
  await control(page).focus();
  await expect(control(page)).toBeFocused();
  await expect(control(page)).toHaveText("Pause");
  await page.keyboard.press("Enter");
  await expect(control(page)).toHaveText("Play");

  const held = await frameText(page);
  await page.clock.runFor(3_000);
  expect(await frameText(page)).toBe(held);

  await page.keyboard.press("Enter");
  await expect(control(page)).toHaveText("Pause");
  await expect.poll(() => advancePlayback(page), { intervals: [0] }).not.toBe(held);
});

test("a demonstration nobody can see is not running", async ({ page }) => {
  await page.setViewportSize({ width: 1_000, height: 400 });
  // Enough document in front of the block to scroll it off the screen.
  await writeDemo(page, harness().appUrl, 40);

  // The caret goes to the top of the document, which takes the panel with it.
  await caretAway(page);
  await expect(panel(page)).not.toBeInViewport();

  // Nothing paints into a panel nobody is looking at.
  await expect.poll(() => frameText(page)).toBe("");
  await page.clock.runFor(2_000);
  expect(await frameText(page)).toBe("");

  // Scrolled back to, it starts — from the top, not from where it left off.
  await panel(page).scrollIntoViewIfNeeded();
  await expect.poll(() => advancePlayback(page), { intervals: [0] }).toContain("$ ub init");
});

test("reduced motion gets the whole transcript, and no control at all", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await writeDemo(page, harness().appUrl);
  await caretAway(page);

  await expect(panel(page)).toBeVisible();
  await expect.poll(() => frameText(page)).toBe(TRANSCRIPT);
  // Nothing moves, so there is nothing to stop — and nothing painted where the
  // control would be. Computed visibility, not the role: the attribute alone
  // satisfied the role engine while the cascade still painted the button.
  await expect(toggle(page)).toBeHidden();
  const settled = await frameText(page);
  await page.clock.runFor(3_000);
  expect(await frameText(page)).toBe(settled);

  // Turned off mid-view, the demonstration starts — the reader is answered
  // either way round, without a reload.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(control(page)).toHaveText("Pause");
  await expect(toggle(page)).toBeVisible();
  await expect.poll(() => advancePlayback(page), { intervals: [0] }).not.toBe(settled);

  // …and turned back on mid-run the control goes again, rather than standing
  // there as a button that would stop nothing.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(toggle(page)).toBeHidden();
  await expect.poll(() => frameText(page)).toBe(TRANSCRIPT);
});

test("an empty transcript is an idle panel with no control on it", async ({ page }) => {
  await writeDemo(page, harness().appUrl, 0, "");
  await caretAway(page);

  // Nothing plays, so the same rule holds for a reason that has nothing to do
  // with motion — and here the button would be blank as well as inert, because
  // a panel that never plays never writes a label on it.
  await expect(panel(page)).toBeVisible();
  await expect(toggle(page)).toBeHidden();
});

test("assistive technology is offered the transcript, not the animation", async ({
  page,
}) => {
  await writeDemo(page, harness().appUrl);
  await caretAway(page);
  await expect(panel(page)).toBeVisible();

  // The animation is out of the accessibility tree; the complete transcript
  // beside it is in it, off-screen rather than removed.
  await expect(frame(page)).toHaveAttribute("aria-hidden", "true");
  await expect
    .poll(
      async () =>
        (await page.locator(".ub-terminal-transcript").textContent()) ?? "",
    )
    .toBe(TRANSCRIPT);
  await expect(page.locator(".ub-terminal [aria-live]")).toHaveCount(0);

  // The panel names itself as the way to the transcript, and the name is what
  // is announced — Chromium's accessible-name computation, not our attribute.
  await expect(panel(page)).toHaveAccessibleName(/transcript/i);
});
