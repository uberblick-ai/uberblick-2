/** Bound-hub administration uses the real signed local bridge without membership. */
import { expect, test } from "@playwright/test";
import { activateControl, createDoc, setupHarness } from "./app-helpers.js";
import { startHarness } from "./harness.js";

test.describe("a hub administrator with no workspace membership", () => {
  const { harness, openApp } = setupHarness({ accessRole: "none", hubAdmin: true, scope: "test" });

  test("hub administration uses native pointer, keyboard and touch input",
    { tag: "@webkit" }, async ({ browser }, info) => {
    const touch = info.project.use.hasTouch === true;
    const page = await openApp(browser, `/${harness().workspace}/settings/hub-admins`, {
      contextOptions: { colorScheme: "light", reducedMotion: "reduce" },
    });
    const table = page.getByRole("table", { name: "Hub admins", exact: true });
    await expect(table).toBeVisible();
    const own = table.getByRole("row").filter({ hasText: "@browser-person" });
    await expect(own).toContainText("you");
    await expect(own.getByRole("cell").first()).toHaveText("0");
    await expect(own.getByRole("button")).toHaveCount(0);
    await expect(own.locator("time:visible")).toHaveText("just now");
    await expect(own.locator("time:visible")).toHaveAttribute("title", /.+/);
    const remove = table.getByRole("button", { name: "Remove other-admin", exact: true });
    await activateControl(remove);
    const dialog = page.getByRole("alertdialog", { name: "Remove @other-admin as a hub administrator?", exact: true });
    await expect(dialog).toContainText("workspace memberships and roles stay");
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeFocused();
    await activateControl(cancel);
    await expect(dialog).toHaveCount(0);
    await expect(remove).toBeFocused();
    if (!touch) {
      await remove.press("Enter");
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
    } else {
      await activateControl(remove);
      await activateControl(dialog.getByRole("button", { name: "Remove", exact: true }));
    }
    await expect(table.getByText("@other-admin", { exact: true })).toHaveCount(0);
    await expect(page.getByText("@other-admin removed as a hub administrator.", { exact: true })).toBeVisible();
    if (touch) await activateControl(page.getByRole("button", { name: "Show sidebar", exact: true }));
    await activateControl(page.getByRole("button", { name: "Workspaces", exact: true }));
    const inventory = page.getByRole("table", { name: "Hub workspaces", exact: true });
    await expect(inventory).toBeVisible();
    await expect(inventory.getByText(harness().workspaceUuid.slice(0, 8), { exact: true })).toBeVisible();
    await expect(inventory.getByText("@other-admin", { exact: true })).toBeVisible();
    const workspace = inventory.getByRole("row").filter({ hasText: harness().workspaceUuid.slice(0, 8) });
    await expect(workspace.getByRole("cell").first()).toHaveCSS("font-variant-numeric", "tabular-nums");
    await expect(workspace.getByRole("cell").first()).toHaveCSS("font-family",
      await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily));
    await expect(workspace.getByRole("cell", { name: "Active", exact: true })).toBeVisible();
    const suspend = workspace.getByRole("button", { name: /^Suspend / });
    await activateControl(suspend);
    const suspension = page.getByRole("alertdialog", { name: /^Suspend / });
    await expect(suspension).toContainText("downloaded copies remain usable");
    await expect(suspension.getByRole("button", { name: "Suspend", exact: true })).toHaveAttribute("data-variant", "default");
    const cancelSuspend = suspension.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancelSuspend).toBeFocused();
    if (!touch) {
      await page.keyboard.press("Escape");
      await expect(suspension).toHaveCount(0);
      await expect(suspend).toBeFocused();
      await suspend.press("Enter");
      await expect(cancelSuspend).toBeFocused();
    }
    await activateControl(cancelSuspend);
    await expect(suspension).toHaveCount(0);
    await expect(suspend).toBeFocused();
    await expect(workspace.getByRole("cell", { name: "Active", exact: true })).toBeVisible();
    if (!touch) {
      await suspend.press("Enter");
      await expect(cancelSuspend).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(suspension.getByRole("button", { name: "Suspend", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
    } else {
      await activateControl(suspend);
      await activateControl(suspension.getByRole("button", { name: "Suspend", exact: true }));
    }
    await expect(workspace.getByRole("cell", { name: "Suspended", exact: true })).toBeVisible();
    await expect(workspace).toContainText("@other-admin");
    await expect(workspace.getByRole("cell").first()).toHaveText("1");
    await page.reload();
    if (touch) await activateControl(page.getByRole("button", { name: "Show sidebar", exact: true }));
    await expect(page.getByRole("region", { name: "Hub", exact: true })).toBeVisible();
    if (touch) await activateControl(page.getByRole("button", { name: "Workspaces", exact: true }));
    await expect(workspace.getByRole("cell", { name: "Suspended", exact: true })).toBeVisible();
    const restore = workspace.getByRole("button", { name: /^Restore / });
    await activateControl(restore);
    const restoration = page.getByRole("alertdialog", { name: /^Restore / });
    await expect(restoration).toContainText("without signing in or being added again");
    await expect(restoration.getByRole("button", { name: "Restore", exact: true })).toHaveAttribute("data-variant", "default");
    const cancelRestore = restoration.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancelRestore).toBeFocused();
    await activateControl(cancelRestore);
    await expect(restoration).toHaveCount(0);
    await expect(restore).toBeFocused();
    await expect(workspace.getByRole("cell", { name: "Suspended", exact: true })).toBeVisible();
    await activateControl(restore);
    await activateControl(restoration.getByRole("button", { name: "Restore", exact: true }));
    await expect(workspace.getByRole("cell", { name: "Active", exact: true })).toBeVisible();
    await expect(workspace.getByRole("button", { name: /^Suspend / })).toBeVisible();
  });

  test("revocation clears a focused tab's group on its next live read", async ({ browser }) => {
    const page = await openApp(browser, `/${harness().workspace}/settings/hub-admins`);
    const table = page.getByRole("table", { name: "Hub admins", exact: true });
    await expect(table).toBeVisible();
    harness().removeCurrentHubAdmin();
    await expect(page.getByText(/hub refused access/i)).toBeVisible();
    await expect(table).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Hub", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.getByRole("button", { name: "Admins", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Workspaces", exact: true })).toHaveCount(0);
  });
});

test.describe("a workspace administrator with no hub role", () => {
  const { harness, openApp } = setupHarness({ accessRole: "admin" });
  test("workspace administration never shows hub administration", async ({ browser }) => {
    const page = await openApp(browser, `/${harness().workspace}/settings/access`);
    await expect(page.getByRole("table", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Admins", exact: true })).toHaveCount(0);
    await page.goto(new URL(`/${harness().workspace}/settings/hub-workspaces`, harness().appUrl).href);
    await expect(page.getByText(/hub refused access/i)).toBeVisible();
    await expect(page.getByRole("table", { name: "Hub workspaces", exact: true })).toHaveCount(0);
  });
});

test.describe("a local workspace with a stored hub-admin login", () => {
  const { harness, openApp } = setupHarness({ accessRole: "admin", hubAdmin: true, localWorkspace: true });
  test("a document on this device alone has Edited and revision without a sync dot", async ({ browser }) => {
    const page = await openApp(browser);
    await createDoc(page, "On this device");
    await expect(page.locator(".ub-last-updated")).toContainText("Edited ");
    await expect(page.locator(".ub-status .ub-doc-rev")).toBeVisible();
    await expect(page.locator(".ub-status-sync, .ub-sync-dot")).toHaveCount(0);
    await expect(page.locator(".ub-status")).not.toContainText(/saved here|synced|Offline|uuid/);
  });
  test("local workspace settings never fall back to the stored login", async ({ browser }) => {
    const page = await openApp(browser, `/${harness().workspace}/settings`);
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Admins", exact: true })).toHaveCount(0);
    await page.goto(new URL(`/${harness().workspace}/settings/hub-admins`, harness().appUrl).href);
    await expect(page.getByText(/only from a workspace bound to that hub/i)).toBeVisible();
    await expect(page.getByRole("table", { name: "Hub admins", exact: true })).toHaveCount(0);
  });
});

test("a login for another hub never qualifies on the current workspace's bound hub", async ({ browser }) => {
  const harness = await startHarness({ multiWorkspace: true, hubAdmin: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(new URL(`/${harness.workspace}/settings`, harness.appUrl).href);
    await expect(page.getByRole("button", { name: "Admins", exact: true })).toBeVisible();
    await page.goto(new URL(`/${harness.secondWorkspace}/settings/hub-admins`, harness.appUrl).href);
    await expect(page.getByText(/hub refused access/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Admins", exact: true })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Hub admins", exact: true })).toHaveCount(0);
  } finally { await context.close(); await harness.stop(); }
});
