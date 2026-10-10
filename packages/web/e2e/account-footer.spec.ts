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
  test(`the standard account footer keeps inert account settings and usable preferences — ${scheme}`, { tag: "@webkit" }, async ({ browser }, info) => {
    test.skip(info.project.name === "webkit-iphone", "The paired explicit iPad context owns touch coverage.");
    const page = await openApp(browser, "/", {
      contextOptions: { hasTouch: false, isMobile: false, viewport: { width: 1280, height: 832 }, colorScheme: scheme, reducedMotion: "reduce" },
      readySelector: ".ub-list-head",
    });
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 832 });
      for (const mode of ["documents", "settings"] as const) {
        const settings = mode === "settings";
        await showSidebar(page, settings);
        if (settings) {
          await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
          await showSidebar(page, true);
        }
        await expect(page.locator(".ub-list")).toHaveAttribute("data-mode", mode);
        await expect(account(page)).toHaveCount(1);
        await expect(account(page)).toContainText(`@${handle}`);
        const footer = page.locator('[data-slot="sidebar-footer"]');
        await expect(footer).toHaveCount(1);
        await expect(footer.locator('[data-slot="sidebar-menu"] > [data-slot="sidebar-menu-item"] [data-sidebar="menu-button"]'))
          .toHaveCount(1);
        const settingsEntry = footer.getByRole("button", { name: "Workspace settings", exact: true });
        await expect(settingsEntry).toBeInViewport({ ratio: 1 });
        await expect(account(page)).toBeInViewport({ ratio: 1 });
        const placeholder = footer.getByText("Account settings", { exact: true });
        expect(await placeholder.evaluate((element) => ({
          interactive: element.closest('button, a, [role="button"], [role="link"]') !== null,
          explicitTabIndex: element.hasAttribute("tabindex"),
          tabIndex: (element as HTMLElement).tabIndex,
        }))).toEqual({ interactive: false, explicitTabIndex: false, tabIndex: -1 });
        const url = page.url();
        const pages = page.context().pages().length;
        await placeholder.click();
        expect(page.url()).toBe(url);
        expect(page.context().pages()).toHaveLength(pages);
        await expect(page.locator(".ub-user-panel")).toHaveCount(0);

        // A real pointer opens the existing controls, then native keyboard
        // activation opens them again and restores focus to the same identity.
        await account(page).click();
        const panel = page.locator(".ub-user-panel");
        await expect(panel.getByRole("group", { name: "Presence colour" })).toBeVisible();
        await expect(panel.getByRole("group", { name: "Appearance" })).toBeVisible();
        await expect(panel.getByText("MCP connections", { exact: true })).toBeVisible();
        const name = panel.getByRole("textbox", { name: "Presence name", exact: true });
        await expect(name).toHaveValue(/\S/);
        await expect(account(page)).not.toContainText(await name.inputValue());
        await page.keyboard.press("Escape");
        await expect(account(page)).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(panel).toBeVisible();
        // The name uses the native form's Enter submission and remains
        // separate from the verified account in both sidebar modes.
        await name.fill(`Presence ${scheme} ${width} ${mode}`);
        await name.press("Enter");
        await page.keyboard.press("Escape");
        await expect(account(page)).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(name).toHaveValue(`Presence ${scheme} ${width} ${mode}`);
        await expect(account(page)).toContainText(`@${handle}`);
        const swatch = panel.getByRole("group", { name: "Presence colour" }).getByRole("button").first();
        await swatch.focus();
        await page.keyboard.press("Space");
        await expect(swatch).toHaveAttribute("aria-pressed", "true");
        const appearance = panel.getByRole("group", { name: "Appearance" }).getByRole("button", {
          name: scheme === "light" ? "Light" : "Dark", exact: true,
        });
        await appearance.focus();
        await page.keyboard.press("Enter");
        await expect(appearance).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.press("Escape");
        await expect(account(page)).toBeFocused();
        if (settings) {
          await page.getByRole("button", { name: /^Back to / }).click();
          await showSidebar(page);
        }
      }
    }
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`the presence name form saves through iPad touch — ${scheme}`, { tag: "@webkit-touch" }, async ({ browser }) => {
    const page = await openApp(browser, "/", {
      contextOptions: { ...devices["iPad Pro 11"], colorScheme: scheme, reducedMotion: "reduce" },
      readySelector: ".ub-body",
    });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.getByRole("button", { name: "Show document list", exact: true }).tap();
    await account(page).tap();
    const name = page.getByRole("textbox", { name: "Presence name", exact: true });
    const save = page.getByRole("button", { name: "Save name", exact: true });
    await expect(name).toBeInViewport({ ratio: 1 });
    await expect(save).toBeInViewport({ ratio: 1 });
    await name.tap();
    await expect(name).toBeFocused();
    await name.fill(`iPad ${scheme}`);
    await save.tap();
    await account(page).tap();
    await expect(name).toHaveCount(0);
    await account(page).tap();
    await expect(name).toHaveValue(`iPad ${scheme}`);
    await expect(account(page)).toContainText(`@${handle}`);
  });
}

test("failed, missing and malformed account answers clear the last verified handle", async ({ browser }) => {
  let reply: unknown = { state: "signed-in", handle: "confirmed-person" };
  let failure: "abort" | "missing" | null = null;
  const page = await openApp(browser, "/", {
    readySelector: ".ub-list-head",
    beforeNavigate: async (opening) => {
      await opening.route("**/api/account", async (route) => {
        if (failure === "abort") await route.abort();
        else if (failure === "missing") await route.fulfill({ status: 404, body: "" });
        else await route.fulfill({ json: reply });
      });
    },
  });
  await expect(account(page)).toContainText("@confirmed-person");
  for (const malformed of [{}, { state: "signed-in" }, { state: "signed-in", handle: "bad handle" }]) {
    reply = malformed;
    await expect(account(page)).toContainText("Account unavailable");
    await expect(account(page)).not.toContainText("confirmed-person");
    reply = { state: "signed-in", handle: "confirmed-person" };
    await expect(account(page)).toContainText("@confirmed-person");
  }
  for (const failed of ["abort", "missing"] as const) {
    failure = failed;
    await expect(account(page)).toContainText("Account unavailable");
    await expect(account(page)).not.toContainText("confirmed-person");
    failure = null;
    await expect(account(page)).toContainText("@confirmed-person");
  }
  reply = { state: "signed-out", handle: "unverified-person" };
  await expect(account(page)).toContainText("Not signed in");
  await expect(account(page)).not.toContainText("unverified-person");
});

test("a page outside ub open has no account reading or generated account name", async ({ browser }) => {
  let accountRequests = 0;
  const page = await openApp(browser, "/", {
    upstream: true,
    readySelector: ".ub-list-head",
    beforeNavigate: async (opening) => {
      opening.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/account") accountRequests += 1;
      });
    },
  });
  await expect(account(page)).toContainText("Account unavailable");
  await account(page).click();
  const presence = await page.getByRole("textbox", { name: "Presence name", exact: true }).inputValue();
  await expect(account(page)).not.toContainText(presence);
  await page.keyboard.press("Escape");
  expect(accountRequests).toBe(0);
});

test("live serving refusal hides a stored handle until the hub accepts the serving run again", async ({ browser }) => {
  let reason: "sign-in-required" | "no-workspace-access" | null = null;
  const page = await openApp(browser, "/", {
    readySelector: ".ub-list-head",
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
  const page = await openApp(browser, "/", { readySelector: ".ub-list-head" });
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
