/** Browser proof for the spike's actual transition and retained hidden panel. */
import { expect, test } from "@playwright/test";
import { startHarness } from "./harness.js";

test("offcanvas motion keeps content mounted and clears keyboard access", async ({ browser }) => {
  const running = await startHarness();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: test.info().outputPath("videos"), size: { width: 1280, height: 800 } },
  });
  try {
    const page = await context.newPage();
    await page.goto(running.appUrl);
    await expect(page.locator(".ub-list-head")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("sidebar-after-desktop.png") });
    const panel = page.locator(".ub-list");
    const samples = await page.evaluate(async () => {
      const sidebar = document.querySelector<HTMLElement>(".ub-list");
      const pane = document.querySelector<HTMLElement>(".ub-pane");
      const hide = document.querySelector<HTMLButtonElement>(".ub-sidebar-hide");
      if (!sidebar || !pane || !hide) throw new Error("No frame");
      const read = () => ({ panel: sidebar.getBoundingClientRect().left, pane: pane.getBoundingClientRect().left });
      const result = [read()];
      hide.click();
      const start = performance.now();
      while (performance.now() - start < 250) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        result.push(read());
      }
      return result;
    });
    expect(samples[0]?.panel).toBe(0);
    expect(samples.at(-1)?.panel).toBe(-288);
    expect(samples.at(-1)?.pane).toBe(0);
    expect(samples.some(({ panel, pane }) => panel < 0 && panel > -288 && pane > 0 && pane < 288)).toBe(true);
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute("inert", "");
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("button", { name: "Show document list" })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("sidebar-after-collapsed.png") });
    await page.getByRole("button", { name: "Show document list" }).click();
    await expect(page.getByRole("button", { name: "Hide document list" })).toBeFocused();
    await expect.poll(async () => (await panel.boundingBox())?.x).toBe(0);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: test.info().outputPath("sidebar-after-dark.png") });
    await page.setViewportSize({ width: 420, height: 720 });
    await page.screenshot({ path: test.info().outputPath("sidebar-after-mobile.png") });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(panel).toHaveCSS("transition-property", "none");
  } finally {
    await context.close();
    await running.stop();
  }
});
