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
const paths = [
  "packages/web/src/ui/document/comparison/deeply/nested/EditorPane.tsx",
  "packages/web/src/ui/status/SyncPanel.tsx",
  `packages/web/src/ui/${"long-filename-".repeat(7)}component.tsx`,
];

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
  const panel = page.getByRole("dialog", { name: "Sync details", exact: true });
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

async function expectPathsContained(group: Locator, expected: readonly string[]): Promise<void> {
  const rows = fact(group, "Looked at").locator(".ub-code-check-path");
  await expect(rows).toHaveCount(expected.length);
  for (const [index, fullPath] of expected.entries()) {
    const row = rows.nth(index);
    const text = row.locator(".ub-code-check-path-text");
    await expect(row.locator(".sr-only")).toHaveText(fullPath);
    const shown = await text.innerText();
    if (shown !== fullPath) {
      expect(shown).toMatch(/^…\//);
      const basename = fullPath.slice(fullPath.lastIndexOf("/") + 1);
      if (shown.endsWith("…")) {
        expect(shown).toMatch(/^…\/[^/]+…$/);
        expect(basename.startsWith(shown.slice(2, -1))).toBe(true);
      } else {
        expect(fullPath.endsWith(`/${shown.slice(2)}`)).toBe(true);
        expect(shown.endsWith(basename)).toBe(true);
      }
    }
    expect(await text.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const row = element.closest(".ub-code-check-path");
      if (row === null) throw new Error("path text has no row");
      const box = row.getBoundingClientRect();
      const panel = element.closest('[role="dialog"]')?.getBoundingClientRect();
      const lines = [...range.getClientRects()];
      return {
        singleLine: lines.every((line) => Math.abs(line.top - (lines[0]?.top ?? line.top)) < 1),
        fits: row.scrollWidth <= row.clientWidth + 1 && lines.every((line) => line.right <= box.right + 1),
        contained: panel !== undefined && box.left >= panel.left && box.right <= panel.right,
      };
    })).toEqual({ singleLine: true, fits: true, contained: true });
  }
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
      beforeNavigate: async (loading) => { await loading.clock.install(); },
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
    await expect(fact(product, "Page edited since")).toHaveText("No");
    await expect(fact(product, "Looked at").locator(".ub-code-check-path")).toHaveCount(1);
    await expectPathsContained(product, paths.slice(0, 1));
    const expand = fact(product, "Looked at").getByRole("button", { name: "+2 more", exact: true });
    await expand.focus();
    await expand.press("Space");
    await expect(expand).toHaveCount(0);
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expectPathsContained(product, paths);
    await expect(fact(worker, "Looked at")).toHaveCount(0);
    await expect(page.locator(".ub-code-check-note")).toHaveCount(0);
    await commit.focus();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await placeCaret(page);
    await page.keyboard.insertText(" An immediate edit.");
    await page.locator(".ub-title").focus();
    await expect(editor(page)).toContainText("An immediate edit.");
    const note = page.locator(".ub-code-check-note");
    await expect(note).toHaveCount(0);
    panel = await openDetails(page, hasTouch);
    await expect(fact(product, "Page edited since")).toHaveText("Yes");
    await expect(fact(product, "Looked at").getByRole("button", { name: "+2 more", exact: true })).toBeVisible();
    await expect(fact(product, "Looked at").locator(".ub-code-check-path")).toHaveCount(1);
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
    await expect(fact(product, "Page edited since")).toHaveText("No");
    await expect(fact(worker, "Page edited since")).toHaveText("No");
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
      const more = fact(product, "Looked at").getByRole("button", { name: "+2 more", exact: true });
      if (hasTouch) await more.tap();
      else await more.click();
      await expect(more).toHaveCount(0);
      await expectPathsContained(product, paths);
      const shortened = fact(product, "Looked at").locator(".ub-code-check-path").first();
      await expect(shortened.locator(".ub-code-check-path-text")).toHaveText(/^…\/.*EditorPane\.tsx$/);
      await shortened.focus();
      await expect(page.getByRole("tooltip")).toHaveText(paths[0] ?? "missing path");
      await commit.focus();
      if (!hasTouch) {
        await shortened.hover();
        await expect(page.getByRole("tooltip")).toHaveText(paths[0] ?? "missing path");
        await page.keyboard.press("Escape");
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        await page.mouse.move(0, 0);
      }
      await expect(fact(product, "Looked at").locator(".ub-code-check-path-text").last()).toHaveText(/^…\/[^/]+…$/);
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
      await commit.focus();
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(page.locator(".ub-status-sync")).toBeFocused();
    }

    const trigger = page.locator(".ub-status-sync");
    const mark = trigger.locator(".ub-sync-code-mark");
    await expect(mark).toHaveCount(0);
    const recentWidth = await trigger.evaluate((element) => element.getBoundingClientRect().width);
    const dotState = await trigger.locator(".ub-sync-dot").getAttribute("data-state");
    const current = await writer.call<{ code_check: { checked_at: string }[] }>("get_doc", { uuid: created.uuid });
    const oldest = Math.min(...current.code_check.map((check) => Date.parse(check.checked_at)));
    const day = 24 * 60 * 60 * 1_000;
    await page.clock.pauseAt(new Date(Date.now() + 1_000));
    await page.clock.setSystemTime(oldest + 14 * day - 60_000);
    await page.clock.fastForward(60_000);
    await expect(mark).toHaveCount(0);
    expect(await trigger.evaluate((element) => element.getBoundingClientRect().width)).toBe(recentWidth);
    await page.clock.fastForward(60_000);
    await expect(mark).toHaveText("</>");
    await expect(trigger).toHaveAttribute("aria-label", / · code check 14 days old$/);
    await expect(trigger.locator(".ub-sync-dot")).toHaveAttribute("data-state", dotState ?? "missing state");
    await page.clock.setSystemTime(oldest + 20.5 * day);
    await page.clock.fastForward(60_000);
    await expect(trigger).toHaveAttribute("aria-label", / · code check 20 days old$/);
    await expect(trigger).toHaveAttribute("title", / · code check 20 days old$/);
    await trigger.blur();
    await trigger.focus();
    await page.clock.runFor(1_000);
    await expect(page.getByRole("tooltip")).toHaveText(/ · code check 20 days old$/);
    expect(await mark.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--muted-foreground)";
      element.append(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(element).color === muted;
    })).toBe(true);
    if (hasTouch) {
      const target = await trigger.boundingBox();
      expect(target?.height).toBeGreaterThanOrEqual(44);
      expect(target?.width).toBeGreaterThanOrEqual(44);
    }
    panel = await openDetails(page, hasTouch);
    await expect(fact(product, "Compared")).toHaveText(/ · due for a re-check$/);
    await expect(fact(worker, "Compared")).toHaveText(/ · due for a re-check$/);
    await page.keyboard.press("Escape");
  });
}
