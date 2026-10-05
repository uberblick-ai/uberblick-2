import { expect, test } from "@playwright/test";
import { createDoc, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { openApp } = setupHarness();

test("inline marks open after punctuation through typing and plain-text paste @webkit", async ({ browser }) => {
  const page = await openApp(browser);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, "Inline marks");
  await placeCaret(page);
  await page.keyboard.type("test (`ab`)");

  const paragraph = page.locator(".ub-paragraph").first();
  await expect(paragraph).toHaveText("test (ab)");
  await expect(paragraph.locator("code.ub-inline-code")).toHaveText("ab");

  await page.keyboard.press("Enter");
  await page.locator(".ub-editor .ProseMirror").evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "(**bold**) [__also bold__] {*italic*} \"_also italic_\" '~~strike~~' (`code`) snake_case a*b*c");
    element.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: clipboard,
      bubbles: true,
      cancelable: true,
    }));
  });

  const pasted = page.locator(".ub-paragraph").nth(1);
  await expect(pasted).toHaveText("(bold) [also bold] {italic} \"also italic\" 'strike' (code) snake_case a*b*c");
  await expect(pasted.locator("strong")).toHaveText(["bold", "also bold"]);
  await expect(pasted.locator("em")).toHaveText(["italic", "also italic"]);
  await expect(pasted.locator("s")).toHaveText("strike");
  await expect(pasted.locator("code.ub-inline-code")).toHaveText("code");
});
