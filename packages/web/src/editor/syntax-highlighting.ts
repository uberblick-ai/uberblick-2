/**
 * Presentation-only syntax colouring for the schema-owned `code` block.
 *
 * Lowlight returns a HAST tree whose leaves are the original source text. We
 * turn only its token classes into ProseMirror inline decorations: no node,
 * mark or attribute is written, and serialization continues to see the same
 * document it did before highlighting existed.
 */

import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { common, createLowlight } from "lowlight";

const highlighter = createLowlight(common);
export const codeHighlightingKey = new PluginKey<DecorationSet>(
  "uberblickCodeHighlighting",
);

type HighlightNode =
  | { type: "text"; value: string }
  | {
      type: "element";
      properties?: { className?: unknown };
      children?: HighlightNode[];
    };

function tokenClasses(node: HighlightNode): string[] {
  if (node.type !== "element") return [];
  const value = node.properties?.className;
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function highlightedCode(node: PMNode, pos: number): Decoration[] {
  const language = node.attrs.language;
  if (
    typeof language !== "string" ||
    language === "" ||
    !highlighter.registered(language)
  ) {
    return [];
  }

  const tree = highlighter.highlight(language, node.textContent) as unknown as {
    children: HighlightNode[];
  };
  const decorations: Decoration[] = [];
  let offset = 0;

  const visit = (child: HighlightNode, inherited: string[]): void => {
    if (child.type === "text") {
      const start = offset;
      offset += child.value.length;
      if (start !== offset && inherited.length > 0) {
        decorations.push(
          Decoration.inline(pos + 1 + start, pos + 1 + offset, {
            class: inherited.join(" "),
          }),
        );
      }
      return;
    }

    const classes = [...inherited, ...tokenClasses(child)];
    for (const nested of child.children ?? []) visit(nested, classes);
  };

  for (const child of tree.children) visit(child, []);
  return decorations;
}

function highlightedDocument(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "code") return;
    decorations.push(...highlightedCode(node, pos));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function codeHighlightingPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: codeHighlightingKey,
    state: {
      init: (_config, state) => highlightedDocument(state.doc),
      apply: (transaction, previous) =>
        transaction.docChanged
          ? highlightedDocument(transaction.doc)
          : previous.map(transaction.mapping, transaction.doc),
    },
    props: {
      decorations: (state) => codeHighlightingKey.getState(state) ?? null,
    },
  });
}

export const CodeHighlighting = Extension.create({
  name: "uberblickCodeHighlighting",
  addProseMirrorPlugins() {
    return [codeHighlightingPlugin()];
  },
});
