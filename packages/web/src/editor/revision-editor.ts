import type { Editor, JSONContent } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { EditorProps } from "@tiptap/pm/view";
import { canonicalDocumentUuid, isExternalHref } from "@uberblick/schema";
import type { DocLinkContext } from "./doc-links.js";
import type { RevisionRow } from "./revision-rows.js";

export function revisionKeyboardShortcuts(editor: Editor, docLinks: DocLinkContext | null) {
  return {
    "Mod-a": () => editor.commands.selectAll(),
    Enter: () => {
      const { selection } = editor.state;
      if (!selection.empty) return false;
      const marks = selection.$from.marks();
      const docId = canonicalDocumentUuid(marks.find((mark) => mark.type.name === "docLink")?.attrs.docId);
      if (docId !== null && docLinks !== null) {
        if (docLinks.lookup(docId).state !== "deleted") docLinks.open(docId);
        return true;
      }
      const href = marks.find((mark) => mark.type.name === "link")?.attrs.href;
      if (!isExternalHref(href)) return false;
      window.open(href, "_blank", "noopener,noreferrer");
      return true;
    },
  };
}

export const revisionNativeKeyboardEvents: NonNullable<EditorProps["handleDOMEvents"]> = {
  // Leave focus navigation and fold-button activation to the browser.
  keydown: (_view, event) => event.key === "Tab" ||
    event.target instanceof Element && event.target.closest(".ub-revision-fold-button") !== null,
  keypress: (_view, event) => event.target instanceof Element && event.target.closest(".ub-revision-fold-button") !== null,
};

export function revisionReadOnlyProps(ariaLabel: string): EditorProps {
  return {
    // Native editing hosts contain selection; renderers and transaction guards prevent editing.
    editable: () => true,
    attributes: { role: "textbox", "aria-label": ariaLabel, "aria-readonly": "true", "aria-multiline": "true", inputmode: "none" },
    handleDOMEvents: { beforeinput: (_view, event) => { event.preventDefault(); return true; } },
  };
}

interface FoldProjection {
  rows: readonly RevisionRow[];
  blocks?: readonly { at: number }[];
}

export function revisionFoldTransaction(editor: Editor, current: FoldProjection & { runs: readonly number[] },
  next: FoldProjection, content: JSONContent): Transaction {
  const transaction = editor.state.tr;
  const currentBlocks = current.blocks ?? current.rows;
  const nextBlocks = next.blocks ?? next.rows;
  for (const run of [...current.runs].reverse()) {
    const oldFold = current.rows.find((row) => row.at === run)?.fold;
    const newFold = next.rows.find((row) => row.at === run)?.fold;
    if ((oldFold === undefined) === (newFold === undefined)) continue;
    const index = currentBlocks.findIndex((block) => block.at === run);
    const start = nextBlocks.findIndex((block) => block.at === run);
    let position = 0;
    for (let node = 0; node < index; node += 1) position += editor.state.doc.child(node).nodeSize;
    let end = position;
    for (let node = index; node < index + (oldFold === undefined ? newFold?.count ?? 0 : 1); node += 1) end += editor.state.doc.child(node).nodeSize;
    const replacement = Fragment.fromArray((content.content ?? []).slice(start, start + (oldFold?.count ?? 1))
      .map((node) => editor.schema.nodeFromJSON(node)));
    transaction.replaceWith(position, end, replacement);
  }
  return transaction;
}
