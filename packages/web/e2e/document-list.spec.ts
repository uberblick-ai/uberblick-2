/** Real search, client convergence, current-answer navigation and browser history. */

import { devices, expect, test } from "@playwright/test";
import { activateControl, createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import type { Locator, Page } from "@playwright/test";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

const { harness, openApp } = setupHarness({ app: { readySelector: ".ub-document-sidebar" } });

let mcpAgent: McpAgent | null = null;

function agent(): McpAgent {
  if (mcpAgent === null) {
    throw new Error("e2e: the MCP agent is not configured");
  }
  return mcpAgent;
}

test.beforeAll(async () => {
  mcpAgent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-document-list-",
  });
});

test.afterEach(async () => {
  await mcpAgent?.closeSessions();
});

test.afterAll(async () => {
  await mcpAgent?.close();
  mcpAgent = null;
});

/** The titles the list shows, top to bottom. */
function listedTitles(page: Page): Locator {
  return page.locator(".ub-docs-title");
}

test("the workspace address is the list, and it holds what another browser created", async ({
  browser,
}) => {
  const first = docTitle("aardvark");
  const second = docTitle("zebra");

  const [author, reader] = await Promise.all([
    openApp(browser, "/", { upstream: true }),
    openApp(browser),
  ]);
  await createDoc(author, first);
  await createDoc(author, second);

  // The second browser was told nothing: the directory is a synced document,
  // and the list is that document. `/` resolves to the workspace's own address,
  // which is where a session starts.
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}$`));
  // Transport is the clause here; the default ordering belongs to jsdom.
  await expect.poll(async () => (await listedTitles(reader).allTextContents()).sort())
    .toEqual([first, second].sort());
  // The sidebar's fixed entry is the same list at its own address.
  const entry = reader.getByRole("button", { name: "All documents" });
  await entry.click();
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}/all$`));
  // And the address is a link: a fresh browser goes straight there.
  const linked = await openApp(browser);
  await linked.goto(new URL(`/${harness().workspace}/all`, harness().appUrl).href);
  await expect(linked.getByRole("table")).toBeVisible();
  await linked.evaluate((query) => history.replaceState({
    query,
    mode: "requirement",
    stateFilter: "all",
    sort: { order: "title", direction: "descending" },
  }, ""), first);
  await linked.reload();
  await expect(linked.getByRole("tab", { name: /^Documents/ })).toHaveAttribute("aria-selected", "true");
  await expect(linked.getByRole("button", { name: "Product", exact: true })).toHaveCount(0);
  await expect(listedTitles(linked)).toHaveText([first]);
  await linked.locator(".ub-docs-open").click();
  await expect(linked.locator(".ub-editor .ProseMirror")).toBeVisible();
  await linked.goBack();
  await expect(linked.getByRole("tab", { name: /^Documents/ })).toHaveAttribute("aria-selected", "true");
  await expect(linked.getByRole("searchbox", { name: "Search" })).toHaveValue(first);
  await expect(listedTitles(linked)).toHaveText([first]);
});

test("MCP decision adoption reaches an open regular page and the directory", async ({
  browser,
}) => {
  const title = docTitle("roadmap");
  // Keep the lifecycle UI's browser on the same upstream as its MCP writer;
  // local/upstream store replay is tested separately.
  const page = await openApp(browser, "/", { upstream: true });
  const session = agent().open({ name: "document-list-e2e" });
  const created = await session.call<{ uuid: string }>("create_doc", {
    title,
    description: "A roadmap item created outside the browser.",
    blocks: [{ type: "paragraph", text: "Keep the roadmap on a regular page." }],
  });
  await expect(page.getByRole("button", { name: "Product", exact: true })).toHaveCount(0);
  const row = page.locator(".ub-docs-row", { hasText: title });
  await row.locator(".ub-docs-open").click();
  await page.locator(".ub-editor .ProseMirror").waitFor({ state: "visible" });
  await expect(page.locator(".ub-lifecycle-badge")).toHaveCount(0);
  await session.call("set_status", {
    uuid: created.uuid,
    status: "open",
  });
  await expect(page.locator(".ub-lifecycle-badge")).toHaveText(
    "Decision",
  );
  await page.getByRole("button", { name: "All documents" }).click();
  await expect(page.locator(".ub-docs-row", { hasText: title })).toHaveCount(0);
  await page.getByRole("tab", { name: /^Decisions/ }).click();
  await page.getByRole("combobox", { name: "Decision state" }).selectOption("not-yet-decided");
  await expect(page.locator(".ub-docs-row", { hasText: title })).toHaveCount(1);
});

test("the list and palette search fragments and block languages through the serving replica", async ({ browser }) => {
  const writer = agent().open({ name: "fragment-search-e2e" });
  const suffix = Date.now();
  const titleHit = `ub workspace use ${suffix}`;
  const bodyHit = `Body guide ${suffix}`;
  const descriptionHit = `Description guide ${suffix}`;
  const tagHit = `Tag guide ${suffix}`;
  const shortTitleHit = `Überblick MCP server tools ${suffix}`;
  const languageHit = `Diagram guide ${suffix}`;
  for (const fixture of [
    { title: titleHit, description: "A title match.", text: "Neutral content." },
    { title: bodyHit, description: "A body match.", text: "workspace mc" },
    { title: descriptionHit, description: "workspace mc", text: "Neutral content." },
    { title: tagHit, description: "A tag match.", text: "Neutral content.", tags: ["mcp"] },
    { title: shortTitleHit, description: "An accented title match.", text: "Neutral content." },
  ]) {
    await writer.call("create_doc", {
      title: fixture.title, description: fixture.description,
      blocks: [{ type: "paragraph", text: fixture.text }],
      ...(fixture.tags === undefined ? {} : { tags: fixture.tags }),
    });
  }
  await writer.call("create_doc", {
    title: languageHit, description: "A drawing and a code sample.",
    blocks: [
      { type: "code", language: "wireframe", text: "page\n  text Hello" },
      { type: "code", language: "ts", text: "const value = 1;" },
    ],
  });
  const page = await openApp(browser, `/${harness().workspace}/all`, { readySelector: ".ub-docs-heading" });
  for (const title of [titleHit, bodyHit, descriptionHit, tagHit, shortTitleHit, languageHit]) {
    await expect(listedTitles(page).filter({ hasText: title })).toBeVisible();
  }
  const listSearch = page.getByRole("searchbox", { name: "Search", exact: true });
  async function search(input: Locator, query: string): Promise<void> {
    await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/search" && url.searchParams.get("q") === query && response.status() === 200;
      }),
      input.fill(query),
    ]);
  }
  for (const query of ["worksp", "space"]) {
    await search(listSearch, query);
    for (const title of [titleHit, bodyHit, descriptionHit]) {
      await expect(listedTitles(page).filter({ hasText: title })).toBeVisible();
    }
  }
  await search(listSearch, "mc");
  for (const title of [shortTitleHit, tagHit]) {
    await expect(listedTitles(page).filter({ hasText: title })).toBeVisible();
  }
  for (const title of [bodyHit, descriptionHit]) {
    await expect(listedTitles(page).filter({ hasText: title })).toHaveCount(0);
  }
  for (const query of ["ub", "uber"]) {
    await search(listSearch, query);
    await expect(listedTitles(page).filter({ hasText: shortTitleHit })).toBeVisible();
  }
  for (const query of ["wire", "ts"]) {
    await search(listSearch, query);
    await expect(listedTitles(page).filter({ hasText: languageHit })).toBeVisible();
  }

  // The palette uses the same live endpoint; its existing navigation matrix
  // stubs ranked hits to exercise decision-topic navigation independently.
  const apple = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform));
  await page.keyboard.press(apple ? "Meta+k" : "Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  await expect(palette).toBeVisible();
  const paletteSearch = palette.getByRole("combobox", { name: "Search documents and decisions", exact: true });
  await search(paletteSearch, "worksp");
  for (const title of [titleHit, bodyHit, descriptionHit]) {
    await expect(palette.getByRole("option", { name: `${title} Document`, exact: true })).toBeVisible();
  }
  for (const query of ["wire", "ts"]) {
    await search(paletteSearch, query);
    await expect(palette.getByRole("option", { name: `${languageHit} Document`, exact: true })).toBeVisible();
  }
});

interface DecisionFixture {
  uuid: string;
}

async function decision(
  writer: McpSession,
  title: string | undefined,
  text: string,
  fields: Record<string, unknown> = {},
): Promise<DecisionFixture> {
  return writer.call<DecisionFixture>("create_doc", {
    ...(title === undefined ? {} : { title }),
    kind: "decision", description: "Browser acceptance fixture.",
    blocks: [{ type: "paragraph", text }], ...fields,
  });
}

for (const touch of [false, true]) {
  test(`a decision row opens the current answer and browser history restores the list on ${touch ? "iPad touch" : "desktop keyboard"}${touch ? " @webkit-touch" : ""}`, async ({ browser }) => {
    const writer = agent().open({ name: "decision-list-history-e2e" });
    const title = docTitle("decisionhistory").replaceAll("-", "");
    const approval = { who: "A workspace member", when: "2026-10-04T12:00:00Z", where: "https://example.org/team/decision" };
    const first = await decision(writer, title, "Earlier answer is history.", { status: "decided", answer: approval });
    const answer = "Current answer stays in force during review.";
    const current = await decision(writer, undefined, answer, {
      status: "decided", supersedes: first.uuid, answer: approval, tags: ["auth"],
    });
    await decision(writer, undefined, "Pending proposal must not become the list answer.", { supersedes: current.uuid });
    const page = await openApp(browser, `/${harness().workspace}/all`, {
      readySelector: ".ub-docs-heading",
      contextOptions: touch ? devices["iPad (gen 7) landscape"] : { viewport: { width: 1440, height: 1000 } },
    });
    const type = page.getByRole("tab", { name: /^Decisions/ });
    const search = page.getByRole("searchbox", { name: "Search", exact: true });
    const tags = page.getByRole("button", { name: "Filter by tags", exact: true });
    const state = page.getByRole("combobox", { name: "Decision state", exact: true });
    const titleHeading = page.getByRole("columnheader", { name: /^Title/ });

    // These changes exercise the application's history writer as well as its reader.
    // Native control composition and filter permutations have focused owners.
    await activateControl(type, { touch });
    await search.fill(title);
    await activateControl(tags, { touch });
    await activateControl(page.getByRole("option", { name: "auth", exact: true }), { touch });
    await page.keyboard.press("Escape");
    await state.selectOption("under-review");
    await activateControl(titleHeading.getByRole("button", { name: "Title", exact: true }), { touch });
    await expect(listedTitles(page)).toHaveText([title]);
    const open = page.locator(".ub-docs-open");
    if (touch) await open.tap();
    else { await open.focus(); await open.press("Enter"); }
    await expect(page).toHaveURL(new RegExp(`/${first.uuid}$`));
    await expect(page.getByRole("textbox", { name: "Document title" })).toHaveValue(title);
    await expect(editor(page)).toHaveText(answer);
    await expect(page.locator(`.ub-decision-timeline > li[data-record="${current.uuid}"] .ub-decision-record`)).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".ub-decision-timeline")).not.toContainText("viewing");

    async function restoredVisit(): Promise<void> {
      await expect(page).toHaveURL(new RegExp(`/${harness().workspace}/all$`));
      await expect(type).toHaveAttribute("aria-selected", "true");
      await expect(search).toHaveValue(title);
      await expect(tags).toContainText("auth");
      await expect(state).toHaveValue("under-review");
      await expect(titleHeading).toHaveAttribute("aria-sort", "ascending");
      await expect(listedTitles(page)).toHaveText([title]);
    }
    async function defaults(): Promise<void> {
      await expect(page.getByRole("tab", { name: /^Documents/ })).toHaveAttribute("aria-selected", "true");
      await expect(search).toHaveValue("");
      await expect(tags).toContainText("Tag Any");
      await expect(state).toHaveCount(0);
      await expect(page.getByRole("columnheader", { name: /^Changed/ })).toHaveAttribute("aria-sort", "descending");
    }

    await page.goBack();
    await restoredVisit();
    await page.goForward();
    await expect(page.getByRole("textbox", { name: "Document title" })).toHaveValue(title);
    if (touch) await page.getByRole("button", { name: "Show document list", exact: true }).tap();
    const all = page.getByRole("button", { name: "All documents", exact: true });
    if (touch) await all.tap();
    else { await all.focus(); await all.press("Enter"); }
    await defaults();
    await page.goBack();
    await page.goBack();
    await restoredVisit();
    await page.goForward();
    await page.goForward();
    await defaults();
    await page.goBack();
    await page.goBack();
    await restoredVisit();
  });
}

test("search results retain focus, scroll and tag disclosure during directory refresh @webkit", async ({ browser }) => {
  const writer = agent().open({ name: "list-refresh-e2e" });
  const query = docTitle("listrefresh").replaceAll("-", "");
  for (let index = 0; index < 24; index += 1) {
    await writer.call("create_doc", {
      title: `${query} ${index}`, description: "A searchable row to keep mounted.",
      blocks: [{ type: "paragraph", text: "A matching document." }],
      tags: ["auth", "billing", "mcp", "permissions", "rfc", "sync"],
    });
  }
  const unrelatedTitle = docTitle("unrelatedrefresh");
  const unrelated = await writer.call<{ uuid: string }>("create_doc", {
    title: unrelatedTitle, description: "An unrelated directory entry.",
    blocks: [{ type: "paragraph", text: "This document does not match the query." }],
  });
  const page = await openApp(browser, `/${harness().workspace}/all`, {
    readySelector: ".ub-docs-heading",
    contextOptions: { viewport: { width: 1280, height: 640 } },
  });
  await expect(page.locator(".ub-docs-row", { hasText: unrelatedTitle })).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search" }).fill(query);
  const rows = page.locator(".ub-docs-row");
  await expect(rows).toHaveCount(24);
  const lastRow = rows.last();
  const open = lastRow.locator(".ub-docs-open");
  await open.focus();
  await expect(open).toBeFocused();
  const pane = page.locator(".ub-pane");
  const scroll = await pane.evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(100);
  let requested = 0;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/search?*", async (route) => {
    requested += 1;
    await held;
    await route.continue();
  });
  let refreshed: Promise<unknown> | undefined;
  try {
    await writer.call("set_metadata", { uuid: unrelated.uuid, title: `${unrelatedTitle} changed` });
    await expect.poll(() => requested).toBeGreaterThan(0);
    await expect(rows).toHaveCount(24);
    await expect(open).toBeFocused();
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(scroll);
    await expect(page.locator(".ub-docs-empty")).toHaveCount(0);
    const more = lastRow.getByRole("button", { name: /^Show all tags for/ });
    await more.focus();
    await more.press("Enter");
    const disclosure = page.getByRole("dialog", { name: /^All tags for/ });
    await expect(disclosure).toBeVisible();
    const arrivals = requested;
    await writer.call("set_metadata", { uuid: unrelated.uuid, description: "Another unrelated directory change." });
    await expect.poll(() => requested).toBeGreaterThan(arrivals);
    await expect(rows).toHaveCount(24);
    await expect(disclosure).toBeVisible();
    refreshed = page.waitForResponse((response) => response.url().includes("/api/search?") && response.status() === 200);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await refreshed;
  await expect(rows).toHaveCount(24);
  await expect(page.getByRole("dialog", { name: /^All tags for/ })).toBeVisible();
});
