/**
 * Syntax colouring in the browser (#922).
 *
 * The jsdom contract test owns document invariants and grammar routing. This
 * proof is only for what needs a CSS engine and real key events: token ink in
 * both appearances and Enter remaining a newline in
 * the existing code block.
 */

import { expect, test } from "@playwright/test";
import { createDoc, setupHarness } from "./app-helpers.js";
import type { Locator } from "@playwright/test";

const { harness } = setupHarness();

async function ink(element: Locator): Promise<string> {
  return element.evaluate((node) => getComputedStyle(node).color);
}

test("code tokens follow the appearance and real Enter inserts a newline", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await createDoc(page, "syntax highlighting");

  const first = page.locator(".ub-editor .ProseMirror > *").first();
  await first.hover();
  await page.getByRole("button", { name: "Insert block below" }).click();
  await page.getByRole("option", { name: "Code" }).click();
  await page.keyboard.type("const answer = 42;", { delay: 15 });

  const language = page.getByRole("textbox", { name: "Code language" });
  await expect(language).toBeVisible();
  await language.fill("ts");

  const block = page.locator(".ub-code");
  const source = block.locator("code");
  const keyword = block.locator(".hljs-keyword").first();
  const lightKeyword = await ink(keyword);
  expect(lightKeyword).not.toBe(await ink(source));

  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "dark"),
  );
  await expect.poll(() => ink(keyword)).not.toBe(lightKeyword);
  expect(await ink(keyword)).not.toBe(await ink(source));

  await source.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("return answer;", { delay: 15 });
  await expect(source).toHaveText("const answer = 42;\nreturn answer;");
});
