import { waitForAcknowledged } from "./settle.js";
/** Composed TableKit surface: direct input, contained overflow and caret reveal. */
import { devices, expect, test } from "@playwright/test";
import { join } from "node:path";
import { roomForDoc } from "@uberblick/schema";
import { activateControl, createDoc, docTitle, setupHarness } from "./app-helpers.js";
import { placeCaret, placeCaretIn } from "./harness.js";

const { harness, openApp, ws } = setupHarness();

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
  if (await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)) {
    const heights = await table.locator("th, td").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().height));
    for (const height of heights) expect(height + 0.001).toBeGreaterThanOrEqual(44);
  }
  const first = table.locator("th").first();
  await activateControl(first, { touch: info.project.use.hasTouch === true });
  await page.keyboard.type("Direct");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(first).toHaveText("Direct");
  await expect(first.locator("p")).toHaveCount(1);
  await expect(page.locator(".ub-table-source")).toHaveCount(0);

  // The two GFM source paragraphs become one table, retaining neighboring blocks.
  await page.locator(".ub-editor .ProseMirror > p").first().click();
  await placeCaret(page);
  await page.keyboard.press("Enter");
  const header = "| Name | Amount | Date | Status | Owner | Notes | Source | Last column |";
  await page.keyboard.type(header);
  await page.keyboard.press("Enter");
  const blocks = page.locator(".ub-editor .ProseMirror > *");
  const sourceBlockCount = await blocks.count();
  await page.keyboard.type("| --- | ---: | --- | --- | --- | --- | --- | --- |");
  const wide = page.locator(".ub-table").first();
  await expect(wide.locator("th")).toHaveCount(8);
  await expect(blocks).toHaveCount(sourceBlockCount - 1);
  const wrapper = wide.locator("..");
  await expect.poll(() => wrapper.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await activateControl(wide.locator("th").first(), { touch: info.project.use.hasTouch === true });
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

  await wide.locator("th").last().scrollIntoViewIfNeeded();
  await wide.locator("th").last().evaluate((element, pointerType) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { pointerType, bubbles: true, pointerId: 1 }));
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }, info.project.use.hasTouch === true ? "touch" : "mouse");
  const formatting = page.getByRole("toolbar", { name: "Text formatting and comment", exact: true });
  await expect(formatting).toBeVisible();
  await expect(formatting.getByRole("button", { name: "Comment", exact: true })).toBeVisible();
  if (process.env.UB_AGENTS_SCRATCH !== undefined) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `table-${info.project.name}-${colorScheme}.png`) });
    }
  }
});

test("a document link typed in a table cell opens its target and Back restores the table", async ({ page }, info) => {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  const targetTitle = docTitle("cell-target");
  const target = await createDoc(page, targetTitle);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  const source = await createDoc(page, docTitle("cell-source"));
  await placeCaret(page);
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  const cell = page.locator(".ub-table th").first();
  await activateControl(cell, { touch: info.project.use.hasTouch === true });
  await page.keyboard.type(`[the target](${target})`);
  const link = cell.locator("a.ub-doclink");
  await expect(link).toHaveText("the target");
  await expect(link).toHaveAttribute("data-doc-id", target);
  if (info.project.use.hasTouch === true) await link.tap();
  else await link.click();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${target}$`));
  await expect(page.locator(".ub-title")).toHaveValue(targetTitle);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${source}$`));
  await expect(page.locator(".ub-table th").first().locator("a.ub-doclink")).toHaveText("the target");
});

test("the cell @ picker takes keyboard and pointer or iPad touch picks through scrolling and sync", { tag: "@webkit-touch" }, async ({ browser, browserName }) => {
  const touch = browserName === "webkit";
  // This cell-picker proof uses an explicit iPad surface and a separate
  // desktop author to prove synchronization across input modes.
  const page = await openApp(browser, "/", {
    contextOptions: browserName === "webkit" ? devices["iPad Pro 11"] : devices["Desktop Chrome"],
  });
  const author = await openApp(browser, "/", {
    upstream: true,
    contextOptions: {
      ...(browserName === "webkit" ? devices["Desktop Safari"] : devices["Desktop Chrome"]),
      viewport: { width: 1280, height: 800 },
    },
  });
  const prefix = docTitle("table-pick");
  const firstTitle = `${prefix} Alpha`;
  const secondTitle = `${prefix} Beta`;
  const first = await createDoc(author, firstTitle);
  const second = await createDoc(author, secondTitle);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await activateControl(page.getByRole("button", { name: "Show document list", exact: true }), { touch });
  }
  const source = await createDoc(page, docTitle("picker table"));
  await placeCaret(page);
  await page.keyboard.type("| Name | Amount | Date | Status | Owner | Notes | Source | Last column |");
  await page.keyboard.press("Enter");
  await page.keyboard.type("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const table = page.locator(".ub-table");
  await expect(table.locator("th")).toHaveCount(8);
  const header = table.locator("th").last();
  const wrapper = table.locator("..");
  await placeCaretIn(header, { touch });
  await expect.poll(() => wrapper.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.type(` @${prefix}`);
  const picker = page.getByRole("listbox", { name: "People and documents" });
  await expect(picker.getByRole("option", { name: firstTitle, exact: true })).toBeVisible();
  await expect(picker.getByRole("option", { name: secondTitle, exact: true })).toBeVisible();
  const arrivedTitle = `${prefix} Gamma`;
  await createDoc(author, arrivedTitle);
  await expect(picker.getByRole("option", { name: arrivedTitle, exact: true })).toBeVisible();

  // The portalled card remains attached to the visible caret inside the
  // horizontally scrolled table, and stays within its document pane.
  const card = page.locator('[data-slot="caret-menu-content"]').filter({ has: picker });
  await expect.poll(() => card.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const pane = document.querySelector(".ub-document-pane")?.getBoundingClientRect();
    const selection = document.getSelection();
    if (pane === undefined || selection === null || selection.rangeCount === 0) return false;
    const caret = selection.getRangeAt(0).getBoundingClientRect();
    return element.closest(".tableWrapper") === null &&
      box.left >= Math.max(0, pane.left) - 1 && box.right <= Math.min(window.innerWidth, pane.right) + 1 &&
      box.top >= Math.max(0, pane.top) - 1 && box.bottom <= Math.min(window.innerHeight, pane.bottom) + 1 &&
      box.left <= caret.left + 1 && box.right >= caret.left - 1 && box.top >= caret.bottom - 1;
  })).toBe(true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const headerLink = header.locator("a.ub-doclink");
  await expect(headerLink).toHaveText(secondTitle);
  await expect(headerLink).toHaveAttribute("data-doc-id", second);
  await expect(header.locator("p")).toHaveCount(1);

  // TableKit's native Tab adds the next body row at this last header cell.
  await page.keyboard.press("Tab");
  await expect(table.locator("td")).toHaveCount(8);
  const body = table.locator("td").first();
  await page.keyboard.type(`@${prefix}`);
  await expect(picker).toBeVisible();
  await activateControl(picker.getByRole("option", { name: firstTitle, exact: true }), { touch });
  const bodyLink = body.locator("a.ub-doclink");
  await expect(bodyLink).toHaveText(firstTitle);
  await expect(bodyLink).toHaveAttribute("data-doc-id", first);
  await expect(headerLink).toHaveAttribute("data-doc-id", second);

  // With no matches, Enter still cannot split the cell and Tab still moves
  // to its next neighbour. Picking has restored the editor's native focus.
  await page.keyboard.press("Tab");
  const emptyResultCell = table.locator("td").nth(1);
  const missing = `@absent-${prefix}`;
  await page.keyboard.type(missing);
  await expect(picker.getByRole("option")).toHaveCount(0);
  const emptyCard = page.locator('[data-slot="caret-menu-content"]').filter({ hasText: "No people or documents match." });
  await expect(emptyCard).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(emptyResultCell).toHaveText(missing);
  await expect(emptyResultCell.locator("p")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await page.keyboard.type("next cell");
  await expect(table.locator("td").nth(2)).toHaveText("next cell");
  await expect(emptyCard).toHaveCount(0);

  const room = roomForDoc(harness().workspaceUuid, source);
  await expect.poll(() => harness().hubText(room)).toContain(`[${secondTitle}](${second})`);
  await expect.poll(() => harness().hubText(room)).toContain(`[${firstTitle}](${first})`);
  await author.goto(new URL(`/${ws()}/${source}`, author.url()).href);
  await expect(author.locator(".ub-table th").last().locator("a.ub-doclink")).toHaveAttribute("data-doc-id", second);
  await expect(author.locator(".ub-table td").first().locator("a.ub-doclink")).toHaveAttribute("data-doc-id", first);
  await waitForAcknowledged(page, { path: "relay" });
  await page.reload();
  await expect(headerLink).toHaveText(secondTitle);
  await expect(bodyLink).toHaveText(firstTitle);
  await activateControl(headerLink, { touch });
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${second}$`));
  await expect(page.locator(".ub-title")).toHaveValue(secondTitle);
});
