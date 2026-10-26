import { waitForAcknowledged } from "./settle.js";
/** Native card parts share ordinary prose input, marks and comment controls. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { join } from "node:path";
import { closeIfOpen, createDoc, docTitle, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";
import { setNativeSelection } from "./native-selection.js";

const { harness } = setupHarness();

async function openCard(page: Page): Promise<Locator> {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, docTitle("Cards"));
  await placeCaret(page);
  await page.keyboard.type("/card");
  await page.keyboard.press("Enter");
  const card = page.locator(".ub-card").first();
  await expect(card).toBeVisible();
  return card;
}

async function selectPart(part: Locator): Promise<void> {
  await part.locator("p").click();
  await setNativeSelection(part, () => part.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true, pointerId: 1 }));
    const range = document.createRange();
    range.selectNodeContents(element.querySelector("p") ?? element);
    const root = element.closest(".ProseMirror") as (HTMLElement & { editor: Editor }) | null;
    if (root === null) throw new Error("e2e: card part has no editor");
    const expected = {
      anchor: root.editor.view.posAtDOM(range.startContainer, range.startOffset),
      head: root.editor.view.posAtDOM(range.endContainer, range.endOffset),
    };
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return expected;
  }));
}

test("empty optional parts collapse outside the card, and all four prose parts take formatting and web comments and keep footer link case", { tag: "@webkit" }, async ({ page }, info) => {
  const card = await openCard(page);
  for (const part of ["label", "body", "footer"]) await expect(card.locator(`[data-card-part=${part}]`)).toBeVisible();
  await page.keyboard.type("Title words");
  await page.locator(".ub-title").click();
  for (const part of ["label", "body", "footer"]) await expect(card.locator(`[data-card-part=${part}]`)).toBeHidden();
  await card.locator(".ub-card-title").click();
  for (const [part, text] of [["label", "Label words"], ["body", "Body words"], ["footer", "Metadata words"]] as const) {
    await card.locator(`[data-card-part=${part}] p`).click();
    await page.keyboard.type(text);
  }
  const toolbar = page.getByRole("toolbar", { name: "Text formatting and comment", exact: true });
  for (const [part, text] of [["label", "Label words"], ["title", "Title words"], ["body", "Body words"], ["footer", "Metadata words"]] as const) {
    const field = card.locator(`[data-card-part=${part}]`);
    await expect(field).toHaveText(text);
    await selectPart(field);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
    await expect(field.locator("strong")).toHaveText(text);
    await toolbar.getByRole("button", { name: "Comment", exact: true }).click();
    const composer = page.locator('[data-slot="selection-composer"]');
    await expect(composer).toContainText("Card 1");
    await composer.locator("textarea").fill(`Discuss ${part}`);
    await composer.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(field.locator("[data-comment-thread]")).toHaveText(text);
    await expect(page.locator(".ub-thread-card").filter({ hasText: `Discuss ${part}` })).toBeVisible();
    await closeIfOpen(page.getByRole("button", { name: "Close comments", exact: true }), page.locator(".ub-threads-toggle"), { touch: false });
  }
  const footer = card.locator(".ub-card-footer p");
  await footer.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" · [issueLink](https://example.com/issue)");
  const link = footer.locator("a.ub-link");
  await expect(link).toHaveText("issueLink");
  await expect(link).toHaveCSS("text-transform", "none");
  await expect(card.locator(".ub-card-footer")).toHaveCSS("text-transform", "uppercase");
  await waitForAcknowledged(page, { path: "relay" });
  await page.reload();
  await expect(page.locator(".ub-card")).toHaveCount(1);
  await expect(page.locator(".ub-card [data-comment-thread]")).toHaveCount(4);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    if (process.env.UB_AGENTS_SCRATCH !== undefined) {
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `card-parts-${info.project.name}-${colorScheme}.png`) });
    }
  }
});
