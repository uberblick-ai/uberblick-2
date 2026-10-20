/** Code comparisons arrive through the serving replica and stay separate from sync. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { editor, setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";
import { placeCaret } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const repository = "example/product";
const otherRepository = "example/worker";
const commitSha = "a".repeat(40);
const paths = ["packages/web/src/ui/document/EditorPane.tsx", "packages/web/src/ui/status/SyncPanel.tsx", "packages/web/src/ui/hooks.ts"];

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-code-check-${process.env.UB_AGENTS_RUN ?? "local"}-`,
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function fact(group: Locator, label: string): Locator {
  return group.locator(".ub-sync-fact").filter({ has: group.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
}

async function openDetails(page: Page, touch: boolean): Promise<Locator> {
  const trigger = page.locator(".ub-status-sync");
  if (touch) await trigger.tap();
  else { await trigger.focus(); await trigger.press("Space"); }
  const panel = page.getByRole("dialog", { name: "Sync and presence", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function expectNoteContained(page: Page): Promise<void> {
  const layout = await page.locator(".ub-status").evaluate((status) => {
    const bounds = status.getBoundingClientRect();
    const elements = [...status.querySelectorAll(".ub-last-updated, .ub-code-check-note, .ub-doc-rev, .ub-peers")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({ name: element.className, rect: element.getBoundingClientRect() }));
    const problems: string[] = [];
    for (const element of elements) {
      if (element.rect.left < bounds.left - 0.5 || element.rect.right > bounds.right + 0.5) {
        problems.push(`${element.name} escapes the status row`);
      }
      for (const other of elements) {
        if (element === other) continue;
        if (element.rect.left < other.rect.right - 0.5 && element.rect.right > other.rect.left + 0.5 &&
          element.rect.top < other.rect.bottom - 0.5 && element.rect.bottom > other.rect.top + 0.5) {
          problems.push(`${element.name} overlaps ${other.name}`);
        }
      }
    }
    return problems;
  });
  expect(layout).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test(`code comparisons show checked text, usable details and AA warnings — ${scheme} @webkit`, async ({
    browser, contextOptions, viewport, hasTouch, isMobile, deviceScaleFactor, userAgent,
  }, info) => {
    if (agent === null) throw new Error("e2e: code-check MCP agent is not configured");
    const writer = agent.open({ name: "code-check-e2e" });
    const created = await writer.call<{ uuid: string }>("create_doc", {
      title: `Code comparisons ${scheme}`,
      description: "Browser fixture for recorded code comparisons and page revision warnings.",
      blocks: [{ type: "paragraph", text: "Compared page text." }],
    });
    const original = await writer.call<{ rev: string }>("get_doc", { uuid: created.uuid });
    const primary = { repository, commit: commitSha, result: "matches", rev: original.rev, paths };
    const secondary = { repository: otherRepository, commit: "b".repeat(40), result: "ahead", rev: original.rev };
    const checked = await writer.call<{ code_check: { checked_at: string }[] }>("set_metadata", {
      uuid: created.uuid, code_check: primary,
    });
    await writer.call("set_metadata", { uuid: created.uuid, code_check: secondary });
    const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
      contextOptions: {
        ...contextOptions, viewport, hasTouch, isMobile, colorScheme: scheme,
        ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
        ...(userAgent === undefined ? {} : { userAgent }),
      },
      readySelector: ".ub-editor",
    });
    const revision = page.locator(".ub-doc-rev");
    await expect(revision).toHaveAttribute("aria-label", `Copy revision ${original.rev}`);
    let panel = await openDetails(page, hasTouch);
    await expect(panel.getByRole("heading", { name: "Code", exact: true })).toBeVisible();
    const groups = panel.locator(".ub-code-check");
    await expect(groups).toHaveCount(2);
    const product = groups.filter({ hasText: repository });
    const worker = groups.filter({ hasText: otherRepository });
    await expect(fact(product, "Repository")).toHaveText(repository);
    const commit = fact(product, "Compared").getByRole("link");
    await expect(commit).toHaveText(commitSha.slice(0, 8));
    await expect(commit).toHaveAttribute("href", `https://github.com/${repository}/commit/${commitSha}`);
    await expect(commit).toHaveAttribute("target", "_blank");
    await expect(commit).toHaveAttribute("rel", "noopener noreferrer");
    const time = fact(product, "Compared").locator("time");
    await expect(time).toHaveAttribute("datetime", checked.code_check[0]?.checked_at ?? "missing checked_at");
    await expect(time).toHaveAttribute("title", /\S/);
    await expect(time).toHaveText(/^(just now|\d+ minutes? ago)$/);
    await expect(fact(product, "Result")).toHaveText("Matches the code");
    await expect(fact(worker, "Result")).toHaveText("Ahead of the code (intended)");
    await expect(fact(product, "Page text")).toHaveText("Unchanged since then");
    await expect(fact(product, "Looked at")).toHaveText(`${paths[0]} +2 more`);
    await expect(fact(worker, "Looked at")).toHaveCount(0);
    await expect(page.locator(".ub-code-check-note")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await placeCaret(page);
    await page.keyboard.insertText(" An immediate edit.");
    await page.locator(".ub-title").focus();
    await expect(editor(page)).toContainText("An immediate edit.");
    const note = page.locator(".ub-code-check-note");
    await expect(note).toHaveText("Edited since code check");
    panel = await openDetails(page, hasTouch);
    await expect(fact(product, "Page text")).toHaveText("Edited since then");
    await page.keyboard.press("Escape");

    let currentRev = "";
    await expectMcp(() => writer.call<{ rev: string; blocks: { text: string }[] }>("get_doc", { uuid: created.uuid }), (doc) => {
      expect(doc.blocks.some((block) => block.text.includes("An immediate edit."))).toBe(true);
      expect(doc.rev).not.toBe(original.rev);
      currentRev = doc.rev;
    });
    await writer.call("set_metadata", { uuid: created.uuid, code_check: { ...primary, rev: currentRev } });
    await writer.call("set_metadata", { uuid: created.uuid, code_check: { ...secondary, rev: currentRev } });
    panel = await openDetails(page, hasTouch);
    await expect(fact(product, "Page text")).toHaveText("Unchanged since then");
    await expect(fact(worker, "Page text")).toHaveText("Unchanged since then");
    await expect(note).toHaveCount(0);
    await expect(revision).toHaveAttribute("aria-label", `Copy revision ${currentRev}`);
    await page.keyboard.press("Escape");

    await writer.call("set_metadata", { uuid: created.uuid, code_check: { ...primary, rev: currentRev, result: "drift" } });
    await expect(note).toHaveText("Differs from code");
    await expect(revision).toHaveAttribute("aria-label", `Copy revision ${currentRev}`);
    for (const width of [1280, 744]) {
      await page.setViewportSize({ width, height: 1080 });
      await expectNoteContained(page);
      const noteInk = await renderedText(page, ".ub-code-check-note");
      expect(noteInk.length).toBeGreaterThan(0);
      for (const reading of noteInk) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
      panel = await openDetails(page, hasTouch);
      await expect(fact(product, "Result")).toHaveText("Differs from the code");
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      const codeInk = await renderedText(page, ".ub-code-check");
      expect(codeInk.length).toBeGreaterThan(0);
      for (const reading of codeInk) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
      const path = info.outputPath(`code-check-${width}.png`);
      await page.screenshot({ path });
      await info.attach(`code comparisons at ${width}px`, { path, contentType: "image/png" });
      await page.keyboard.press("Escape");
      await expect(page.locator(".ub-status-sync")).toBeFocused();
    }
  });
}
