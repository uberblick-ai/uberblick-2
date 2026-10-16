/** Settings groups reflect independent live workspace, login and hub permissions. */
import { devices, expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { activateControl, setupHarness } from "./app-helpers.js";

const WORKSPACE_CONTROLS = "#ub-workspace-name, #ub-main-repository, #ub-new-tag, #ub-github-account";

function navigation(page: Page) {
  return page.getByRole("navigation", { name: "Settings", exact: true });
}

async function showSidebar(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) >= 1280) return;
  const sidebar = page.getByRole("dialog", { name: "Sidebar", exact: true });
  if (!await sidebar.isVisible()) await activateControl(page.getByRole("button", { name: "Show sidebar", exact: true }));
  await expect(sidebar).toBeVisible();
}

test.describe("a current workspace and hub admin", () => {
  const { harness, openApp } = setupHarness({ accessRole: "admin", hubAdmin: true });

  test("all seven distinct entries work through desktop keyboard and wide and narrow iPad touch", { tag: "@webkit" }, async ({ browser }, info) => {
    const touch = info.project.use.hasTouch === true;
    const page = await openApp(browser, `/${harness().workspace}/settings`, {
      contextOptions: { ...(touch ? devices["iPad Pro 11"] : { viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false }), reducedMotion: "reduce" },
    });
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    for (const width of touch ? [834, 600] : [1440]) {
      await page.setViewportSize({ width, height: 900 });
      await showSidebar(page);
      const nav = navigation(page);
      await expect(nav.locator(".ub-settings-nav > p")).toHaveText(["Workspace", "User", "Hub"]);
      await expect(nav.locator(".ub-settings-nav > p").first()).toHaveCSS("font-size", "12px");
      await expect(nav.locator(".ub-settings-nav > p").first()).toHaveCSS("text-transform", "none");
      const rows = nav.locator(".ub-settings-nav li > button");
      await expect(rows).toHaveText(["General", "Tags", "Members", "Preferences", "Devices", "Admins", "Workspaces"]);
      const icons = await rows.locator("svg").evaluateAll((elements) => elements.map((element) => element.innerHTML));
      expect(icons).toHaveLength(7);
      expect(new Set(icons).size).toBe(7);
      await expect(page.locator('[data-slot="sidebar-footer"]').getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
      for (const title of ["General", "Tags", "Members", "Preferences", "Devices", "Admins", "Workspaces"]) {
        await showSidebar(page);
        const entry = navigation(page).getByRole("button", { name: title, exact: true });
        if (touch) {
          expect((await entry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
          await entry.tap();
        } else {
          await entry.focus();
          await page.keyboard.press("Enter");
        }
        await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
      }
      await showSidebar(page);
      const back = navigation(page).locator(".ub-settings-back");
      await expect(back).not.toContainText("Back to");
      expect(await back.locator("svg").evaluate((element) => getComputedStyle(element).color))
        .toBe(await back.evaluate((element) => getComputedStyle(element).color));
      await activateControl(back);
      await expect(page).toHaveURL(new URL(`/${harness().workspace}`, harness().appUrl).href);
      if (touch) await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
      await activateControl(page.getByRole("button", { name: "Settings", exact: true }));
      await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    }
  });

  for (const [suffix, title] of [["", "General"], ["/tags", "Tags"], ["/members", "Members"]] as const) {
    test(`opening and reloading ${title} waits for the admin read at the same address`, async ({ browser }) => {
      let hold = true;
      const pending: Route[] = [];
      const path = `/${harness().workspace}/settings${suffix}`;
      const page = await openApp(browser, path, {
        contextOptions: { viewport: { width: 1440, height: 900 } },
        beforeNavigate: async (opening) => {
          await opening.route("**/api/access", (route) => {
            const action = route.request().postDataJSON() as { operation: string };
            if (hold && action.operation === "own-role") { pending.push(route); return; }
            return route.continue();
          });
        },
      });
      for (const visit of ["open", "reload"]) {
        if (visit === "reload") { hold = true; await page.reload(); }
        await expect(page.getByText("Reading workspace permissions…", { exact: true })).toBeVisible();
        await expect(page).toHaveURL(new URL(path, harness().appUrl).href);
        await expect(navigation(page).getByRole("region", { name: "Workspace", exact: true })).toHaveCount(0);
        await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
        await expect.poll(() => pending.length).toBeGreaterThan(0);
        hold = false;
        for (const route of pending.splice(0)) await route.continue();
        await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
        await expect(page).toHaveURL(new URL(path, harness().appUrl).href);
        await expect(navigation(page).getByRole("region", { name: "Workspace", exact: true })).toBeVisible();
      }
    });
  }

  test("a changed workspace role removes controls and returns an open page to Preferences", async ({ browser }) => {
    let role = "admin";
    const page = await openApp(browser, `/${harness().workspace}/settings`, {
      beforeNavigate: async (opening) => {
        await opening.route("**/api/access", (route) => {
          const action = route.request().postDataJSON() as { operation: string };
          return action.operation === "own-role"
            ? route.fulfill({ json: { status: "ok", role, hub: harness().hubUrl } }) : route.continue();
        });
      },
    });
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Main repository", exact: true })).toBeEnabled();
    role = "member";
    await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
    await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
    await expect(navigation(page).locator(".ub-settings-nav > p")).toHaveText(["User", "Hub"]);
    await page.goto(new URL(`/${harness().workspace}/settings/tags`, harness().appUrl).href);
    await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
    await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
  });

  test("signing this computer out removes Workspace, Devices and Hub while the page stays open", async ({ browser }) => {
    const page = await openApp(browser, `/${harness().workspace}/settings`);
    await expect(navigation(page).locator(".ub-settings-nav > p")).toHaveText(["Workspace", "User", "Hub"]);
    await expect(navigation(page).getByRole("button", { name: "Devices", exact: true })).toBeVisible();
    try {
      harness().setStoredLogin(false);
      await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
      await expect(navigation(page).locator(".ub-settings-nav > p")).toHaveText(["User"]);
      await expect(navigation(page).getByRole("button", { name: "Devices", exact: true })).toHaveCount(0);
      await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
      await page.getByTestId("account-menu").click();
      await expect(page.getByRole("menuitem")).toHaveText(["Preferences"]);
    } finally { harness().setStoredLogin(true); }
  });

  test("a rebound configuration removes a previously confirmed admin's controls on reload", async ({ browser }) => {
    const page = await openApp(browser, `/${harness().workspace}/settings/tags`);
    await expect(page.locator("#ub-new-tag")).toBeEnabled();
    try {
      harness().rebindProject("ws://127.0.0.1:1");
      await page.reload();
      await expect(page.locator(".ub-rebound-notice")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
      await expect(navigation(page).locator(".ub-settings-nav > p")).toHaveText(["User"]);
      await expect(navigation(page).getByRole("button", { name: "Devices", exact: true })).toHaveCount(0);
      await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
    } finally { harness().rebindProject(harness().hubUrl); }
  });

  test("a login for another hub grants none of the bound hub's settings groups", async ({ browser }) => {
    const otherHub = "wss://other-hub.example.test/ws";
    const page = await openApp(browser, `/${harness().workspace}/settings`, {
      beforeNavigate: async (opening) => {
        await opening.route("**/uberblick-config.json", async (route) => {
          const config = await (await route.fetch()).json();
          config.remoteHubUrl = otherHub;
          config.servedWorkspaces[harness().workspaceUuid].remoteHubUrl = otherHub;
          await route.fulfill({ json: config });
        });
        await opening.route("**/api/access", (route) => route.fulfill({ json: {
          status: "sign-in-required", hub: "https://other-hub.example.test",
        } }));
        await opening.route("**/api/account", (route) => route.fulfill({ json: { state: "signed-out" } }));
        await opening.route("**/api/device-login", (route) => route.fulfill({ json: { state: "signed-out" } }));
      },
    });
    await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
    await expect(navigation(page).locator(".ub-settings-nav > p")).toHaveText(["User"]);
    await expect(navigation(page).getByRole("button", { name: "Devices", exact: true })).toHaveCount(0);
    await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
  });

  for (const offline of ["refused", "waiting"] as const) {
    test(`stored sign-in keeps Devices available on a cold open while hub management is ${offline}`, async ({ browser }) => {
      const pending: Route[] = [];
      const page = await openApp(browser, `/${harness().workspace}/settings/preferences`, {
        beforeNavigate: async (opening) => {
          await opening.route("**/api/access", (route) => {
            if (offline === "waiting") { pending.push(route); return; }
            return route.fulfill({ json: { status: "hub-down", hub: harness().hubUrl } });
          });
        },
      });
      try {
        await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
        await expect(navigation(page).locator(".ub-settings-nav > p")).toHaveText(["User"]);
        await expect(navigation(page).getByRole("button", { name: "Devices", exact: true })).toBeVisible();
        await page.getByTestId("account-menu").click();
        await expect(page.getByRole("menuitem")).toHaveText(["Preferences", "Devices"]);
        await page.getByRole("menuitem", { name: "Devices", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
        await expect(page.getByText(`Computers signed in to ${new URL(harness().hubUrl).host} as @browser-person. Revoking one stops its sync; its downloaded documents stay.`, { exact: true })).toBeVisible();
        if (offline === "waiting") {
          await expect(page.getByText("Reading devices from the hub…", { exact: true })).toBeVisible();
        }
        await expect(page.getByRole("alert").filter({ hasText: "The hub cannot be reached." })).toBeVisible();
        await expect(navigation(page).getByRole("button", { name: "Devices", exact: true })).toBeVisible();
        harness().setStoredLogin(false);
        await expect(navigation(page).getByRole("button", { name: "Devices", exact: true })).toHaveCount(0);
        await expect(navigation(page).locator(".ub-settings-nav > p")).toHaveText(["User"]);
        await page.getByTestId("account-menu").click();
        await expect(page.getByRole("menuitem")).toHaveText(["Preferences"]);
      } finally {
        harness().setStoredLogin(true);
        for (const route of pending) await route.abort().catch(() => {});
      }
    });
  }

  for (const status of ["hub-down", "sign-in-required", "forbidden"]) {
    test(`a ${status} workspace-role answer never exposes workspace controls by address`, async ({ browser }) => {
      const page = await openApp(browser, `/${harness().workspace}/settings/members`, {
        beforeNavigate: async (opening) => {
          await opening.route("**/api/access", (route) => {
            const action = route.request().postDataJSON() as { operation: string };
            return action.operation === "own-role"
              ? route.fulfill({ json: { status, hub: harness().hubUrl } }) : route.continue();
          });
        },
      });
      await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
      await expect(navigation(page).getByRole("region", { name: "Workspace", exact: true })).toHaveCount(0);
      await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
    });
  }
});

for (const role of ["member", "none"] as const) {
  test.describe(`a signed-in account with ${role === "none" ? "no workspace membership" : "a member role"} and no hub role`, () => {
    const { harness, openApp } = setupHarness({ accessRole: role });
    test("shows User alone, defaults Settings to Preferences and keeps own Devices", async ({ browser }) => {
      const page = await openApp(browser, `/${harness().workspace}`);
      const account = page.getByTestId("account-menu");
      await expect(account).toContainText(role === "member" ? "@browser-person" : "Account unavailable");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
      await expect(navigation(page).locator(".ub-settings-nav > p")).toHaveText(["User"]);
      await expect(navigation(page).getByRole("button", { name: "Devices", exact: true })).toBeVisible();
      for (const suffix of ["", "/tags", "/members"]) {
        await page.goto(new URL(`/${harness().workspace}/settings${suffix}`, harness().appUrl).href);
        await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
        await expect(page).toHaveURL(new URL(`/${harness().workspace}/settings/preferences`, harness().appUrl).href);
        await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
      }
      await navigation(page).getByRole("button", { name: "Devices", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
      const host = new URL(harness().hubUrl).host;
      await expect(page.getByText(`Computers signed in to ${host} as @browser-person. Revoking one stops its sync; its downloaded documents stay.`, { exact: true })).toBeVisible();
      await expect(page.getByRole("table", { name: "Devices", exact: true })).toBeVisible();
      await expect(account).toContainText(role === "member" ? "@browser-person" : "Account unavailable");
      if (role === "none") {
        await account.click();
        await expect(page.getByRole("menuitem")).toHaveText(["Preferences", "Devices"]);
      }
    });
  });
}

test.describe("a local workspace without roles", () => {
  const { harness, openApp } = setupHarness({ accessRole: "admin", hubAdmin: true, localWorkspace: true });
  test("always offers Workspace and Preferences while stored hub login grants no Devices or Hub group", async ({ browser }) => {
    const page = await openApp(browser, `/${harness().workspace}/settings`);
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(navigation(page).locator(".ub-settings-nav > p")).toHaveText(["Workspace", "User"]);
    await expect(navigation(page).getByRole("button", { name: "Devices", exact: true })).toHaveCount(0);
    await expect(navigation(page).getByRole("button", { name: "Admins", exact: true })).toHaveCount(0);
    await page.getByTestId("account-menu").click();
    await expect(page.getByRole("menuitem")).toHaveText(["Preferences"]);
    await page.keyboard.press("Escape");
    await navigation(page).getByRole("button", { name: "Tags", exact: true }).click();
    await expect(page.locator("#ub-new-tag")).toBeEnabled();
  });
});
