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

/** Canonical fence names from the same registry that colours the source. */
export const codeLanguages: readonly string[] = highlighter.listLanguages();

interface CodeToken {
  from: number;
  to: number;
  classes: string;
}

interface HighlightedCode {
  text: string;
  language: unknown;
  tokens: CodeToken[];
}

interface HighlightingState {
  decorations: DecorationSet;
  blocks: Map<PMNode, HighlightedCode>;
}

export const codeHighlightingKey = new PluginKey<HighlightingState>(
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

function codeTokens(language: unknown, text: string): CodeToken[] {
  if (
    typeof language !== "string" ||
    language === "" ||
    !highlighter.registered(language)
  ) {
    return [];
  }

  const tree = highlighter.highlight(language, text) as unknown as {
    children: HighlightNode[];
  };
  const tokens: CodeToken[] = [];
  let offset = 0;

  const visit = (child: HighlightNode, inherited: string[]): void => {
    if (child.type === "text") {
      const start = offset;
      offset += child.value.length;
      if (start !== offset && inherited.length > 0) {
        tokens.push({ from: start, to: offset, classes: inherited.join(" ") });
      }
      return;
    }

    const classes = [...inherited, ...tokenClasses(child)];
    for (const nested of child.children ?? []) visit(nested, classes);
  };

  for (const child of tree.children) visit(child, []);
  return tokens;
}

function highlightedDocument(
  doc: PMNode,
  previous: Map<PMNode, HighlightedCode> = new Map(),
): HighlightingState {
  // Node identity avoids even reading unchanged source. A new node can also
  // carry only a comment/attribute change, so fall back to the actual inputs.
  // Both indexes retain only the previous/current document, not edit history.
  const sources = new Map<unknown, Map<string, HighlightedCode>>();
  for (const cached of previous.values()) {
    let texts = sources.get(cached.language);
    if (texts === undefined) {
      texts = new Map();
      sources.set(cached.language, texts);
    }
    texts.set(cached.text, cached);
  }
  const blocks = new Map<PMNode, HighlightedCode>();
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "code") return;
    let cached = previous.get(node);
    if (cached === undefined) {
      const text = node.textContent;
      const language: unknown = node.attrs.language;
      cached = sources.get(language)?.get(text) ?? {
        text,
        language,
        tokens: codeTokens(language, text),
      };
    }
    blocks.set(node, cached);
    // Rebuild positions from block-relative tokens: y-prosemirror replaces
    // the whole document for remote edits and undo, which drops mapped spans.
    for (const token of cached.tokens) {
      decorations.push(
        Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, {
          class: token.classes,
        }),
      );
    }
    return false;
  });
  return { decorations: DecorationSet.create(doc, decorations), blocks };
}

function codeHighlightingPlugin(): Plugin<HighlightingState> {
  return new Plugin<HighlightingState>({
    key: codeHighlightingKey,
    state: {
      init: (_config, state) => highlightedDocument(state.doc),
      apply: (transaction, previous) =>
        transaction.docChanged
          ? highlightedDocument(transaction.doc, previous.blocks)
          : previous,
    },
    props: {
      decorations: (state) => codeHighlightingKey.getState(state)?.decorations ?? null,
    },
  });
}

export const CodeHighlighting = Extension.create({
  name: "uberblickCodeHighlighting",
  addProseMirrorPlugins() {
    return [codeHighlightingPlugin()];
  },
});
