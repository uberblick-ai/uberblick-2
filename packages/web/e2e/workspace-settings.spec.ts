/** General settings at desktop and iPad widths through native input. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { activateControl, createDoc, setupHarness } from "./app-helpers.js";
import { waitForAcknowledged } from "./settle.js";

const { harness, openApp } = setupHarness({ accessRole: "admin" });

function value(page: Page, label: string): Locator {
  return page.locator("[data-settings-facts] > div").filter({
    has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }),
  }).locator("dd");
}

function notice(page: Page, message: string): Locator {
  return page.locator("[data-sonner-toast]:not([data-removed=true])").filter({
    has: page.locator("[data-title]", { hasText: message }),
  });
}

test.beforeAll(async ({ browser }) => {
  const page = await openApp(browser, "/", {
    contextOptions: { viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false },
  });
  await createDoc(page, "General settings browser proof");
  await waitForAcknowledged(page, { path: "relay" });
  await page.context().close();
});

for (const touch of [false, true]) {
  test(`General keeps its sections and native controls on ${touch ? "iPad touch" : "desktop keyboard and pointer"} in both appearances`,
    { tag: touch ? "@webkit-touch" : [] }, async ({ browser }, info) => {
      const path = `/${harness().workspace}/settings`;
      const page = await openApp(browser, path, {
        contextOptions: {
          ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false }),
          colorScheme: "light", reducedMotion: "reduce",
        },
        readySelector: "[data-settings-page]",
        beforeNavigate: async (target) => { await target.addInitScript(() => {
          const state = window as unknown as { workspaceCopies: string[]; workspaceCopyFails: boolean };
          state.workspaceCopies = [];
          state.workspaceCopyFails = false;
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: async (text: string) => {
              if (state.workspaceCopyFails) throw new Error("Clipboard refused");
              state.workspaceCopies.push(text);
            } },
          });
          const execCommand = document.execCommand.bind(document);
          document.execCommand = (command, ...args) => command === "copy" ? false : execCommand(command, ...args);
        }); },
      });
      const pane = page.locator("[data-settings-page]");
      const name = pane.getByLabel("Name", { exact: true });
      const details = pane.getByRole("button", { name: "Connection details", exact: true });
      const copy = pane.getByRole("button", { name: "Copy workspace ID", exact: true });
      await expect(name).toBeEnabled();
      await expect(name).toHaveAccessibleDescription("Shown in the sidebar header and the workspace menu.");
      await expect(pane.getByRole("heading", { level: 2 })).toHaveText([
        "Where it lives", "About this workspace", "Connection details",
      ]);
      await expect(pane.locator('[class~="bg-card"], [data-slot="card"]')).toHaveCount(0);
      await expect(pane.locator('button[data-variant="default"]')).toHaveText("Save");
      await expect(pane.getByLabel("Main repository", { exact: true })).toBeVisible();
      await expect(pane.getByRole("button", { name: "Save main repository", exact: true })).toHaveAttribute("data-variant", "outline");
      await expect(pane.getByText("Use 1–64 characters", { exact: false })).toHaveCount(0);
      await expect(value(page, "Hub")).toHaveText(new URL(harness().hubUrl).host);
      await expect(value(page, "Workspace ID").locator("span > span")).toHaveText(harness().workspaceUuid);
      await expect(value(page, "Documents")).toHaveText("1");
      await expect(value(page, "Tags")).toHaveText(/^\d+$/);
      await expect(value(page, "Last edited")).not.toHaveText("—");
      await expect(value(page, "Last edited").locator("time")).toHaveAttribute("title", /.+/);
      await expect(details).toHaveAttribute("aria-expanded", "false");
      await expect(value(page, "Address segment")).toBeHidden();
      await expect(pane).not.toContainText(/wss?:\/\//);

      if (touch) await details.tap();
      else {
        await details.focus();
        await page.keyboard.press("Enter");
      }
      await expect(details).toHaveAttribute("aria-expanded", "true");
      await expect(value(page, "Address segment")).toHaveText(harness().workspace);
      for (const label of ["Source", "Connection", "MCP connections"]) await expect(value(page, label)).toBeVisible();
      await activateControl(details, { touch });
      await expect(details).toHaveAttribute("aria-expanded", "false");
      if (!touch) {
        await details.focus();
        await page.keyboard.press("Space");
        await expect(details).toHaveAttribute("aria-expanded", "true");
      } else await details.tap();

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(colorScheme === "dark");
        for (const width of touch ? [810, 600] : [1440]) {
          await page.setViewportSize({ width, height: 1100 });
          await page.evaluate(() => document.fonts.ready);
          await expect(pane.getByRole("heading", { level: 2 }).first()).toHaveCSS("font-size", "22px");
          await expect(pane.getByRole("heading", { level: 2 }).first()).toHaveCSS("line-height", "28px");
          const geometry = await pane.evaluate((element) => ({
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
            paneOverflow: element.scrollWidth - element.clientWidth,
            rowsOverflowing: [...element.querySelectorAll<HTMLElement>("[data-settings-facts] > div")]
              .filter((row) => row.offsetHeight > 0 && row.scrollWidth > row.clientWidth + 1).map((row) => row.textContent),
            shortControls: [...element.querySelectorAll<HTMLElement>("button, input")]
              .filter((control) => control.offsetHeight > 0 && control.getBoundingClientRect().height < 44).map((control) => control.textContent),
          }));
          expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
          expect(geometry.paneOverflow).toBeLessThanOrEqual(1);
          expect(geometry.rowsOverflowing).toEqual([]);
          if (touch) expect(geometry.shortControls).toEqual([]);
          await page.screenshot({ path: info.outputPath(`general-${width}-${colorScheme}.png`) });
          await info.attach(`General ${width} ${colorScheme}`, {
            path: info.outputPath(`general-${width}-${colorScheme}.png`), contentType: "image/png",
          });
        }
      }

      if (touch) await copy.tap();
      else {
        await copy.focus();
        await page.keyboard.press("Enter");
      }
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(colorScheme === "dark");
        await expect(notice(page, "Workspace ID copied")).toHaveAttribute("data-type", "success");
      }
      expect(await page.evaluate(() => (window as unknown as { workspaceCopies: string[] }).workspaceCopies))
        .toEqual([harness().workspaceUuid]);
      await page.evaluate(() => { (window as unknown as { workspaceCopyFails: boolean }).workspaceCopyFails = true; });
      await page.clock.install();
      await activateControl(copy, { touch });
      const failure = notice(page, "Couldn't copy the workspace ID. Try again in a browser with clipboard access.");
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(colorScheme === "dark");
        await expect(failure).toHaveAttribute("data-type", "error");
      }
      await page.clock.runFor(10_000);
      await expect(failure).toHaveCount(0);
      await page.goto(new URL(path, harness().appUrl).href);
      await expect(page.getByRole("button", { name: "Connection details", exact: true })).toHaveAttribute("aria-expanded", "false");
    });
}
