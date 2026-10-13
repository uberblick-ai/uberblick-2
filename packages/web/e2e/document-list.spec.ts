/**
 * The document list in a real browser.
 *
 * This holds transport, native activation, layout and real navigation: a
 * directory created by another context reaches this one, Enter and Space
 * activate its Title sort button, the filter spans the table, and All docs
 * enters the browser's history at `/<workspace>/all`. Legacy Product history
 * restores Working, and MCP decision adoption reaches the open page and list.
 *
 * The list searches the serving replica, preserves relevance through browser
 * filters, and retains each visit's controls across Back and Forward. Shared
 * tag controls and decision topics work with keyboard/pointer and iPad touch
 * in light and dark.
 */

import { devices, expect, test } from "@playwright/test";
import { activateControl, createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import type { Locator, Page } from "@playwright/test";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

const { harness, openApp } = setupHarness({ app: { readySelector: ".ub-list-head" } });

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

async function pickTags(page: Page, tags: readonly string[], touch: boolean): Promise<void> {
  const trigger = page.getByRole("button", { name: "Filter by tags", exact: true });
  if (touch) await trigger.tap();
  else { await trigger.focus(); await trigger.press("Enter"); }
  for (const [index, tag] of tags.entries()) {
    const option = page.getByRole("option", { name: tag, exact: true });
    if (touch) await option.tap();
    else if (index === 0) { await option.focus(); await option.press("Space"); }
    else await option.click();
    await expect(option).toHaveAttribute("aria-selected", "true");
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
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
  const table = reader.getByRole("table");
  const titleHeading = table.getByRole("columnheader", { name: /^Title/ });

  // One resulting order per native activation, rather than re-proving the
  // sort-state, glyph and ARIA sequence from the jsdom test.
  const titleSort = titleHeading.getByRole("button", { name: "Title" });
  await titleSort.focus();
  await reader.keyboard.press("Enter");
  await expect(listedTitles(reader)).toHaveText([first, second]);

  await reader.keyboard.press("Space");
  await expect(listedTitles(reader)).toHaveText([second, first]);

  const filterField = reader.getByRole("searchbox", {
    name: "Search",
  });
  // The width of the table it narrows, resolved by the browser's own layout.
  const box = await filterField.boundingBox();
  const tableBox = await table.boundingBox();
  expect(box?.width).toBeCloseTo(tableBox?.width ?? 0, 0);

  // The sidebar's fixed entry is the same list at its own address.
  const entry = reader.getByRole("button", { name: "All docs" });
  await entry.click();
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}/all$`));
  // The icon is painted; its name and pressed state belong to jsdom.
  const pin = reader.getByRole("button", { name: `Pin ${second} to the sidebar` });
  await expect(pin.locator("svg")).toBeVisible();

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
  await expect(linked.getByRole("button", { name: "Documents", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(linked.getByRole("button", { name: "Product", exact: true })).toHaveCount(0);
  await expect(listedTitles(linked)).toHaveText([first]);
  await linked.locator(".ub-docs-open").click();
  await expect(linked.locator(".ub-editor .ProseMirror")).toBeVisible();
  await linked.goBack();
  await expect(linked.getByRole("button", { name: "Documents", exact: true })).toHaveAttribute("aria-pressed", "true");
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
    "Decision · open",
  );
  await page.getByRole("button", { name: "All docs" }).click();
  await expect(page.locator(".ub-docs-row", { hasText: title })).toHaveCount(0);
  await page.getByRole("button", { name: "Decisions", exact: true }).click();
  await expect(
    page.locator(".ub-docs-row", { hasText: title }),
  ).toContainText("Not yet decided");
});

interface DecisionFixture {
  uuid: string;
  blocks: Array<{ id: string; text: string }>;
  tags: Array<{ id: string; name: string }>;
}

async function decision(
  writer: McpSession,
  title: string,
  text: string,
  fields: Record<string, unknown> = {},
): Promise<DecisionFixture> {
  return writer.call<DecisionFixture>("create_doc", {
    title, kind: "decision", description: "Browser acceptance fixture.",
    blocks: [{ type: "paragraph", text }], ...fields,
  });
}

for (const touch of [false, true]) for (const appearance of ["light", "dark"] as const) {
  test(`decision list filters and returns to topics on ${touch ? "iPad touch" : "desktop keyboard and pointer"} in ${appearance}`, async ({ browser }) => {
    const writer = agent().open({ name: "decision-list-e2e" });
    const prefix = docTitle("decisionlist").replaceAll("-", "");
    const approval = { who: "A workspace member", when: "2026-10-04T12:00:00Z", where: "https://example.org/team/decision" };
    const first = await decision(writer, `${prefix} earlier title`, "Earlier answer is history.", {
      status: "decided", answer: approval,
    });
    const currentTitle = `${prefix} current title`;
    const currentAnswer = "Current answer stays in force during review.";
    const current = await decision(writer, currentTitle, currentAnswer, {
      status: "decided", supersedes: first.uuid, answer: approval,
      tags: ["auth", "billing", "mcp", "rfc", "sync"],
    });
    const storedTags = current.tags.map((tag) => tag.name);
    const pending = await decision(writer, `${prefix} pending title`, "Pending proposal must not become the list answer.", {
      supersedes: current.uuid,
    });
    for (const record of [first, current, pending]) {
      const block = record.blocks[0];
      if (block === undefined) throw new Error("e2e: the decision has no answer");
      await writer.call("annotate", { uuid: record.uuid, block_id: block.id, start: 0, end: 7, text: "A cached conversation." });
    }
    const undecidedTitle = `${prefix} unanswered title`;
    await decision(writer, undecidedTitle, "This proposal is not an answer in force.", { tags: ["rfc"] });
    const stanceTitle = `${prefix} stance title`;
    await decision(writer, stanceTitle, "The agent recommends this answer.", { status: "decided", tags: ["rfc"] });
    const archived = await decision(writer, `${prefix} archived title`, "The whole topic will be archived.", {
      status: "decided", answer: approval,
    });
    await decision(writer, `${prefix} archived successor`, "An archived topic includes later proposals.", { supersedes: archived.uuid });
    await writer.call("archive_doc", { uuid: archived.uuid });

    const page = await openApp(browser, `/${harness().workspace}/all`, {
      readySelector: ".ub-docs-heading",
      contextOptions: { ...(touch ? devices["iPad (gen 7) landscape"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: appearance },
    });
    const type = page.getByRole("button", { name: "Decisions", exact: true });
    await activateControl(type, { touch });
    const titleFilter = page.getByRole("searchbox", { name: "Search" });
    await titleFilter.fill(prefix);
    const state = page.getByRole("combobox", { name: "Decision state" });
    await expect(state).toHaveValue("all");
    await expect(state.getByRole("option")).toHaveText([
      "All", "Not yet decided", "Under review", "Agent stance", "Conflict", "Changed after approval",
    ]);
    await expect.poll(async () => (await listedTitles(page).allTextContents()).sort())
      .toEqual([currentTitle, undecidedTitle, stanceTitle].sort());
    await expect(page.locator("thead [aria-sort]")).toHaveCount(0);
    const tagFilter = page.getByRole("button", { name: "Filter by tags", exact: true });
    await expect(tagFilter).toContainText("Any tag");
    const searchBox = await titleFilter.boundingBox();
    const typeBox = await type.boundingBox();
    expect(searchBox?.y).toBeLessThan(typeBox?.y ?? 0);
    await expect(titleFilter).toHaveAttribute("placeholder", "Search");
    await expect(titleFilter).toHaveCSS("border-top-width", "1px");
    await expect(titleFilter).toHaveCSS("font-size", "14px");
    await expect(titleFilter).toHaveCSS("line-height", "20px");
    await expect(titleFilter).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.getByRole("columnheader")).toHaveText(["Title", "Group", "Tags", "Changed", "Actions"]);
    if (!touch) {
      await titleFilter.focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Documents", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(type).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(tagFilter).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(state).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Title", exact: true })).toBeFocused();
    }
    await pickTags(page, ["auth", "rfc"], touch);
    await expect(tagFilter).toContainText("auth, rfc");
    await expect.poll(async () => (await listedTitles(page).allTextContents()).sort())
      .toEqual([currentTitle, undecidedTitle, stanceTitle].sort());
    const currentRow = page.locator(".ub-docs-row", { hasText: currentTitle });
    await activateControl(currentRow.getByRole("button", { name: "auth", exact: true }), { touch });
    await expect(page).toHaveURL(new RegExp(`/${harness().workspace}/all$`));
    await expect(tagFilter).toContainText("auth");
    await expect(tagFilter).not.toContainText("rfc");
    await expect(listedTitles(page)).toHaveText([currentTitle]);
    const more = currentRow.getByRole("button", { name: `Show all tags for ${currentTitle}`, exact: true });
    await expect(more).toBeVisible();
    if (!touch) {
      await more.hover();
      await expect(page.getByRole("tooltip")).toContainText(storedTags.join(", "));
      await more.focus();
      await more.press("Enter");
    } else await more.tap();
    const allTags = page.getByRole("dialog", { name: `All tags for ${currentTitle}`, exact: true });
    await expect(allTags.getByRole("button")).toHaveText(storedTags);
    await activateControl(allTags.getByRole("button", { name: "billing", exact: true }), { touch });
    await expect(allTags).toHaveCount(0);
    await expect(tagFilter).toContainText("billing");
    await activateControl(tagFilter, { touch });
    await activateControl(page.getByRole("button", { name: "Clear tags", exact: true }), { touch });
    await page.keyboard.press("Escape");
    await expect(tagFilter).toContainText("Any tag");
    await pickTags(page, ["auth"], touch);

    // Native select input and row activation are real on each supported device;
    // the full cached state matrix and room-join invariant belong to unit tests.
    if (touch) {
      await state.tap();
      await state.selectOption("under-review");
    } else {
      await state.focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("u");
      await page.keyboard.press("Enter");
    }
    await expect(state).toHaveValue("under-review");
    await expect(listedTitles(page)).toHaveText([currentTitle]);
    await activateControl(page.getByRole("button", { name: "Documents", exact: true }), { touch });
    await expect(titleFilter).toHaveValue(prefix);
    await expect(tagFilter).toContainText("auth");
    await activateControl(type, { touch });
    await expect(state).toHaveValue("under-review");
    await expect(listedTitles(page)).toHaveText([currentTitle]);
    await activateControl(page.getByRole("button", { name: "Title", exact: true }), { touch });
    await expect(page.getByRole("columnheader", { name: /^Title/ })).toHaveAttribute("aria-sort", "ascending");
    const row = page.locator(".ub-docs-row");
    await expect(row).toContainText("Under review");
    await expect(row).toContainText(currentAnswer);
    await expect(row).not.toContainText("Pending proposal must not become the list answer.");
    await expect(row).toContainText("3 comments");
    await expect(row.locator("time")).toBeVisible();
    await expect(row.locator("time")).toHaveCSS("font-variant-numeric", "tabular-nums");
    await expect(row.locator(".ub-docs-age-cell")).toHaveCSS("text-align", "right");
    const cellBorders = await page.locator(".ub-docs-table th, .ub-docs-table td").evaluateAll((cells) =>
      cells.map((cell) => ({ left: getComputedStyle(cell).borderLeftWidth, right: getComputedStyle(cell).borderRightWidth })));
    expect(cellBorders.every((border) => border.left === "0px" && border.right === "0px")).toBe(true);
    const screenshot = test.info().outputPath("decision-list.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    await test.info().attach(`decision-list-${touch ? "ipad" : "desktop"}-${appearance}`, {
      path: screenshot, contentType: "image/png",
    });
    const open = row.locator(".ub-docs-open");
    if (touch) await open.tap();
    else { await open.focus(); await page.keyboard.press("Enter"); }
    await expect(page).toHaveURL(new RegExp(`/${first.uuid}$`));
    await expect(page.getByRole("heading", { name: currentTitle, exact: true })).toBeVisible();
    await expect(editor(page)).toHaveText(currentAnswer);
    await expect(page.locator(`.ub-decision-timeline > li[data-record="${current.uuid}"] .ub-decision-record`)).toHaveAttribute("aria-current", "true");

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/${harness().workspace}/all$`));
    await expect(type).toHaveAttribute("aria-pressed", "true");
    await expect(state).toHaveValue("under-review");
    await expect(titleFilter).toHaveValue(prefix);
    await expect(tagFilter).toContainText("auth");
    await expect(page.getByRole("columnheader", { name: /^Title/ })).toHaveAttribute("aria-sort", "ascending");
    await expect(listedTitles(page)).toHaveText([currentTitle]);

    await page.goForward();
    await expect(page.getByRole("heading", { name: currentTitle, exact: true })).toBeVisible();
    if (touch) await page.getByRole("button", { name: "Show document list", exact: true }).tap();
    await activateControl(page.getByRole("button", { name: "All docs", exact: true }), { touch });
    await expect(page.getByRole("button", { name: "Documents", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(titleFilter).toHaveValue("");
    await expect(state).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: /^Changed/ })).toHaveAttribute("aria-sort", "descending");
    await page.goBack();
    await page.goBack();
    await expect(type).toHaveAttribute("aria-pressed", "true");
    await expect(state).toHaveValue("under-review");
    await expect(titleFilter).toHaveValue(prefix);
    await expect(tagFilter).toContainText("auth");
    await expect(listedTitles(page)).toHaveText([currentTitle]);
    await page.goForward();
    await page.goForward();
    await expect(page.getByRole("button", { name: "Documents", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(titleFilter).toHaveValue("");
    await page.goBack();
    await page.goBack();

    await activateControl(tagFilter, { touch });
    await activateControl(page.getByRole("button", { name: "Clear tags", exact: true }), { touch });
    await page.keyboard.press("Escape");

    await activateControl(state, { touch });
    await state.selectOption("agent-stance");
    await expect(listedTitles(page)).toHaveText([stanceTitle]);
    await expect(page.locator(".ub-docs-row")).toContainText("Agent stance");
    await expect(page.locator(".ub-docs-row")).not.toContainText("In force");
    await titleFilter.fill(`absent${prefix}`);
    await expect(page.locator(".ub-docs-empty")).toContainText("Agent stance");
    await expect(page.locator(".ub-docs-empty")).not.toContainText("No decision records in this workspace");
    await titleFilter.fill(prefix);
    await state.selectOption("changed-after-approval");
    await expect(page.locator(".ub-docs-empty")).toContainText("Changed after approval");
    await pickTags(page, ["auth", "rfc"], touch);
    await expect(page.locator(".ub-docs-empty")).toContainText("auth");
    await expect(page.locator(".ub-docs-empty")).toContainText("rfc");
    await expect(page.locator(".ub-docs-empty")).toContainText(prefix);
    await activateControl(page.getByRole("button", { name: "Clear filters", exact: true }), { touch });
    await expect(titleFilter).toHaveValue("");
    await expect(tagFilter).toContainText("Any tag");
    await expect(page.getByRole("button", { name: "Documents", exact: true })).toHaveAttribute("aria-pressed", "true");
    await activateControl(type, { touch });
    await expect(state).toHaveValue("all");
  });
}

test("local search matches all fields and word forms, keeps shared relevance, and finds a topic's history", async ({ browser }) => {
  const writer = agent().open({ name: "shared-list-search-e2e" });
  const marker = docTitle("sharedsearch").replaceAll("-", "");
  const fixtures = [
    { title: `Launching ${marker}`, description: "A title match.", text: "A release plan." },
    { title: `A description match ${marker}`, description: "We are launching the release.", text: "The owner and schedule." },
    { title: `Z body match ${marker}`, description: "A content match.", text: "We are launching the release." },
    { title: `Tag lookup ${marker}`, description: "Only its tag names this subject.", text: "A routine plan.", tags: ["sync"] },
  ];
  const names = new Map<string, string>();
  for (const fixture of fixtures) {
    const created = await writer.call<{ uuid: string }>("create_doc", {
      title: fixture.title, description: fixture.description,
      blocks: [{ type: "paragraph", text: fixture.text }],
      ...(fixture.tags === undefined ? {} : { tags: fixture.tags }),
    });
    names.set(created.uuid, fixture.title);
  }
  const page = await openApp(browser, `/${harness().workspace}/all`);
  const mcp = await writer.call<{ hits: Array<{ uuid: string }> }>("search", { query: "launch", limit: 100 });
  const expected = mcp.hits.map((hit) => names.get(hit.uuid));
  expect(expected).not.toContain(undefined);
  const search = page.getByRole("searchbox", { name: "Search" });
  await search.fill("launch");
  await expect(listedTitles(page)).toHaveText(expected as string[]);
  await expect(page.locator("thead [aria-sort]")).toHaveCount(0);
  // A nonmatching second word leaves every launch match: words combine with OR.
  await search.fill(`launch absent${marker}`);
  await expect(listedTitles(page)).toHaveText(expected as string[]);
  await page.getByRole("button", { name: "Title", exact: true }).click();
  const titleOrder = fixtures.slice(0, 3).map((fixture) => fixture.title).sort((left, right) => left.localeCompare(right));
  await expect(listedTitles(page)).toHaveText(titleOrder);
  await expect(page.getByRole("columnheader", { name: /^Title/ })).toHaveAttribute("aria-sort", "ascending");
  // Even an edit with the same effective words restores shared relevance.
  await search.fill("launch ");
  await expect(listedTitles(page)).toHaveText(expected as string[]);
  await expect(page.locator("thead [aria-sort]")).toHaveCount(0);
  await search.fill("");
  await expect(page.getByRole("columnheader", { name: /^Title/ })).toHaveAttribute("aria-sort", "ascending");
  await search.fill("sync");
  await expect(listedTitles(page)).toHaveText([`Tag lookup ${marker}`]);

  const historyWord = `historical${marker}`;
  const approval = { who: "A workspace member", when: "2026-10-04T12:00:00Z", where: "https://example.org/team/decision" };
  const first = await decision(writer, `${marker} former question`, `${historyWord} belongs to the previous answer.`, { status: "decided", answer: approval });
  const current = await decision(writer, `${marker} current question`, "The current answer still appears.", { status: "decided", supersedes: first.uuid, answer: approval });
  await search.fill(historyWord);
  await page.getByRole("button", { name: "Decisions", exact: true }).click();
  await expect(listedTitles(page)).toHaveText([`${marker} current question`]);
  await expect(page.locator(".ub-docs-row")).toContainText("The current answer still appears.");
  await page.locator(".ub-docs-open").click();
  await expect(page).toHaveURL(new RegExp(`/${first.uuid}$`));
  await expect(page.locator(`.ub-decision-timeline > li[data-record="${current.uuid}"] .ub-decision-record`)).toHaveAttribute("aria-current", "true");
  await page.goBack();
  await page.route("**/api/search?*", (route) => route.fulfill({ status: 503, json: { error: "replica_unavailable" } }));
  await search.fill(`absent${marker}`);
  await expect(page.locator(".ub-docs-empty")).toContainText("Search is unavailable");
  await expect(page.locator(".ub-docs-empty")).not.toContainText("No decisions");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("button", { name: "Documents", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a tag filter retains a matching document beyond the first 100 shared search hits", async ({ browser }) => {
  test.setTimeout(120_000);
  const writer = agent().open({ name: "uncapped-list-search-e2e" });
  const query = docTitle("uncappedsearch").replaceAll("-", "");
  for (let index = 0; index < 149; index += 1) {
    await writer.call("create_doc", {
      title: `${query} ${index}`, description: "A high-ranked title match.",
      blocks: [{ type: "paragraph", text: "A release plan." }], tags: ["billing"],
    });
  }
  const tailTitle = `Filtered tail ${query.slice(-6)}`;
  const tail = await writer.call<{ uuid: string }>("create_doc", {
    title: tailTitle, description: "A low-ranked content match.",
    blocks: [{ type: "paragraph", text: `${query} ${"Other planning details. ".repeat(40)}` }], tags: ["auth"],
  });
  const page = await openApp(browser, `/${harness().workspace}/all`);
  const mcp = await writer.call<{ hits: Array<{ uuid: string }> }>("search", { query, limit: 100 });
  expect(mcp.hits.map((hit) => hit.uuid)).not.toContain(tail.uuid);
  await page.getByRole("searchbox", { name: "Search" }).fill(query);
  await expect(page.locator(".ub-docs-row")).toHaveCount(150);
  await pickTags(page, ["auth"], false);
  await expect(listedTitles(page)).toHaveText([tailTitle]);
});

for (const touch of [false, true]) test(`tag measurement does not widen the document pane and overflow stays accessible on ${touch ? "iPad touch" : "desktop keyboard"} @webkit`, async ({ browser }) => {
  const contextOptions = { ...(touch ? devices["iPad (gen 7) landscape"] : { viewport: { width: 1024, height: 768 }, hasTouch: false, isMobile: false }) };
  const settings = await openApp(browser, `/${harness().workspace}/settings/tags`, {
    upstream: true,
    readySelector: "#ub-new-tag",
    contextOptions,
  });
  const tagPrefix = touch ? "touch" : "measure";
  const tags = Array.from({ length: 8 }, (_, index) => `${tagPrefix}-${index}-long-overflow-tags`);
  const firstTag = `${tagPrefix}-0-long-overflow-tags`;
  for (const tag of tags) {
    await settings.getByLabel("Create a tag").fill(tag);
    await settings.getByRole("button", { name: "Create", exact: true }).click();
    await expect(settings.getByRole("button", { name: `Retire ${tag}`, exact: true })).toBeVisible();
  }
  const title = docTitle("tagmeasurement");
  const writer = agent().open({ name: "tag-measurement-e2e" });
  const created = await writer.call<{ tags: Array<{ name: string }> }>("create_doc", {
    title, description: "A row with more tags than its pane can fit.",
    blocks: [{ type: "paragraph", text: "All tags remain available through overflow." }], tags,
  });
  const page = await openApp(browser, `/${harness().workspace}/all`, {
    readySelector: ".ub-docs-heading",
    contextOptions,
  });
  expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(touch);
  await page.getByRole("searchbox", { name: "Search" }).fill(title);
  const row = page.locator(".ub-docs-row", { hasText: title });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".ub-docs-tags-cell")).toBeVisible();
  const pane = page.locator(".ub-pane");
  const dimensions = await pane.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  const measuredWidth = await row.locator(".ub-docs-tag-measure").evaluate((element) =>
    Array.from(element.children).reduce((width, chip) => width + chip.getBoundingClientRect().width, 0));
  expect(measuredWidth).toBeGreaterThan(dimensions.client);
  expect(dimensions.scroll).toBe(dimensions.client);
  const more = row.getByRole("button", { name: `Show all tags for ${title}`, exact: true });
  await expect(more).toHaveText("+8");
  if (touch) await more.tap();
  else { await more.focus(); await more.press("Enter"); }
  const disclosure = page.getByRole("dialog", { name: `All tags for ${title}`, exact: true });
  await expect(disclosure.getByRole("button")).toHaveText(created.tags.map((tag) => tag.name));
  await activateControl(disclosure.getByRole("button", { name: firstTag, exact: true }), { touch });
  await expect(disclosure).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter by tags", exact: true })).toContainText(firstTag);
  await expect(listedTitles(page)).toHaveText([title]);
});

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
