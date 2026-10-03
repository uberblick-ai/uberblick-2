/** An open page survives local serving restarts and credential changes. */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDoc, docTitle, editor, openDoc, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, openApp } = setupHarness({ app: { readySelector: ".ub-list-head" } });

async function documentText(page: Page): Promise<string | null> {
  return editor(page).evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return copy.textContent;
  });
}

async function statusGeometry(page: Page) {
  const [status, prose, updated] = await Promise.all([
    page.locator(".ub-status").boundingBox(),
    editor(page).locator(":scope > *").first().boundingBox(),
    page.locator(".ub-last-updated").boundingBox(),
  ]);
  expect(status).not.toBeNull();
  expect(prose).not.toBeNull();
  expect(updated).not.toBeNull();
  return { status, proseY: prose?.y, updated };
}

test("local-only edits survive a restart and reach the hub after authentication returns", async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await openApp(browser, "/", { contextOptions: { reducedMotion: "reduce" } });
  await createDoc(page, docTitle("local-credentials"), { pin: true });
  await placeCaret(page);
  await page.keyboard.type("before restart");
  const observer = await openApp(browser, new URL(page.url()).pathname, { upstream: true });
  await expect.poll(() => documentText(observer)).toBe("before restart");

  const pageInstance = await page.evaluate(() => performance.timeOrigin);
  const saved = page.locator(".ub-status-word--saved");
  const shared = page.locator(".ub-status-word--hub");
  const reason = page.locator(".ub-status").getByText("this machine has no credentials for its hub", { exact: true });
  await expect(shared).toHaveText("synced with hub");
  const authenticatedGeometry = await statusGeometry(page);

  await harness().restartOpen({ authenticated: false });
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  await expect(reason).toBeVisible();
  await expect(reason).toHaveText("this machine has no credentials for its hub");
  expect(await statusGeometry(page)).toEqual(authenticatedGeometry);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
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
  const localGeometry = await statusGeometry(page);

  // This page retains its original imported browser key on another local-only
  // boot, as well as across both authentication transitions below.
  await harness().restartOpen({ authenticated: false });
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  await expect.poll(() => documentText(page)).toBe("before restart; saved locally");
  expect(await statusGeometry(page)).toEqual(localGeometry);

  await harness().restartOpen({ authenticated: true });
  await expect.poll(() => documentText(observer)).toBe("before restart; saved locally");
  await expect(shared).toHaveText("synced with hub");
  await expect(reason).toBeHidden();
  expect(await statusGeometry(page)).toEqual(localGeometry);

  await harness().restartOpen({ authenticated: false });
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  await expect(reason).toBeVisible();
  expect(await statusGeometry(page)).toEqual(localGeometry);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageInstance);
});

test("local-only status answers leave the readings and prose in place", async ({ browser }) => {
  test.setTimeout(90_000);
  const seed = await openApp(browser);
  const titles = [docTitle("geometry-a"), docTitle("geometry-b")] as const;
  const paths: string[] = [];
  for (const title of titles) {
    await createDoc(seed, title, { pin: true });
    await placeCaret(seed);
    await seed.keyboard.type("the prose stays here");
    await expect(seed.locator(".ub-status-word--saved")).toHaveText("saved here");
    paths.push(new URL(seed.url()).pathname);
  }
  await seed.close();
  await harness().restartOpen({ authenticated: false });

  for (const width of [1280, 390, 320]) {
    // Withhold usable API answers until after the local room has settled. A
    // fresh page has no earlier serving reason to keep through this blank.
    let blankAnswers = true;
    let failNext = false;
    const page = await openApp(browser, paths[0], {
      contextOptions: { viewport: { width, height: 844 }, reducedMotion: "reduce" },
      readySelector: ".ub-editor .ProseMirror",
      beforeNavigate: async (opening) => {
        await opening.route("**/api/status", async (route) => {
          if (blankAnswers || failNext) {
            failNext = false;
            await route.abort();
          } else {
            await route.continue();
          }
        });
      },
    });
    const pageInstance = await page.evaluate(() => performance.timeOrigin);
    const saved = page.locator(".ub-status-word--saved");
    const shared = page.locator(".ub-status-word--hub");
    const reason = page.locator(".ub-status").getByText("this machine has no credentials for its hub", { exact: true });
    await expect(saved).toHaveText("saved here");
    await expect(shared).toHaveText("");
    await expect(reason).toBeHidden();
    const beforeFirstAnswer = await statusGeometry(page);
    blankAnswers = false;
    await expect(reason).toBeVisible();
    expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
    await expect(shared).toHaveText("not shared with hub");
    expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);

    for (const title of [titles[1], titles[0]]) {
      blankAnswers = true;
      if (width < 768) {
        await page.getByRole("button", { name: "Show document list", exact: true }).click();
      }
      await openDoc(page, title);
      await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
      await expect(saved).toHaveText("saved here");
      await expect(shared).toHaveText("");
      await expect(reason).toBeVisible();
      expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
      blankAnswers = false;
      await expect(shared).toHaveText("not shared with hub");
      expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
    }

    failNext = true;
    await expect(shared).toHaveText("");
    await expect(reason).toBeVisible();
    expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
    await expect(shared).toHaveText("not shared with hub");
    expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageInstance);
    await page.close();
  }
});
