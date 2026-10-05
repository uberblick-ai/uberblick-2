/** Composed TableKit surface: direct input, contained overflow and caret reveal. */
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { createDoc, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness } = setupHarness();

test("TableKit cells stay drawn and wide tables contain horizontal scrolling", { tag: "@webkit" }, async ({ page }, info) => {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, "Editable table");
  await placeCaret(page);
  await page.keyboard.type("Neighbor paragraph");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  const table = page.locator(".ub-table");
  await expect(table).toBeVisible();
  await expect(table.locator("th")).toHaveCount(3);
  await expect(table.locator("td")).toHaveCount(6);
  const first = table.locator("th").first();
  if (info.project.use.hasTouch === true) await first.tap();
  else await first.click();
  await page.keyboard.type("Direct");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(first).toHaveText("Direct");
  await expect(first.locator("p")).toHaveCount(1);
  await expect(page.locator(".ub-table-source")).toHaveCount(0);

  // A fresh empty paragraph takes exactly one GFM table, retaining the block.
  await page.locator(".ub-editor .ProseMirror > p").first().click();
  await placeCaret(page);
  await page.keyboard.press("Enter");
  const header = "| Name | Amount | Date | Status | Owner | Notes | Source | Last column |";
  await page.keyboard.type(header);
  await page.keyboard.press("Enter");
  await page.keyboard.type("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const wide = page.locator(".ub-table").first();
  await expect(wide.locator("th")).toHaveCount(8);
  const wrapper = wide.locator("..");
  await expect.poll(() => wrapper.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await wide.locator("th").first().click();
  for (let index = 0; index < 7; index += 1) await page.keyboard.press("Tab");
  await expect.poll(() => wrapper.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.type(" edited");
  await expect(wide.locator("th").last()).toContainText("edited");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Native horizontal wheel input stands in for a trackpad's deltaX.
  if (info.project.use.isMobile !== true) {
    await wrapper.evaluate((element) => { element.scrollLeft = 0; });
    await wrapper.hover();
    await page.mouse.wheel(500, 0);
    await expect.poll(() => wrapper.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  }

  await wide.locator("th").last().evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  await expect(page.locator('[data-slot="selection-composer"]')).toHaveCount(0);
  if (process.env.UB_AGENTS_SCRATCH !== undefined) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `table-${info.project.name}-${colorScheme}.png`) });
    }
  }
});
