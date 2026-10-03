/**
 * The document list in a real browser (#406).
 *
 * One spec, and only for the claims jsdom cannot make: that the workspace's own
 * address is the list — the first screen of a session, in a real bundle beside
 * a real sidebar — that the sidebar's fixed entry navigates a real history to
 * `/<workspace>/all` and finds the same list there, and that what both show is
 * a directory which travelled the hub: the documents were created in another
 * browser context, and nothing told this one about them.
 *
 * The semantic table and keyboard-sort contract need the browser's own
 * accessibility and activation behavior. So does the filter above it, and for
 * three claims jsdom cannot make: that it issues no request over a real
 * network from a page a real `ub open` is serving, that it is laid out at the
 * width of the table it narrows, and that a page connected straight at a hub —
 * with no `ub open` behind it at all — filters exactly the same way. Which
 * text it matches, and the wording of an empty list, stay in the focused unit
 * suite. The lifecycle scenario is the other browser-only seam: an external
 * writer moves the open header and the directory-backed row without a reload.
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
  const first = docTitle("zebra");
  const second = docTitle("aardvark");

  const [author, reader] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(author, first);
  await createDoc(author, second);
  await author.locator(".ub-editor .ProseMirror").fill("bodyonly quasartrail");

  // The second browser was told nothing: the directory is a synced document,
  // and the list is that document. `/` resolves to the workspace's own address,
  // which is where a session starts.
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}$`));
  // Most recently changed first — the second document was created last.
  await expect(listedTitles(reader)).toHaveText([second, first]);
  const table = reader.getByRole("table");
  const titleHeading = table.getByRole("columnheader", { name: /^Title/ });
  const changedHeading = table.getByRole("columnheader", { name: /^Last changed/ });
  await expect(changedHeading).toHaveAttribute("aria-sort", "descending");
  await expect(titleHeading).not.toHaveAttribute("aria-sort");

  // Native buttons give the two headers the same keyboard and pointer path.
  const titleSort = titleHeading.getByRole("button", { name: "Title" });
  await titleSort.focus();
  await reader.keyboard.press("Enter");
  await expect(titleHeading).toHaveAttribute("aria-sort", "ascending");
  await expect(titleHeading.locator(".ub-docs-sort-arrow")).toHaveText("↑");
  await expect(changedHeading).not.toHaveAttribute("aria-sort");

  await reader.keyboard.press("Space");
  await expect(titleHeading).toHaveAttribute("aria-sort", "descending");
  await expect(listedTitles(reader)).toHaveText([first, second]);

  await changedHeading.getByRole("button", { name: "Last changed" }).click();
  await expect(changedHeading).toHaveAttribute("aria-sort", "descending");
  await expect(listedTitles(reader)).toHaveText([second, first]);
  // The field narrows the rows already on screen, and asks this real `ub open`
  // nothing while doing it.
  const searched: string[] = [];
  reader.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/search") searched.push(request.url());
  });
  const filterField = reader.getByRole("searchbox", {
    name: "Filter this list by title",
  });
  await expect(filterField).toBeEnabled();
  await expect(filterField).toHaveAttribute("placeholder", "Filter by title");
  // The width of the table it narrows, resolved by the browser's own layout.
  const box = await filterField.boundingBox();
  const tableBox = await table.boundingBox();
  expect(box?.width).toBeCloseTo(tableBox?.width ?? 0, 0);

  // The term occurs only in the second document's body, which this field does
  // not consult — the index still holds it, and nobody asked the index.
  await filterField.fill("bodyonly");
  await expect(listedTitles(reader)).toHaveText([]);

  // Titles it does consult, folding case, and clearing restores the list.
  await filterField.fill(first.toUpperCase());
  await expect(listedTitles(reader)).toHaveText([first]);
  await filterField.fill("");
  await expect(listedTitles(reader)).toHaveText([second, first]);
  expect(searched).toEqual([]);

  // The sidebar's fixed entry is the same list at its own address.
  const entry = reader.getByRole("button", { name: "All docs" });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}/all$`));
  await expect(listedTitles(reader)).toHaveText([second, first]);
  // Named after its own row, so the two pins are two different controls.
  const pin = reader.getByRole("button", { name: `Pin ${second} to the sidebar` });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect(pin.locator("svg")).toBeVisible();

  // And the address is a link: a fresh browser goes straight there.
  const linked = await openApp(browser);
  await linked.goto(new URL(`/${harness().workspace}/all`, harness().appUrl).href);
  await expect(listedTitles(linked)).toHaveText([second, first]);

  // Opening a row is opening the document.
  await listedTitles(linked).first().click();
  await expect(linked.locator(".ub-title")).toHaveValue(second);
});

test("a new document stores the title shown by the list", async ({ browser }) => {
  const page = await openApp(browser);

  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-title")).toHaveValue("Untitled");

  // The stored title is literally "Untitled", so the title filter finds it —
  // unlike a row whose title is absent and merely drawn as that word.
  await page.getByRole("button", { name: "All docs" }).click();
  await page.locator(".ub-docs-search").fill("untitled");
  await expect(listedTitles(page)).toHaveText(["Untitled"]);
});

test("a lifecycle update outside the browser moves the row and both badges", async ({
  browser,
}) => {
  const title = docTitle("roadmap");
  // The local/upstream store replay is #752. This criterion concerns #441's
  // lifecycle UI, so keep its browser on the same upstream as its MCP writer.
  const page = await openApp(browser, "/", { upstream: true });
  // No `ub open` behind this page, and the filter does not care: what it
  // narrows already arrived over the hub connection.
  const filterField = page.getByRole("searchbox", {
    name: "Filter this list by title",
  });
  await expect(filterField).toBeEnabled();
  await expect(page.locator(".ub-docs")).not.toContainText("unavailable");
  const session = agent().open({ name: "document-list-e2e" });
  const created = await session.call<{ uuid: string }>("create_doc", {
    title,
    description: "A roadmap item created outside the browser.",
    kind: "requirement",
    status: "planned",
  });
  await page.getByRole("button", { name: "Product", exact: true }).click();
  const row = page.locator(".ub-docs-row", { hasText: title });
  await expect(row.locator(".ub-lifecycle-badge")).toHaveText(
    "Product · planned",
  );

  await filterField.fill(title);
  await expect(page.locator(".ub-docs-row")).toHaveCount(1);
  await filterField.fill("");

  await row.locator(".ub-docs-open").click();
  await expect(page.locator(".ub-lifecycle-badge")).toHaveText(
    "Product · planned",
  );
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
