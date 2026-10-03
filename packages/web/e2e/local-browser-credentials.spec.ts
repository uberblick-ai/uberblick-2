/** An open page survives local serving restarts and credential changes. */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, openApp } = setupHarness({ app: { readySelector: ".ub-list-head" } });

async function documentText(page: Page): Promise<string | null> {
  return editor(page).evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return copy.textContent;
  });
}

test("local-only edits survive a restart and reach the hub after authentication returns", async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await openApp(browser);
  await createDoc(page, docTitle("local-credentials"), { pin: true });
  await placeCaret(page);
  await page.keyboard.type("before restart");
  const observer = await openApp(browser, new URL(page.url()).pathname, { upstream: true });
  await expect.poll(() => documentText(observer)).toBe("before restart");

  const pageInstance = await page.evaluate(() => performance.timeOrigin);
  const saved = page.locator(".ub-status-word--saved");
  const shared = page.locator(".ub-status-word--hub");
  await expect(shared).toHaveText("synced with hub");

  await harness().restartOpen({ authenticated: false });
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  await expect(page.locator(".ub-status")).toContainText("this machine has no credentials for its hub");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const reason = page.locator(".ub-status").getByText("this machine has no credentials for its hub", { exact: true });
    await expect(reason).toBeInViewport({ ratio: 1 });
    const trigger = page.locator(".ub-sync-toggle");
    await expect(trigger).toBeInViewport({ ratio: 1 });
    await trigger.click();
    await expect(page.locator('.ub-sync-fact:has(dt:text-is("Reason")) dd'))
      .toHaveText("this machine has no credentials for its hub");
    await page.getByRole("button", { name: "Close sync details" }).click();
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await placeCaret(page);
  await page.keyboard.type("; saved locally");
  await expect(saved).toHaveText("saved here");
  await expect.poll(() => documentText(observer)).toBe("before restart");

  // This page retains its original imported browser key on another local-only
  // boot, as well as across both authentication transitions below.
  await harness().restartOpen({ authenticated: false });
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  await expect.poll(() => documentText(page)).toBe("before restart; saved locally");

  await harness().restartOpen({ authenticated: true });
  await expect.poll(() => documentText(observer)).toBe("before restart; saved locally");
  await expect(shared).toHaveText("synced with hub");
  await expect(page.locator(".ub-status")).not.toContainText("no credentials");

  await harness().restartOpen({ authenticated: false });
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageInstance);
});
