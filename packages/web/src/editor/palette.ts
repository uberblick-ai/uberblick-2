/**
 * The restricted block palette, and the gate that keeps foreign content out.
 *
 * The editor's ProseMirror schema declares exactly the schema-owned block types
 * and exactly the schema-owned marks. That is deliberate: y-prosemirror serialises a
 * ProseMirror node straight onto the `blocks` Y.XmlFragment, and its
 * `updateYFragment` removes any Yjs attribute the ProseMirror node spec does
 * not declare. A wider palette means the web client can write shapes the schema
 * package cannot read; an under-declared attribute set means the web client
 * silently deletes attributes an agent wrote.
 *
 * ## Why a gate exists at all
 *
 * y-prosemirror's `createNodeFromYElement` calls `schema.node(el.nodeName, …)`
 * and, when that throws — which is exactly what happens for a node name the
 * schema does not know — its catch block **deletes the Y.XmlElement from the
 * document**. Unknown blocks would not merely fail to render: they would be
 * destroyed in the CRDT and the deletion would replicate to every peer.
 *
 * So binding is gated. `findForeignBlocks` scans the fragment before an editor
 * is created; when it finds anything outside the palette the app refuses to
 * bind ProseMirror and renders a loud read-only fallback instead (see
 * `ui/EditorPane.tsx`). Loud, and nothing is dropped — the foreign elements
 * stay in the document untouched, which is the whole point.
 *
 * A ProseMirror schema cannot have a catch-all node type, so there is no
 * in-editor placeholder that would let us bind safely; refusing to bind is the
 * only option that preserves the data.
 *
 * ## The scan is recursive, because the hazard is
 *
 * The same catch-and-delete sits one level down. `createNodeFromYElement`
 * recurses into a block's children, and `createTextNodesFromYText` builds every
 * mark with `schema.mark(name, attrs)`; either throwing deletes the offending
 * Y type. So a *known* block name is not enough: a `<paragraph>` holding a
 * `<callout>` loses the callout, and a Y.XmlText carrying a mark the schema does not
 * declare (`underline`, say) loses the whole text node.
 *
 * A mark the schema *does* declare but the enclosing block may not hold is
 * foreign too, and fails more quietly. `schema.text` never validates marks
 * against the parent node, so nothing throws and nothing is deleted — the editor
 * just holds an invalid document until the next write normalises the mark out of
 * it. An inline mark inside a `code` or `mermaid` block is exactly that: those
 * nodes hold source text, so `comment` is the only mark they allow.
 *
 * A mark whose *value* the editor cannot render faithfully is the same kind of
 * hazard, one step further in, and the quietest of the three. y-prosemirror hands
 * whatever it finds to `schema.mark(name, attrs)`, which happily builds a mark
 * from a value the schema package's reader calls "not marked" — a `{bold: false}`
 * binds as bold and the next keystroke writes it back as real bold, and a `link`
 * with a `javascript:` target goes straight into an `<a href>`. Neither is a loss;
 * both are the document meaning two things at once. So the gate asks the reader's
 * own question, {@link readsAsMark}, and refuses to bind when the answer is no.
 *
 * The same hazard has a *precedence* form, for the two link marks: a merge can
 * leave both on one range, the schema package reads that as the docLink alone,
 * and y-prosemirror — which builds one mark per attribute and never consults
 * ProseMirror's `excludes` — would bind both and render two nested anchors. So
 * the gate asks the reader's precedence question too.
 *
 * A Y.XmlText's *content* is the third case, and the quietest one.
 * `createTextNodesFromYText` only ever calls `schema.text(delta.insert, marks)`,
 * so a delta op whose `insert` is not a string (an embed, written with
 * `insertEmbed`) has no ProseMirror representation at all. Nothing throws and
 * nothing is deleted at bind time — but the embed is absent from the editor
 * state, so the next keystroke round-trips the block's text back onto the
 * Y.XmlText without it. That is silent data loss on a later mutation rather than
 * on binding, which makes it worse, not better. A block is safe to bind only
 * when its children are all Y.XmlText, those texts insert nothing but strings,
 * and those strings carry nothing but marks the block itself allows.
 */

import * as Y from "yjs";
import { BLOCK_TYPES, isBlockType, readsAsMark } from "@uberblick/schema";
import { uberblickSchema } from "./create-editor.js";

/** The node names the editor may render. Identical to the schema's block types. */
export const BLOCK_NODE_NAMES: readonly string[] = BLOCK_TYPES;

/**
 * The gate's reason for a range a merge left carrying both link marks.
 *
 * Not a `#mark:` reason, deliberately: `link` and `docLink` are both supported,
 * and naming either one as unsupported would point at the wrong thing. This is
 * a conflict between two supported marks, and it has its own recovery — see
 * {@link describeForeignBlocks}.
 */
export const LINK_CONFLICT = "#conflict:link+docLink";

/** Content in the `blocks` fragment that the palette cannot render. */
export interface ForeignBlock {
  /** Position of the *top-level* element in the fragment, in document order. */
  index: number;
  /**
   * What the palette cannot represent: an unknown node name, `#text`/`#hook`
   * for a stray non-element, `#mark:<name>` for an undeclared mark, `#embed`
   * for a non-string delta insertion, or {@link LINK_CONFLICT} — the one
   * reason that is not "unsupported" at all, but two supported marks a merge
   * left on one range.
   */
  nodeName: string;
  /** The element's `id` attribute, when it has one. */
  id: string | null;
  /** First 80 characters of the element's text, for the loud placeholder. */
  preview: string;
}

function previewOf(child: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  const text = child instanceof Y.XmlElement ? child.toString() : String(child);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** Whether `blockName`'s node type allows `mark`, read off the editor's schema. */
function blockAllowsMark(blockName: string, mark: string): boolean {
  const node = uberblickSchema.nodes[blockName];
  const type = uberblickSchema.marks[mark];
  return node !== undefined && type !== undefined && node.allowsMarkType(type);
}

/**
 * What inside an otherwise-renderable block the palette cannot represent, or
 * `null` when the child is fine. A block's children must be Y.XmlText, and a
 * Y.XmlText may only insert strings, carrying only marks that block allows, with
 * values the editor can render.
 */
function foreignInsideBlock(
  blockName: string,
  child: Y.XmlElement | Y.XmlText | Y.XmlHook,
): string | null {
  if (child instanceof Y.XmlElement) return child.nodeName;
  if (!(child instanceof Y.XmlText)) return "#hook";
  for (const op of child.toDelta() as Array<{
    insert?: unknown;
    attributes?: Record<string, unknown>;
  }>) {
    // Embeds have no ProseMirror equivalent, so binding drops them from the
    // editor state and the next edit writes the text back without them.
    if (typeof op.insert !== "string") return "#embed";
    for (const [mark, value] of Object.entries(op.attributes ?? {})) {
      if (!blockAllowsMark(blockName, mark)) return `#mark:${mark}`;
      // Same question the schema package's reader asks, and it has to be the same
      // answer: y-prosemirror builds a mark from any attrs object it is handed, so
      // a value the reader calls "not marked" would bind as marked and be written
      // back as the real thing.
      if (!readsAsMark(mark, value)) return `#mark:${mark}`;
      // …and the same *precedence*, for the one range that can carry both link
      // marks. A merge of two replicas that formatted it differently leaves
      // both keys behind (the schema package's `inlineLinkTarget` resolves that
      // to the docLink), but y-prosemirror's `attributesToMarks` builds a mark
      // per attribute without consulting ProseMirror's `excludes`, so binding
      // would render an external anchor wrapping a document anchor: the
      // document meaning two things at once, which is exactly what this gate is
      // for. Nothing is dropped — the loud fallback shows the block and both
      // marks stay in the CRDT until a writer resolves them.
      if (mark === "link" && readsAsMark("docLink", op.attributes?.docLink)) {
        return LINK_CONFLICT;
      }
    }
  }
  return null;
}

/**
 * Everything in the `blocks` fragment the editor palette cannot represent, one
 * entry per offending top-level block. Empty array means the fragment is safe
 * to bind.
 *
 * Non-element children (a bare Y.XmlText directly under the fragment, which the
 * schema package never writes) count as foreign too: the editor's `doc` node is
 * `block+`, so inline content at the top level has nowhere to go.
 */
export function findForeignBlocks(fragment: Y.XmlFragment): ForeignBlock[] {
  const foreign: ForeignBlock[] = [];
  const children = fragment.toArray();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    if (!(child instanceof Y.XmlElement)) {
      foreign.push({
        index,
        nodeName: child instanceof Y.XmlText ? "#text" : "#hook",
        id: null,
        preview: previewOf(child),
      });
      continue;
    }
    const id = child.getAttribute("id") ?? null;
    if (!isBlockType(child.nodeName)) {
      foreign.push({ index, nodeName: child.nodeName, id, preview: previewOf(child) });
      continue;
    }
    for (const inner of child.toArray()) {
      const nodeName = foreignInsideBlock(child.nodeName, inner);
      if (nodeName === null) continue;
      // One entry per block: the count in the banner is a block count.
      foreign.push({ index, nodeName, id, preview: previewOf(child) });
      break;
    }
  }
  return foreign;
}

/**
 * One maximal range a merge left carrying both link marks, and the two targets
 * it means at once — what an explicit repair needs in order to offer a choice.
 *
 * The anchor is the live `Y.XmlText` itself, never the block's `id`. A
 * concurrent re-type can leave two raw elements carrying one id, and a block
 * can hold more than one text child, so an id lookup is not a collision-proof
 * way back to the range this entry describes. `blockId` and `index` are for
 * display and for a stable list key; the write goes through `text`.
 */
export interface LinkConflictRange {
  /** Start of the range, in Yjs format indices — an embed counts as one. */
  start: number;
  /** End of the range, exclusive. */
  end: number;
  /** The range's own characters: which words on screen carry both marks. */
  label: string;
  /** The external target. */
  href: string;
  /** The referenced document's uuid. */
  docId: string;
}

export interface LinkConflict extends LinkConflictRange {
  /** Position of the *top-level* element in the fragment, in document order. */
  index: number;
  /** The element's `id` attribute, when it has one. Display, never lookup. */
  blockId: string | null;
  /** The text holding the range, and the handle the repair writes through. */
  text: Y.XmlText;
}

/** The two targets of one delta op, when it carries both link marks. */
function linkPair(op: {
  insert?: unknown;
  attributes?: Record<string, unknown>;
}): { href: string; docId: string } | null {
  if (typeof op.insert !== "string") return null;
  const attributes = op.attributes ?? {};
  // The reader's own question, twice: a value it calls "not marked" is not one
  // of the two targets, so it is not half of a conflict either.
  if (!readsAsMark("link", attributes.link)) return null;
  if (!readsAsMark("docLink", attributes.docLink)) return null;
  return {
    href: (attributes.link as { href: string }).href,
    docId: (attributes.docLink as { docId: string }).docId,
  };
}

/**
 * The conflicting ranges in one text, as maximal runs of the *same* pair.
 *
 * Maximal by the pair alone: bold, a comment anchor or any other mark splits
 * the raw delta without splitting the conflict, so adjacent ops carrying the
 * same `href` and `docId` are one range and one choice. A different pair
 * beside it is a different choice, and a range carrying only one of the two
 * marks is not a conflict at all.
 *
 * Shared by the scan below and by the repair's re-read (`link-repair.ts`), so
 * the range a control offers and the range a click writes to are found by one
 * definition rather than two that can drift.
 */
export function linkConflictsIn(text: Y.XmlText): LinkConflictRange[] {
  const ranges: LinkConflictRange[] = [];
  let offset = 0;
  let open: { start: number; label: string; href: string; docId: string } | null =
    null;
  const close = (end: number): void => {
    if (open !== null) ranges.push({ ...open, end });
    open = null;
  };
  for (const op of text.toDelta() as Array<{
    insert?: unknown;
    attributes?: Record<string, unknown>;
  }>) {
    const pair = linkPair(op);
    if (open !== null && (pair === null || pair.href !== open.href || pair.docId !== open.docId)) {
      close(offset);
    }
    if (pair !== null) {
      if (open === null) open = { start: offset, label: "", ...pair };
      open.label += op.insert as string;
    }
    // An embed is one index to Yjs' formatter, so it is one index here too:
    // these offsets are what `Y.XmlText.format` is called with.
    offset += typeof op.insert === "string" ? op.insert.length : 1;
  }
  close(offset);
  return ranges;
}

/**
 * Every conflicting range in the fragment, in document order.
 *
 * Deliberately not {@link findForeignBlocks}: that reports the *first* offender
 * per top-level block and stops, so a conflict sitting behind any other foreign
 * reason in the same block — an undeclared mark earlier in the text, a nested
 * element before it — is invisible there. A repair list that inherited that
 * limit would silently refuse to offer half the choices in the document.
 *
 * Only where the block itself may hold both marks. On a `code` or `mermaid`
 * block the same pair is `#mark:link`: an undeclared mark, a different problem
 * with a different recovery, and not something a link choice can fix.
 */
export function findLinkConflicts(fragment: Y.XmlFragment): LinkConflict[] {
  const conflicts: LinkConflict[] = [];
  const children = fragment.toArray();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!(child instanceof Y.XmlElement)) continue;
    if (!isBlockType(child.nodeName)) continue;
    if (!blockAllowsMark(child.nodeName, "link")) continue;
    if (!blockAllowsMark(child.nodeName, "docLink")) continue;
    const blockId = child.getAttribute("id") ?? null;
    for (const inner of child.toArray()) {
      if (!(inner instanceof Y.XmlText)) continue;
      for (const range of linkConflictsIn(inner)) {
        conflicts.push({ ...range, index, blockId, text: inner });
      }
    }
  }
  return conflicts;
}

/**
 * A single-line, human-readable summary for the loud placeholder.
 *
 * The two reasons are said separately, because they are not the same problem
 * and do not have the same recovery. An unsupported type is content this
 * client cannot represent at all; a link conflict is two marks it supports
 * perfectly well, on one range, where the model reads only one of them. Rolling
 * the second into "unsupported type (#mark:link)" would name a mark that *is*
 * supported and leave the reader with nothing to do about it.
 *
 * `repairable` is what the conflict sentence points at. An archived document
 * takes no write at all, so it is offered no repair control — telling its
 * reader to choose below, where nothing is, would be the one thing worse than
 * the old advice to go and use the MCP tools.
 */
export function describeForeignBlocks(
  foreign: ForeignBlock[],
  options: { repairable?: boolean } = {},
): string {
  if (foreign.length === 0) return "";
  const blocks = (count: number): string =>
    `${count} block${count === 1 ? "" : "s"}`;
  const conflicting = foreign.filter((block) => block.nodeName === LINK_CONFLICT);
  const unsupported = foreign.filter((block) => block.nodeName !== LINK_CONFLICT);
  const sentences: string[] = [];
  if (unsupported.length > 0) {
    const names = [...new Set(unsupported.map((block) => block.nodeName))].join(
      ", ",
    );
    sentences.push(
      `${blocks(unsupported.length)} of unsupported type (${names}) — editing is disabled so nothing gets destroyed.`,
    );
  }
  if (conflicting.length > 0) {
    sentences.push(
      options.repairable === false
        ? `${blocks(conflicting.length)} with conflicting external and document links on one range — both are retained; restore this document to choose which link each range keeps.`
        : `${blocks(conflicting.length)} with conflicting external and document links on one range — both are retained; choose below which link each range keeps, and editing resumes.`,
    );
  }
  return sentences.join(" ");
}
