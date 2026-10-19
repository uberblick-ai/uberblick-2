/** `ub open` admits a browser through the address it printed, once. */
import { expect, test } from "@playwright/test";
import { LOCAL_SESSION_KEY } from "../src/collab/local-session.js";
import { setupHarness } from "./app-helpers.js";
import { unauthorizedContext } from "./harness.js";

const { harness, trackContext } = setupHarness();

test("a browser without a session is sent to the printed address, which connects it once", async ({ browser }) => {
  // A restart prints a launch secret this harness has not traded itself.
  await harness().restartOpen({ authenticated: true });
  const printed = harness().printedUrl();
  const context = trackContext(await unauthorizedContext(browser));
  const unconnected = await context.newPage();
  await unconnected.goto(harness().appUrl);
  const notice = unconnected.getByRole("region", { name: "Connect this page" });
  await expect(notice).toContainText("Open the address ub open printed in your terminal");
  await expect(unconnected.locator(".ub-document-sidebar")).toHaveCount(0);

  const opened = await context.newPage();
  await opened.goto(printed);
  await expect(opened.locator(".ub-document-sidebar")).toHaveAttribute("data-directory-state", "synced");
  expect(new URL(opened.url()).hash).toBe("");
  expect(await opened.evaluate((key) => localStorage.getItem(key), LOCAL_SESSION_KEY)).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // The traded secret is spent: another browser opening the same address learns nothing from it.
  const other = trackContext(await unauthorizedContext(browser));
  const late = await other.newPage();
  await late.goto(printed);
  await expect(late.getByRole("region", { name: "Connect this page" })).toBeVisible();
  expect(new URL(late.url()).hash).toBe("");

  // Another tab of the connected browser shares its session, which survives a restart.
  await harness().restartOpen({ authenticated: true });
  const tab = await context.newPage();
  await tab.goto(harness().appUrl);
  await expect(tab.locator(".ub-document-sidebar")).toHaveAttribute("data-directory-state", "synced");
});
