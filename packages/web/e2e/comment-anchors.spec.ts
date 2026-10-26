/** A real Enter split keeps the rail, MCP reader and Markdown at one anchor. */
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import { setNativeSelection } from "./native-selection.js";
import { expectMcp } from "./settle.js";

const { harness, openApp } = setupHarness();

test("an Enter split moves the shared comment anchor into the new paragraph", async ({ browser }) => {
  const agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-anchors-${process.env.UB_AGENTS_RUN ?? "local"}-`,
  });
  try {
    const writer = agent.open({ name: "comment-anchor-e2e" });
    const created = await writer.call<{ uuid: string; blocks: Array<{ id: string }> }>("create_doc", {
      title: "Split comment anchor", description: "A comment follows its surviving text.",
      blocks: [{ type: "paragraph", text: "Hello brave world" }, { type: "paragraph", text: "Next paragraph" }],
    });
    const original = created.blocks[0];
    const later = created.blocks[1];
    if (original === undefined || later === undefined) throw new Error("e2e: missing comment anchor fixture blocks");
    const recorded = original.id;
    const thread = await writer.call<{ annotation: { id: string } }>("annotate", {
      uuid: created.uuid, block_id: recorded, start: 6, end: 11, text: "Keep brave anchored",
    });
    const other = await writer.call<{ annotation: { id: string } }>("annotate", {
      uuid: created.uuid, block_id: later.id, start: 0, end: 4, text: "Later conversation",
    });
    const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
      contextOptions: { viewport: { width: 1400, height: 800 }, reducedMotion: "reduce" },
      readySelector: ".ub-editor .ProseMirror",
    });
    const prose = editor(page).locator(":scope > p");
    await expect(prose.first()).toHaveText("Hello brave world");
    await placeCaretIn(prose.first(), { edge: "start" });
    await setNativeSelection(prose.first(), () => prose.first().evaluate((element) => {
      const root = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement?.closest(".ProseMirror-yjs-cursor") === null
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      const text = walker.nextNode();
      if (text?.textContent !== "Hello ") throw new Error("e2e: missing comment anchor prefix");
      const range = document.createRange();
      range.setStart(text, 6);
      range.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const position = root.editor.view.posAtDOM(text, 6);
      return { anchor: position, head: position };
    }));
    await page.keyboard.press("Enter");
    await expect(prose).toHaveText(["Hello ", "brave world", "Next paragraph"]);
    const destination = await prose.nth(1).getAttribute("id");
    expect(destination).not.toBeNull();
    expect(destination).not.toBe(recorded);
    const card = page.locator(`#ub-thread-${thread.annotation.id}`);
    await expect(card).toContainText("brave");
    await expect(prose.nth(1).locator("[data-comment-thread]")).toHaveText("brave");
    await expect(card).not.toContainText("orphaned");
    await expect.poll(() => page.locator(".ub-thread-card").evaluateAll((cards) => cards.map((card) => card.id))).toEqual([
      `ub-thread-${thread.annotation.id}`, `ub-thread-${other.annotation.id}`,
    ]);
    await expectMcp(() => writer.call<{ annotations: Array<{ id: string; blockId: string; range: unknown }> }>(
      "get_doc", { uuid: created.uuid },
    ), (doc) => {
      expect(doc.annotations.find(({ id }) => id === thread.annotation.id)).toMatchObject({
        blockId: destination, range: { start: 0, end: 5 },
      });
    });
    await expectMcp(() => writer.call<{ markdown: string }>("export_markdown", {
      uuid: created.uuid, frontmatter: false, annotations: "html-comments",
    }), (exported) => {
      const commentAt = exported.markdown.indexOf(thread.annotation.id);
      expect(commentAt).toBeGreaterThan(exported.markdown.indexOf("brave world"));
      expect(commentAt).toBeLessThan(exported.markdown.indexOf("Next paragraph"));
      expect(exported.markdown).toContain("range=0-5");
    });
  } finally { await agent.close(); }
});
