/** Hosted grants travel from consent state through the real local management bridge. */
import { expect, test } from "@playwright/test";
import { activateControl, setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness({ accessRole: "member", scope: "test" });

test("an unused hosted grant is readable in both appearances and revocable with native input", { tag: "@webkit" }, async ({ browser }, info) => {
  const deviceId = harness().createAgentGrant("Hosted research agent", "read-only");
  const touch = info.project.use.hasTouch === true;
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await openApp(browser, `/${harness().workspace}/settings/devices`, {
      contextOptions: { colorScheme, reducedMotion: "reduce", viewport: { width: touch ? 810 : 1440, height: 1080 } },
    });
    const table = page.getByRole("table", { name: "Devices", exact: true });
    await expect(table.getByRole("columnheader")).toHaveText(["Device", "Signed in", "Revoke"]);
    const row = table.getByRole("row").filter({ hasText: "Hosted research agent" });
    await expect(row.getByRole("rowheader")).toHaveText(`Hosted research agent Hosted Unnamed workspace ${harness().workspaceUuid.slice(0, 8)} Read only`);
    await expect(row.locator("time")).toHaveText(/just now|ago/);
    await page.evaluate(() => document.fonts.ready);
    const header = row.getByRole("rowheader");
    const geometry = await header.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll("span"), child => {
        const rect = child.getBoundingClientRect();
        return { contained: rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom };
      });
    });
    expect(geometry.every(label => label.contained)).toBe(true);
    const trigger = row.getByRole("button", { name: `Revoke Hosted research agent (${deviceId})`, exact: true });
    await expect(trigger).toBeVisible();
    if (colorScheme === "light") { await page.context().close(); continue; }
    if (touch) await activateControl(trigger);
    else { await trigger.focus(); await page.keyboard.press("Enter"); }
    const dialog = page.getByRole("alertdialog", { name: "Revoke Hosted research agent?", exact: true });
    await expect(dialog).toContainText("This hosted agent loses access to its workspace");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    if (touch) await activateControl(dialog.getByRole("button", { name: "Cancel", exact: true }));
    else await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    if (touch) await activateControl(trigger);
    else await page.keyboard.press("Enter");
    const confirm = dialog.getByRole("button", { name: "Revoke", exact: true });
    if (touch) await activateControl(confirm);
    else { await page.keyboard.press("Tab"); await expect(confirm).toBeFocused(); await page.keyboard.press("Enter"); }
    await expect(page.getByText("Hosted access revoked. Documents already downloaded stay where they are.", { exact: true })).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(table.getByText("This computer", { exact: true })).toBeVisible();
    await page.reload();
    await expect(table.getByText("This computer", { exact: true })).toBeVisible();
    await expect(table.getByText("Hosted research agent", { exact: true })).toHaveCount(0);
  }
});
