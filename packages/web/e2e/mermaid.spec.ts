/**
 * A mermaid block drawn as a diagram, in a real browser (#495).
 *
 * Only what jsdom structurally cannot answer is here. `test/mermaid.test.ts`
 * pins everything about the document and the DOM — that drawing writes nothing,
 * that an unsupported diagram stays source, that an agent's edit redraws, that
 * two replicas draw the same bytes. What is left needs a real engine:
 *
 * - **which representation a reader actually sees.** The switch is CSS, and
 *   only a browser applies CSS: the diagram visible with the source hidden, and
 *   the two swapping the moment the caret lands in the block.
 * - **the OS scheme moving under the "system" appearance.** The colours are
 *   ablauf's two palettes written into the SVG as `light-dark()`, which are CSS
 *   values in presentation attributes — so the picture follows the scheme with
 *   nothing subscribed and nothing drawn again. Only a CSS engine can say
 *   whether that resolution actually happens, and `page.emulateMedia` is what
 *   makes the scheme change a real event.
 */

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
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

function diagram(page: Page): Locator {
  return page.locator(".ub-mermaid-render svg");
}

function source(page: Page): Locator {
  return page.locator(".ub-mermaid > pre");
}

/**
 * The ground ablauf painted, as the browser resolved it. The *attribute* is one
 * `light-dark()` string in both appearances — the computed value is where the
 * scheme shows up, which is the whole point of drawing the picture once.
 */
async function ground(page: Page): Promise<string> {
  return diagram(page)
    .locator("rect")
    .first()
    .evaluate((element) => getComputedStyle(element).fill);
}

test("a flowchart draws, opens its source under the caret, and follows the scheme", async ({
  page,
}) => {
  if (started === null) throw new Error("e2e: the harness is not running");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(started.appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  await page.locator(".ub-title").fill("diagrams");

  // A mermaid block, the way a reader makes one, with the caret left in it.
  const first = page.locator(".ub-editor .ProseMirror > *").first();
  await first.hover();
  await page.locator(".ub-gutter-add").click();
  await page.getByRole("option", { name: "Mermaid" }).click();
  await page.keyboard.type("flowchart TD", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("  a[Start] --> b{Ok?}", { delay: 15 });

  // The caret is in the block, so the reader is looking at what they typed.
  await expect(source(page)).toBeVisible();
  await expect(diagram(page)).toBeHidden();

  // Caret away, and the block is a picture of what they typed.
  await first.click();
  await expect(diagram(page)).toBeVisible();
  await expect(source(page)).toBeHidden();
  await expect(diagram(page)).toContainText("Start");
  const light = await ground(page);
  expect(light).not.toBe("");
  // One picture, not one per appearance: the attribute names both halves.
  await expect(diagram(page).locator("rect").first()).toHaveAttribute(
    "fill",
    /^light-dark\(/,
  );

  // Clicking the picture is how they get back to the source.
  await diagram(page).click();
  await expect(source(page)).toBeVisible();
  await expect(diagram(page)).toBeHidden();

  // …and the OS scheme changing under "system" recolours it, still legible.
  await first.click();
  await expect(diagram(page)).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => ground(page)).not.toBe(light);
  await expect(diagram(page)).toBeVisible();
  await expect(diagram(page)).toContainText("Start");
});
