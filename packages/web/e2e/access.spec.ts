/** Access controls use the real local bridge and a device-admitted hub. */
import { expect, test } from "@playwright/test";
import { setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness({ accessRole: "admin", scope: "test" });

test("confirm a GitHub account, manage membership, and revoke only your devices", async ({ browser }) => {
  test.setTimeout(120_000);
  const access = harness().access;
  if (access === undefined) throw new Error("Access fixture is missing");
  const page = await openApp(browser, `/${harness().workspace}/settings`);
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
  const members = page.getByRole("table", { name: "Members", exact: true });
  const devices = page.getByRole("table", { name: "Your devices", exact: true });
  await expect(members.getByText("browser-person", { exact: true })).toBeVisible();
  await expect(devices.getByText("This computer", { exact: true })).toBeVisible();
  await expect(devices.getByRole("rowheader").filter({ hasText: access.deviceName })).toHaveCount(2);
  await expect(devices.getByText(access.otherDeviceId, { exact: true })).toHaveCount(0);
  await expect(devices.getByText(access.legacyDeviceId, { exact: true })).toBeVisible();
  await expect(devices.getByText(access.foreignDeviceId, { exact: true })).toHaveCount(0);
  await expect(devices.getByText("private-foreign-device", { exact: true })).toHaveCount(0);
  for (const button of await devices.getByRole("button").all()) await expect(button).toHaveText("Revoke device");

  for (const handle of ["@octocat", "https://github.com/octocat", "octo cat"]) {
    await page.getByLabel("GitHub account", { exact: true }).fill(handle);
    await page.getByRole("button", { name: "Look up account", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Enter a GitHub handle, without @, a link or spaces.");
    await expect(members.getByText("browser-person", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm and add account", exact: true })).toHaveCount(0);
  }

  await page.getByLabel("GitHub account", { exact: true }).fill("missing-user");
  await page.getByRole("button", { name: "Look up account", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No such GitHub account");
  await page.getByLabel("GitHub account", { exact: true }).fill("rate-limited");
  await page.getByRole("button", { name: "Look up account", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/lookup.*unavailable/i);
  await expect(members.getByText("new-agent", { exact: true })).toHaveCount(0);

  await page.getByLabel("GitHub account", { exact: true }).fill("new-agent");
  await page.getByRole("button", { name: "Look up account", exact: true }).click();
  await expect(page.getByText("new-agent (GitHub account 9001)", { exact: true })).toBeVisible();
  await expect(members.getByText("new-agent", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Role for new account", { exact: true })).toHaveValue("member");
  await page.getByRole("button", { name: "Confirm and add account", exact: true }).click();
  await expect(members.getByText("new-agent", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Role for new-agent", { exact: true })).toHaveValue("member");
  await page.getByLabel("Role for new-agent", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Save role for new-agent", exact: true }).click();
  await expect(page.getByText("new-agent's role changed to admin.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Role for new-agent", { exact: true })).toHaveValue("admin");
  await page.getByLabel("GitHub account", { exact: true }).fill("new-agent");
  await page.getByRole("button", { name: "Look up account", exact: true }).click();
  await expect(page.getByText("Already a member as admin.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm and add account", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove new-agent", exact: true }).click();
  const remove = page.getByRole("alertdialog", { name: "Remove new-agent?", exact: true });
  await expect(remove).toContainText(/every device/);
  await expect(remove).toContainText(/Documents already downloaded stay/);
  await remove.getByRole("button", { name: "Remove member", exact: true }).click();
  await expect(members.getByText("new-agent", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Remove other-admin", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Remove other-admin?", exact: true })
    .getByRole("button", { name: "Remove member", exact: true }).click();
  await expect(members.getByText("other-admin", { exact: true })).toHaveCount(0);
  await page.getByLabel("Role for browser-person", { exact: true }).selectOption("member");
  await page.getByRole("button", { name: "Save role for browser-person", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("last admin");
  await expect(page.getByLabel("Role for browser-person", { exact: true })).toHaveValue("admin");

  const otherDevice = access.otherDeviceId;
  const otherTrigger = page.getByRole("button", { name: `Revoke device ${otherDevice}`, exact: true });
  await expect(otherTrigger).toHaveText("Revoke device");
  await otherTrigger.click();
  const revoke = page.getByRole("alertdialog", { name: "Revoke device?", exact: true });
  await expect(revoke).toContainText(/one device of yours/);
  await expect(revoke).toContainText(/Documents already downloaded stay/);
  await revoke.getByRole("button", { name: "Revoke device", exact: true }).click();
  await expect(otherTrigger).toHaveCount(0);
  await expect(devices.getByRole("rowheader").filter({ hasText: access.deviceName })).toHaveCount(1);
  await expect(devices.getByText(access.legacyDeviceId, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Revoke device ${access.legacyDeviceId}`, exact: true }).click();
  await page.getByRole("alertdialog", { name: "Revoke device?", exact: true })
    .getByRole("button", { name: "Revoke device", exact: true }).click();
  await expect(devices.getByText(access.legacyDeviceId, { exact: true })).toHaveCount(0);

  // The current-device acknowledgement survives the refused follow-up reads.
  const current = devices.getByRole("row").filter({ hasText: "This computer" });
  await current.getByRole("button").click();
  const currentRevoke = page.getByRole("alertdialog", { name: "Revoke this computer?", exact: true });
  await expect(currentRevoke).toContainText(/ub auth login/);
  await currentRevoke.getByRole("button", { name: "Revoke device", exact: true }).click();
  await expect(page.getByText(/sync with the hub stops/i)).toBeVisible();
  await expect(page.getByText(/Sign-in is required/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm and add account", exact: true })).toHaveCount(0);
});

test("a lost hub offers no management and refresh reads the hub again", async ({ browser }) => {
  const page = await openApp(browser, `/${harness().workspace}/settings/access`);
  await expect(page.getByRole("table", { name: "Members", exact: true })).toBeVisible();
  await harness().stopHub();
  await page.reload();
  await expect(page.getByText(/hub cannot be reached/i).first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Members", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Look up account", exact: true })).toHaveCount(0);
  await harness().startHub();
  await page.reload();
  await expect(page.getByRole("table", { name: "Members", exact: true })).toBeVisible();
});
