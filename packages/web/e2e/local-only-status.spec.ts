/** Local-only header paint and native input over the real application shell. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";
import type { McpAgent } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = harness().createMcpAgent(`uberblick-e2e-local-status-${process.env.UB_AGENTS_RUN ?? "local"}-`);
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

async function expectLocalHeader(page: Page): Promise<void> {
  await expect(page.locator(".ub-status-left")).toHaveText(/^Local-only · Edited /);
  await expect(page.locator(".ub-status-sync, .ub-sync-dot, .ub-status-offline")).toHaveCount(0);
  await expect(page.locator(".ub-status")).not.toContainText(/hub|127\.0\.0\.1|localhost/i);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
}

async function closeDetails(page: Page, trigger: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Sync details", exact: true })).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

test("local-only Code disclosure takes native input and keeps its quiet paint in both appearances @webkit", async ({
  browser, contextOptions, viewport, hasTouch, isMobile, deviceScaleFactor, userAgent,
}) => {
  if (agent === null) throw new Error("e2e: local workspace MCP agent is not configured");
  const writer = agent.open({ name: "local-status-e2e" });
  const created = await writer.call<{ uuid: string }>("create_doc", {
    title: "Local code comparison",
    description: "Browser fixture for the local-only status row and Code disclosure.",
    blocks: [{ type: "paragraph", text: "This page stays on this computer." }],
  });
  const original = await writer.call<{ rev: string }>("get_doc", { uuid: created.uuid });
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    contextOptions: {
      ...contextOptions, viewport, hasTouch, isMobile,
      ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
      ...(userAgent === undefined ? {} : { userAgent }),
    },
    beforeNavigate: async (loading) => {
      // Control only the workspace record: real serving, rooms, components,
      // styles and focus owners still expose native input and paint failures.
      // CLI tests separately prove publication from a local-only binding.
      await loading.route("**/uberblick-config.json", async (route) => {
        const response = await route.fetch();
        const config = await response.json() as {
          servedWorkspaces: Record<string, { remoteHubUrl: string; localOnly: boolean }>;
        };
        const serving = config.servedWorkspaces[harness().workspaceUuid];
        if (serving === undefined) throw new Error("e2e: workspace is not served");
        expect(serving.remoteHubUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
        serving.localOnly = true;
        await route.fulfill({ response, json: config });
      });
    },
    readySelector: ".ub-editor",
  });
  await expect(page.locator(".ub-editor")).toContainText("This page stays on this computer.");
  await expectLocalHeader(page);
  await expect(page.locator(".ub-status-code-check")).toHaveCount(0);
  await expect(page.locator(".ub-doc-rev")).toHaveAttribute("aria-label", `Copy revision ${original.rev}`);

  await writer.call("set_metadata", {
    uuid: created.uuid,
    code_check: { repository: "example/product", commit: "a".repeat(40), result: "drift", rev: original.rev },
  });
  const trigger = page.getByRole("button", { name: "Code check", exact: true });
  const panel = page.getByRole("dialog", { name: "Sync details", exact: true });
  await expect(trigger).toHaveText("</>");
  await expect(trigger).toHaveAttribute("title", "Code check");
  await expect(page.locator(".ub-code-check-note")).toHaveText("Differs from code");
  await expectLocalHeader(page);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(hasTouch);

  if (!hasTouch) {
    await page.locator(".ub-title").focus();
    await page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();
    for (const key of ["Enter", "Space"]) {
      await page.keyboard.press(key);
      await expect(panel).toBeVisible();
      await closeDetails(page, trigger);
    }
    await trigger.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Code check");
    await page.mouse.move(0, 0);
  }

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const target = await trigger.boundingBox();
    expect(target?.width).toBeGreaterThanOrEqual(hasTouch ? 44 : 24);
    expect(target?.height).toBeGreaterThanOrEqual(hasTouch ? 44 : 24);
    const colours = await trigger.locator(".ub-sync-code-mark").evaluate((element) => {
      const reference = document.createElement("span");
      reference.style.color = "var(--muted-foreground)";
      element.append(reference);
      const muted = getComputedStyle(reference).color;
      reference.remove();
      return { actual: getComputedStyle(element).color, muted };
    });
    expect(colours.actual).toBe(colours.muted);
    if (hasTouch) await trigger.tap();
    else await trigger.click();
    await expect(panel).toBeInViewport({ ratio: 1 });
    const summary = panel.getByText("Local-only workspace", { exact: true });
    await expect(summary).toBeVisible();
    await expect(summary).toHaveCSS("text-align", "center");
    await expect(panel.getByRole("heading")).toHaveText(["Code"]);
    await expect(panel.locator("dt")).toHaveText(["Repository", "Compared", "Result", "Page edited since"]);
    await expect(panel).toContainText("Differs from the code");
    await expect(panel).not.toContainText(/hub|127\.0\.0\.1|localhost/i);
    for (const selector of [".ub-status-left", ".ub-sync-panel"]) {
      const readings = await renderedText(page, selector);
      expect(readings.length).toBeGreaterThan(0);
      for (const reading of readings) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
    }
    await closeDetails(page, trigger);
  }
  await expectLocalHeader(page);
});
