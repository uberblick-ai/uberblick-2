/** Bound-hub administration uses the real signed local bridge without membership. */
import { devices, expect, test } from "@playwright/test";
import { activateControl, setupHarness } from "./app-helpers.js";
import { startHarness } from "./harness.js";

test.describe("a hub administrator with no workspace membership", () => {
  const { harness, openApp } = setupHarness({ accessRole: "none", hubAdmin: true, scope: "test" });

  for (const appearance of ["light", "dark"] as const) {
    for (const touch of [false, true]) {
      test(`administrator removal uses ${touch ? "iPad touch" : "desktop pointer and keyboard"} in ${appearance}`,
        { tag: touch ? "@webkit-touch" : "@webkit" }, async ({ browser, browserName }, info) => {
        test.skip(!touch && info.project.name === "webkit-iphone", "The paired iPad context owns touch coverage.");
        const page = await openApp(browser, `/${harness().workspace}/settings/hub-admins`, {
          contextOptions: { ...(touch ? devices["iPad Pro 11"] : { viewport: { width: 1280, height: 832 }, hasTouch: false, isMobile: false }), colorScheme: appearance, reducedMotion: "reduce" },
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
          await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
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
        await expect(inventory.getByRole("button")).toHaveCount(0);
      });
    }
  }

  for (const colorScheme of ["light", "dark"] as const) {
    test(`phone hub tables keep secondary facts with their account or workspace in ${colorScheme}`,
      { tag: "@webkit-touch" }, async ({ browser }) => {
      const page = await openApp(browser, `/${harness().workspace}/settings/hub-admins`, {
        contextOptions: { viewport: { width: 375, height: 812 }, hasTouch: true, colorScheme },
      });
      const admins = page.getByRole("table", { name: "Hub admins", exact: true });
      await expect(admins).toBeVisible();
      await expect(admins.getByRole("columnheader", { name: "Workspaces", exact: true })).toHaveCount(0);
      await expect(admins.getByRole("columnheader", { name: "Last signed in", exact: true })).toHaveCount(0);
      const own = admins.getByRole("row").filter({ hasText: "@browser-person" });
      await expect(own.getByRole("rowheader")).toContainText("Workspaces: 0 · Last signed in: just now");
      await expect(own.locator("time:visible")).toHaveAttribute("title", /.+/);
      await expect(admins.getByRole("button", { name: "Remove other-admin", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.goto(new URL(`/${harness().workspace}/settings/hub-workspaces`, harness().appUrl).href);
      const workspaces = page.getByRole("table", { name: "Hub workspaces", exact: true });
      await expect(workspaces).toBeVisible();
      await expect(workspaces.getByRole("columnheader", { name: "Members", exact: true })).toHaveCount(0);
      await expect(workspaces.getByRole("columnheader", { name: "Admins", exact: true })).toHaveCount(0);
      await expect(workspaces.getByRole("rowheader")).toContainText("Members: 1 · Admins: @other-admin");
      await expect(workspaces.getByRole("button")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }

  test("the signed bridge reads the complete inventory beyond one response's byte limit", async ({ browser }) => {
    const inventory = harness().seedHubInventory(420);
    expect(inventory.unpagedBytes).toBeGreaterThan(65_536);
    const reads: Array<Record<string, unknown>> = [];
    const page = await openApp(browser, `/${harness().workspace}/settings/hub-workspaces`, {
      beforeNavigate: async (page) => {
        page.on("request", (request) => {
          if (!request.url().endsWith("/api/access")) return;
          const body = request.postDataJSON() as Record<string, unknown>;
          if (body.operation === "list-hub-workspaces") reads.push(body);
        });
      },
    });
    const table = page.getByRole("table", { name: "Hub workspaces", exact: true });
    await expect(table).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(422);
    for (const uuid of inventory.workspaceIds) {
      await expect(table.getByText(uuid.slice(0, 8), { exact: true })).toHaveCount(1);
    }
    expect(reads.length).toBeGreaterThan(1);
    expect(reads[0]?.cursor).toBeUndefined();
    expect(reads.slice(1).every((read) => typeof read.cursor === "string")).toBe(true);
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
