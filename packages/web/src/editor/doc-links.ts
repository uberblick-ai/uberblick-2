/**
 * Document references in the editor: the doors one comes in through, the anchor
 * one renders as, and the click that follows it.
 *
 * The `docLink` mark itself is schema (see `marks.ts`): one `docId`, a document
 * uuid, and nothing else. A reference that stored a *path* would break the
 * moment somebody spelled the workspace differently, so the address is derived
 * at render time and never written down.
 *
 * Everything a reference needs beyond the uuid is per-workspace and
 * per-editor — the address of a document, the title the directory currently
 * advertises for it, where a click goes. None of it can live on the mark:
 * `uberblickSchema` is a module-level singleton built once from
 * `paletteExtensions`, so configuring the mark would configure it for every
 * editor in the process. So this is a *behaviour* extension, like
 * `BlockInputRules` and `TableBlocks`, and it takes that workspace-shaped half
 * as a {@link DocLinkContext} the shell hands down.
 *
 * ## The four doors, and only four
 *
 * 1. **Typing** `[label](<uuid>)`, and the shorthand `[<uuid>]`. The external
 *    `[label](https://…)` rule in `marks.ts` is untouched: the two patterns are
 *    disjoint (a uuid is never an `http(s)` URL), so neither can shadow the
 *    other and the order they are registered in does not matter.
 * 2. **Plain-text markdown paste** of the same two spellings. Tiptap's paste
 *    rules skip a clipboard that came from a ProseMirror editor
 *    (`data-pm-slice`), which is what keeps door 3 from being re-parsed as
 *    markdown.
 * 3. **Rich paste**, which is `marks.ts`'s `a[data-doc-id]` parse rule and is
 *    already identity-preserving: the `docId` survives a copy between two
 *    documents, and a pasted `href` is never trusted — the `link` mark refuses
 *    anything that is not external, and the address this file renders is
 *    derived, never read back.
 *
 * 4. **The `@` picker** (`editor/mention-menu.ts`), which is the same insertion
 *    reached from a menu instead of a pattern: it replaces the typed `@query`
 *    through {@link replaceWithDocLink}, so a picked reference and a typed one
 *    are the same mark on the same kind of text. Its candidates come from
 *    {@link DocLinkContext.candidates}, the directory this replica already
 *    holds — no target room is opened to offer one.
 *
 * `canonicalDocumentUuid` is the one definition of a target in all four, the
 * same door the schema package's write boundary uses: an upper-cased uuid is
 * canonicalized down rather than becoming a second identity for one document,
 * and anything else is not a reference at all.
 *
 * ## Resolution happens once, at creation
 *
 * The shorthand borrows a *label*, not a subscription: the directory's title at
 * the moment the link is made becomes ordinary text, and nothing rewrites it
 * later when a rename arrives (#443 decided that live titles are out of scope).
 * A target the directory cannot name right now — absent, not yet synced, empty
 * title, tombstoned — contributes the uuid instead, so the reader always sees
 * something and an empty label is never written.
 *
 * ## Availability is the opposite: always re-read
 *
 * A missing directory entry is not proof of a missing document — the directory
 * may simply not have synced — so an unknown target renders as *unresolved* and
 * a tombstoned one as *archived*, and both are re-read whenever the directory
 * changes. That is what forces the mark view: a mark's `renderHTML` is static,
 * and the state has to be able to change under an open document without
 * touching a single target room. The anchor owns its own attributes, which is
 * why it ignores attribute mutations — ProseMirror must not read a repaint back
 * as an edit.
 */

import { Extension, InputRule, PasteRule } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin } from "@tiptap/pm/state";
import type { Mark, Schema } from "@tiptap/pm/model";
import type { MarkView, ViewMutationRecord } from "@tiptap/pm/view";
import type * as Y from "yjs";
import {
  canonicalDocumentUuid,
  getDirectoryEntry,
  getDirectoryMap,
  listDirectory,
} from "@uberblick/schema";

/**
 * What the directory says about a target right now.
 *
 * `unresolved` is deliberately not "deleted": the directory is a synced
 * document like any other, so a uuid it has never heard of is most often one it
 * has not heard of *yet*.
 */
export type DocLinkState = "resolved" | "unresolved" | "archived";

export interface DocLinkTarget {
  state: DocLinkState;
  /**
   * The label the shorthand may borrow, or null when there is none to borrow —
   * an unknown target, a tombstoned one, or a document with no title. The uuid
   * is what a caller falls back to, and it is visible on purpose.
   */
  title: string | null;
}

/** A document a reference can be made to, and the text such a reference carries. */
export interface DocLinkCandidate {
  docId: string;
  /**
   * What {@link labelFor} would write for this target: its directory title, or
   * its uuid where it has none. One rule, so a picker shows the words the
   * document is about to receive rather than a second spelling of them.
   */
  label: string;
}

/**
 * The workspace-shaped half of a document reference, supplied by the shell.
 *
 * Five questions, all answerable from the directory room the app has already
 * joined: nothing here opens a target's room, and nothing here writes.
 */
export interface DocLinkContext {
  /** The in-app address of a document, from the workspace on screen. */
  href(docId: string): string;
  /** What the directory says about a target right now. */
  lookup(docId: string): DocLinkTarget;
  /**
   * Every document a reference could name, by title. Read at call time from the
   * directory, so it is correct offline and costs nothing until something asks.
   * Tombstoned documents are absent: a reference to one renders as `archived`,
   * which is not a thing to offer a writer.
   */
  candidates(): DocLinkCandidate[];
  /** Directory changes, so an open document can restyle itself. */
  subscribe(onChange: () => void): () => void;
  /** Follow a reference — the shell's own navigation, so Back works. */
  open(docId: string): void;
}

/**
 * A context over one workspace's directory document.
 *
 * `href` and `open` are passed in rather than derived here: routing is the
 * shell's (`ui/route.ts`), and the editor has no business knowing how an
 * address is spelled. A null directory — the moment before the room is
 * joined — is a directory that knows nothing, which is exactly `unresolved`.
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
      if (entry.deleted === true) return { state: "archived", title: null };
      return { state: "resolved", title: entry.title === "" ? null : entry.title };
    },
    candidates(): DocLinkCandidate[] {
      if (directory === null) return [];
      // `listDirectory` drops tombstones and sorts by title; a stub with no
      // title falls back to its uuid, which is what a reference to it would
      // carry anyway.
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
 * The uuid *shape*, for the patterns below.
 *
 * Not a second definition of a document identity — {@link canonicalDocumentUuid}
 * has the last word on every path here and is what lowercases a shouted uuid.
 * This only keeps a rule from claiming text that is plainly not a reference,
 * which is what lets the external link rule and these coexist without either
 * knowing about the other.
 */
const UUID_SHAPE = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";

const DOC_LINK_INPUT = new RegExp(`\\[([^\\]\\n]+)\\]\\((${UUID_SHAPE})\\)$`);
const DOC_LINK_PASTE = new RegExp(`\\[([^\\]\\n]+)\\]\\((${UUID_SHAPE})\\)`, "g");
const SHORTHAND_INPUT = new RegExp(`\\[(${UUID_SHAPE})\\]$`);
const SHORTHAND_PASTE = new RegExp(`\\[(${UUID_SHAPE})\\]`, "g");

/**
 * The text a new reference carries: what the reader wrote, or — for the
 * shorthand — the title the directory advertises this second. Never empty:
 * a link with no label is a link nobody can see or click.
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
 * Replace `range` in `tr` with one marked label, or decline the target.
 *
 * The one place a reference enters a document, shared by all four doors: a rule
 * runner hands its own `state.tr` in, the `@` picker hands in a transaction it
 * dispatches itself. False means the target is not a document uuid — the caller
 * leaves the text exactly as it was typed, pasted, or offered.
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
  tr.replaceWith(
    range.from,
    range.to,
    // A directory title is *text*, and this is the only place one enters a
    // document: `schema.text` cannot make it anything else.
    schema.text(labelFor(docId, label, context), [type.create({ docId })]),
  );
  return true;
}

/**
 * The rule runners' door onto {@link replaceWithDocLink}. Declining is `null`,
 * which both runners read as "this rule did not fire".
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
 * Where the anchor says which of the three states it is in. The stylesheet
 * reads the same attribute, which is what keeps "unresolved" one fact with one
 * spelling rather than a class name and a state that can disagree.
 */
const DOC_LINK_STATE_ATTRIBUTE = "data-doc-link-state";

const STATE_TITLE: Record<DocLinkState, string | null> = {
  resolved: null,
  unresolved:
    "This document has not reached this replica's directory yet — the link " +
    "opens it as soon as it arrives.",
  archived: "This document is archived. The link opens it read-only.",
};

/**
 * Paint one anchor from the directory: address, state, and the sentence that
 * explains a state a reader cannot be expected to guess.
 *
 * Idempotent, because it is called again on every directory change.
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
  // A real anchor with a real address: cmd-click opens a tab, the status bar
  // says where it goes, and the click handler in `EditorPane` only has to
  // intercept the ordinary case. Derived from the workspace on screen — a
  // reference names a document, never an address.
  anchor.setAttribute("href", context.href(docId));
  const explanation = STATE_TITLE[state];
  if (explanation === null) anchor.removeAttribute("title");
  else anchor.setAttribute("title", explanation);
}

/**
 * The mark view: one live anchor per reference.
 *
 * ProseMirror keeps a mark view's DOM for as long as the mark is unchanged, so
 * nothing here re-runs on an edit — the subscription is what makes an
 * availability change visible, and it is torn down with the anchor.
 */
function docLinkMarkViews(context: DocLinkContext): Plugin {
  return new Plugin({
    props: {
      markViews: {
        docLink: (mark: Mark): MarkView => {
          const dom = document.createElement("a");
          const docId = canonicalDocumentUuid(mark.attrs.docId);
          if (docId === null) {
            // Unreachable through the palette gate, which refuses to bind a
            // docLink the schema package's reader rejects. Rendered inert
            // rather than trusted: no address is better than a wrong one.
            dom.className = DOC_LINK_CLASS;
            dom.setAttribute(DOC_LINK_STATE_ATTRIBUTE, "unresolved");
            return { dom };
          }
          const paint = (): void => paintDocLink(dom, docId, context);
          paint();
          const unsubscribe = context.subscribe(paint);
          return {
            dom,
            // The anchor's attributes are this file's, not the document's. A
            // repaint is a DOM mutation inside the editable region, and
            // ProseMirror would otherwise read one back as an edit.
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
 * The document a pointer event landed on, or null.
 *
 * The attribute is read back through the same door it was written through, so
 * a hostile `data-doc-id` that somehow reached the DOM navigates nowhere.
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
 * Everything a `docLink` does that is not storage. Behaviour, so it is added by
 * `createUberblickEditor` and never by `paletteExtensions`: the schema must stay
 * the node and mark set alone.
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
    // No workspace, no address and no directory: the stored mark still renders
    // through `marks.ts`, inert, which is the honest thing for an editor that
    // has nowhere to navigate to.
    return context === null ? [] : [docLinkMarkViews(context)];
  },
});
