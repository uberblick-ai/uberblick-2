import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createDoc } from "./app-helpers.js";

/** Make a document and pin it — the sidebar lists what is pinned, and only that. */
export async function createPinnedDoc(page: Page, title: string): Promise<void> {
  await createDoc(page, title, { pin: true });
  const actions = page.getByRole("button", { name: "Document actions" });
  await actions.click();
  await expect(
    page.getByRole("menuitem", { name: "Unpin from sidebar" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
}

/** Drag the row itself with real pointer events. */
export async function dragOnto(page: Page, source: Locator, target: Locator): Promise<void> {
  await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error("e2e: nothing to drag");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 8);
  const x = to.x + to.width / 2;
  const y = to.y + to.height / 2;
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.move(x, y);
  await page.mouse.up();
  await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
}
