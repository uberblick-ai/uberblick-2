/**
 * The document list in a real browser.
 *
 * This holds transport, native activation, layout and real navigation: a
 * directory created by another context reaches this one, Enter and Space
 * activate its Title sort button, the filter spans the table, and All docs
 * enters the browser's history at `/<workspace>/all`. Legacy Product history
 * restores Working, and MCP decision adoption reaches the open page and list.
 *
 * Sort state, title-only filtering, its absence of search requests, list
 * content, creation and lifecycle rendering stay in the jsdom suite. Each
 * native sort activation checks only the row order witnessing that input.
 * Decision topics retain their current answer and list filters across a topic
 * visit, with keyboard/pointer and iPad touch input in light and dark.
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
    name: "Filter this list by title",
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
  await expect(linked.getByRole("button", { name: "Working", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(linked.getByRole("button", { name: "Product", exact: true })).toHaveCount(0);
  await expect(listedTitles(linked)).toHaveText([first]);
  await linked.locator(".ub-docs-open").click();
  await expect(linked.locator(".ub-editor .ProseMirror")).toBeVisible();
  await linked.goBack();
  await expect(linked.getByRole("button", { name: "Working", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(linked.getByRole("searchbox", { name: "Filter this list by title" })).toHaveValue(first);
  await expect(linked.getByRole("columnheader", { name: /^Title/ })).toHaveAttribute("aria-sort", "descending");
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
    const prefix = docTitle("decision-list");
    const approval = { who: "A workspace member", when: "2026-10-04T12:00:00Z", where: "https://example.org/team/decision" };
    const first = await decision(writer, `${prefix} earlier title`, "Earlier answer is history.", {
      status: "decided", answer: approval,
    });
    const currentTitle = `${prefix} current title`;
    const currentAnswer = "Current answer stays in force during review.";
    const current = await decision(writer, currentTitle, currentAnswer, {
      status: "decided", supersedes: first.uuid, answer: approval,
    });
    const pending = await decision(writer, `${prefix} pending title`, "Pending proposal must not become the list answer.", {
      supersedes: current.uuid,
    });
    for (const record of [first, current, pending]) {
      const block = record.blocks[0];
      if (block === undefined) throw new Error("e2e: the decision has no answer");
      await writer.call("annotate", { uuid: record.uuid, block_id: block.id, start: 0, end: 7, text: "A cached conversation." });
    }
    const undecidedTitle = `${prefix} unanswered title`;
    await decision(writer, undecidedTitle, "This proposal is not an answer in force.");
    const stanceTitle = `${prefix} stance title`;
    await decision(writer, stanceTitle, "The agent recommends this answer.", { status: "decided" });
    const archived = await decision(writer, `${prefix} archived title`, "The whole topic will be archived.", {
      status: "decided", answer: approval,
    });
    await decision(writer, `${prefix} archived successor`, "An archived topic includes later proposals.", { supersedes: archived.uuid });
    await writer.call("archive_doc", { uuid: archived.uuid });

    const page = await openApp(browser, `/${harness().workspace}/all`, {
      upstream: true,
      readySelector: ".ub-docs-heading",
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: appearance },
    });
    const type = page.getByRole("button", { name: "Decisions", exact: true });
    await activateControl(type, { touch });
    const titleFilter = page.getByRole("searchbox", { name: "Filter this list by title" });
    await titleFilter.fill(prefix);
    const state = page.getByRole("combobox", { name: "Decision state" });
    await expect(state).toHaveValue("all");
    await expect(state.getByRole("option")).toHaveText([
      "All", "Not yet decided", "Under review", "Agent stance", "Conflict", "Changed after approval",
    ]);
    await expect.poll(async () => (await listedTitles(page).allTextContents()).sort())
      .toEqual([currentTitle, undecidedTitle, stanceTitle].sort());
    await expect(page.getByRole("columnheader", { name: /^Last changed/ })).toHaveAttribute("aria-sort", "descending");

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
    const row = page.locator(".ub-docs-row");
    await expect(row).toContainText("Under review");
    await expect(row).toContainText(currentAnswer);
    await expect(row).not.toContainText("Pending proposal must not become the list answer.");
    await expect(row).toContainText("3 comments");
    await expect(row.locator("time")).toBeVisible();
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
    await expect(listedTitles(page)).toHaveText([currentTitle]);

    await page.goForward();
    await expect(page.getByRole("heading", { name: currentTitle, exact: true })).toBeVisible();
    if (touch) await page.getByRole("button", { name: "Show document list", exact: true }).tap();
    await activateControl(page.getByRole("button", { name: "All docs", exact: true }), { touch });
    await expect(page.getByRole("button", { name: "Working", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(titleFilter).toHaveValue("");
    await expect(state).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: /^Last changed/ })).toHaveAttribute("aria-sort", "descending");
    await page.goBack();
    await page.goBack();
    await expect(type).toHaveAttribute("aria-pressed", "true");
    await expect(state).toHaveValue("under-review");
    await expect(titleFilter).toHaveValue(prefix);
    await expect(listedTitles(page)).toHaveText([currentTitle]);
    await page.goForward();
    await page.goForward();
    await expect(page.getByRole("button", { name: "Working", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(titleFilter).toHaveValue("");
    await page.goBack();
    await page.goBack();

    await activateControl(state, { touch });
    await state.selectOption("agent-stance");
    await expect(listedTitles(page)).toHaveText([stanceTitle]);
    await expect(page.locator(".ub-docs-row")).toContainText("Agent stance");
    await expect(page.locator(".ub-docs-row")).not.toContainText("In force");
    await titleFilter.fill(currentTitle);
    await expect(page.locator(".ub-docs-empty")).toContainText("Agent stance");
    await expect(page.locator(".ub-docs-empty")).not.toContainText("No decision records in this workspace");
    await titleFilter.fill(prefix);
    await state.selectOption("changed-after-approval");
    await expect(page.locator(".ub-docs-empty")).toContainText("Changed after approval");
  });
}
