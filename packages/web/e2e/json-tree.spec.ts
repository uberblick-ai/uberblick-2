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
    blocks: [{ type: "code", language: "json-tree", text }],
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

test("an existing first-block tree opens as a tree, and Edit and Done format the stored text", async ({ browser }) => {
  const session = writer();
  const uuid = await treeDoc(session, "JSON tree editing", MINIFIED);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expect(page.getByRole("tree", { name: "JSON tree" })).toBeVisible();
  await expect(row(page, "")).toHaveAttribute("aria-expanded", "true");
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

test("keyboard focus reaches Copy value and reveals a truncated string while preserving tree navigation", async ({ browser }) => {
  const session = writer();
  const long = "A long JSON string remains available to someone navigating without a pointer. ".repeat(6);
  const uuid = await treeDoc(session, "JSON tree row actions", JSON.stringify({ a: { b: 1 }, long }));
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: async page => { await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => document.documentElement.setAttribute("data-copied-value", text) },
      });
    }); },
  });
  await expect(page.getByRole("tree", { name: "JSON tree" })).toBeVisible();
  await row(page, "").focus();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, ".a")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(row(page, ".a").getByRole("button", { name: "Copy this value", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-copied-value", '{\n  "b": 1\n}');

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("clipboard refused"); } },
    });
    document.addEventListener("copy", () => {
      const field = document.activeElement;
      if (field instanceof HTMLTextAreaElement && field.selectionStart === 0 && field.selectionEnd === field.value.length) {
        document.documentElement.setAttribute("data-fallback-copied-value", field.value);
      }
    }, { capture: true, once: true });
  });
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-fallback-copied-value", '{\n  "b": 1\n}');
  await expect(row(page, ".a").getByRole("button", { name: "Copy this value", exact: true })).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(row(page, ".a")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, ".a")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(row(page, ".a")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("End");
  const stringRow = row(page, ".long");
  await expect(stringRow).toBeFocused();
  await expect(stringRow.locator(".ub-json-string")).toHaveCSS("text-overflow", "ellipsis");
  const truncatedHeight = await stringRow.evaluate(element => element.clientHeight);
  await page.keyboard.press("Enter");
  await expect(row(page, ".long")).toHaveAttribute("data-wrapped", "true");
  await expect(row(page, ".long")).toHaveCSS("white-space", "pre-wrap");
  await expect.poll(() => row(page, ".long").evaluate(element => element.clientHeight)).toBeGreaterThan(truncatedHeight);
  await page.keyboard.press("Space");
  await expect(row(page, ".long")).not.toHaveAttribute("data-wrapped", "true");
  await expect(page.locator(".ub-json-tree-source")).toBeHidden();
});

test("inserting a JSON tree through the block menu starts in source editing", async ({ browser }) => {
  const session = writer();
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Insert a JSON tree", description: "A new tree opens for authoring.",
    blocks: [{ type: "paragraph", text: "Add a tree below." }],
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await page.locator(".ub-editor .ProseMirror > *").last().hover();
  await page.getByRole("button", { name: "Insert block below", exact: true }).click();
  await page.getByRole("option", { name: "JSON tree", exact: true }).click();
  await expect(page.locator(".ub-json-tree-source")).toBeVisible();
  await expect(page.locator(".ub-json-tree-source")).toHaveText("{}");
  await expect(page.getByRole("tree", { name: "JSON tree" })).toBeHidden();
  await expectMcp(() => codeText(session, uuid), text => { expect(text).toBe("{}"); });
  await page.getByRole("button", { name: "Done editing JSON", exact: true }).click();
  await expect(page.getByRole("tree", { name: "JSON tree" })).toBeVisible();
  await expect(page.locator(".ub-json-tree-source")).toBeHidden();
});
