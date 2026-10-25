import { describe, expect, it } from "vitest";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import * as Y from "yjs";
import {
  appendBlock, createAnnotation, findBlockElement, getBlockInline, getBlocks,
  getBlocksFragment, initDoc, listAnnotationRanges,
} from "@uberblick/schema";
import { bindGuardedEditor } from "../src/editor/guarded-binding.js";
import { uberblickSchema } from "../src/editor/create-editor.js";
import { findForeignBlocks } from "../src/editor/palette.js";
import { mountEditor } from "./helpers.js";

const cases = [
  { name: "known", attrs: { variant: "warning", icon: "🚀" }, label: "Warning" },
  { name: "unknown", attrs: { variant: "future-variant", icon: ":future:" }, label: "Note" },
  { name: "unknown icon", attrs: { variant: "warning", icon: ":future:" }, label: "Warning" },
  { name: "unknown variant with curated icon", attrs: { variant: "future-variant", icon: ":claude:" }, label: "Note" },
  { name: "absent", attrs: {}, label: "Note" },
] as const;

describe("stored callout compatibility", () => {
  for (const arrivesWhileBound of [false, true]) {
    it.each(cases)(`keeps $name attributes, marks and anchors when its body is edited ${arrivesWhileBound ? "after remote arrival" : "after opening"}`, ({ attrs, label }) => {
      const ydoc = new Y.Doc();
      const peer = new Y.Doc();
      initDoc(ydoc, { uuid: "callout-compatibility", title: "Callout" });
      appendBlock(ydoc, { type: "paragraph", text: "Context" });
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
      const id = appendBlock(peer, {
        type: "callout", variant: "warning", icon: "🚀",
        inline: [
          { text: "Keep ", marks: {} },
          { text: "bold", marks: { bold: true } },
          { text: " italic", marks: { italic: true } },
          { text: " strike", marks: { strike: true } },
          { text: " code", marks: { inlineCode: true } },
          { text: " external", marks: { link: "https://example.com" } },
          { text: " document", marks: { docLink: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } },
          { text: " :claude: tail", marks: {} },
        ],
      });
      const source = findBlockElement(peer, id)!;
      source.removeAttribute("variant");
      source.removeAttribute("icon");
      for (const [name, value] of Object.entries(attrs)) source.setAttribute(name, value);
      createAnnotation(peer, id, 5, 9, "Reader", "Keep the emphasis");
      const inline = getBlockInline(peer, id);
      const anchors = listAnnotationRanges(peer, id);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const unbound: string[] = [];
      if (!arrivesWhileBound) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
      const beforeBinding = Y.encodeStateAsUpdate(ydoc);
      const binding = bindGuardedEditor({
        element: host, fragment: getBlocksFragment(ydoc), awareness: null,
        onUnbind: () => unbound.push("unbound"),
      });
      try {
        expect(Y.encodeStateAsUpdate(ydoc)).toEqual(beforeBinding);
        if (arrivesWhileBound) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
        const stored = findBlockElement(ydoc, id)!;
        const storedAttrs = stored.getAttributes();
        const editor = binding.editor!;
        expect(binding.refused).toBe(false);
        expect(editor.isEditable).toBe(true);
        expect(unbound).toEqual([]);
        expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
        expect(storedAttrs).toEqual({ id, ...attrs });
        expect(editor.state.doc.lastChild?.attrs).toMatchObject({
          variant: "variant" in attrs ? attrs.variant : null,
          icon: "icon" in attrs ? attrs.icon : null,
        });
        expect(host.querySelector(".ub-callout")?.getAttribute("aria-label")).toBe(label);
        if ("icon" in attrs && attrs.icon === ":claude:") {
          expect(host.querySelector(".ub-callout-icon")?.getAttribute("data-icon")).toBe("claude");
        }
        expect(getBlockInline(ydoc, id)).toEqual(inline);
        expect(listAnnotationRanges(ydoc, id)).toEqual(anchors);

        editor.view.dispatch(editor.state.tr.insertText(" edited", editor.state.doc.content.size - 1));

        expect(findBlockElement(ydoc, id)).toBe(stored);
        expect(stored.nodeName).toBe("callout");
        expect(stored.getAttributes()).toEqual(storedAttrs);
        expect(getBlockInline(ydoc, id)).toEqual([
          ...inline.slice(0, -1), { text: " :claude: tail edited", marks: {} },
        ]);
        expect(listAnnotationRanges(ydoc, id)).toEqual(anchors);
        expect(getBlocks(ydoc)[1]?.text).toBe("Keep bold italic strike code external document :claude: tail edited");
        expect(editor.getText()).not.toContain(label);
      } finally {
        binding.destroy(); host.remove(); ydoc.destroy(); peer.destroy();
      }
    });
  }

  it("updates the caption from remote attributes while retaining the callout and its prose", () => {
    const ydoc = new Y.Doc();
    const peer = new Y.Doc();
    initDoc(ydoc, { uuid: "callout-remote-attributes", title: "Remote caption" });
    const id = appendBlock(ydoc, { type: "callout", variant: "warning", text: "Keep the body" });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const remote = findBlockElement(peer, id)!;
    const { editor, element } = mountEditor(ydoc);
    try {
      const callout = element.querySelector(".ub-callout")!;
      const defaultWarning = callout.querySelector(".ub-callout-icon")!.innerHTML;
      const update = (attrs: Record<string, string | null>): void => {
        peer.transact(() => {
          for (const [key, value] of Object.entries(attrs)) {
            if (value === null) remote.removeAttribute(key);
            else remote.setAttribute(key, value);
          }
        });
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
        expect(element.querySelector(".ub-callout")).toBe(callout);
        expect(callout.querySelector(".ub-callout-body")?.textContent).toBe("Keep the body");
        expect(editor.isEditable).toBe(true);
      };
      update({ icon: ":future:" });
      expect(callout.getAttribute("aria-label")).toBe("Warning");
      expect(callout.querySelector(".ub-callout-icon")?.innerHTML).toBe(defaultWarning);
      update({ variant: "tip", icon: null });
      expect(callout.getAttribute("aria-label")).toBe("Tip");
      expect(callout.querySelector(".ub-callout-icon")?.innerHTML).not.toBe(defaultWarning);
      update({ variant: "future-variant", icon: ":claude:" });
      expect(callout.getAttribute("aria-label")).toBe("Note");
      expect(callout.querySelector(".ub-callout-icon")?.getAttribute("data-icon")).toBe("claude");
      expect(callout.getAttribute("data-variant")).toBe("future-variant");
      update({ variant: "caution", icon: "🚀" });
      expect(callout.getAttribute("aria-label")).toBe("Caution");
      expect(callout.querySelector(".ub-callout-icon")?.textContent).toBe("🚀");
      update({ variant: null, icon: null });
      expect(callout.getAttribute("aria-label")).toBe("Note");
      expect(callout.hasAttribute("data-variant")).toBe(false);
      expect(callout.hasAttribute("data-icon")).toBe(false);
      expect(findBlockElement(ydoc, id)?.getAttributes()).toEqual({ id });
    } finally { editor.destroy(); ydoc.destroy(); peer.destroy(); }
  });

  it.each(cases)("keeps $name attributes through HTML serialization and parsing", ({ attrs, label }) => {
    const callout = uberblickSchema.nodes.callout!.create({ id: "callout-html", ...attrs }, uberblickSchema.text("Authored\nprose"));
    const host = document.createElement("div");
    host.append(DOMSerializer.fromSchema(uberblickSchema).serializeNode(callout));
    const rendered = host.firstElementChild!;
    expect(rendered.getAttribute("aria-label")).toBe(label);
    expect(rendered.textContent).toBe("Authored\nprose");
    expect(rendered.querySelector(".ub-block-caption")).toBeNull();
    expect(rendered.getAttribute("data-variant")).toBe("variant" in attrs ? attrs.variant : null);
    expect(rendered.getAttribute("data-icon")).toBe("icon" in attrs ? attrs.icon : null);
    const parsed = DOMParser.fromSchema(uberblickSchema).parse(host).firstChild!;
    expect(parsed.type.name).toBe("callout");
    expect(parsed.attrs).toEqual(callout.attrs);
    expect(parsed.textContent).toBe("Authored\nprose");
  });
});
