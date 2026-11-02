import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { devices, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { findBlockElement, getBlocksFragment, getMeta, roomForDoc } from "@uberblick/schema";
import { wrapToken } from "@uberblick/schema/protocol";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import * as Y from "yjs";
import { docTitle, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, proveBrowserArrival, proveBrowserTitleArrival, proveMcpArrival } from "./settle.js";
import { renderedText } from "./contrast-helpers.js";

const pageErrors: string[] = [];
const { harness, openApp } = setupHarness({ app: { beforeNavigate: async (page) => {
  page.on("pageerror", (error) => pageErrors.push(error.message));
} } });
let agent: McpAgent | null = null;

test.beforeEach(() => { pageErrors.length = 0; });
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-divider-fallback-",
  });
});
test.afterEach(async () => {
  await agent?.closeSessions();
  expect(pageErrors).toEqual([]);
});
test.afterAll(async () => { await agent?.close(); agent = null; });

interface WrittenDoc {
  uuid: string;
  blocks: Array<{ id: string; rev: string }>;
}
interface StoredDoc extends WrittenDoc {
  blocks: Array<{ id: string; rev: string; type: string; text: string }>;
}

async function selectAcrossPlaceholder(page: Page): Promise<void> {
  await editor(page).locator(".ub-paragraph").last().click();
  await page.keyboard.press("End");
  const size = await editor(page).evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.content.size);
  for (let offset = 0; offset < size; offset += 1) await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => editor(page).evaluate(element => {
    const editor = (element as HTMLElement & { editor: Editor }).editor;
    const { from, to } = editor.state.selection;
    const position = editor.state.doc.child(0).nodeSize;
    return { selected: !editor.state.selection.empty, spans: from <= position && to > position };
  })).toEqual({ selected: true, spans: true });
}

for (const arrivesWhileBound of [false, true]) {
  test(`a divider ${arrivesWhileBound ? "arriving during editing" : "already stored"} stays editable and intact`, { tag: "@webkit" }, async ({ browser }, info) => {
    if (agent === null) throw new Error("e2e: the MCP agent is not configured");
    const writer = agent.open({ name: "divider-fallback-e2e" });
    const created = await writer.call<WrittenDoc>("create_doc", {
      title: docTitle("Divider compatibility"), description: "Dividers stay editable through collaboration.",
      blocks: [{ type: "paragraph", text: "Context stays intact." }, ...(arrivesWhileBound ? [] : [{ type: "divider" }])],
    });
    const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
      upstream: true,
      contextOptions: {
        ...(info.project.use.hasTouch === true ? devices["iPad (gen 7)"] : {}),
        colorScheme: arrivesWhileBound ? "dark" : "light",
      },
    });
    let divider = created.blocks[1];
    if (arrivesWhileBound) {
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      const inserted = await writer.call<WrittenDoc>("insert_block", {
        uuid: created.uuid, after_block_id: created.blocks[0]?.id, blocks: [{ type: "divider" }],
      });
      divider = inserted.blocks[0];
    }
    if (divider === undefined) throw new Error("e2e: the divider write returned no block");
    const expected = [
      { ...created.blocks[0], type: "paragraph", text: "Context stays intact." },
      { ...divider, type: "divider", text: "" },
    ];
    await expect(editor(page).getByRole("separator")).toHaveCount(1);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");

    await proveMcpArrival(page, writer, created.uuid, { path: "upstream" });
    await expect(page.locator(".ub-foreign")).toHaveCount(0);
    await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
      expect(stored.blocks).toEqual(expected);
    });
    await editor(page).locator(".ub-paragraph").first().click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" Edited beside a divider.");
    await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
      expect(stored.blocks[0]?.text).toBe("Context stays intact. Edited beside a divider.");
      expect(stored.blocks[1]).toEqual(expected[1]);
    });
  });
}

for (const arrivesWhileBound of [false, true]) {
  test(`a divider child ${arrivesWhileBound ? "arriving during editing" : "already stored"} stays opaque beside editable blocks`, { tag: "@webkit" }, async ({ browser, browserName }, info) => {
    if (agent === null) throw new Error("e2e: the MCP agent is not configured");
    const writer = agent.open({ name: "divider-child-e2e" });
    const created = await writer.call<WrittenDoc>("create_doc", {
      title: docTitle("Older client divider"), description: "An older client's text child must remain untouched.",
      blocks: [{ type: "paragraph", text: "Context stays intact." }, { type: "divider" }, { type: "paragraph", text: "After the placeholder." }],
    });
    const doc = new Y.Doc();
    const secret = await importRootSecret(harness().authSecret);
    const provider = new HocuspocusProvider({
      url: harness().hubUrl, name: roomForDoc(harness().workspaceUuid, created.uuid), document: doc,
      token: async () => wrapToken(await mintToken(secret, {
        typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
        scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      })),
    });
    try {
      const id = created.blocks[1]?.id ?? "";
      await expect.poll(() => findBlockElement(doc, id)).not.toBeNull();
      const divider = findBlockElement(doc, id);
      if (divider === null) throw new Error("e2e: the divider fixture is missing");
      const options = { upstream: true, contextOptions: {
        ...(info.project.use.hasTouch === true ? devices["iPad (gen 7)"] : {}),
        colorScheme: arrivesWhileBound ? "dark" as const : "light" as const,
      } };
      const page = arrivesWhileBound ? await openApp(browser, `/${harness().workspace}/${created.uuid}`, options) : null;
      if (page !== null) await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      const child = new Y.XmlText("Written by an older client");
      divider.insert(0, [child]);
      const browserWrites: unknown[] = [];
      divider.observeDeep((events, transaction) => { if (!transaction.local) browserWrites.push(...events); });
      const browserPage = page ?? await openApp(browser, `/${harness().workspace}/${created.uuid}`, options);
      const placeholder = editor(browserPage).locator(".ub-unsupported-block");
      await expect(placeholder).toHaveText("This block needs a newer version.");
      await expect(placeholder).toHaveAttribute("contenteditable", "false");
      await expect(browserPage.locator(".ub-foreign")).toHaveCount(0);
      await expect(editor(browserPage)).toHaveAttribute("contenteditable", "true");
      await proveBrowserArrival(browserPage, { path: "upstream", readTags: () => getMeta(doc).tags });
      await browserPage.evaluate(() => document.fonts.ready);
      const paint = await renderedText(browserPage, ".ub-unsupported-block");
      expect(paint.length).toBeGreaterThan(0);
      for (const text of paint) expect(text.ratio).toBeGreaterThanOrEqual(4.5);

      const before = editor(browserPage).locator(".ub-paragraph").first();
      const afterId = created.blocks[2]?.id ?? "";
      const after = editor(browserPage).locator(`[id="${afterId}"]`);
      if (info.project.use.hasTouch === true) await before.tap();
      else await before.click();
      await browserPage.keyboard.press("End");
      await browserPage.keyboard.press("ArrowRight");
      await expect.poll(() => editor(browserPage).evaluate(element => {
        const editor = (element as HTMLElement & { editor: Editor }).editor;
        return editor.state.selection.$head.parent.attrs.id;
      })).toBe(afterId);
      await browserPage.keyboard.insertText("Keyboard ");
      await expect(after).toHaveText("Keyboard After the placeholder.");
      if (info.project.use.hasTouch === true) await after.tap();
      else await after.click();
      await browserPage.keyboard.press("End");
      await browserPage.keyboard.insertText(" Pointer.");
      child.insert(0, "Remote ");
      await browserPage.keyboard.insertText(" Local.");
      await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
        expect(stored.blocks.find(block => block.id === afterId)?.text).toBe("Keyboard After the placeholder. Pointer. Local.");
      });

      await selectAcrossPlaceholder(browserPage);
      await browserPage.keyboard.insertText("A selection replacement must retain opaque content.");
      await proveBrowserTitleArrival(browserPage, { path: "upstream", readTitle: () => getMeta(doc).title });
      expect(findBlockElement(doc, id)).toBe(divider);
      expect(getBlocksFragment(doc).get(1)).toBe(divider);
      expect(divider.length).toBe(1);
      expect(divider.firstChild).toBe(child);
      expect(child.toString()).toBe("Remote Written by an older client");
      expect(divider.getAttributes()).toEqual({ id });
      expect(browserWrites).toEqual([]);

      if (!arrivesWhileBound) {
        const modifier = await browserPage.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
        if (browserName === "chromium") await browserPage.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await before.click();
        await selectAcrossPlaceholder(browserPage);
        await browserPage.keyboard.press(`${modifier}+c`);
        await browserPage.evaluate(() => {
          const target = document.createElement("textarea");
          target.setAttribute("data-placeholder-copy", "");
          document.body.append(target);
        });
        const copied = browserPage.locator("textarea[data-placeholder-copy]");
        await copied.focus();
        await browserPage.keyboard.press(`${modifier}+v`);
        await expect(copied).toHaveValue(/Context stays intact\./);
        expect(await copied.inputValue()).not.toMatch(/newer version|Written by an older client/);
        await copied.evaluate(element => element.remove());
        await after.click();
        await browserPage.keyboard.press("End");
        await browserPage.keyboard.press(`${modifier}+v`);
        await expect(placeholder).toHaveCount(1);
        await before.click();
        await selectAcrossPlaceholder(browserPage);
        await browserPage.keyboard.press(`${modifier}+x`);
        await proveBrowserTitleArrival(browserPage, { path: "upstream", readTitle: () => getMeta(doc).title });
        expect(getBlocksFragment(doc).get(1)).toBe(divider);
        expect(divider.firstChild).toBe(child);
        expect(child.toString()).toBe("Remote Written by an older client");
        expect(browserWrites).toEqual([]);
        if (info.project.use.hasTouch !== true) {
          await editor(browserPage).evaluate(element => {
            element.addEventListener("dragstart", event => {
              const transfer = (event as DragEvent).dataTransfer;
              element.setAttribute("data-opaque-drag", JSON.stringify({
                text: transfer?.getData("text/plain"), html: transfer?.getData("text/html"),
              }));
            });
          });
          await before.click();
          await selectAcrossPlaceholder(browserPage);
          await before.dragTo(after, { sourcePosition: { x: 12, y: 10 }, targetPosition: { x: 12, y: 10 } });
          await expect(editor(browserPage)).toHaveAttribute("data-opaque-drag", /Context stays intact/);
          expect(await editor(browserPage).getAttribute("data-opaque-drag"))
            .not.toMatch(/newer version|Written by an older client|data-unsupported-block/);
          await proveBrowserTitleArrival(browserPage, { path: "upstream", readTitle: () => getMeta(doc).title });
          expect(findBlockElement(doc, id)).toBe(divider);
          expect(divider.firstChild).toBe(child);
          expect(browserWrites).toEqual([]);
        }
      }

      divider.delete(0, 1);
      await expect(placeholder).toHaveCount(0);
      await expect(editor(browserPage).getByRole("separator")).toHaveCount(1);
      await expect(editor(browserPage)).toHaveAttribute("contenteditable", "true");
      await before.click();
      await browserPage.keyboard.press("End");
      await browserPage.keyboard.insertText(" Still editable.");
      await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
        expect(stored.blocks[0]?.text).toBe("Context stays intact. Still editable.");
      });
    } finally { provider.destroy(); doc.destroy(); }
  });
}

test("horizontal caret movement skips consecutive opaque blocks while other arrows stay native", { tag: "@webkit" }, async ({ browser }, info) => {
  if (agent === null) throw new Error("e2e: the MCP agent is not configured");
  const writer = agent.open({ name: "opaque-arrow-e2e" });
  const created = await writer.call<WrittenDoc>("create_doc", {
    title: docTitle("Opaque block keyboard movement"), description: "Native selection and opaque boundaries agree.",
    blocks: [{ type: "paragraph", text: "Before opaque blocks." }, { type: "divider" }, { type: "divider" }, { type: "paragraph", text: "After opaque blocks." }],
  });
  const doc = new Y.Doc();
  const secret = await importRootSecret(harness().authSecret);
  const provider = new HocuspocusProvider({
    url: harness().hubUrl, name: roomForDoc(harness().workspaceUuid, created.uuid), document: doc,
    token: async () => wrapToken(await mintToken(secret, {
      typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
      scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    })),
  });
  try {
    for (const index of [1, 2]) {
      const id = created.blocks[index]?.id ?? "";
      await expect.poll(() => findBlockElement(doc, id)).not.toBeNull();
      const divider = findBlockElement(doc, id);
      if (divider === null) throw new Error("e2e: the divider fixture is missing");
      divider.insert(0, [new Y.XmlText("Keep the old divider child.")]);
    }
    const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
      upstream: true,
      contextOptions: info.project.use.hasTouch === true ? devices["iPad (gen 7)"] : {},
    });
    await expect(editor(page).locator(".ub-unsupported-block")).toHaveCount(2);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");

    for (const forward of [true, false]) {
      await editor(page).evaluate((element, forwards) => {
        const root = element as HTMLElement & { editor: Editor; resumeSelectionChanges?: () => void; staleSelection?: boolean };
        const mounted = root.editor;
        mounted.commands.setTextSelection(forwards ? 1 : mounted.state.doc.content.size - 1);
        mounted.view.focus();
        // Reproduce native movement reaching the next key before selectionchange.
        const hold = (event: Event): void => event.stopImmediatePropagation();
        const position = forwards ? mounted.state.doc.child(0).nodeSize - 1 :
          mounted.state.doc.content.size - mounted.state.doc.child(3).nodeSize + 1;
        const placeNativeCaret = (event: KeyboardEvent): void => {
          if (event.key !== (forwards ? "ArrowRight" : "ArrowLeft")) return;
          document.removeEventListener("keydown", placeNativeCaret, true);
          const target = mounted.view.domAtPos(position);
          document.getSelection()?.collapse(target.node, target.offset);
          root.staleSelection = mounted.state.selection.head !== position;
        };
        document.addEventListener("selectionchange", hold, true);
        document.addEventListener("keydown", placeNativeCaret, true);
        root.resumeSelectionChanges = () => {
          document.removeEventListener("selectionchange", hold, true);
          document.removeEventListener("keydown", placeNativeCaret, true);
        };
      }, forward);
      try {
        await page.keyboard.press(forward ? "ArrowRight" : "ArrowLeft");
        expect(await editor(page).evaluate(element =>
          (element as HTMLElement & { staleSelection?: boolean }).staleSelection)).toBe(true);
        await expect.poll(() => editor(page).evaluate(element => {
          const { selection } = (element as HTMLElement & { editor: Editor }).editor.state;
          return { block: selection.$head.parent.attrs.id, offset: selection.$head.parentOffset };
        })).toEqual({
          block: created.blocks[forward ? 3 : 0]?.id,
          offset: forward ? 0 : "Before opaque blocks.".length,
        });
      } finally {
        await editor(page).evaluate(element => {
          (element as HTMLElement & { resumeSelectionChanges?: () => void }).resumeSelectionChanges?.();
        });
      }
    }

    const compareNativeArrows = async (keys: string[], withinFirstBlock = false): Promise<void> => {
      for (const key of keys) {
        const results: unknown[] = [];
        for (const enabled of [false, true]) {
          await editor(page).evaluate((element, handlerEnabled) => {
            const root = element as HTMLElement & { editor: Editor; arrowPrevented?: boolean; restoreArrowHandler?: () => void };
            const mounted = root.editor;
            const protection = mounted.state.plugins.find(plugin => plugin.props.transformCopied !== undefined &&
              plugin.props.transformPasted !== undefined && plugin.props.handleKeyDown !== undefined);
            if (protection === undefined) throw new Error("Missing unsupported-block keyboard protection");
            const original = protection.props.handleKeyDown;
            if (original === undefined) throw new Error("Missing unsupported-block key handler");
            if (!handlerEnabled) protection.props.handleKeyDown = () => false;
            mounted.commands.setTextSelection(mounted.state.doc.child(0).nodeSize - 1);
            mounted.view.focus();
            delete root.arrowPrevented;
            const observe = (event: KeyboardEvent): void => {
              if (!event.key.startsWith("Arrow")) return;
              root.arrowPrevented = event.defaultPrevented;
              root.removeEventListener("keydown", observe);
            };
            root.addEventListener("keydown", observe);
            root.restoreArrowHandler = () => {
              protection.props.handleKeyDown = original;
              root.removeEventListener("keydown", observe);
            };
          }, enabled);
          try {
            await page.keyboard.press(key);
            await expect.poll(() => editor(page).evaluate(element => {
              const root = element as HTMLElement & { editor: Editor; arrowPrevented?: boolean };
              const native = document.getSelection();
              const view = root.editor.view;
              return root.arrowPrevented !== undefined && native?.anchorNode != null && native.focusNode != null &&
                view.state.selection.anchor === view.posAtDOM(native.anchorNode, native.anchorOffset) &&
                view.state.selection.head === view.posAtDOM(native.focusNode, native.focusOffset);
            })).toBe(true);
            const result = await editor(page).evaluate(element => {
              const root = element as HTMLElement & { editor: Editor; arrowPrevented?: boolean };
              const { selection, doc } = root.editor.state;
              return {
                prevented: root.arrowPrevented, anchor: selection.anchor, head: selection.head,
                spans: selection.from < doc.child(0).nodeSize && selection.to > doc.child(0).nodeSize + 2,
                block: selection.$head.parent.attrs.id, offset: selection.$head.parentOffset,
              };
            });
            if (key === "Shift+ArrowRight") expect(result.spans).toBe(true);
            if (withinFirstBlock) {
              expect(result.block).toBe(created.blocks[0]?.id);
              expect(result.offset).toBeLessThan("Before אבג".length);
            }
            results.push(result);
          } finally {
            await editor(page).evaluate(element =>
              (element as HTMLElement & { restoreArrowHandler?: () => void }).restoreArrowHandler?.());
          }
        }
        expect(results[1]).toEqual(results[0]);
      }
    };
    await compareNativeArrows(["Shift+ArrowRight", "Alt+Shift+ArrowRight", "Control+Shift+ArrowRight", "Meta+Shift+ArrowRight", "ArrowUp", "ArrowDown"]);
    const beforeText = findBlockElement(doc, created.blocks[0]?.id ?? "")?.firstChild;
    if (!(beforeText instanceof Y.XmlText)) throw new Error("e2e: the first paragraph text is missing");
    doc.transact(() => {
      beforeText.delete(0, beforeText.length);
      beforeText.insert(0, "Before אבג");
    });
    await expect(editor(page).locator(".ub-paragraph").first()).toHaveText("Before אבג");
    await compareNativeArrows(["ArrowLeft"], true);
    await proveBrowserTitleArrival(page, { path: "upstream", readTitle: () => getMeta(doc).title });
    expect(findBlockElement(doc, created.blocks[1]?.id ?? "")?.firstChild?.toString()).toBe("Keep the old divider child.");
    expect(findBlockElement(doc, created.blocks[2]?.id ?? "")?.firstChild?.toString()).toBe("Keep the old divider child.");
  } finally { provider.destroy(); doc.destroy(); }
});
