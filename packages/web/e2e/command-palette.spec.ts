/** The palette's app-wide shortcut, native focus lifecycle and result navigation. */

import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { docTitle, editor, openPath, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-command-palette-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function palette(page: Page): Locator {
  return page.getByRole("dialog", { name: "Command palette", exact: true });
}

function search(page: Page): Locator {
  return palette(page).getByRole("combobox", { name: "Search documents and decisions", exact: true });
}

async function openPalette(page: Page): Promise<void> {
  const apple = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform));
  await page.keyboard.press(apple ? "Meta+k" : "Control+k");
  await expect(palette(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
}

for (const touch of [false, true]) for (const appearance of ["light", "dark"] as const) {
  test(`search, navigation and creation from every workspace surface on ${touch ? "iPad with external keyboard and touch" : "desktop keyboard and pointer"} in ${appearance}${touch ? " @webkit-touch" : ""}`, async ({ browser }) => {
    if (agent === null) throw new Error("e2e: MCP agent is not configured");
    const writer = agent.open({ name: "command-palette-e2e" });
    const prefix = docTitle("palette");
    const regularTitle = `${prefix} document`;
    const regularText = "The shortcut must leave this editor text unchanged.";
    const regular = await writer.call<{ uuid: string }>("create_doc", {
      title: regularTitle, description: "Palette browser acceptance fixture.",
      blocks: [{ type: "paragraph", text: regularText }],
    });
    const prior = await writer.call<{ uuid: string }>("create_doc", {
      title: `${prefix} current question`, description: "Palette browser acceptance fixture.", kind: "decision", status: "decided",
      blocks: [{ type: "paragraph", text: "The previous answer belongs in history." }],
    });
    const currentTitle = `${prefix} current question`;
    const currentAnswer = "The topic opens its current answer rather than the matching historical record.";
    const current = await writer.call<{ uuid: string }>("create_doc", {
      title: currentTitle, description: "Palette browser acceptance fixture.", kind: "decision", status: "decided", supersedes: prior.uuid,
      answer: { who: "A workspace member", when: "2026-10-17T12:00:00Z", where: "https://example.org/team/decision" },
      blocks: [{ type: "paragraph", text: currentAnswer }],
    });
    const archived = await writer.call<{ uuid: string }>("create_doc", {
      title: `${prefix} archived`, description: "An archived palette browser fixture.",
    });
    await writer.call("archive_doc", { uuid: archived.uuid });

    const page = await openApp(browser, `/${harness().workspace}/all`, {
      contextOptions: {
        ...(touch ? devices["iPad (gen 7) landscape"] : { viewport: { width: 1440, height: 900 } }),
        colorScheme: appearance,
      },
      readySelector: ".ub-docs-heading",
      beforeNavigate: async (opening) => {
        if (touch) await opening.addInitScript(() => {
          Object.defineProperty(navigator, "platform", { configurable: true, get: () => "iPad" });
        });
        // Ranking belongs to shared local search. A historical record ranks
        // first here so browser navigation must still resolve the live topic.
        await opening.route("**/api/search?*", async (route) => {
          expect(new URL(route.request().url()).searchParams.get("q")).toBe(prefix);
          await route.fulfill({ json: { hits: [prior, regular, current, archived], capped: false } });
        });
      },
    });
    const listSearch = page.getByRole("searchbox", { name: "Search", exact: true });
    await listSearch.fill(prefix);
    await expect(page.locator(".ub-docs-title")).toHaveText([regularTitle]);
    await page.getByRole("tab", { name: /^Decisions/ }).click();
    await expect(page.locator(".ub-docs-title")).toHaveText([currentTitle]);

    // All documents has no editor and Settings has a different navigation tree;
    // both still use the same workspace shortcut.
    await listSearch.focus();
    await openPalette(page);
    await expect(palette(page).getByRole("option")).toHaveText(["Create document"]);
    await page.keyboard.press("Escape");
    await expect(listSearch).toBeFocused();

    await page.goto(new URL(`/${harness().workspace}/${regular.uuid}`, harness().appUrl).href);
    await expect(editor(page)).toHaveText(regularText);
    await editor(page).click();
    const documentPath = openPath(page);
    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    await expect(editor(page)).toHaveText(regularText);
    expect(openPath(page)).toBe(documentPath);

    await openPalette(page);
    await search(page).fill(prefix);
    const options = palette(page).getByRole("option");
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toContainText(currentTitle);
    await expect(options.nth(0)).toContainText("Decision");
    await expect(options.nth(1)).toContainText(regularTitle);
    await expect(options.nth(1)).toContainText("Document");
    await expect(options.nth(2)).toHaveText("Create document");
    const screenshot = test.info().outputPath("command-palette.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    await test.info().attach(`command-palette-${touch ? "ipad" : "desktop"}-${appearance}`, {
      path: screenshot, contentType: "image/png",
    });
    await search(page).press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/${prior.uuid}$`));
    await expect(page.getByRole("textbox", { name: "Document title" })).toHaveValue(currentTitle);
    await expect(editor(page)).toHaveText(currentAnswer);

    await openPalette(page);
    await search(page).fill(prefix);
    const document = palette(page).getByRole("option", { name: `${regularTitle} Document`, exact: true });
    if (touch) await document.tap();
    else await document.click();
    await expect(palette(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/${regular.uuid}$`));
    await expect(editor(page)).toHaveText(regularText);

    await openPalette(page);
    await search(page).fill(prefix);
    await expect(options).toHaveCount(3);
    const create = palette(page).getByRole("option", { name: "Create document", exact: true });
    if (touch) await create.tap();
    else await create.click();
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator(".ub-title")).toHaveValue("Untitled");
    await expect(editor(page)).toBeVisible();
    expect(openPath(page)).not.toBe(documentPath);

    await page.goto(new URL(`/${harness().workspace}/settings/preferences`, harness().appUrl).href);
    await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
    await openPalette(page);
    await expect(search(page)).toHaveValue("");
    await expect(create).toBeEnabled();
    await search(page).press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator(".ub-title")).toHaveValue("Untitled");
    await expect(editor(page)).toBeVisible();
  });
}

test("search failures and absent local search differ from successful no matches", async ({ browser }) => {
  let fail = false;
  const page = await openApp(browser, "/", {
    readySelector: ".ub-docs-heading",
    beforeNavigate: async (opening) => {
      await opening.route("**/api/search?*", async (route) => {
        if (fail) await route.fulfill({ status: 503, body: "Search failed" });
        else await route.fulfill({ json: { hits: [], capped: false } });
      });
    },
  });
  await openPalette(page);
  await search(page).fill("nothing-matches");
  await expect(palette(page)).toContainText(/No .*match/i);
  await expect(palette(page)).not.toContainText("Search is unavailable");
  await expect(palette(page).getByRole("option")).toHaveText(["Create document"]);
  fail = true;
  await search(page).fill("request-fails");
  await expect(palette(page)).toContainText("Search is unavailable");
  await expect(palette(page)).not.toContainText(/No .*match/i);

  const upstream = await openApp(browser, "/", { upstream: true, readySelector: ".ub-docs-heading" });
  await openPalette(upstream);
  await search(upstream).fill("unavailable-without-ub-open");
  await expect(palette(upstream)).toContainText("Search is unavailable");
  await expect(palette(upstream)).not.toContainText(/No .*match/i);
});

test("the shortcut does nothing without a current workspace", async ({ browser }) => {
  const page = await openApp(browser, "/not-a-workspace", { readySelector: ".ub-notice" });
  await expect(page.locator(".ub-notice")).toContainText("not a workspace id");
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Meta+k");
  await expect(palette(page)).toHaveCount(0);
});
