/**
 * Block-menu layout and real input delivery, in a browser.
 *
 * Document and menu state belong in `test/block-menu.test.tsx`,
 * `test/input-rules.test.ts`, `test/list-keys.test.ts` and `test/list-a11y.test.ts`.
 * Real input keeps one end-state witness here, without replaying those state
 * sequences. The browser owns:
 *
 * - the gutter `+` revealing on hover *without moving the prose*, which is a
 *   claim about pixels and can only be measured where there are pixels;
 * - the pointer's route onto that `+`, which is a claim about which element is
 *   under every pixel on the way — `hover()` and `click()` both jump straight
 *   onto their target, so only a stepped move asks the question;
 * - a real click reaching the menu, real typing reaching an input rule, and
 *   Tab leaving both focus and the caret in a list item;
 * - the arrow keys keeping the highlighted entry inside a list that is taller
 *   than its viewport, which is a claim about a scroll container and the boxes
 *   inside it — jsdom measures every one of them as zero.
 *
 * The annotated slash-heading scenario and the table source/drawing proof are
 * retained under their separate contracts (#668 and #1095).
 */

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createDoc, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness } = setupHarness();

/** A fresh document, open and focused, with one paragraph of prose in it. */
async function openDoc(page: Page, seed: string): Promise<void> {
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await createDoc(page, "block menu");

  await placeCaret(page);
  await page.keyboard.type(seed, { delay: 15 });
}

function blocks(page: Page) {
  return page.locator(".ub-editor .ProseMirror > *");
}

/** An element's box inside the positioned frame that owns the block menu. */
async function frameGeometry(locator: Locator) {
  return locator.evaluate((element) => {
    const frame = element.closest(".ub-editor-frame") ??
      element.ownerDocument.querySelector(".ub-editor-frame");
    if (!(frame instanceof HTMLElement)) {
      throw new Error("e2e: block-menu geometry has no editor frame");
    }
    const box = element.getBoundingClientRect();
    const origin = frame.getBoundingClientRect();
    return {
      x: box.x - origin.x,
      y: box.y - origin.y,
      width: box.width,
      height: box.height,
    };
  });
}

test("hovering a block reveals the gutter + without moving the prose", async ({
  page,
}) => {
  await openDoc(page, "hover me");

  const block = blocks(page).first();
  const button = page.getByRole("button", { name: "Insert block below", includeHidden: true });
  // Away from the prose: the caret was placed with a click, which leaves the
  // pointer inside the block it clicked.
  await page.mouse.move(0, 0);
  await expect(button).toHaveCSS("opacity", "0");

  const before = await frameGeometry(block);
  await block.hover();
  await expect(button).toHaveCSS("opacity", "1");
  const after = await frameGeometry(block);

  // The gutter is reserved for good, so revealing the button is a change of
  // opacity and nothing else: the prose does not move by a pixel.
  expect(after).toEqual(before);
});

/**
 * Drag the pointer along the ground rather than lifting it: one `mousemove` per
 * pixel, so no gap between two elements can be stepped over. That is the whole
 * point of this test — the button used to hide in the few pixels between the
 * prose and itself, and any pointer that jumped, or strode, never saw them
 * (#507).
 */
async function walk(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));
  await page.mouse.move(to.x, to.y, { steps });
}

/** Observe the rendered hover state at every pixel of the pointer route. */
async function humanWalk(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await page.mouse.move(
      from.x + (to.x - from.x) * progress,
      from.y + (to.y - from.y) * progress,
    );
    await expect(page.getByRole("button", { name: "Insert block below" })).toHaveCSS("opacity", "1");
  }
}

/** Wait out the CSS close transition before proving that the hint still holds. */
async function settleGutter(button: Locator): Promise<void> {
  await button.evaluate(async (control) => {
    await Promise.all(control.getAnimations().map((animation) =>
      animation.finished.catch(() => undefined),
    ));
  });
}

/**
 * The journey, in the order a hand makes it: select prose, walk diagonally from
 * a lower line onto the first-line `+`, walk off it, come back and press it.
 */
test("the pointer can walk from the prose onto the gutter + and press it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1395, height: 720 });
  await openDoc(page, "reach me");
  await page.keyboard.type(" reach me".repeat(50));
  // Scale the document to the fractional geometry a 125% browser zoom adds.
  await page.evaluate(() => {
    document.documentElement.style.zoom = "125%";
  });

  const button = page.getByRole("button", { name: "Insert block below", includeHidden: true });
  const block = blocks(page).first();
  const prose = await block.boundingBox();
  if (prose === null) throw new Error("e2e: the first block has no box");
  const lineHeight = await block.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).lineHeight),
  );
  const firstLine = prose.y + lineHeight / 2;

  // Whatever the gutter claims, it claims none of the prose: caret placement
  // and a real pointer selection still belong to the editor.
  await page.mouse.click(prose.x + 1, firstLine);
  await page.keyboard.type("X", { delay: 15 });
  await expect(block).toContainText(/^Xreach me/);
  await page.mouse.move(prose.x + 2, firstLine);
  await page.mouse.down();
  await page.mouse.move(prose.x + 70, firstLine, { steps: 12 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(
    0,
  );

  // The ordinary hard case: a multi-line paragraph, approached from its last
  // line to the button beside its first. The full-height strip must carry the
  // diagonal without giving up hover.
  const inProse = {
    x: prose.x + 120,
    y: prose.y + prose.height - lineHeight / 2,
  };
  await page.mouse.move(inProse.x, inProse.y);
  await expect(button).toHaveCSS("opacity", "1");
  const target = await button.boundingBox();
  if (target === null) throw new Error("e2e: the gutter button has no box");
  expect(prose.height).toBeGreaterThan(3 * target.height);
  const centre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  // A point on the diagonal inside the button's gutter column but still below
  // its box. Only the full-height corridor owns this part of the hand's route.
  const gutterX = target.x + target.width - 0.5;
  const progress = (inProse.x - gutterX) / (inProse.x - centre.x);
  const gutterPause = {
    x: gutterX,
    y: inProse.y + (centre.y - inProse.y) * progress,
  };
  expect(gutterPause.y).toBeGreaterThan(target.y + target.height);
  const away = { x: prose.x - 2 * target.width, y: centre.y };

  const approach = async (): Promise<void> => {
    await page.mouse.move(inProse.x, inProse.y);
    await expect(button).toHaveCSS("opacity", "1");
    await humanWalk(page, inProse, gutterPause);
    await settleGutter(button);
    await expect(button).toHaveCSS("opacity", "1");
    await humanWalk(page, gutterPause, centre);
    await settleGutter(button);
    await expect(button).toHaveCSS("opacity", "1");
    expect(
      await button.evaluate((control) => {
        const box = control.getBoundingClientRect();
        return control.contains(
          document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
        );
      }),
    ).toBe(true);
  };

  await approach();

  // And it still goes when the walk continues past the gutter, which is neither
  // the block nor its strip.
  await walk(page, centre, away);
  await expect(button).toHaveCSS("opacity", "0");

  // Back by the same human-paced route, and pressed where the pointer already
  // is: `click()` would move it first, which is the gesture this test exists to
  // avoid. Insertion comes last because it re-centres the column.
  await approach();
  await page.mouse.down();
  await page.mouse.up();
  await page.getByRole("option", { name: "Heading 2" }).click();
  await page.keyboard.type("second", { delay: 15 });
  await expect(blocks(page).nth(1)).toHaveText("second");
});

/**
 * The annotation is the machine end of the link to the human-readable scenario.
 * The assertions were already the behavior proof; the unit-suite link check
 * asks Playwright whether this test is still registered and still names it.
 */
test(
  "typing / on an empty block filters, and Enter converts it",
  { annotation: { type: "scenario", description: "slash-menu-heading" } },
  async ({ page }) => {
    await openDoc(page, "first");

    // A second block, empty, the way a reader gets one.
    await page.keyboard.press("Enter");
    await page.keyboard.type("/he", { delay: 15 });
    // Scoped to the menu: the sidebar's workspace switcher is a `<select>`,
    // and its options carry the same role.
    await expect(page.getByRole("listbox", { name: "Block types" }).getByRole("option")).toHaveCount(3);

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("listbox", { name: "Block types" })).toHaveCount(0);
    await expect(blocks(page)).toHaveCount(2);
    expect(await blocks(page).nth(1).evaluate((node) => node.tagName)).toBe("H2");
    // The slash was consumed, not saved.
    await expect(blocks(page).nth(1)).toHaveText("");

    await page.keyboard.type("a heading", { delay: 15 });
    await expect(blocks(page).nth(1)).toHaveText("a heading");
  },
);

/** The list's viewport and every entry in it, measured in one pass. */
async function listGeometry(page: Page) {
  return page.getByRole("listbox", { name: "Block types" }).evaluate((box) => {
    const view = box.getBoundingClientRect();
    return {
      scrollTop: box.scrollTop,
      top: view.top,
      bottom: view.bottom,
      entries: Array.from(box.querySelectorAll('[role="option"]')).map((option) => {
        const rect = option.getBoundingClientRect();
        return {
          label: option.textContent ?? "",
          top: rect.top,
          bottom: rect.bottom,
          selected: option.getAttribute("aria-selected") === "true",
        };
      }),
    };
  });
}

type Geometry = Awaited<ReturnType<typeof listGeometry>>;

/** The highlighted entry, whole and inside the list's viewport. */
function visibleSelection(geometry: Geometry): void {
  const entry = geometry.entries.find((candidate) => candidate.selected);
  if (entry === undefined) throw new Error("e2e: no entry is highlighted");
  // A pixel of slack: scroll offsets are subpixel, and so is the arithmetic
  // that produced them.
  expect(entry.top).toBeGreaterThanOrEqual(geometry.top - 1);
  expect(entry.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
}

/**
 * Arrow keys through a list too long to show at once.
 *
 * The bug this pins: the highlight moved to an entry below the fold and the
 * list stayed where it was, so the reader could no longer see what Enter would
 * choose. What makes it a browser test is that every term in it — the
 * viewport, the entry boxes, the scroll offset — exists only where there is
 * layout.
 */
test("arrow keys keep the highlighted block type in view, and move nothing else", async ({
  page,
}) => {
  await openDoc(page, "first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/", { delay: 15 });

  const start = await listGeometry(page);
  // The premise: the palette really is taller than the box it is shown in.
  // Without this the rest of the test would pass on a list that never scrolls.
  expect(start.entries[start.entries.length - 1]?.bottom).toBeGreaterThan(start.bottom);
  expect(start.scrollTop).toBe(0);

  const card = page.getByRole("listbox", { name: "Block types" });
  const cardBefore = await frameGeometry(card);
  const proseBefore = await frameGeometry(blocks(page).first());
  const focusBefore = await page.evaluate(() => document.activeElement?.className ?? "");
  const shown = start.entries.filter((entry) => entry.bottom <= start.bottom + 1).length;

  // Down to the last entry that was already visible: nothing needed revealing,
  // so nothing scrolled.
  for (let step = 1; step < shown; step += 1) await page.keyboard.press("ArrowDown");
  const atFold = await listGeometry(page);
  expect(atFold.scrollTop).toBe(0);
  visibleSelection(atFold);

  // One more, onto the first entry below the fold. The list moves by exactly
  // what that entry needed and no further: its bottom edge lands on the
  // viewport's.
  await page.keyboard.press("ArrowDown");
  const revealed = await listGeometry(page);
  const entry = revealed.entries.find((candidate) => candidate.selected);
  visibleSelection(revealed);
  expect(entry?.bottom).toBeCloseTo(revealed.bottom, 0);

  // Walk to the bottom, then make the highlighted entry cross the viewport in
  // each direction. The wrap-around identities are jsdom state contracts;
  // revealing their boxes is the browser's job.
  const remaining = start.entries.length - 1 - shown;
  for (let step = 0; step < remaining; step += 1) await page.keyboard.press("ArrowDown");
  const last = await listGeometry(page);
  expect(last.scrollTop).toBeGreaterThan(0);
  visibleSelection(last);

  await page.keyboard.press("ArrowDown");
  visibleSelection(await listGeometry(page));
  await page.keyboard.press("ArrowUp");
  visibleSelection(await listGeometry(page));

  // Revealing an entry moves the list and nothing else: the menu keeps its
  // place at the caret, the prose under it has not moved, and the keys are
  // still the editor's.
  expect(await frameGeometry(card)).toEqual(cardBefore);
  expect(await frameGeometry(blocks(page).first())).toEqual(proseBefore);
  expect(await page.evaluate(() => document.activeElement?.className ?? "")).toBe(
    focusBefore,
  );

  // A reopened menu discards the previous list's scroll position.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/", { delay: 15 });
  const reopened = await listGeometry(page);
  expect(reopened.scrollTop).toBe(0);
  visibleSelection(reopened);
});

/**
 * The same list, reached the other way. The gutter menu keeps the keys in its
 * search field rather than in the prose, and it is the one that can be filtered
 * down to a different list under the same open menu.
 */
test("the gutter menu reveals with the keyboard, and scrolls for no pointer", async ({
  page,
}) => {
  await openDoc(page, "first");
  await blocks(page).first().hover();
  await page.getByRole("button", { name: "Insert block below" }).click();

  const start = await listGeometry(page);
  const search = page.getByRole("combobox", { name: "Search blocks" });

  /** The middle of an entry's visible part, in page coordinates. */
  async function over(entry: Geometry["entries"][number], view: Geometry) {
    const box = await page.getByRole("listbox", { name: "Block types" }).boundingBox();
    if (box === null) throw new Error("e2e: the list has no box");
    return {
      x: box.x + box.width / 2,
      y: (Math.max(entry.top, view.top) + Math.min(entry.bottom, view.bottom)) / 2,
    };
  }

  // Put the pointer over the first visible entry, then leave it there while
  // the list scrolls. Ordinary pointer highlighting is held in jsdom.
  const first = start.entries[0];
  if (first === undefined) throw new Error("e2e: the list is empty");
  const rest = await over(first, start);
  await page.mouse.move(rest.x, rest.y);

  // Now the hand stays exactly there while the keys walk past the fold. The
  // scroll that reveals the entry slides a *different* entry under the
  // stationary pointer, and the browser reports that as entering it — read as a
  // choice, it would undo the keystroke that caused it and leave Enter aimed at
  // an entry the reader never chose.
  for (let step = 1; step < start.entries.length; step += 1) {
    await page.keyboard.press("ArrowDown");
  }
  const walked = await listGeometry(page);
  expect(walked.scrollTop).toBeGreaterThan(0);
  visibleSelection(walked);
  // A real scroll must not let the entry newly under the stationary pointer
  // steal the keyboard's selection. This is its one end-state witness.
  expect(walked.entries.find((entry) => entry.selected)?.label).toBe(
    start.entries[start.entries.length - 1]?.label,
  );

  // A list that has scrolled leaves an entry half shown at the top edge; the
  // pointer takes that one too, and still moves nothing.
  const edge = walked.entries.find((entry) => entry.bottom > walked.top + 1);
  if (edge === undefined) throw new Error("e2e: nothing is on screen");
  const half = await over(edge, walked);
  await page.mouse.move(half.x, half.y);
  const hovered = await listGeometry(page);
  expect(hovered.scrollTop).toBe(walked.scrollTop);
  expect(hovered.entries.find((entry) => entry.selected)?.label).toBe(edge.label);

  // Filtering discards the old list's scroll position. Its entries and initial
  // selection are state contracts held in jsdom.
  await search.fill("he");
  const filtered = await listGeometry(page);
  expect(filtered.scrollTop).toBe(0);
  visibleSelection(filtered);
});

/**
 * jsdom calls `handleTextInput` directly and proves the rule's document
 * invariants and undo. A real keystroke also has to reach it through the
 * browser's input/DOM-change route; the resulting H2 is that route's witness.
 */
test("real typing reaches the heading input rule", async ({
  page,
}) => {
  await openDoc(page, "first");
  await page.keyboard.press("Enter");

  const second = blocks(page).nth(1);
  await page.keyboard.type("## ", { delay: 15 });
  expect(await second.evaluate((node) => node.tagName)).toBe("H2");
});

/**
 * In a browser Tab normally moves focus. Here it leaves focus and the caret in
 * the typed list item; typing on is the witness. The depth change, document
 * identity and ARIA state are held in jsdom.
 */
test("real Tab keeps focus and the caret in the typed list item", async ({
  page,
}) => {
  await openDoc(page, "first");
  await page.keyboard.press("Enter");

  await page.keyboard.type("- a", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("b", { delay: 15 });
  await page.keyboard.press("Tab");

  const items = page.locator(".ub-editor .ProseMirror > li");
  await expect(page.locator(".ub-editor .ProseMirror")).toBeFocused();

  // And the caret is still in the item Tab indented: typing carries on there.
  await page.keyboard.type("!", { delay: 15 });
  await expect(items.nth(1)).toHaveText("b!");
});

/**
 * The table block's two faces. Which one is shown is CSS keyed off the caret's
 * block, so "the reader sees a table until they click it, and then they see its
 * source" is a claim about rendering that only a browser can settle — jsdom
 * applies no stylesheet, and `test/table.test.ts` can therefore only assert the
 * class and the document.
 */
test("a typed table draws as a table, and clicking it opens the source", async ({
  page,
}) => {
  await openDoc(page, "first");
  await page.keyboard.press("Enter");

  await page.keyboard.type("| name | count |", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("| --- | ---: |", { delay: 10 });

  const table = page.locator(".ub-table");
  await expect(table).toHaveCount(1);
  // Two paragraphs became one block: the delimiter row was syntax.
  await expect(blocks(page)).toHaveCount(2);
  // The caret is in it, so the source is what is on screen.
  await expect(table.locator(".ub-table-source")).toBeVisible();

  // Click away, and the reader sees a table.
  await blocks(page).first().click();
  await expect(table.locator(".ub-table-render table")).toBeVisible();
  await expect(table.locator(".ub-table-source")).toBeHidden();
  await expect(table.locator("th").first()).toHaveText("name");

  // Click the table, and the source is back — that is the editing gesture.
  await table.locator(".ub-table-render").click();
  await expect(table.locator(".ub-table-source")).toBeVisible();
  await expect(table.locator(".ub-table-render")).toBeHidden();
});
