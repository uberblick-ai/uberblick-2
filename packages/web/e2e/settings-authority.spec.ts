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
    await page.getByRole("navigation", { name: "Settings", exact: true }).getByRole("button", { name: "Tags", exact: true }).click();
    const tag = page.getByRole("textbox", { name: "Create a tag", exact: true });
    await expect(tag).toBeEnabled();
    await tag.fill("offline-admin");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retire offline-admin", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Active", exact: true }).getByRole("listitem")).toHaveCount(1);
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
    await expect(page.getByText(/workspace name.*refused/i)).toHaveCount(1);
    expect(sockets).toBe(1);
  } finally {
    harness().changeCurrentWorkspaceRole("admin");
  }
});
