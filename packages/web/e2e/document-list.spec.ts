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
 * accessibility and activation behavior. The same production path proves that
 * a body-only query crosses `ub open`'s authenticated search seam, while a page
 * connected directly to a hub names the unavailable state. Request races and
 * empty/failure wording stay in the focused unit suite. The lifecycle scenario
 * is the other browser-only seam: an external writer moves the open header and
 * the directory-backed row without a reload.
 */

import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { openUpstreamApp, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";

test.describe.configure({ mode: "serial" });

let started: Harness | null = null;
let mcpAgent: McpAgent | null = null;
const contexts: BrowserContext[] = [];

function harness(): Harness {
  if (started === null) {
    throw new Error("e2e: the harness is not running — its bootstrap failed");
  }
  return started;
}

function agent(): McpAgent {
  if (mcpAgent === null) {
    throw new Error("e2e: the MCP agent is not configured");
  }
  return mcpAgent;
}

test.beforeAll(async () => {
  started = await startHarness();
  mcpAgent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-document-list-",
  });
});

test.afterEach(async () => {
  await mcpAgent?.closeSessions();
  for (const context of contexts.splice(0)) await context.close();
});

test.afterAll(async () => {
  const running = started;
  started = null;
  await mcpAgent?.close();
  mcpAgent = null;
  await running?.stop();
});

/** A fresh context: its own history and its own tab. */
async function openApp(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  return page;
}

/** Unique per run: every test in the file shares one workspace. */
function docTitle(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The titles the list shows, top to bottom. */
function listedTitles(page: Page): Locator {
  return page.locator(".ub-docs-title");
}

async function createDoc(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  await page.locator(".ub-title").fill(title);
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
  // The field calls the store-backed search endpoint through the same real
  // `ub open`. Both terms occur only in the body, and the second is a prefix.
  const search = reader.getByRole("searchbox", { name: "Search document text" });
  await expect(search).toBeEnabled();
  await search.fill("bodyonly quasartr*");
  await expect(listedTitles(reader)).toHaveText([second]);

  // Titles are part of the same index, and clearing restores the whole list
  // locally rather than issuing an empty search.
  await search.fill(first);
  await expect(listedTitles(reader)).toHaveText([first]);
  await search.fill("");
  await expect(listedTitles(reader)).toHaveText([second, first]);

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
  const { context, page } = await openUpstreamApp(browser, harness());
  contexts.push(context);
  const unavailable = page.getByRole("searchbox", {
    name: "Search unavailable without ub open",
  });
  await expect(unavailable).toBeDisabled();
  await expect(page.locator(".ub-docs-search-state")).toContainText(
    "connected directly to a remote hub",
  );
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
