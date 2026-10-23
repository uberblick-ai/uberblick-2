/** JSON trees are view chrome over ordinary code source, read and edited through the production replica. */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const MINIFIED = '{"name":"planner","limits":{"tokens":9007199254740993,"price":1.50},"steps":[{"id":"read"},{"id":"write"}]}';
const FORMATTED = '{\n  "name": "planner",\n  "limits": {\n    "tokens": 9007199254740993,\n    "price": 1.50\n  },\n  "steps": [\n    {\n      "id": "read"\n    },\n    {\n      "id": "write"\n    }\n  ]\n}';

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-json-tree-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: JSON tree MCP agent is not configured");
  return agent.open({ name: "json-tree-e2e" });
}

async function treeDoc(session: McpSession, title: string, text: string): Promise<string> {
  const result = await session.call<{ uuid: string }>("create_doc", {
    title, description: "A JSON tree over ordinary code source.",
    blocks: [{ type: "paragraph", text: "Neighbor prose." }, { type: "code", language: "json-tree", text }],
  });
  return result.uuid;
}

async function codeText(session: McpSession, uuid: string): Promise<string | undefined> {
  const result = await session.call<{ blocks: { type: string; text: string }[] }>("get_doc", { uuid });
  return result.blocks.find((block) => block.type === "code")?.text;
}

function row(page: Page, path: string) {
  return page.locator(`.ub-json-row[data-path="${path}"]`);
}

test("an MCP-authored tree folds by keyboard, and Edit and Done format the stored text", async ({ browser }) => {
  const session = writer();
  const uuid = await treeDoc(session, "JSON tree editing", MINIFIED);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expect(page.getByRole("tree", { name: "JSON tree" })).toBeVisible();
  await expect(row(page, ".limits.tokens")).toContainText("9007199254740993");
  await expect(row(page, ".limits.price")).toContainText("1.50");
  await expect(page.locator(".ub-json-tree-source")).toBeHidden();

  await row(page, ".limits").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, ".limits")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, ".limits")).toContainText("2 keys");
  await page.keyboard.press("ArrowDown");
  await expect(row(page, ".steps")).toBeFocused();

  await page.locator(".ub-json-tree").hover();
  await page.getByRole("button", { name: "Edit JSON", exact: true }).click();
  await expect(page.locator(".ub-json-tree-source")).toBeVisible();
  await expect(page.getByRole("tree", { name: "JSON tree" })).toBeHidden();
  await expectMcp(() => codeText(session, uuid), (text) => { expect(text).toBe(FORMATTED); });

  await page.keyboard.type("x");
  await expect(page.locator(".ub-json-tree-validity")).toHaveText("");
  await expect(page.locator(".ub-json-tree-validity")).toContainText("Not valid JSON", { timeout: 5_000 });
  await page.keyboard.press("Backspace");
  await expect(page.locator(".ub-json-tree-validity")).toHaveText("");

  await page.getByRole("button", { name: "Done editing JSON", exact: true }).click();
  await expect(page.getByRole("tree", { name: "JSON tree" })).toBeVisible();
  // The reader's fold choice outlived the edit.
  await expect(row(page, ".limits")).toHaveAttribute("aria-expanded", "false");
  await expectMcp(() => codeText(session, uuid), (text) => { expect(text).toBe(FORMATTED); });
});

test("Expand opens a full-screen viewer whose search opens folded matches and follows remote edits", async ({ browser }) => {
  const session = writer();
  const source = JSON.stringify({ agents: [{ id: "implementer", labels: ["needs-review"] }, { id: "reviewer", labels: [] }], review: true,
    filler: Array.from({ length: 30 }, (_, index) => ({ index })) });
  const uuid = await treeDoc(session, "JSON tree viewer", source);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await page.locator(".ub-json-tree").hover();
  await page.getByRole("button", { name: "Expand JSON tree", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "JSON tree", exact: true });
  await expect(viewer).toBeVisible();

  const search = viewer.getByRole("searchbox", { name: "Search keys and values" });
  const close = viewer.getByRole("button", { name: "Close JSON viewer", exact: true });
  expect((await search.boundingBox())?.height).toBe((await close.boundingBox())?.height);
  await viewer.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(viewer.locator('.ub-json-row[data-path=".agents"]')).toHaveAttribute("aria-expanded", "false");
  await search.fill("review");
  await expect(viewer.locator(".ub-json-tree-count")).toHaveText("1 of 3");
  await expect(viewer.locator(".ub-json-match-current")).toHaveText("review");
  await expect(viewer.locator('.ub-json-row[data-path=".agents[0].labels"]')).toHaveAttribute("aria-expanded", "true");
  await search.press("Enter");
  await expect(viewer.locator(".ub-json-tree-count")).toHaveText("2 of 3");
  await search.press("Shift+Enter");
  await search.press("Shift+Enter");
  await expect(viewer.locator(".ub-json-tree-count")).toHaveText("3 of 3");

  const block = await session.call<{ blocks: { id: string; type: string; text: string; rev: string }[] }>("get_doc", { uuid });
  const code = block.blocks.find((entry) => entry.type === "code");
  if (code === undefined) throw new Error("e2e: JSON tree block is missing");
  await session.call("edit_block", { uuid, block_id: code.id, rev: code.rev, old_text: code.text, new_text: code.text.replace('"reviewer"', '"second reviewer"') });
  await expect(viewer.getByText('"second reviewer"')).toBeVisible();
  await expect(viewer.locator(".ub-json-tree-count")).toContainText("of 3");
  await expect(search).toHaveValue("review");

  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(page.locator('.ub-json-tree [role="treeitem"][tabindex="0"]')).toBeFocused();
});
