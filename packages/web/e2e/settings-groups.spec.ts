/** Settings groups reflect independent live workspace, login and hub permissions. */
import { devices, expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { activateControl, setupHarness } from "./app-helpers.js";

const WORKSPACE_CONTROLS = "#ub-workspace-name, #ub-main-repository, #ub-new-tag, #ub-github-account";

function workspaceNavigation(page: Page) {
  return page.getByRole("navigation", { name: "Workspace settings", exact: true });
}

function personalNavigation(page: Page) {
  return page.getByRole("navigation", { name: "Personal settings", exact: true });
}

async function openPersonal(page: Page, title: "Preferences" | "Devices"): Promise<void> {
  await showSidebar(page);
  const account = page.getByTestId("account-menu");
  const entry = page.getByRole("menuitem", { name: title, exact: true });
  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
    await account.tap();
    await entry.tap();
  } else {
    await account.press("Enter");
    await entry.press("Enter");
  }
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
}

async function showSidebar(page: Page, settings = true): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) >= 1280) return;
  const sidebar = page.getByRole("dialog", { name: "Sidebar", exact: true });
  if (!await sidebar.isVisible()) await activateControl(page.getByRole("button", { name: settings ? "Show sidebar" : "Show document list", exact: true }));
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
      const nav = workspaceNavigation(page);
      await expect(nav.locator(".ub-settings-nav > p")).toHaveText(["Workspace", "Hub"]);
      await expect(nav.locator(".ub-settings-nav > p").first()).toHaveCSS("font-size", "12px");
      await expect(nav.locator(".ub-settings-nav > p").first()).toHaveCSS("text-transform", "none");
      const rows = nav.locator(".ub-settings-nav li > button");
      await expect(rows).toHaveText(["General", "Tags", "Members", "Admins", "Workspaces"]);
      const icons = await rows.locator("svg").evaluateAll((elements) => elements.map((element) => element.innerHTML));
      await expect(page.locator('[data-slot="sidebar-footer"]').getByRole("button", { name: "Workspace settings", exact: true })).toHaveCount(0);
      for (const title of ["General", "Tags", "Members", "Admins", "Workspaces"]) {
        await showSidebar(page);
        const entry = workspaceNavigation(page).getByRole("button", { name: title, exact: true });
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
      const back = workspaceNavigation(page).locator(".ub-settings-back");
      await expect(back).toContainText("Unnamed workspace");
      await expect(back).not.toContainText("Back to");
      expect(await back.locator("svg").evaluate((element) => getComputedStyle(element).color))
        .toBe(await back.evaluate((element) => getComputedStyle(element).color));
      await activateControl(back);
      await expect(page).toHaveURL(new URL(`/${harness().workspace}`, harness().appUrl).href);
      if (touch) await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
      else await expect(page.getByRole("button", { name: "Workspace settings", exact: true })).toBeFocused();
      await openPersonal(page, "Preferences");
      await showSidebar(page);
      const personal = personalNavigation(page);
      await expect(personal.locator(".ub-settings-nav li > button")).toHaveText(["Preferences", "Devices"]);
      icons.push(...await personal.locator(".ub-settings-nav li > button svg").evaluateAll((elements) => elements.map((element) => element.innerHTML)));
      expect(icons).toHaveLength(7);
      expect(new Set(icons).size).toBe(7);
      const workspaceEntry = page.getByRole("button", { name: "Workspace settings", exact: true });
      await expect(workspaceEntry).toBeVisible();
      if (!touch) await expect(personal.locator(".ub-settings-back")).toBeFocused();
      await activateControl(personal.getByRole("button", { name: "Devices", exact: true }));
      await expect(page.getByRole("heading", { level: 1, name: "Devices", exact: true })).toBeVisible();
      await showSidebar(page);
      await activateControl(personal.locator(".ub-settings-back"));
      await expect(page).toHaveURL(new URL(`/${harness().workspace}`, harness().appUrl).href);
      if (touch) await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
      else await expect(page.getByTestId("account-menu")).toBeFocused();
      await openPersonal(page, "Devices");
      await showSidebar(page);
      await activateControl(workspaceEntry);
      await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
      if (!touch) await expect(workspaceNavigation(page).locator(".ub-settings-back")).toBeFocused();
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
        await expect(workspaceNavigation(page).getByRole("region", { name: "Workspace", exact: true })).toHaveCount(0);
        await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
        await expect.poll(() => pending.length).toBeGreaterThan(0);
        hold = false;
        for (const route of pending.splice(0)) await route.continue();
        await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
        await expect(page).toHaveURL(new URL(path, harness().appUrl).href);
        await expect(workspaceNavigation(page).getByRole("region", { name: "Workspace", exact: true })).toBeVisible();
      }
    });
  }

  test("a changed workspace role leaves only local General settings and denies admin pages", async ({ browser }) => {
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
    await expect(workspaceNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["General", "Admins", "Workspaces"]);
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "On this computer", exact: true })).toBeVisible();
    await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
    for (const suffix of ["/tags", "/members"]) {
      await page.goto(new URL(`/${harness().workspace}/settings${suffix}`, harness().appUrl).href);
      await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
      await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
    }
  });

  test("signing this computer out removes Workspace, Devices and Hub while the page stays open", async ({ browser }) => {
    const page = await openApp(browser, `/${harness().workspace}/settings`);
    await expect(workspaceNavigation(page).locator(".ub-settings-nav > p")).toHaveText(["Workspace", "Hub"]);
    await page.getByTestId("account-menu").click();
    await expect(page.getByRole("menuitem", { name: "Devices", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    try {
      harness().setStoredLogin(false);
      await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
      await expect(personalNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["Preferences"]);
      await expect(page.getByRole("button", { name: "Workspace settings", exact: true })).toHaveCount(0);
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
      await expect(personalNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["Preferences"]);
      await expect(page.getByRole("button", { name: "Workspace settings", exact: true })).toHaveCount(0);
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
    await expect(personalNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["Preferences"]);
    await expect(page.getByRole("button", { name: "Workspace settings", exact: true })).toHaveCount(0);
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
        await expect(personalNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["Preferences", "Devices"]);
        await page.getByTestId("account-menu").click();
        await expect(page.getByRole("menuitem")).toHaveText(["Preferences", "Devices"]);
        await page.getByRole("menuitem", { name: "Devices", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
        await expect(page.getByText(`Computers signed in to ${new URL(harness().hubUrl).host} as @browser-person. Revoking one stops its sync; its downloaded documents stay.`, { exact: true })).toBeVisible();
        if (offline === "waiting") {
          await expect(page.getByText("Reading devices from the hub…", { exact: true })).toBeVisible();
        }
        await expect(page.getByRole("alert").filter({ hasText: "The hub cannot be reached." })).toBeVisible();
        await expect(personalNavigation(page).getByRole("button", { name: "Devices", exact: true })).toBeVisible();
        harness().setStoredLogin(false);
        await expect(personalNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["Preferences"]);
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
      await expect(personalNavigation(page).getByRole("region", { name: "Workspace", exact: true })).toHaveCount(0);
      await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
    });
  }
});

for (const role of ["member", "none"] as const) {
  test.describe(`a hub administrator with workspace role ${role}`, () => {
    const { harness, openApp } = setupHarness({ accessRole: role, hubAdmin: true });
    test("confirms hub authority independently and keeps personal pages separate", async ({ browser }) => {
      let hold = true;
      const pending: Route[] = [];
      const page = await openApp(browser, `/${harness().workspace}`, {
        beforeNavigate: async (opening) => {
          await opening.route("**/api/access", (route) => {
            const action = route.request().postDataJSON() as { operation: string };
            if (hold && action.operation === "own-hub-role") { pending.push(route); return; }
            return route.continue();
          });
        },
      });
      try {
        const entry = page.getByRole("button", { name: "Workspace settings", exact: true });
        await expect.poll(() => pending.length).toBeGreaterThan(0);
        if (role === "member") await expect(entry).toBeVisible();
        else await expect(entry).toHaveCount(0);
        await openPersonal(page, "Preferences");
        await expect(personalNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["Preferences", "Devices"]);
        if (role === "member") await expect(entry).toBeVisible();
        else await expect(entry).toHaveCount(0);
        hold = false;
        for (const route of pending.splice(0)) await route.continue().catch(() => {});
        await expect(entry).toBeVisible();
        await entry.click();
        const landing = role === "member" ? "" : "/hub-admins";
        await expect(page).toHaveURL(new URL(`/${harness().workspace}/settings${landing}`, harness().appUrl).href);
        await expect(workspaceNavigation(page).locator(".ub-settings-nav > p")).toHaveText(role === "member" ? ["Workspace", "Hub"] : ["Hub"]);
        await expect(workspaceNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(role === "member" ? ["General", "Admins", "Workspaces"] : ["Admins", "Workspaces"]);
        if (role === "member") {
          await expect(page.getByRole("heading", { name: "On this computer", exact: true })).toBeVisible();
          await workspaceNavigation(page).getByRole("button", { name: "Admins", exact: true }).click();
        }
        await expect(page.getByRole("table", { name: "Hub admins", exact: true })).toBeVisible();
        await expect(entry).toHaveCount(0);
        await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
        await openPersonal(page, "Devices");
        await expect(personalNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["Preferences", "Devices"]);
        await expect(entry).toBeVisible();
      } finally {
        hold = false;
        for (const route of pending) await route.abort().catch(() => {});
      }
    });
  });

  test.describe(`a signed-in account with ${role === "none" ? "no workspace membership" : "a member role"} and no hub role`, () => {
    const { harness, openApp } = setupHarness({ accessRole: role });
    if (role === "member") {
      test("a member saves this computer's retention with desktop keyboard and iPad touch", { tag: "@webkit" }, async ({ browser }, info) => {
        const touch = info.project.use.hasTouch === true;
        let retention = { mode: "recent", days: 30, keepNamed: true };
        let hold = true;
        const pending: Route[] = [];
        const page = await openApp(browser, `/${harness().workspace}`, {
          contextOptions: {
            ...(touch ? devices["iPad Pro 11"] : { viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false }),
            colorScheme: "light", reducedMotion: "reduce",
          },
          beforeNavigate: async (opening) => {
            await opening.route("**/api/local-settings", (route) => {
              if (route.request().method() === "POST") {
                retention = (route.request().postDataJSON() as { retention: typeof retention }).retention;
              } else if (hold) {
                pending.push(route);
                return;
              }
              return route.fulfill({ json: { retention, size: { bytes: 1_200_000_000, usedFraction: 0.75 } } });
            });
          },
        });
        await showSidebar(page, false);
        const entry = page.getByRole("button", { name: "Workspace settings", exact: true });
        if (touch) await entry.tap();
        else await entry.press("Enter");
        await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
        const local = page.getByRole("region", { name: "On this computer", exact: true });
        const size = local.locator("div").filter({ has: page.getByText("Size", { exact: true }) }).last();
        await expect(size).toContainText("—");
        await expect.poll(() => pending.length).toBeGreaterThan(0);
        hold = false;
        for (const route of pending.splice(0)) {
          await route.fulfill({ json: { retention, size: { bytes: 1_200_000_000, usedFraction: 0.75 } } });
        }
        await expect(size).toContainText("1.2 GB · 75% used");
        const mode = local.getByRole("combobox", { name: "History retention", exact: true });
        const period = local.getByRole("combobox", { name: "Recent history period", exact: true });
        const named = local.getByRole("checkbox", { name: "Keep named revisions", exact: true });
        const save = local.getByRole("button", { name: "Save history retention", exact: true });
        await expect(mode).toHaveValue("recent");
        await expect(mode.locator("option")).toHaveText(["Named revisions only", "Recent history", "Everything"]);
        await expect(period).toHaveValue("30");
        await expect(period.locator("option")).toHaveText(["7 days", "30 days", "90 days"]);
        await expect(named).toBeChecked();
        const backgrounds: string[] = [];
        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme });
          for (const control of [mode, period, named, save]) await expect(control).toBeVisible();
          await expect(save).toBeDisabled();
          await expect(save).toHaveCSS("border-top-width", "1px");
          await expect(save).toHaveCSS("border-top-style", "solid");
          await expect(save).toHaveCSS("opacity", "0.5");
          await period.selectOption("7");
          await expect(save).toBeEnabled();
          await expect(save).toHaveCSS("opacity", "1");
          await period.selectOption("30");
          await expect(save).toBeDisabled();
          if (colorScheme === "dark") {
            await expect.poll(() => mode.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(backgrounds[0]);
          }
          backgrounds.push(await mode.evaluate((element) => getComputedStyle(element).backgroundColor));
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const bounds = await local.boundingBox();
          expect(bounds?.width).toBeGreaterThan(0);
          expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 1440);
        }
        expect(backgrounds[0]).not.toBe(backgrounds[1]);
        if (touch) {
          await period.selectOption("90");
          await named.tap();
          await save.tap();
        } else {
          await period.focus();
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Tab");
          await expect(named).toBeFocused();
          await page.keyboard.press("Space");
          await page.keyboard.press("Tab");
          await expect(save).toBeFocused();
          await page.keyboard.press("Enter");
        }
        await expect.poll(() => retention).toEqual({ mode: "recent", days: 90, keepNamed: false });
        await expect(save).toBeDisabled();
        await page.reload();
        await expect(page.getByRole("combobox", { name: "Recent history period", exact: true })).toHaveValue("90");
        await expect(page.getByRole("checkbox", { name: "Keep named revisions", exact: true })).not.toBeChecked();
        await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
      });
    }
    test("opens the allowed settings and keeps own Devices separate", async ({ browser }) => {
      const page = await openApp(browser, `/${harness().workspace}`);
      const account = page.getByTestId("account-menu");
      await expect(account).toContainText(role === "member" ? "@browser-person" : "Account unavailable");
      const workspaceEntry = page.getByRole("button", { name: "Workspace settings", exact: true });
      if (role === "member") {
        await expect(workspaceEntry).toBeVisible();
        await workspaceEntry.click();
        await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
        await expect(workspaceNavigation(page).locator(".ub-settings-nav > p")).toHaveText(["Workspace"]);
        await expect(workspaceNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["General"]);
        await expect(page.getByRole("heading", { level: 2 })).toHaveText(["On this computer"]);
        await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
      } else await expect(workspaceEntry).toHaveCount(0);
      await openPersonal(page, "Preferences");
      await expect(personalNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["Preferences", "Devices"]);
      await expect(page.getByRole("navigation", { name: "Settings", exact: true })).toHaveCount(0);
      await personalNavigation(page).locator(".ub-settings-back").click();
      await expect(page).toHaveURL(new URL(`/${harness().workspace}`, harness().appUrl).href);
      await expect(account).toBeFocused();
      await openPersonal(page, "Devices");
      for (const suffix of ["", "/tags", "/members"]) {
        await page.goto(new URL(`/${harness().workspace}/settings${suffix}`, harness().appUrl).href);
        if (role === "member" && suffix === "") {
          await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
          await expect(page.getByRole("heading", { level: 2 })).toHaveText(["On this computer"]);
          await page.reload();
          await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
          await expect(page.getByRole("heading", { level: 2 })).toHaveText(["On this computer"]);
        } else {
          await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
          await expect(page).toHaveURL(new URL(`/${harness().workspace}/settings/preferences`, harness().appUrl).href);
        }
        await expect(page.locator(WORKSPACE_CONTROLS)).toHaveCount(0);
      }
      await personalNavigation(page).getByRole("button", { name: "Devices", exact: true }).click();
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
    const page = await openApp(browser, `/${harness().workspace}/settings`, {
      beforeNavigate: async (opening) => {
        await opening.route("**/api/local-settings", (route) => route.fulfill({ json: { size: { bytes: 24_000_000, usedFraction: 0.5 } } }));
      },
    });
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "On this computer", exact: true })).toContainText("24 MB · 50% used");
    await expect(page.locator("[data-settings-page]")).not.toContainText(/history/i);
    await expect(workspaceNavigation(page).locator(".ub-settings-nav > p")).toHaveText(["Workspace"]);
    await expect(workspaceNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["General", "Tags", "Members"]);
    await page.getByTestId("account-menu").click();
    await expect(page.getByRole("menuitem")).toHaveText(["Preferences"]);
    await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
    await expect(personalNavigation(page).locator(".ub-settings-nav li > button")).toHaveText(["Preferences"]);
    await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await workspaceNavigation(page).getByRole("button", { name: "Tags", exact: true }).click();
    await expect(page.locator("#ub-new-tag")).toBeEnabled();
  });
});
