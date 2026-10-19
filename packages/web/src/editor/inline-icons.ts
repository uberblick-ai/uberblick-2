import { Extension } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { COMMENT_MARK, INLINE_ICONS } from "@uberblick/schema";
import type { InlineIconName } from "@uberblick/schema";
import { inlineIconSvg, inlineIconTokens } from "../inline-icons.js";
import type { InlineIconToken } from "../inline-icons.js";

interface TextRun { from: number; to: number; marks: readonly Mark[] }
interface IconRange extends InlineIconToken { marks: readonly Mark[]; scopeFrom: number; scopeTo: number }

function linkMark(marks: readonly Mark[]): Mark | undefined {
  return marks.find((mark) => mark.type.name === "link" || mark.type.name === "docLink");
}

function ranges(node: ProseMirrorNode): { text: string; icons: IconRange[] } {
  let text = "";
  const runs: TextRun[] = [];
  node.forEach((child, offset) => {
    text += child.isText ? child.text : "\ufffc".repeat(child.nodeSize);
    runs.push({ from: offset, to: offset + child.nodeSize, marks: child.marks });
  });
  const icons = inlineIconTokens(text).flatMap((token): IconRange[] => {
    const touched = runs.filter((run) => run.from < token.to && token.from < run.to);
    const first = touched[0];
    if (first === undefined || touched.some((run) => run.marks.some((mark) => mark.type.spec.code))) return [];
    const linkedRun = touched.find((run) => linkMark(run.marks) !== undefined);
    const link = linkMark(linkedRun?.marks ?? []);
    let scopeFrom = 0;
    let scopeTo = text.length;
    if (link !== undefined) {
      const index = runs.indexOf(linkedRun ?? first);
      let start = index;
      let end = index;
      while (start > 0 && linkMark(runs[start - 1]?.marks ?? [])?.eq(link)) start -= 1;
      while (end + 1 < runs.length && linkMark(runs[end + 1]?.marks ?? [])?.eq(link)) end += 1;
      scopeFrom = Math.min(runs[start]?.from ?? token.from, token.from);
      scopeTo = Math.max(runs[end]?.to ?? token.to, token.to);
    }
    const marks = [...(link?.addToSet(first.marks) ?? first.marks)];
    for (const run of touched) {
      for (const mark of run.marks) {
        if (mark.type.name === COMMENT_MARK && !marks.some((existing) => existing.eq(mark))) marks.push(mark);
      }
    }
    return [{ ...token, marks, scopeFrom, scopeTo }];
  });
  return { text, icons };
}

let nextSvgId = 0;
function icon(name: InlineIconName, labelled: boolean): HTMLElement {
  const dom = document.createElement("span");
  dom.className = "ub-inline-icon";
  dom.dataset.icon = name;
  if (labelled) {
    dom.setAttribute("role", "img");
    dom.setAttribute("aria-label", INLINE_ICONS[name].label);
  } else dom.setAttribute("aria-hidden", "true");
  dom.innerHTML = inlineIconSvg(name, `ub-inline-icon-${nextSvgId++}`);
  dom.querySelector("svg")?.setAttribute("aria-hidden", "true");
  return dom;
}

function decorations(state: EditorState, editing: boolean): DecorationSet {
  const result: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    const { text, icons } = ranges(node);
    const rendered = icons.filter((range) => {
      const from = pos + 1 + range.from;
      const to = pos + 1 + range.to;
      const selection = state.selection;
      return !editing || !(selection.empty
        ? from < selection.from && selection.from < to
        : selection.from < to && from < selection.to);
    });
    for (const range of rendered) {
      let visible = text.slice(range.scopeFrom, range.scopeTo);
      for (const other of [...rendered].reverse()) {
        if (other.from < range.scopeFrom || other.to > range.scopeTo) continue;
        const from = other.from - range.scopeFrom;
        visible = visible.slice(0, from) + visible.slice(other.to - range.scopeFrom);
      }
      const labelled = visible.trim() === "";
      const from = pos + 1 + range.from;
      const to = pos + 1 + range.to;
      result.push(
        Decoration.inline(from, to, { class: "ub-inline-icon-text", "aria-hidden": "true" }),
        Decoration.widget(to, () => icon(range.name, labelled), {
          marks: range.marks,
          side: -1,
          key: JSON.stringify([to, range.name, labelled, range.marks.map((mark) => mark.toJSON())]),
        }),
      );
    }
    return false;
  });
  return DecorationSet.create(state.doc, result);
}

/** Decorations leave native character editing, clipboard serialization and Yjs intact. */
export const InlineIcons = Extension.create({
  name: "uberblickInlineIcons",
  addProseMirrorPlugins() {
    return [new Plugin({ props: {
      decorations: (state) => decorations(state, this.editor.isFocused && this.editor.isEditable),
    } })];
  },
});
