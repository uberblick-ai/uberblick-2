/**
 * The one thing `mountEditor` promises beyond mounting an editor: it leaves the
 * document as it found it.
 *
 * Every test in a file shares one jsdom document, and fixtures reuse block ids.
 * A mount left behind by an earlier test therefore holds blocks with exactly
 * the ids a later test looks up, and `document.getElementById` answers with the
 * first match in the document rather than the one in the editor that test just
 * mounted — so a later test could pass against a corpse. Nothing else asserts
 * this, and a helper whose cleanup silently stopped working would not fail
 * anything; it would only make other failures impossible.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, initDoc } from "@uberblick/schema";
import { mountEditor } from "./helpers.js";

describe("mountEditor", () => {
  it("takes its blocks back out of the document when the editor is destroyed", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "helpers-doc", title: "Helpers" });
    const blockId = appendBlock(ydoc, { type: "paragraph", text: "one" });

    const { editor, element } = mountEditor(ydoc);
    expect(element.isConnected).toBe(true);
    expect(document.getElementById(blockId)).not.toBeNull();

    editor.destroy();

    expect(element.isConnected).toBe(false);
    expect(document.getElementById(blockId)).toBeNull();
  });

  it("cleans up from wherever a test re-parented it", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "helpers-doc-2", title: "Helpers" });
    const blockId = appendBlock(ydoc, { type: "paragraph", text: "two" });

    // The block-menu tests move the mount into a frame of their own, so the
    // cleanup must not assume it is still a child of body.
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    const { editor, element } = mountEditor(ydoc);
    pane.appendChild(element);

    editor.destroy();

    expect(document.getElementById(blockId)).toBeNull();
    expect(pane.childElementCount).toBe(0);
    pane.remove();
  });
});
