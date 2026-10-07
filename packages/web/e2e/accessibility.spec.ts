import { writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { assertNoViolations, unexpectedViolations, WCAG_TAGS } from "./accessibility-assertions.js";
import { scanExclusions } from "./accessibility-exclusions.js";
import { placeCaret } from "./harness.js";

// Untagged: this file runs only in Chromium, including its narrow drawer layout.
const { harness, openApp } = setupHarness({ scope: "test" });

for (const colorScheme of ["light", "dark"] as const) {
  test(`WCAG A/AA on the composed web surfaces — ${colorScheme}`, async ({ browser }, info) => {
    test.setTimeout(120_000);
    const page = await openApp(browser, "/", {
      upstream: true,
      contextOptions: { colorScheme, viewport: { width: 1280, height: 800 } },
      beforeNavigate: (opened) => opened.emulateMedia({ reducedMotion: "reduce" }),
      readySelector: ".ub-workspace",
    });
    const reports: Array<{ surface: string; milliseconds: number; violations: unknown; incomplete: unknown }> = [];
    const failures: Array<{ surface: string; message: string }> = [];
    const scan = async (surface: string) => test.step(surface, async () => {
      const started = performance.now();
      const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const exclusions = await scanExclusions(page, result.violations);
      reports.push({ surface, milliseconds: Math.round(performance.now() - started),
        violations: result.violations, incomplete: result.incomplete });
      try {
        assertNoViolations(result.violations, exclusions);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failures.push({ surface, message: error.message });
      }
    });
    try {
      await createDoc(page, "Picker destination");
      await createDoc(page, `Accessibility ${colorScheme}`);
      const documentUrl = page.url();
      await placeCaret(page);
      // Keep the first paragraph empty for the real slash/@ typing triggers.
      await page.keyboard.press("Enter");
      for (const text of ["# Overview", "## Details", "annotated range"]) {
        await page.keyboard.type(text);
        await page.keyboard.press("Enter");
      }
      await editor(page).locator(".ub-paragraph").filter({ hasText: "annotated range" }).evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.getByPlaceholder(/Comment as/).fill("Scan conversation");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Contents 2" })).toBeVisible();
      await expect(page.locator(".ub-thread")).toContainText("Scan conversation");
      await scan("document and docked shell — MacBook 1280px");

      await page.locator(".ub-workspace").click();
      await expect(page.locator("[data-slot=dropdown-menu-content]")).toBeVisible();
      await scan("workspace switcher");
      await page.keyboard.press("Escape");
      await page.locator(".ub-user-card").click();
      await expect(page.locator("[data-slot=popover-content]")).toBeVisible();
      await scan("user menu");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "+ group", exact: true }).click();
      const groupName = page.getByRole("textbox", { name: "Group name" });
      await groupName.fill("Scan group");
      await groupName.press("Enter");
      await page.getByRole("button", { name: "Delete group Scan group", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await scan("Delete group confirmation");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();

      await page.locator(".ub-status .ub-sync-toggle").click();
      await expect(page.getByRole("dialog", { name: "Sync and presence" })).toBeVisible();
      await scan("Sync details");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Document actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Archive document" })).toBeVisible();
      await scan("Document actions");
      await page.getByRole("menuitem", { name: "Archive document" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await scan("archive confirmation");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Contents 2" }).click();
      await expect(page.getByRole("menu", { name: "Contents 2" })).toBeVisible();
      await scan("Contents");
      await page.keyboard.press("Escape");

      const tagsUrl = new URL(`/${harness().workspace}/settings/tags`, harness().appUrl).href;
      await page.goto(tagsUrl);
      await expect(page.getByRole("region", { name: "Active" }).getByRole("listitem")).toHaveCount(5);
      await page.goto(documentUrl);
      await page.getByRole("button", { name: "Edit tags" }).click();
      await expect(page.getByRole("option")).toHaveCount(5);
      await scan("tag picker — list");
      await page.keyboard.press("Escape");
      await page.goto(tagsUrl);
      for (let index = 0; index < 5; index += 1) {
        await page.getByLabel("Create a tag").fill(`scan-${index}`);
        await page.getByRole("button", { name: "Create", exact: true }).click();
        await expect(page.getByRole("button", { name: `Retire scan-${index}` })).toBeVisible();
      }
      await page.goto(documentUrl);
      await page.getByRole("button", { name: "Edit tags" }).click();
      await expect(page.getByRole("searchbox", { name: "Search tags" })).toBeVisible();
      await scan("tag picker — search");
      await page.keyboard.press("Escape");

      for (let index = 0; index < 4; index += 1) {
        await openApp(browser, new URL(documentUrl).pathname, {
          upstream: true,
          contextOptions: { colorScheme, viewport: { width: 1280, height: 800 } },
          readySelector: ".ub-editor .ProseMirror",
        });
      }
      await expect(page.locator(".ub-peer-more")).toBeVisible();
      await page.locator(".ub-peers > .ub-peer-control[data-peer-id]").first().focus();
      await expect(page.getByRole("tooltip")).toBeVisible();
      await scan("collaborator tooltip");
      await page.locator(".ub-title").focus();
      await page.locator(".ub-peer-more").click();
      await expect(page.getByRole("dialog", { name: "More active collaborators" })).toBeVisible();
      await scan("collaborator overflow");
      await page.keyboard.press("Escape");

      await placeCaret(page);
      await page.keyboard.type("/");
      await expect(page.getByRole("listbox", { name: "Block types" })).toBeVisible();
      await scan("caret menu — slash");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Backspace");
      await editor(page).locator(":scope > *").last().hover();
      await page.getByRole("button", { name: "Insert block below" }).click();
      await expect(page.getByRole("combobox", { name: "Search blocks" })).toBeVisible();
      await scan("caret menu — gutter search");
      await page.keyboard.press("Escape");
      await placeCaret(page);
      await page.keyboard.type("@");
      await expect(page.getByRole("listbox", { name: "Documents" })).toBeVisible();
      await scan("caret menu — document picker");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Backspace");
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      await expect(page.getByPlaceholder("Reply…")).toBeVisible();
      await scan("Threads and reply form — docked");

      for (const [device, viewport] of [
        ["iPhone", { width: 390, height: 844 }],
      ] as const) {
        await page.setViewportSize(viewport);
        await page.locator(".ub-threads-toggle").click();
        // The retained reply form lives in different Sheet DOM below 1280px.
        await expect(page.getByRole("dialog", { name: "Threads", exact: true })).toBeVisible();
        if (device === "iPhone") await scan(`Threads drawer and reply form — ${device} ${viewport.width}px`);
        await page.getByRole("button", { name: "Close threads", exact: true }).click();
        await scan(`document and closed drawers — ${device} ${viewport.width}px`);
        await page.getByRole("button", { name: "Show document list", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
        await scan(`sidebar drawer — ${device} ${viewport.width}px`);
        await page.keyboard.press("Escape");
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const [surface, suffix] of [["workspace settings", "settings"], ["tag settings", "settings/tags"]]) {
        await page.goto(new URL(`/${harness().workspace}/${suffix}`, harness().appUrl).href);
        await expect(page.locator("[data-settings-page]")).toBeVisible();
        await scan(surface ?? "settings");
      }
    } finally {
      const reportPath = info.outputPath("axe-surfaces.json");
      await writeFile(reportPath, JSON.stringify(reports, null, 2));
      await info.attach("axe surfaces", { path: reportPath, contentType: "application/json" });
      console.log(`${colorScheme}: ${reports.length} axe scans, ${reports.reduce((sum, report) => sum + report.milliseconds, 0)}ms in axe`);
    }
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  });
}

test("the scan rejects a seeded unnamed button on an open surface", async ({ browser }) => {
  const page = await openApp(browser, "/", {
    contextOptions: { viewport: { width: 1280, height: 800 } }, readySelector: ".ub-workspace",
  });
  await page.locator(".ub-workspace").click();
  await expect(page.locator("[data-slot=dropdown-menu-content]")).toBeVisible();
  await page.locator("[data-slot=dropdown-menu-content]").evaluate((surface) => {
    const button = document.createElement("button");
    button.id = "seeded-unnamed-button";
    button.style.cssText = "width:32px;height:32px";
    surface.append(button);
  });
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(result.violations.find((rule) => rule.id === "button-name")?.nodes.map((node) => node.target))
    .toContainEqual(["#seeded-unnamed-button"]);
  const exclusions = await scanExclusions(page, result.violations);
  expect(() => assertNoViolations(result.violations, exclusions)).toThrow(/button-name/);
});

test("element exclusions preserve same-rule siblings and reject ambiguous selectors", async ({ page }) => {
  await page.setContent(`<!doctype html><html lang="en"><title>Exclusion probe</title><body>
    <main><h1>Scrollable lists</h1><div data-slot="caret-menu-content">
      <div id="radix:tracked" role="listbox" aria-label="Block types" style="height:50px;overflow:auto">
        <button role="option" aria-selected="false" tabindex="-1" style="height:200px">Tracked option</button>
      </div>
      <div id="radix:sibling" role="listbox" aria-label="Other list" style="height:50px;overflow:auto">
        <button role="option" aria-selected="false" tabindex="-1" style="height:200px">Sibling option</button>
      </div>
    </div></main></body></html>`);
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const rule = result.violations.filter(({ id }) => id === "scrollable-region-focusable");
  expect(rule.flatMap(({ nodes }) => nodes)).toHaveLength(2);
  const remaining = unexpectedViolations(rule, await scanExclusions(page, rule));
  expect(remaining.flatMap(({ nodes }) => nodes)).toHaveLength(1);
  expect(await page.locator(remaining[0]?.nodes[0]?.target[0] as string).getAttribute("id")).toBe("radix:sibling");
  await page.locator('[id="radix:sibling"]').evaluate((node) => node.setAttribute("aria-label", "Block types"));
  const ambiguous = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  await expect(scanExclusions(page, ambiguous.violations)).rejects.toThrow(/exclusion is ambiguous/);
});

test("record axe's rendered oklch via light-dark contrast classification", async ({ browser }, info) => {
  const readings = [];
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await openApp(browser, "/", {
      contextOptions: { colorScheme, viewport: { width: 1280, height: 800 } }, readySelector: ".ub-workspace",
    });
    await page.evaluate(() => {
      const probe = document.createElement("p");
      probe.id = "axe-bad-contrast";
      // Neutral oklch has relative luminance L^3: ~1.39:1 light, ~1.23:1 dark.
      probe.style.cssText = "position:fixed;inset:100px auto auto 400px;z-index:9999;padding:20px;font:16px sans-serif;color:light-dark(oklch(0.8 0 0),oklch(0.25 0 0));background:light-dark(oklch(0.9 0 0),oklch(0.15 0 0))";
      probe.textContent = "Deliberately unreadable contrast";
      document.body.append(probe);
    });
    const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const classification = ["violations", "passes", "incomplete"] as const;
    const outcome = classification.find((kind) => result[kind].some((rule) =>
      rule.id === "color-contrast" && rule.nodes.some((node) => node.target.includes("#axe-bad-contrast"))));
    expect(outcome, "axe must classify the rendered colour probe").toBeDefined();
    readings.push({ colorScheme, outcome, rendered: await page.locator("#axe-bad-contrast").evaluate((node) => {
      const style = getComputedStyle(node);
      return { color: style.color, background: style.backgroundColor, colorScheme: style.colorScheme };
    }), results: classification.flatMap((kind) => result[kind].filter((rule) => rule.id === "color-contrast")
      .flatMap((rule) => rule.nodes.filter((node) => node.target.includes("#axe-bad-contrast")).map((node) => ({ kind, node })))) });
  }
  console.log(JSON.stringify(readings.map(({ colorScheme, outcome, rendered }) => ({ colorScheme, outcome, rendered }))));
  const reportPath = info.outputPath("axe-colour-probe.json");
  await writeFile(reportPath, JSON.stringify(readings, null, 2));
  await info.attach("axe colour probe", { path: reportPath, contentType: "application/json" });
});
