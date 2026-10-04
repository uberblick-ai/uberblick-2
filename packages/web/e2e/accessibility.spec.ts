import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { expect, test } from "@playwright/test";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import { appendBlock, createAnnotation, createTagCatalogEntry, seedTagCatalog, settingsRoom } from "@uberblick/schema";
import * as Y from "yjs";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { assertNoViolations, unexpectedViolations, WCAG_TAGS } from "./accessibility-assertions.js";
import { scanExclusions } from "./accessibility-exclusions.js";
import { placeCaret } from "./harness.js";

// Untagged: this file runs only in Chromium, including its phone/tablet widths.
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
    const failures: Array<{ surface: string; violations: unknown }> = [];
    const scan = async (surface: string) => test.step(surface, async () => {
      const started = performance.now();
      const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const violations = unexpectedViolations(result.violations, await scanExclusions(page, result.violations));
      reports.push({ surface, milliseconds: Math.round(performance.now() - started),
        violations: result.violations, incomplete: result.incomplete });
      if (violations.length > 0) failures.push({ surface, violations: violations.map((rule) => ({
        rule: rule.id, nodes: rule.nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      })) });
    });
    const peers: Array<{ doc: Y.Doc; provider: HocuspocusProvider }> = [];
    const secret = await importRootSecret(harness().authSecret);
    const peer = async (room: string) => {
      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: harness().hubUrl, name: room, document: doc,
        token: async () => wrapToken(await mintToken(secret, {
          typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
          scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
        })),
      });
      peers.push({ doc, provider });
      await new Promise<void>((resolve) => provider.on("synced", resolve));
      return { doc, provider };
    };
    try {
      await createDoc(page, "Picker destination");
      await createDoc(page, `Accessibility ${colorScheme}`);
      const documentUrl = page.url();
      const uuid = new URL(documentUrl).pathname.split("/")[2];
      const { doc } = await peer(`${harness().workspaceUuid}/${uuid}`);
      appendBlock(doc, { type: "heading", level: 1, text: "Overview" });
      appendBlock(doc, { type: "heading", level: 2, text: "Details" });
      const passage = appendBlock(doc, { type: "paragraph", text: "annotated range" });
      createAnnotation(doc, passage, 0, 9, "Reviewer", "Scan conversation");
      appendBlock(doc, { type: "paragraph", text: "" });
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

      const { doc: catalog } = await peer(settingsRoom(harness().workspaceUuid));
      seedTagCatalog(catalog);
      await page.getByRole("button", { name: "Edit tags" }).click();
      await expect(page.getByRole("option")).toHaveCount(5);
      await scan("tag picker — list");
      await page.keyboard.press("Escape");
      for (let index = 0; index < 5; index += 1) createTagCatalogEntry(catalog, `scan-${index}`);
      await page.getByRole("button", { name: "Edit tags" }).click();
      await expect(page.getByRole("searchbox", { name: "Search tags" })).toBeVisible();
      await scan("tag picker — search");
      await page.keyboard.press("Escape");

      for (let index = 0; index < 4; index += 1) {
        const { provider } = await peer(`${harness().workspaceUuid}/${uuid}`);
        provider.setAwarenessField("user", { name: `Scan peer ${index}`, color: "#0675c9" });
        provider.setAwarenessField("client", "agent");
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
        ["iPad", { width: 820, height: 1180 }],
      ] as const) {
        await page.setViewportSize(viewport);
        await page.locator(".ub-threads-toggle").click();
        // The retained reply form lives in different Sheet DOM below 1280px.
        await expect(page.getByRole("dialog", { name: "Threads", exact: true })).toBeVisible();
        await scan(`Threads drawer and reply form — ${device} ${viewport.width}px`);
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
      for (const { provider, doc } of peers) { provider.destroy(); doc.destroy(); }
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
