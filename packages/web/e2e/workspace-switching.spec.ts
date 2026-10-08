/** ub open serves each recorded replica without moving the project's binding. */
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { createDoc, docTitle, editor } from "./app-helpers.js";
import { placeCaret, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

let running: Harness;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => { running = await startHarness({ multiWorkspace: true }); });
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });
test.afterAll(async () => { await running?.stop(); });

async function switchToSecond(page: Page, keyboard = false): Promise<void> {
  const trigger = page.locator(".ub-workspace");
  if (keyboard) {
    await trigger.focus();
    await page.keyboard.press("Enter");
  } else await trigger.click();
  const items = page.getByRole("menu").getByRole("menuitem");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText(running.workspaceUuid.slice(0, 8));
  await expect(items.last()).toContainText("Second workspace");
  if (keyboard) {
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
  } else await items.last().click();
  await expect(page).toHaveURL(new URL(`/${running.secondWorkspace}`, running.appUrl).href);
  await expect(page.locator(".ub-list-head .ub-muted")).toHaveText("directory synced");
}

for (const scheme of ["light", "dark"] as const) {
  test(`switching uses the selected replica, hub and account while another tab keeps syncing — ${scheme}`, async ({ browser }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce" });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(running.appUrl);
    await expect(page).toHaveURL(new URL(`/${running.workspace}`, running.appUrl).href);
    await expect(page.getByTestId("account-menu")).toContainText("@browser-person");
    const startupBinding = running.projectBinding();
    const pageInstance = await page.evaluate(() => performance.timeOrigin);
    const firstTitle = docTitle("first-workspace");
    const firstDoc = await createDoc(page, firstTitle, { pin: true });
    await placeCaret(page);
    await page.keyboard.type("first workspace text");
    const firstRoom = `${running.workspaceUuid}/${firstDoc}`;
    await expect.poll(() => running.hubText(firstRoom)).toBe("first workspace text");

    const firstTab = await context.newPage();
    await firstTab.goto(page.url());
    await expect(editor(firstTab)).toContainText("first workspace text");
    await switchToSecond(page, scheme === "dark");
    await expect(page.getByTestId("account-menu")).toContainText("@second-person");
    await expect(page.locator(".ub-docs-open").filter({ hasText: firstTitle })).toHaveCount(0);
    const filter = page.getByRole("searchbox", { name: "Filter this list by title" });
    await filter.fill(firstTitle);
    await expect(page.locator(".ub-docs-row")).toHaveCount(0);
    await filter.fill("");
    const secondTitle = docTitle("second-workspace");
    const secondDoc = await createDoc(page, secondTitle, { pin: true });
    await placeCaret(page);
    await page.keyboard.type("second workspace text");
    const secondRoom = `${running.secondWorkspace}/${secondDoc}`;
    await expect.poll(() => running.hubText(secondRoom, true)).toBe("second workspace text");
    expect(running.hubText(secondRoom)).toBeNull();
    expect(running.hubText(firstRoom, true)).toBeNull();
    await expect(page.locator(".ub-status-word--hub")).toHaveText("synced with hub");
    await page.locator(".ub-sync-toggle").click();
    await expect(page.locator('.ub-sync-fact:has(dt:text-is("Hub")) dd')).toHaveText(running.secondHubUrl ?? "");
    await expect(page.locator('.ub-sync-fact:has(dt:text-is("Room")) dd')).toHaveText(secondRoom);
    await page.keyboard.press("Escape");

    // This tab still has the startup workspace open while the original tab
    // edits the other replica. Both changes must reach their own upstream.
    await placeCaret(firstTab);
    await firstTab.keyboard.type("; another tab");
    await expect.poll(() => running.hubText(firstRoom)).toBe("first workspace text; another tab");
    await placeCaret(page);
    await page.keyboard.type("; still the second hub");
    await expect.poll(() => running.hubText(secondRoom, true)).toBe("second workspace text; still the second hub");
    expect(running.projectBinding()).toEqual(startupBinding);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageInstance);
    expect(context.pages()).toHaveLength(2);
    const defaultTab = await context.newPage();
    await defaultTab.goto(running.appUrl);
    await expect(defaultTab).toHaveURL(new URL(`/${running.workspace}`, running.appUrl).href);
    await expect(defaultTab.getByTestId("account-menu")).toContainText("@browser-person");
  });
}

test("a secondary replica failure is shown on its pages and clears when switching back", async ({ browser }) => {
  const context = await browser.newContext();
  contexts.push(context);
  let failure = false;
  await context.route("**/api/status", async (route) => {
    if (failure) await route.fulfill({ status: 503, json: { error: "replica_unavailable", reason: "replica-held" } });
    else await route.continue();
  });
  const page = await context.newPage();
  await page.goto(running.appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  failure = true;
  await switchToSecond(page);
  await expect(page.locator(".ub-replica-unavailable")).toContainText("serving another ub open");
  failure = false;
  await page.locator(".ub-workspace").click();
  await page.getByRole("menu").getByRole("menuitem").first().click();
  await expect(page).toHaveURL(new URL(`/${running.workspace}`, running.appUrl).href);
  await expect(page.locator(".ub-replica-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("account-menu")).toContainText("@browser-person");
});
