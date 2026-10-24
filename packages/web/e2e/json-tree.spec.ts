/** JSON trees are view chrome over ordinary code source, read and edited through the production replica. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
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

async function rewriteTree(session: McpSession, uuid: string, text: string): Promise<void> {
  const doc = await session.call<{ blocks: { id: string; text: string; rev: string }[] }>("get_doc", { uuid });
  const block = doc.blocks[0];
  if (block === undefined) throw new Error("e2e: JSON tree document has no block");
  await session.call("edit_block", { uuid, block_id: block.id, rev: block.rev, old_text: block.text, new_text: text });
}

async function authoredText(source: Locator): Promise<string> {
  return source.evaluate(element => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return copy.textContent ?? "";
  });
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

for (const annotated of [false, true]) {
  test(`remote invalid edits keep the tree during the pause, then show source${annotated ? " beside a comment" : ""}`, async ({ browser }) => {
    const session = writer();
    const valid = '{\n  "a": 1\n}';
    const invalid = '{\n  "a": 1,\n}';
    const uuid = await treeDoc(session, "JSON tree remote validation", valid);
    if (annotated) {
      const doc = await session.call<{ blocks: { id: string }[] }>("get_doc", { uuid });
      await session.call("annotate", { uuid, block_id: doc.blocks[0]?.id, start: 4, end: 5, text: "Keep this key." });
    }
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: async loading => { await loading.clock.install(); },
    });
    const block = page.locator(".ub-json-tree");
    const source = page.locator(".ub-json-tree-source");
    const sourceFrame = page.locator(".ub-json-tree-source-frame");
    const note = page.locator(".ub-json-tree-validity");
    const tree = page.getByRole("tree", { name: "JSON tree" });
    await expect(tree).toBeVisible();
    await expect(block).not.toHaveClass(/ub-json-tree-editing/);
    await page.clock.pauseAt(new Date(Date.now() + 1_000));

    await rewriteTree(session, uuid, invalid);
    await expect.poll(() => authoredText(source)).toBe(invalid);
    await page.clock.runFor(1_000);
    await expect(block).toHaveAttribute("data-json", "stale");
    await expect(tree).toBeVisible();
    await expect(row(page, ".a")).toContainText('"a": 1');
    await expect(note).toHaveText("");
    if (!annotated) await expect(source).toBeHidden();

    await rewriteTree(session, uuid, invalid.replace("1,", "1, "));
    await expect.poll(() => authoredText(source)).toBe(invalid.replace("1,", "1, "));
    await page.clock.runFor(1_499);
    await expect(block).toHaveAttribute("data-json", "stale");
    await expect(tree).toBeVisible();
    await expect(note).toHaveText("");
    if (annotated) await expect(source).toBeVisible();
    else await expect(source).toBeHidden();
    const sourceHeight = annotated
      ? await sourceFrame.evaluate(element => element.getBoundingClientRect().height)
      : null;
    await page.clock.runFor(1);
    await expect(block).toHaveAttribute("data-json", "invalid");
    await expect(tree).toBeHidden();
    await expect(source).toBeVisible();
    await expect(note).toContainText("Not valid JSON: line 3, column 1");
    await expect(note).toBeVisible();
    if (annotated) {
      expect(await sourceFrame.evaluate(element => element.getBoundingClientRect().height)).toBe(sourceHeight);
    }

    await rewriteTree(session, uuid, invalid.replace("1,", "1,  "));
    await expect.poll(() => authoredText(source)).toBe(invalid.replace("1,", "1,  "));
    await expect(note).toHaveText("");
    await page.clock.runFor(1_499);
    await expect(note).toHaveText("");
    await page.clock.runFor(1);
    await expect(note).toContainText("Not valid JSON: line 3, column 1");
    await expect(note).toBeVisible();

    await rewriteTree(session, uuid, valid.replace("1", "2"));
    await expect.poll(() => authoredText(source)).toBe(valid.replace("1", "2"));
    await page.clock.runFor(200);
    await expect(block).toHaveAttribute("data-json", "valid");
    await expect(tree).toBeVisible();
    await expect(row(page, ".a")).toContainText('"a": 2');
    await expect(note).toHaveText("");
    if (!annotated) await expect(source).toBeHidden();
  });
}

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
