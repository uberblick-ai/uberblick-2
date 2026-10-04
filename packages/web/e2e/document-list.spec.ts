/**
 * The document list in a real browser (#406).
 *
 * This holds transport, native activation, layout and real navigation: a
 * directory created by another context reaches this one, Enter and Space
 * activate its Title sort button, the filter spans the table, and All docs
 * enters the browser's history at `/<workspace>/all`. An external MCP status
 * write reaches both the open document and the directory without a reload.
 *
 * Sort state, title-only filtering, its absence of search requests, list
 * content, creation and lifecycle rendering stay in the jsdom suite. Each
 * native sort activation checks only the row order witnessing that input.
 */

import { expect, test } from "@playwright/test";
import { createDoc, docTitle, setupHarness } from "./app-helpers.js";
import type { Locator, Page } from "@playwright/test";
import { McpAgent } from "./mcp-agent.js";

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
});

test("an external status write reaches the open document and the directory", async ({
  browser,
}) => {
  const title = docTitle("roadmap");
  // The local/upstream store replay is #752. This criterion concerns #441's
  // lifecycle UI, so keep its browser on the same upstream as its MCP writer.
  const page = await openApp(browser, "/", { upstream: true });
  const session = agent().open({ name: "document-list-e2e" });
  const created = await session.call<{ uuid: string }>("create_doc", {
    title,
    description: "A roadmap item created outside the browser.",
    kind: "requirement",
    status: "planned",
  });
  await page.getByRole("button", { name: "Product", exact: true }).click();
  const row = page.locator(".ub-docs-row", { hasText: title });
  await row.locator(".ub-docs-open").click();
  await page.locator(".ub-editor .ProseMirror").waitFor({ state: "visible" });
  await session.call("set_status", {
    uuid: created.uuid,
    status: "implementing",
  });
  await expect(page.locator(".ub-lifecycle-badge")).toHaveText(
    "Product · implementing",
  );
  await page.getByRole("button", { name: "All docs" }).click();
  await page.getByRole("button", { name: "Product", exact: true }).click();
  await expect(
    page.locator(".ub-docs-row", { hasText: title }).locator(".ub-lifecycle-badge"),
  ).toHaveText("Product · implementing");
});
