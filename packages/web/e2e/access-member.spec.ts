import { expect, test } from "@playwright/test";
import { setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness({ accessRole: "member" });

test("a member has their role and own devices with no membership controls", async ({ browser }) => {
  const access = harness().access;
  if (access === undefined) throw new Error("Access fixture is missing");
  const page = await openApp(browser, `/${harness().workspace}/settings/access`);
  await expect(page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
  await expect(page.getByText(/Your role: member/)).toBeVisible();
  await expect(page.getByRole("table", { name: "Members", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Look up account", exact: true })).toHaveCount(0);
  const devices = page.getByRole("table", { name: "Your devices", exact: true });
  await expect(devices.getByText("This computer", { exact: true })).toBeVisible();
  await expect(devices.getByText(access.otherDeviceId, { exact: true })).toBeVisible();
  await expect(devices.getByText(access.foreignDeviceId, { exact: true })).toHaveCount(0);
  await expect(devices.getByRole("columnheader", { name: /Signed in/ })).toBeVisible();
  await page.getByRole("button", { name: `Revoke device ${access.otherDeviceId}`, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Revoke device?", exact: true });
  await expect(dialog).toContainText("This one device of yours loses access to this hub.");
  await expect(dialog).toContainText("Documents already downloaded stay where they are.");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(devices.getByText(access.otherDeviceId, { exact: true })).toBeVisible();
});
