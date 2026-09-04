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
 * - the pointer's route onto that `+`, which is a claim about which element is
 *   under every pixel on the way — `hover()` and `click()` both jump straight
 *   onto their target, so only a stepped move asks the question;
 * - the three gestures end to end through the browser's own event plumbing —
 *   typed keys reaching ProseMirror, a click reaching the menu, and a markdown
 *   prefix reaching `handleTextInput`, which only a real keystroke does;
 * - the arrow keys keeping the highlighted entry inside a list that is taller
 *   than its viewport, which is a claim about a scroll container and the boxes
 *   inside it — jsdom measures every one of them as zero.
 */

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { placeCaret, startHarness } from "./harness.js";
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

  await placeCaret(page);
  await page.keyboard.type(seed, { delay: 15 });
}

function blocks(page: Page) {
  return page.locator(".ub-editor .ProseMirror > *");
}

/** An element's box inside the positioned frame that owns the block menu. */
async function frameGeometry(locator: Locator) {
  return locator.evaluate((element) => {
    const frame = element.closest(".ub-editor-frame");
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
  const button = page.locator(".ub-gutter-add");
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

/** Move slowly enough for hover state and the opacity transition to settle. */
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
    await page.waitForTimeout(8);
  }
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

  const button = page.locator(".ub-gutter-add");
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
    await page.waitForTimeout(180);
    await expect(button).toHaveCSS("opacity", "1");
    await humanWalk(page, gutterPause, centre);
    await page.waitForTimeout(180);
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
  await expect(blocks(page)).toHaveCount(2);
  await page.keyboard.type("second", { delay: 15 });
  await expect(blocks(page).nth(1)).toHaveText("second");
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
    await expect(page.locator(".ub-blockmenu").getByRole("option")).toHaveCount(3);

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect(page.locator(".ub-blockmenu")).toHaveCount(0);
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
  return page.locator(".ub-blockmenu-list").evaluate((box) => {
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
function visibleSelection(geometry: Geometry): string {
  const entry = geometry.entries.find((candidate) => candidate.selected);
  if (entry === undefined) throw new Error("e2e: no entry is highlighted");
  // A pixel of slack: scroll offsets are subpixel, and so is the arithmetic
  // that produced them.
  expect(entry.top).toBeGreaterThanOrEqual(geometry.top - 1);
  expect(entry.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
  return entry.label;
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

  const card = page.locator(".ub-blockmenu");
  const cardBefore = await frameGeometry(card);
  const proseBefore = await frameGeometry(blocks(page).first());
  const focusBefore = await page.evaluate(() => document.activeElement?.className ?? "");
  const shown = start.entries.filter((entry) => entry.bottom <= start.bottom + 1).length;

  // Down to the last entry that was already visible: nothing needed revealing,
  // so nothing scrolled.
  for (let step = 1; step < shown; step += 1) await page.keyboard.press("ArrowDown");
  const atFold = await listGeometry(page);
  expect(atFold.scrollTop).toBe(0);
  expect(visibleSelection(atFold)).toBe(start.entries[shown - 1]?.label);

  // One more, onto the first entry below the fold. The list moves by exactly
  // what that entry needed and no further: its bottom edge lands on the
  // viewport's.
  await page.keyboard.press("ArrowDown");
  const revealed = await listGeometry(page);
  const entry = revealed.entries.find((candidate) => candidate.selected);
  expect(visibleSelection(revealed)).toBe(start.entries[shown]?.label);
  expect(entry?.bottom).toBeCloseTo(revealed.bottom, 0);

  // On to the end, then past it: Down from the last entry wraps to the first,
  // which is now above the viewport, and Up from there wraps back.
  const remaining = start.entries.length - 1 - shown;
  for (let step = 0; step < remaining; step += 1) await page.keyboard.press("ArrowDown");
  const last = await listGeometry(page);
  expect(visibleSelection(last)).toBe(start.entries[start.entries.length - 1]?.label);

  await page.keyboard.press("ArrowDown");
  const wrapped = await listGeometry(page);
  expect(visibleSelection(wrapped)).toBe(start.entries[0]?.label);

  await page.keyboard.press("ArrowUp");
  const back = await listGeometry(page);
  expect(visibleSelection(back)).toBe(start.entries[start.entries.length - 1]?.label);

  // Revealing an entry moves the list and nothing else: the menu keeps its
  // place at the caret, the prose under it has not moved, and the keys are
  // still the editor's.
  expect(await frameGeometry(card)).toEqual(cardBefore);
  expect(await frameGeometry(blocks(page).first())).toEqual(proseBefore);
  expect(await page.evaluate(() => document.activeElement?.className ?? "")).toBe(
    focusBefore,
  );

  // And a menu opened again starts at the top, rather than wearing the scroll
  // the last one ended on.
  await page.keyboard.press("Escape");
  await expect(page.locator(".ub-blockmenu")).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/", { delay: 15 });
  const reopened = await listGeometry(page);
  expect(reopened.scrollTop).toBe(0);
  expect(visibleSelection(reopened)).toBe(start.entries[0]?.label);
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
  await page.locator(".ub-gutter-add").click();

  const start = await listGeometry(page);
  const search = page.locator(".ub-blockmenu-search");
  await expect(search).toBeFocused();

  /** The middle of an entry's visible part, in page coordinates. */
  async function over(entry: Geometry["entries"][number], view: Geometry) {
    const box = await page.locator(".ub-blockmenu-list").boundingBox();
    if (box === null) throw new Error("e2e: the list has no box");
    return {
      x: box.x + box.width / 2,
      y: (Math.max(entry.top, view.top) + Math.min(entry.bottom, view.bottom)) / 2,
    };
  }

  // The pointer takes the entry it is on, and takes nothing else with it.
  const first = start.entries[0];
  if (first === undefined) throw new Error("e2e: the list is empty");
  const rest = await over(first, start);
  await page.mouse.move(rest.x, rest.y);
  const pointed = await listGeometry(page);
  expect(pointed.scrollTop).toBe(0);
  expect(visibleSelection(pointed)).toBe(first.label);

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
  expect(visibleSelection(walked)).toBe(start.entries[start.entries.length - 1]?.label);

  // A list that has scrolled leaves an entry half shown at the top edge; the
  // pointer takes that one too, and still moves nothing.
  const edge = walked.entries.find((entry) => entry.bottom > walked.top + 1);
  if (edge === undefined) throw new Error("e2e: nothing is on screen");
  const half = await over(edge, walked);
  await page.mouse.move(half.x, half.y);
  const hovered = await listGeometry(page);
  expect(hovered.scrollTop).toBe(walked.scrollTop);
  expect(hovered.entries.find((entry) => entry.selected)?.label).toBe(edge.label);

  // The keys have not left the search field through any of it.
  await expect(search).toBeFocused();

  // Filtering makes a different list, so the highlight goes back to its first
  // entry — and the scroll position from the list before it goes with it.
  await search.fill("he");
  const filtered = await listGeometry(page);
  expect(filtered.entries).toHaveLength(3);
  expect(filtered.scrollTop).toBe(0);
  expect(visibleSelection(filtered)).toBe(filtered.entries[0]?.label);
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

/**
 * The list keyboard, and Tab in particular. In a browser Tab moves focus — so
 * the proof that it indents the item instead, leaving the caret where it was,
 * is a claim about a real focus model that jsdom cannot make. The rest of the
 * list rules are pinned in `test/list-keys.test.ts` against a real Y.Doc.
 */
test("typing - starts a list, and Tab indents the item rather than leaving it", async ({
  page,
}) => {
  await openDoc(page, "first");
  await page.keyboard.press("Enter");

  await page.keyboard.type("- a", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("b", { delay: 15 });
  await page.keyboard.press("Tab");

  const items = page.locator(".ub-editor .ProseMirror > li");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-indent", "0");
  await expect(items.nth(1)).toHaveAttribute("data-indent", "1");

  // Two items, two blocks, two ids — each of them addressable on its own.
  const first = await items.nth(0).getAttribute("id");
  const second = await items.nth(1).getAttribute("id");
  expect(first).not.toBeNull();
  expect(second).not.toBe(first);

  // And the caret is still in the item Tab indented: typing carries on there.
  await page.keyboard.type("!", { delay: 15 });
  await expect(items.nth(1)).toHaveText("b!");

  // The two blocks are lists for a screen reader (#227): a container per set,
  // and each item levelled and counted where it sits. Tab made the second item
  // a nested set of its own, so it is a list of its own — the attributes are
  // pinned in `test/list-a11y.test.ts`; what a browser adds is that they
  // survive a list built by typing, in the live editor.
  const lists = page.locator(".ub-editor .ProseMirror [role=list]");
  await expect(lists).toHaveCount(2);
  await expect(lists.nth(0)).toHaveAttribute("aria-owns", first ?? "");
  await expect(lists.nth(1)).toHaveAttribute("aria-owns", second ?? "");
  await expect(items.nth(0)).toHaveAttribute("aria-level", "1");
  await expect(items.nth(0)).toHaveAttribute("aria-setsize", "1");
  await expect(items.nth(1)).toHaveAttribute("aria-level", "2");
  await expect(items.nth(1)).toHaveAttribute("aria-posinset", "1");
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
