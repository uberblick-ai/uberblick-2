/**
 * Store only a canonical document UUID on docLink. Workspace addresses are
 * derived at render time; module-level schema marks cannot hold editor context.
 *
 * Typing, Markdown paste and the @ picker share replaceWithDocLink. Rich paste
 * preserves data-doc-id and never trusts its href; data-pm-slice prevents Markdown
 * paste rules from reparsing editor clipboard content.
 *
 * Borrow a directory title only at creation; later renames do not rewrite text.
 * Availability is re-read on directory changes without opening target rooms;
 * mark-view repaints must not be read back as document edits.
 */

import { Extension, InputRule, PasteRule } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin } from "@tiptap/pm/state";
import type { Mark, Schema } from "@tiptap/pm/model";
import type { MarkView, ViewMutationRecord } from "@tiptap/pm/view";
import type * as Y from "yjs";
import { singleLine } from "./table-text.js";
import {
  decisionTopicArchived,
  canonicalDocumentUuid,
  getDirectoryEntry,
  getDirectoryMap,
  listDirectory,
} from "@uberblick/schema";

/**
 * A missing directory entry is unresolved, because synchronization may be late.
 */
export type DocLinkState = "resolved" | "unresolved" | "archived";

export interface DocLinkTarget {
  state: DocLinkState;
  /**
   * Null for unknown, archived or untitled targets; callers must fall back to the
   * UUID so a link never has an empty label.
   */
  title: string | null;
}

/** A document a reference can be made to, and the text such a reference carries. */
export interface DocLinkCandidate {
  docId: string;
  /**
   * Use the same directory-title/UUID label that insertion writes.
   */
  label: string;
}

/**
 * Read only the already-joined directory; no target-room opens or writes.
 */
export interface DocLinkContext {
  /** The in-app address of a document, from the workspace on screen. */
  href(docId: string): string;
  /** What the directory says about a target right now. */
  lookup(docId: string): DocLinkTarget;
  /**
   * Read current title-ordered candidates from the local directory, excluding
   * archived entries. This must work offline without hydrating target rooms.
   */
  candidates(): DocLinkCandidate[];
  /** Directory changes, so an open document can restyle itself. */
  subscribe(onChange: () => void): () => void;
  /** Follow a reference — the shell's own navigation, so Back works. */
  open(docId: string): void;
}

/**
 * Routing stays with the shell. A null directory is unresolved, not missing.
 */
export function createDocLinkContext(options: {
  directory: Y.Doc | null;
  href: (docId: string) => string;
  open: (docId: string) => void;
}): DocLinkContext {
  const { directory, href, open } = options;
  return {
    href,
    open,
    lookup(docId: string): DocLinkTarget {
      const entry = directory === null ? null : getDirectoryEntry(directory, docId);
      if (entry === null) return { state: "unresolved", title: null };
      if (directory !== null && decisionTopicArchived(directory, docId)) {
        return { state: "archived", title: null };
      }
      return { state: "resolved", title: entry.title === "" ? null : entry.title };
    },
    candidates(): DocLinkCandidate[] {
      if (directory === null) return [];
      // Match insertion labels; listDirectory excludes tombstones and orders titles.
      return listDirectory(directory).map((entry) => ({
        docId: entry.uuid,
        label: entry.title === "" ? entry.uuid : entry.title,
      }));
    },
    subscribe(onChange: () => void): () => void {
      if (directory === null) return () => {};
      const map = getDirectoryMap(directory);
      map.observe(onChange);
      return () => map.unobserve(onChange);
    },
  };
}

/**
 * Keep UUID patterns disjoint from external URL rules; canonicalDocumentUuid
 * remains the identity validator and lowercases accepted targets.
 */
const UUID_SHAPE = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";

const DOC_LINK_INPUT = new RegExp(`\\[([^\\]\\n]+)\\]\\((${UUID_SHAPE})\\)$`);
const DOC_LINK_PASTE = new RegExp(`\\[([^\\]\\n]+)\\]\\((${UUID_SHAPE})\\)`, "g");
const SHORTHAND_INPUT = new RegExp(`\\[(${UUID_SHAPE})\\]$`);
const SHORTHAND_PASTE = new RegExp(`\\[(${UUID_SHAPE})\\]`, "g");

/**
 * Use authored text or the current directory title for shorthand. Fall back to
 * the UUID for an empty label so the anchor remains visible and clickable.
 */
function labelFor(
  docId: string,
  label: string | null,
  context: DocLinkContext | null,
): string {
  const borrowed = label ?? context?.lookup(docId).title ?? null;
  return borrowed === null || borrowed.trim() === "" ? docId : borrowed;
}

/**
 * All insertion paths use one canonical UUID boundary. Invalid targets return
 * false without changing the transaction.
 */
export function replaceWithDocLink(
  tr: Transaction,
  schema: Schema,
  range: { from: number; to: number },
  target: string | undefined,
  label: string | null,
  context: DocLinkContext | null,
): boolean {
  const docId = canonicalDocumentUuid(target);
  const type = schema.marks.docLink;
  if (docId === null || type === undefined) return false;
  const $from = tr.doc.resolve(range.from);
  const title = labelFor(docId, label, context);
  // Table cells store one line, including titles borrowed from the directory.
  const text = $from.depth > 1 && $from.node(1).type.name === "table" ? singleLine(title) : title;
  tr.replaceWith(
    range.from,
    range.to,
    // Directory titles enter as text, never markup.
    schema.text(text, [type.create({ docId })]),
  );
  return true;
}

/**
 * Return null on refusal: both rule runners interpret it as not matching.
 */
function insertDocLink(
  state: EditorState,
  range: { from: number; to: number },
  target: string | undefined,
  label: string | null,
  context: DocLinkContext | null,
): null | undefined {
  return replaceWithDocLink(state.tr, state.schema, range, target, label, context)
    ? undefined
    : null;
}

/** The class every document reference carries, resolved or not. */
const DOC_LINK_CLASS = "ub-doclink";

/**
 * Keep CSS availability state and the anchor's state on this one attribute.
 */
const DOC_LINK_STATE_ATTRIBUTE = "data-doc-link-state";

const STATE_TITLE: Record<DocLinkState, string | null> = {
  resolved: null,
  unresolved:
    "This document has not reached this page's directory yet — the link " +
    "opens it as soon as it arrives.",
  archived: "This document is archived. The link opens it read-only.",
};

/**
 * Repaint idempotently on directory changes without writing the reference.
 */
function paintDocLink(
  anchor: HTMLAnchorElement,
  docId: string,
  context: DocLinkContext,
): void {
  const { state } = context.lookup(docId);
  anchor.className = DOC_LINK_CLASS;
  anchor.setAttribute("data-doc-id", docId);
  anchor.setAttribute(DOC_LINK_STATE_ATTRIBUTE, state);
  // A derived href preserves native modified clicks and the status-bar address.
  anchor.setAttribute("href", context.href(docId));
  const explanation = STATE_TITLE[state];
  if (explanation === null) anchor.removeAttribute("title");
  else anchor.setAttribute("title", explanation);
}

/**
 * Subscribe for the anchor's lifetime: ProseMirror reuses unchanged mark DOM,
 * so availability changes need this subscription and its teardown.
 */
function docLinkMarkViews(context: DocLinkContext): Plugin {
  return new Plugin({
    props: {
      markViews: {
        docLink: (mark: Mark): MarkView => {
          const dom = document.createElement("a");
          const docId = canonicalDocumentUuid(mark.attrs.docId);
          if (docId === null) {
            // The palette gate rejects this shape; render inert if it reaches the view.
            dom.className = DOC_LINK_CLASS;
            dom.setAttribute(DOC_LINK_STATE_ATTRIBUTE, "unresolved");
            return { dom };
          }
          const paint = (): void => paintDocLink(dom, docId, context);
          paint();
          const unsubscribe = context.subscribe(paint);
          return {
            dom,
            // Ignore presentation attribute mutations so repaint cannot become an edit.
            ignoreMutation: (mutation: ViewMutationRecord) =>
              mutation.type === "attributes",
            destroy: unsubscribe,
          };
        },
      },
    },
  });
}

/**
 * Validate DOM data-doc-id through the same canonical UUID boundary before
 * navigating, even if an invalid attribute reaches the DOM.
 */
export function docLinkFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[data-doc-id]");
  return anchor === null
    ? null
    : canonicalDocumentUuid(anchor.getAttribute("data-doc-id"));
}

export interface DocLinkOptions {
  /** Null in an editor with no workspace behind it — the rules still work. */
  context: DocLinkContext | null;
}

/**
 * Add context-dependent behavior in createUberblickEditor; keep the shared
 * paletteExtensions schema independent of workspaces and routing.
 */
export const DocLinks = Extension.create<DocLinkOptions>({
  name: "uberblickDocLinks",

  addOptions() {
    return { context: null };
  },

  addInputRules() {
    const context = this.options.context;
    return [
      new InputRule({
        find: DOC_LINK_INPUT,
        handler: ({ state, range, match }) =>
          insertDocLink(state, range, match[2], match[1] ?? "", context),
      }),
      new InputRule({
        find: SHORTHAND_INPUT,
        handler: ({ state, range, match }) =>
          insertDocLink(state, range, match[1], null, context),
      }),
    ];
  },

  addPasteRules() {
    const context = this.options.context;
    return [
      new PasteRule({
        find: DOC_LINK_PASTE,
        handler: ({ state, range, match }) =>
          insertDocLink(state, range, match[2], match[1] ?? "", context),
      }),
      new PasteRule({
        find: SHORTHAND_PASTE,
        handler: ({ state, range, match }) =>
          insertDocLink(state, range, match[1], null, context),
      }),
    ];
  },

  addProseMirrorPlugins() {
    const context = this.options.context;
    // Without workspace context, marks.ts renders an inert stored reference.
    return context === null ? [] : [docLinkMarkViews(context)];
  },
});
