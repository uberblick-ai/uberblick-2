/** The footer identifies the login of this running local service, separately from presence. */
import { devices, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDoc, docTitle, setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness({ accessRole: "member" });
const handle = "browser-person";
const account = (page: Page) => page.getByTestId("account-menu");

async function showSidebar(page: Page, settings = false): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) >= 1280) return;
  if (await page.getByRole("dialog", { name: "Sidebar", exact: true }).count() === 0) {
    await page.getByRole("button", { name: settings ? "Show sidebar" : "Show document list", exact: true }).click();
  }
  await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
}

for (const scheme of ["light", "dark"] as const) {
  test(`the account footer opens personal settings by pointer and keyboard — ${scheme}`, async ({ browser }) => {
    const page = await openApp(browser, "/", {
      contextOptions: { hasTouch: false, isMobile: false, viewport: { width: 1280, height: 832 }, colorScheme: scheme, reducedMotion: "reduce" },
      readySelector: ".ub-document-sidebar",
    });
    for (const width of [1280, 810]) {
      await page.setViewportSize({ width, height: 832 });
      for (const mode of ["documents", "settings"] as const) {
        await page.goto(harness().appUrl);
        await showSidebar(page);
        if (mode === "settings") {
          await account(page).click();
          await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
          await showSidebar(page, true);
        }
        await expect(page.locator(".ub-list")).toHaveAttribute("data-mode", mode);
        const footer = page.locator('[data-slot="sidebar-footer"]');
        await expect(account(page)).toContainText(`@${handle}`);
        await expect(account(page)).toBeInViewport({ ratio: 1 });
        await expect(footer.getByRole("button", { name: "Workspace settings", exact: true })).toHaveCount(0);
        await expect(footer.getByText("Account settings", { exact: true })).toHaveCount(0);
        await account(page).click();
        const menu = page.getByRole("menu");
        await expect(menu.getByRole("menuitem")).toHaveText(["Preferences", "Devices"]);
        await page.keyboard.press("Escape");
        await expect(account(page)).toBeFocused();
        await page.keyboard.press("Enter");
        await menu.getByRole("menuitem", { name: "Preferences", exact: true }).press("Enter");
        const preferences = page.locator("[data-settings-page]");
        await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
        await expect(preferences).toContainText("Saved in this browser only.");
        await expect(preferences.getByText("MCP connections", { exact: true })).toHaveCount(0);
        const name = preferences.getByRole("textbox", { name: "Presence name", exact: true });
        await name.fill(`Presence ${scheme} ${width} ${mode}`);
        await name.press("Enter");
        await expect(preferences).toContainText(`How others see you while you edit: Presence ${scheme} ${width} ${mode}`);
        const swatch = preferences.getByRole("group", { name: "Presence colour" }).getByRole("button").first();
        await swatch.focus();
        await page.keyboard.press("Space");
        await expect(swatch).toHaveAttribute("aria-pressed", "true");
        const appearance = preferences.getByRole("group", { name: "Appearance" }).getByRole("button", {
          name: scheme === "light" ? "Light" : "Dark", exact: true,
        });
        await appearance.focus();
        await page.keyboard.press("Enter");
        await expect(appearance).toHaveAttribute("aria-pressed", "true");
        await showSidebar(page, true);
        await expect(account(page)).toContainText(`@${handle}`);
        await account(page).press("Enter");
        await page.getByRole("menuitem", { name: "Devices", exact: true }).press("Enter");
        await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
        await expect(page.getByRole("table", { name: "Devices", exact: true })).toBeVisible();
      }
    }
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`the presence name form saves through wide and narrow iPad touch — ${scheme}`, { tag: "@webkit-touch" }, async ({ browser }) => {
    const page = await openApp(browser, "/", {
      contextOptions: { ...devices["iPad Pro 11"], colorScheme: scheme, reducedMotion: "reduce" },
      readySelector: ".ub-body",
    });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    for (const width of [834, 600]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(harness().appUrl);
      await page.getByRole("button", { name: "Show document list", exact: true }).tap();
      await account(page).tap();
      const menuitem = page.getByRole("menuitem", { name: "Preferences", exact: true });
      expect((await menuitem.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await menuitem.tap();
      const name = page.getByRole("textbox", { name: "Presence name", exact: true });
      const save = page.getByRole("button", { name: "Save name", exact: true });
      await expect(name).toBeInViewport({ ratio: 1 });
      await expect(save).toBeInViewport({ ratio: 1 });
      expect((await name.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect((await save.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await name.tap();
      await name.fill(`iPad ${scheme} ${width}`);
      await save.tap();
      await page.reload();
      await expect(name).toHaveValue(`iPad ${scheme} ${width}`);
      await showSidebar(page, true);
      await expect(account(page)).toContainText(`@${handle}`);
      await account(page).tap();
      const devices = page.getByRole("menuitem", { name: "Devices", exact: true });
      expect((await devices.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await devices.tap();
      await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
      const revoke = page.getByRole("table", { name: "Devices", exact: true }).getByRole("button").first();
      expect((await revoke.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await revoke.tap();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).tap();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
    }
  });
}

test("a page outside ub open has no account reading or generated account name", async ({ browser }) => {
  let accountRequests = 0;
  const page = await openApp(browser, "/", {
    upstream: true,
    readySelector: ".ub-document-sidebar",
    beforeNavigate: async (opening) => {
      opening.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/account") accountRequests += 1;
      });
    },
  });
  await expect(account(page)).toContainText("Account unavailable");
  await account(page).click();
  await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
  const presence = await page.getByRole("textbox", { name: "Presence name", exact: true }).inputValue();
  await expect(account(page)).not.toContainText(presence);
  expect(accountRequests).toBe(0);
});

test("live serving refusal hides a stored handle until the hub accepts the serving run again", async ({ browser }) => {
  let reason: "sign-in-required" | "no-workspace-access" | null = null;
  const page = await openApp(browser, "/", {
    readySelector: ".ub-document-sidebar",
    beforeNavigate: async (opening) => {
      await opening.route("**/api/status", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.notSharedReason = reason;
        await route.fulfill({ response, json: body });
      });
    },
  });
  await createDoc(page, docTitle("account-refusal"));
  await expect(account(page)).toContainText(`@${handle}`);
  for (const refused of ["sign-in-required", "no-workspace-access"] as const) {
    reason = refused;
    await expect(account(page)).toContainText("Account unavailable");
    await expect(account(page)).not.toContainText(handle);
    reason = null;
    await expect(account(page)).toContainText(`@${handle}`);
  }
});

test("the same ub open follows login removal and return for its frozen hub after a project rebind", async ({ browser }) => {
  const page = await openApp(browser, "/", { readySelector: ".ub-document-sidebar" });
  await expect(account(page)).toContainText(`@${handle}`);
  const instance = await page.evaluate(() => performance.timeOrigin);
  const unauthenticated = await page.request.get(new URL("/api/account", harness().appUrl).href);
  expect(unauthenticated.status()).toBe(401);
  const reading = await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/account");
  expect(await reading.json()).toEqual({ state: "signed-in", handle });
  try {
    harness().rebindProject("ws://127.0.0.1:1");
    harness().setStoredLogin(false);
    await expect(account(page)).toContainText("Not signed in");
    await expect(account(page)).not.toContainText(handle);
    harness().setStoredLogin(true);
    await expect(account(page)).toContainText(`@${handle}`);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(instance);
  } finally {
    harness().setStoredLogin(true);
    harness().rebindProject(harness().hubUrl);
  }
});
