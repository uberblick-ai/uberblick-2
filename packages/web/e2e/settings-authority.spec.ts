import { expect, test } from "@playwright/test";
import { setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness({ accessRole: "admin" });

test("a confirmed admin edits settings offline and keeps access after reloading", async ({ browser }) => {
  const page = await openApp(browser, `/${harness().workspace}/settings`);
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeEnabled();
  await harness().stopHub();
  try {
    const offlineRole = page.waitForResponse(async (response) => response.url().endsWith("/api/access") &&
      response.request().postDataJSON()?.operation === "own-role" && (await response.json()).status === "hub-down");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await offlineRole;
    await expect(name).toBeEnabled();
    await name.fill("Offline admin name");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("textbox", { name: "Main repository", exact: true }).fill("Owner/Offline");
    await page.getByRole("button", { name: "Save main repository", exact: true }).click();
    await page.reload();
    await expect(name).toBeEnabled();
    await expect(name).toHaveValue("Offline admin name");
    await expect(page.getByRole("textbox", { name: "Main repository", exact: true })).toHaveValue("Owner/Offline");
    await page.getByRole("navigation", { name: "Workspace settings", exact: true }).getByRole("button", { name: "Tags", exact: true }).click();
    const tag = page.getByRole("textbox", { name: "Name", exact: true });
    await expect(tag).toBeEnabled();
    await tag.fill("offline-admin");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete offline-admin", exact: true })).toBeVisible();
    await expect(page.locator("[data-tag-list] tbody tr")).toHaveCount(1);
  } finally {
    await harness().startHub();
  }
  await expect.poll(() => harness().hubWorkspaceSettings()).toEqual({
    name: "Offline admin name", mainRepository: "Owner/Offline", tags: ["offline-admin"],
  });
});

test("a refused settings edit rebuilds the browser room and reports the discarded change once", async ({ browser }) => {
  let sockets = 0;
  const page = await openApp(browser, `/${harness().workspace}/settings`, {
    beforeNavigate: async (opening) => {
      opening.on("websocket", () => { sockets += 1; });
      await opening.route("**/api/access", (route) => {
        const action = route.request().postDataJSON() as { operation: string };
        return action.operation === "own-role"
          ? route.fulfill({ json: { status: "ok", role: "admin", hub: harness().hubUrl } }) : route.continue();
      });
    },
  });
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeEnabled();
  const original = await name.inputValue();
  harness().changeCurrentWorkspaceRole("member");
  try {
    await name.fill("Refused browser name");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(name).toHaveValue(original);
    await expect(name).toBeEnabled();
    await expect(page.getByText(/refused changes to workspace name/i)).toHaveCount(1);
    expect(sockets).toBe(1);
  } finally {
    harness().changeCurrentWorkspaceRole("admin");
  }
});

test("settings refusals report after a serving restart and again in the same open tab", async ({ browser }) => {
  const page = await openApp(browser, `/${harness().workspace}/settings`);
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  const repository = page.getByRole("textbox", { name: "Main repository", exact: true });
  await expect(name).toBeEnabled();
  const originalName = await name.inputValue();
  const originalRepository = await repository.inputValue();
  const originalHub = harness().hubWorkspaceSettings();
  expect(originalHub).not.toBeNull();
  const initialResetSeq = harness().localSettingsReset()?.seq ?? 0;
  await harness().stopHub();
  try {
    const offlineRole = page.waitForResponse(async (response) => response.url().endsWith("/api/access") &&
      response.request().postDataJSON()?.operation === "own-role" && (await response.json()).status === "hub-down");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await offlineRole;
    await name.fill("Refused while no tab was open");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await repository.fill("Owner/RefusedOffline");
    await page.getByRole("button", { name: "Save main repository", exact: true }).click();
    await page.reload();
    await expect(name).toHaveValue("Refused while no tab was open");
    await expect(repository).toHaveValue("Owner/RefusedOffline");
    await page.context().close();

    await harness().stopOpen();
    await harness().startHub();
    harness().changeCurrentWorkspaceRole("member");
    await harness().restartOpen({ authenticated: true });
    await expect.poll(() => harness().localSettingsReset()?.seq ?? 0).toBeGreaterThan(initialResetSeq);
    await harness().restartOpen({ authenticated: true });

    // Keep a cached admin view while the hub enforces the current member role.
    const later = await openApp(browser, `/${harness().workspace}/settings`, {
      beforeNavigate: async (opening) => {
        await opening.route("**/api/access", (route) => {
          const action = route.request().postDataJSON() as { operation: string };
          return action.operation === "own-role"
            ? route.fulfill({ json: { status: "ok", role: "admin", hub: harness().hubUrl } }) : route.continue();
        });
      },
    });
    const refusal = later.getByText(/refused changes to workspace name, main repository/i);
    const laterRepository = later.getByRole("textbox", { name: "Main repository", exact: true });
    await expect(laterRepository).toBeEnabled();
    await expect(refusal).toHaveCount(1);
    await expect.poll(() => harness().hubWorkspaceSettings()).toEqual(originalHub);

    await laterRepository.fill("Owner/RefusedAgain");
    await later.getByRole("button", { name: "Save main repository", exact: true }).click();
    await expect(laterRepository).toHaveValue(originalRepository);
    const secondRefusal = later.getByText(/refused changes to main repository/i);
    await expect(secondRefusal).toHaveCount(1);
    await expect(refusal).toHaveCount(0);
    await expect.poll(() => harness().hubWorkspaceSettings()).toEqual(originalHub);

    await later.unroute("**/api/access");
    await later.reload();
    await expect(later.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(later.getByRole("heading", { level: 2 })).toHaveText(["On this computer"]);
    await expect(later.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
    await expect(later.getByRole("textbox", { name: "Main repository", exact: true })).toHaveCount(0);
    await expect(refusal).toHaveCount(0);
    await expect(secondRefusal).toHaveCount(0);

    harness().changeCurrentWorkspaceRole("admin");
    await later.goto(new URL(`/${harness().workspace}/settings`, harness().appUrl).href);
    await expect(later.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(originalName);
    await expect(later.getByRole("textbox", { name: "Main repository", exact: true })).toHaveValue(originalRepository);
    await expect(refusal).toHaveCount(0);
    await expect(secondRefusal).toHaveCount(0);
  } finally {
    await harness().startHub();
    harness().changeCurrentWorkspaceRole("admin");
  }
});
