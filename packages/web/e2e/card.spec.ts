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

test("both menu paths focus the title and optional placeholders collapse outside the focused card", { tag: "@webkit" }, async ({ page }, info) => {
  const first = await openCard(page);
  await expect.poll(() => page.evaluate(() => {
    const anchor = document.getSelection()?.anchorNode;
    return anchor?.parentElement?.closest("[data-card-part]")?.getAttribute("data-card-part");
  })).toBe("title");
  for (const part of ["label", "body", "footer"]) await expect(first.locator(`[data-card-part=${part}]`)).toBeVisible();
  await page.keyboard.type("First recommendation");
  await expect(first.locator(".ub-card-title")).toHaveText("First recommendation");
  await page.locator(".ub-title").click();
  for (const part of ["label", "body", "footer"]) await expect(first.locator(`[data-card-part=${part}]`)).toBeHidden();
  await first.locator(".ub-card-title").click();
  if (info.project.use.hasTouch !== true) await first.hover();
  const insert = page.getByRole("button", { name: "Insert block below", exact: true });
  await insert.click();
  await page.getByRole("option", { name: "Card", exact: true }).click();
  await expect(page.locator(".ub-card")).toHaveCount(2);
  await page.keyboard.type("Second recommendation");
  const second = page.locator(".ub-card").nth(1);
  await expect(second.locator(".ub-card-title")).toHaveText("Second recommendation");
  await page.locator(".ub-title").click();
  const gap = await page.locator(".ub-card").evaluateAll((cards) => {
    const firstCard = cards[0];
    const secondCard = cards[1];
    if (firstCard === undefined || secondCard === undefined) throw new Error("e2e: missing stacked cards");
    const first = firstCard.getBoundingClientRect();
    const second = secondCard.getBoundingClientRect();
    return second.top - first.bottom;
  });
  expect(gap).toBe(12);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const shell = await first.evaluate((element) => {
      const style = getComputedStyle(element);
      const root = getComputedStyle(document.documentElement);
      return { vertical: style.paddingTop, horizontal: style.paddingLeft, border: style.borderTopWidth,
        radius: style.borderTopLeftRadius, card: style.backgroundColor, radiusToken: root.getPropertyValue("--radius") };
    });
    expect(shell).toMatchObject({ vertical: "20px", horizontal: "24px", border: "1px" });
    expect(shell.card).not.toBe("rgba(0, 0, 0, 0)");
    if (process.env.UB_AGENTS_SCRATCH !== undefined) {
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `card-${info.project.name}-${colorScheme}.png`) });
    }
  }
});

test("all four prose parts take formatting and web comments and keep footer link case", { tag: "@webkit" }, async ({ page }, info) => {
  const card = await openCard(page);
  await page.keyboard.type("Title words");
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
    await expect(page.locator(".ub-thread-card").filter({ hasText: `Discuss ${part}` })).toContainText("Card 1");
    await closeIfOpen(page.getByRole("button", { name: "Close threads", exact: true }), { touch: false });
  }
  const footer = card.locator(".ub-card-footer p");
  await footer.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" · [issueLink](https://example.com/issue)");
  const link = footer.locator("a.ub-link");
  await expect(link).toHaveText("issueLink");
  await expect(link).toHaveCSS("text-transform", "none");
  await expect(card.locator(".ub-card-footer")).toHaveCSS("text-transform", "uppercase");
  await expect(page.locator(".ub-status-word--saved")).toHaveText("saved here");
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
