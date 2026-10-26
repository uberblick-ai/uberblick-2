import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { COMMENT_MARK } from "@uberblick/schema";
import { personMentionTokens } from "../mentions.js";

const membersKey = new PluginKey<readonly string[]>("uberblickPersonMentions");

/** Membership is presentation context, never document state or history. */
export function setEditorMembers(editor: Editor, members: readonly string[]): void {
  if (editor.isDestroyed) return;
  const current = membersKey.getState(editor.state);
  if (current === undefined || current.length === members.length
    && current.every((member, index) => member === members[index])) return;
  editor.view.dispatch(editor.state.tr.setMeta(membersKey, members).setMeta("addToHistory", false));
}

interface TextRun { from: number; to: number; marks: readonly Mark[] }

function ranges(node: ProseMirrorNode, members: readonly string[]) {
  let text = "";
  const runs: TextRun[] = [];
  node.forEach((child, offset) => {
    text += child.isText ? child.text : "\ufffc".repeat(child.nodeSize);
    runs.push({ from: offset, to: offset + child.nodeSize, marks: child.marks });
  });
  return personMentionTokens(text, members).flatMap((token) => {
    const touched = runs.filter((run) => run.from < token.to && token.from < run.to);
    if (touched.some((run) => run.marks.some((mark) => mark.type.spec.code))) return [];
    const link = touched.flatMap((run) => run.marks).find((mark) => mark.type.name === "link" || mark.type.name === "docLink");
    const marks: Mark[] = [...(link?.addToSet(touched[0]?.marks ?? []) ?? touched[0]?.marks ?? [])];
    for (const run of touched) {
      for (const mark of run.marks) {
        if (mark.type.name === COMMENT_MARK
          && !marks.some((existing) => existing.eq(mark))) marks.push(mark);
      }
    }
    return [{ ...token, marks }];
  });
}

function decorations(state: EditorState, editing: boolean, members: readonly string[]): DecorationSet {
  const result: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    for (const range of ranges(node, members)) {
      const from = pos + 1 + range.from;
      const to = pos + 1 + range.to;
      const selection = state.selection;
      if (editing && (selection.empty
        ? from < selection.from && selection.from < to
        : selection.from < to && from < selection.to)) continue;
      result.push(
        Decoration.inline(from, to, { class: "ub-person-mention-text", "aria-hidden": "true" }),
        Decoration.widget(to, () => {
          const pill = document.createElement("span");
          pill.className = "ub-person-pill";
          pill.textContent = range.text;
          return pill;
        }, {
          marks: range.marks,
          side: -1,
          key: JSON.stringify([to, range.text, range.marks.map((mark) => mark.toJSON())]),
        }),
      );
    }
    return false;
  });
  return DecorationSet.create(state.doc, result);
}

/** Plain @username text remains intact for Yjs, clipboard, Markdown, MCP and search. */
export const PersonMentions = Extension.create({
  name: "uberblickPersonMentions",
  addProseMirrorPlugins() {
    return [new Plugin<readonly string[]>({
      key: membersKey,
      state: {
        init: () => [],
        apply: (tr, previous) => tr.getMeta(membersKey) as readonly string[] | undefined ?? previous,
      },
      props: {
        decorations: (state) => decorations(state, this.editor.isFocused && this.editor.isEditable,
          membersKey.getState(state) ?? []),
      },
    })];
  },
});
