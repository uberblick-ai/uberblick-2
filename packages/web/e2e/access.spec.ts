/** Access controls use the real local bridge and a device-admitted hub. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page, Route } from "@playwright/test";
import { setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness({ accessRole: "admin", scope: "test" });

function roleToast(page: Page): Locator {
  return page.locator("[data-sonner-toast]:not([data-removed=true])").filter({
    has: page.locator("[data-title]", { hasText: /^Role changed$/ }),
  });
}

test("confirm a GitHub account, manage membership, and revoke only your devices", async ({ browser }) => {
  const access = harness().access;
  if (access === undefined) throw new Error("Access fixture is missing");
  const page = await openApp(browser, `/${harness().workspace}/settings`);
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Members", exact: true })).toBeVisible();
  await expect(page.getByText("You are an admin of this workspace.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add a member", level: 2, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workspace access", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Refresh/ })).toHaveCount(0);
  const members = page.getByRole("table", { name: "Members", exact: true });
  await expect(members.getByRole("rowheader").filter({ hasText: "browser-person" })).toBeVisible();
  await expect(members.getByRole("row").filter({ hasText: "browser-person" }).getByText("you", { exact: true })).toBeVisible();
  await expect(members.getByRole("columnheader")).toHaveText(["Account", "Role", "Actions"]);
  await expect(page.getByRole("table", { name: "Devices", exact: true })).toHaveCount(0);

  for (const handle of ["@octocat", "https://github.com/octocat", "octo cat"]) {
    await page.getByLabel("GitHub handle", { exact: true }).fill(handle);
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Enter a GitHub handle, without @, a link or spaces.");
    await expect(members.getByRole("rowheader").filter({ hasText: "browser-person" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add as member", exact: true })).toHaveCount(0);
  }

  await page.getByLabel("GitHub handle", { exact: true }).fill("missing-user");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No such GitHub account");
  await page.getByLabel("GitHub handle", { exact: true }).fill("rate-limited");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/lookup.*unavailable/i);
  await expect(members.getByText("new-agent", { exact: true })).toHaveCount(0);

  await page.getByLabel("GitHub handle", { exact: true }).fill("new-agent");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.getByText("new-agent · GitHub account 9001", { exact: true })).toBeVisible();
  await expect(members.getByText("new-agent", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Role for new account", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add as member", exact: true }).click();
  await expect(page.locator('table[aria-label="Members"]').getByText("new-agent", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Role for new-agent", { exact: true })).toHaveValue("member");
  await page.getByLabel("Role for new-agent", { exact: true }).selectOption("admin");
  await expect(roleToast(page)).toHaveAttribute("data-type", "success");
  await expect(page.getByLabel("Role for new-agent", { exact: true })).toHaveValue("admin");
  await expect(page.getByRole("button", { name: /Save role/ })).toHaveCount(0);
  await page.getByLabel("GitHub handle", { exact: true }).fill("new-agent");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.getByText("Already a member as Admin.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add as member", exact: true })).toHaveCount(0);
  const removeNew = page.getByRole("button", { name: "Remove new-agent", exact: true });
  await expect(removeNew).toHaveText("Remove");
  await expect(removeNew).not.toHaveClass(/(?:^|\s)(?:border|bg-primary)(?:\s|$)/);
  await removeNew.click();
  const remove = page.getByRole("alertdialog", { name: "Remove new-agent?", exact: true });
  await expect(remove).toContainText(/every device/);
  await expect(remove).toContainText(/Documents already downloaded stay/);
  await expect(page.locator('table[aria-label="Members"]').getByText("new-agent", { exact: true })).toBeVisible();
  await remove.getByRole("button", { name: "Remove member", exact: true }).click();
  await expect(members.getByText("new-agent", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Remove other-admin", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Remove other-admin?", exact: true })
    .getByRole("button", { name: "Remove member", exact: true }).click();
  await expect(members.getByText("other-admin", { exact: true })).toHaveCount(0);
  await expect(roleToast(page)).toBeHidden();
  await page.getByLabel("Role for browser-person", { exact: true }).selectOption("member");
  await expect(page.getByRole("alert")).toHaveText("The hub refused this change: the last admin cannot be removed or demoted.");
  await expect(page.getByLabel("Role for browser-person", { exact: true })).toHaveValue("admin");
  await expect(roleToast(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Remove browser-person", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Remove browser-person?", exact: true })
    .getByRole("button", { name: "Remove member", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("The hub refused this change: the last admin cannot be removed or demoted.");
  await expect(members.getByRole("rowheader").filter({ hasText: "browser-person" })).toBeVisible();

  await page.getByTestId("account-menu").click();
  await page.getByRole("menuitem", { name: "Devices", exact: true }).click();
  const devices = page.getByRole("table", { name: "Devices", exact: true });
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  await expect(page.getByText(`Computers signed in to ${new URL(harness().hubUrl).host} as @browser-person. Revoking one stops its sync; its downloaded documents stay.`, { exact: true })).toBeVisible();
  await expect(devices.getByRole("columnheader")).toHaveText(["Device", "Signed in", "Revoke"]);
  await expect(devices.getByText("This computer", { exact: true })).toBeVisible();
  await expect(devices.getByRole("rowheader").filter({ hasText: access.deviceName })).toHaveCount(2);
  await expect(devices.getByText(access.legacyDeviceId.slice(0, 8), { exact: true })).toBeVisible();
  await expect(devices.getByText("Unnamed device", { exact: true })).toBeVisible();
  await expect(devices.getByText("private-foreign-device", { exact: true })).toHaveCount(0);
  await expect(devices.locator("time").first()).toHaveText(/just now|ago/);
  await expect(devices.locator("time").first()).toHaveAttribute("title", /.+/);
  const otherTrigger = devices.getByRole("button", { name: `Revoke ${access.deviceName} (${access.otherDeviceId})`, exact: true });
  await expect(otherTrigger).toHaveText("Revoke");
  await otherTrigger.click();
  const revoke = page.getByRole("alertdialog", { name: `Revoke ${access.deviceName}?`, exact: true });
  await expect(revoke).toContainText(/one device of yours/);
  await expect(revoke).toContainText(/Documents already downloaded stay/);
  await revoke.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(otherTrigger).toHaveCount(0);
  await expect(devices.getByRole("rowheader").filter({ hasText: access.deviceName })).toHaveCount(1);
  await expect(devices.getByText(access.legacyDeviceId.slice(0, 8), { exact: true })).toBeVisible();

  await devices.getByRole("button", { name: `Revoke Unnamed device (${access.legacyDeviceId})`, exact: true }).click();
  await page.getByRole("alertdialog", { name: `Revoke Unnamed device (${access.legacyDeviceId.slice(0, 8)})?`, exact: true })
    .getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(devices.getByText(access.legacyDeviceId.slice(0, 8), { exact: true })).toHaveCount(0);

  // The current-device acknowledgement survives the refused follow-up reads.
  const current = devices.getByRole("row").filter({ hasText: "This computer" });
  await current.getByRole("button").click();
  const currentRevoke = page.getByRole("alertdialog", { name: "Revoke this computer?", exact: true });
  await expect(currentRevoke).toContainText(/ub auth login/);
  await currentRevoke.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText(/sync with the hub stops/i)).toBeVisible();
  await expect(page.getByText(/Sign-in is required/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add as member", exact: true })).toHaveCount(0);
});

test("stored member logins render as text and remain manageable by principal", async ({ browser }) => {
  const username = 'private/provider <img src=x onerror="alert(1)"> & "login"';
  const principalId = harness().changeOtherMemberUsername(username);
  const page = await openApp(browser, `/${harness().workspace}/settings/members`);
  const members = page.getByRole("table", { name: "Members", exact: true });
  await expect(members.getByRole("rowheader")).toHaveCount(2);
  await expect(members.getByRole("rowheader").filter({ hasText: "browser-person" })).toBeVisible();
  const storedAccount = members.getByRole("rowheader", { name: username, exact: true });
  await expect(storedAccount).toBeVisible();
  expect(await storedAccount.textContent()).toBe(username);
  await expect(storedAccount.locator("*")).toHaveCount(0);

  const role = page.getByLabel(`Role for ${username}`, { exact: true });
  const changed = page.waitForRequest((request) => request.url().endsWith("/api/access") &&
    request.method() === "POST" && request.postDataJSON().operation === "change-role");
  await role.selectOption("member");
  expect((await changed).postDataJSON()).toEqual({
    operation: "change-role", workspaceId: harness().workspaceUuid, principalId, role: "member",
  });
  await expect(roleToast(page)).toHaveAttribute("data-type", "success");
  await expect(role).toHaveValue("member");
  await page.reload();
  await expect(members.getByRole("rowheader")).toHaveCount(2);
  await expect(role).toHaveValue("member");

  await page.getByRole("button", { name: `Remove ${username}`, exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: `Remove ${username}?`, exact: true });
  await expect(confirm.getByRole("heading")).toHaveText(`Remove ${username}?`);
  await expect(confirm.locator("img")).toHaveCount(0);
  const removed = page.waitForRequest((request) => request.url().endsWith("/api/access") &&
    request.method() === "POST" && request.postDataJSON().operation === "remove-member");
  await confirm.getByRole("button", { name: "Remove member", exact: true }).click();
  expect((await removed).postDataJSON()).toEqual({
    operation: "remove-member", workspaceId: harness().workspaceUuid, principalId,
  });
  await expect(storedAccount).toHaveCount(0);
  await expect(members.getByRole("rowheader")).toHaveCount(1);
  await expect(members.getByRole("rowheader").filter({ hasText: "browser-person" })).toBeVisible();
});

test("a lost hub refuses a role change and keeps member management unavailable on reload until authority returns", async ({ browser }) => {
  const page = await openApp(browser, `/${harness().workspace}/settings/members`);
  await expect(page.getByRole("table", { name: "Members", exact: true })).toBeVisible();
  await harness().stopHub();
  await page.getByLabel("Role for other-admin", { exact: true }).selectOption("member");
  await expect(page.getByText(/hub cannot be reached/i).first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Members", exact: true })).toHaveCount(0);
  await expect(roleToast(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  await expect(page.getByText(/hub cannot be reached/i).first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Members", exact: true })).toHaveCount(0);
  await expect(roleToast(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Look up", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Refresh/ })).toHaveCount(0);
  await harness().startHub();
  await page.goto(new URL(`/${harness().workspace}/settings/members`, harness().appUrl).href);
  await expect(page.getByRole("table", { name: "Members", exact: true })).toBeVisible();
  await expect(page.getByLabel("Role for other-admin", { exact: true })).toHaveValue("admin");
});

for (const profile of [
  { name: "desktop keyboard", touch: false, width: 1440 },
  { name: "iPad touch", touch: true, width: 810 },
  { name: "narrow iPad touch", touch: true, width: 600 },
] as const) {
  test(`member controls work with ${profile.name}`, { tag: profile.touch ? "@webkit-touch" : [] }, async ({ browser }, info) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await openApp(browser, `/${harness().workspace}/settings/members`, {
        contextOptions: {
          ...(profile.touch ? devices["iPad (gen 7)"] : { hasTouch: false, isMobile: false }),
          viewport: { width: profile.width, height: 1080 }, colorScheme, reducedMotion: "reduce",
        },
      });
      const pane = page.locator("[data-settings-page]");
      const members = page.getByRole("table", { name: "Members", exact: true });
      const handle = page.getByLabel("GitHub handle", { exact: true });
      const lookUp = page.getByRole("button", { name: "Look up", exact: true });
      const activate = async (target: Locator): Promise<void> => {
        if (profile.touch) await target.tap();
        else {
          await target.focus();
          await page.keyboard.press("Enter");
        }
      };
      await expect(handle).toBeEnabled();
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(profile.touch);
      for (const title of ["Add a member", "Members"]) {
        await expect(pane.getByRole("heading", { name: title, level: 2, exact: true }).locator("..")).not.toHaveClass(/(?:^|\s)(?:border|bg-card)(?:\s|$)/);
      }
      await expect(members.getByRole("columnheader")).toHaveText(["Account", "Role", "Actions"]);
      if (profile.touch) await handle.tap();
      else await handle.focus();
      await page.keyboard.type("new-agent");
      await activate(lookUp);
      await expect(page.getByText("new-agent · GitHub account 9001", { exact: true })).toBeVisible();
      await expect(members.getByText("new-agent", { exact: true })).toHaveCount(0);
      const add = page.getByRole("button", { name: "Add as member", exact: true });
      for (const target of [handle, lookUp, add]) {
        expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(profile.touch ? 44 : 24);
      }
      await activate(add);
      const role = page.getByLabel("Role for new-agent", { exact: true });
      const remove = page.getByRole("button", { name: "Remove new-agent", exact: true });
      await expect(role).toBeEnabled();
      await expect(role).toHaveValue("member");
      await expect(role.getByRole("option")).toHaveText(["Member", "Admin"]);
      await expect(remove).toHaveText("Remove");
      for (const target of [role, remove]) {
        const dimensions = await target.evaluate(element => ({
          name: element.getAttribute("aria-label"), classes: element.className,
          minHeight: getComputedStyle(element).minHeight, height: element.getBoundingClientRect().height,
        }));
        expect(dimensions.height, JSON.stringify(dimensions)).toBeGreaterThanOrEqual(profile.touch ? 44 : 24);
      }
      let pending: Route | undefined;
      await page.route("**/api/access", (route) => {
        const action = route.request().postDataJSON() as { operation: string };
        if (action.operation === "change-role") pending = route;
        else return route.continue();
      });
      if (profile.touch) {
        await role.tap();
        await role.selectOption("admin");
      } else {
        await role.focus();
        // Native type-ahead selects Admin without opening the platform-owned popup.
        await page.keyboard.press("a");
      }
      await expect.poll(() => pending !== undefined).toBe(true);
      await expect(role).toBeDisabled();
      await expect(role).toHaveValue("admin");
      await expect(handle).toBeDisabled();
      await expect(lookUp).toBeDisabled();
      for (const trigger of await members.getByRole("button").all()) await expect(trigger).toBeDisabled();
      if (pending === undefined) throw new Error("Role change did not reach the bridge");
      await pending.continue();
      await expect(roleToast(page)).toHaveAttribute("data-type", "success");
      await expect(role).toBeEnabled();
      await expect(role).toHaveValue("admin");
      await expect(page.getByRole("button", { name: /Save role|Refresh/ })).toHaveCount(0);
      const image = info.outputPath(`members-${profile.width}-${colorScheme}.png`);
      await page.screenshot({ path: image });
      await info.attach(`Members ${profile.name} ${colorScheme}`, { path: image, contentType: "image/png" });
      await activate(remove);
      const confirm = page.getByRole("alertdialog", { name: "Remove new-agent?", exact: true });
      await expect(page.locator('table[aria-label="Members"]').getByText("new-agent", { exact: true })).toBeVisible();
      await activate(confirm.getByRole("button", { name: "Cancel", exact: true }));
      await expect(confirm).toHaveCount(0);
      await expect(members.getByText("new-agent", { exact: true })).toBeVisible();
      await activate(remove);
      await activate(confirm.getByRole("button", { name: "Remove member", exact: true }));
      await expect(members.getByText("new-agent", { exact: true })).toHaveCount(0);
      await page.context().close();
    }
  });
}
