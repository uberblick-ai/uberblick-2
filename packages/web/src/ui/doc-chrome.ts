/**
 * The document-local chrome's pure derivations.
 *
 * They live apart from the components that draw them because both are about
 * what is *true* — which session has a caret where, and whether the content has
 * changed — and neither needs React to say it.
 */

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { blockRev, getBlock, getBlocks, getBlocksFragment } from "@uberblick/schema";
import { parseRemoteAwareness } from "../collab/remote-awareness.js";

/** What kind of session a peer is, as the session itself says. */
export type SessionKind = "agent" | "human";

/** A remote session in this room, and the block its caret sits in if any. */
export interface RemotePresence {
  /** Stable key: names collide, client ids do not. */
  clientId: number;
  name: string;
  /** The session's own presence colour — its chip is drawn in it. */
  color: string;
  /**
   * Agent only where the session says so (#494). Everything else is a person:
   * a browser tab, including one running a bundle from before either marker
   * existed. This is the positive test — the absence test it replaces called
   * every silent session an agent.
   */
  kind: SessionKind;
  /**
   * The agent session id (`agent-<uuid>`, the one `sync_status` reports), or
   * null for a session that publishes none. Null for every human, and for an
   * agent whose bundle predates the field.
   */
  session: string | null;
  /**
   * 1-based position of the block its caret is in, or null when there is no
   * saying: no cursor published, or one anchored where no reader is looking.
   * Null is "not known", never "block zero" — the sync panel omits the words
   * rather than naming a block it cannot resolve.
   */
  block: number | null;
  /**
   * Stable id of that same visible block, or null when the caret has no
   * resolvable target. The number is for reading; the id is for a one-shot
   * jump that survives blocks being inserted above the caret.
   */
  blockId: string | null;
}

/**
 * The block elements a reader can see, in document order.
 *
 * The first element to claim an id wins; every later element carrying that id
 * is *shadowed* — two replicas re-typing one block converge on two elements
 * sharing its id, and only the first is a block anyone resolves. An element
 * with no id has claimed no identity, so two of those are two blocks and both
 * are visible.
 *
 * This is schema's `partitionById` rule, re-derived because schema exports no
 * projection helper and adding one would be a schema change in service of
 * chrome. Both derivations below go through it, so the block a pill numbers and
 * the blocks a rev folds are the blocks `getBlocks` would have returned.
 */
function visibleBlocks(fragment: Y.XmlFragment): Y.XmlElement[] {
  const seen = new Set<string>();
  const visible: Y.XmlElement[] = [];
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const id = child.getAttribute("id") ?? "";
    if (id !== "") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    visible.push(child);
  }
  return visible;
}

/** The block a relative position lands in, 1-based, or null if it lands nowhere. */
function blockOf(
  ydoc: Y.Doc,
  blocks: readonly Y.XmlElement[],
  anchor: unknown,
): { block: number; blockId: string | null } | null {
  let absolute: { type: Y.AbstractType<unknown> } | null = null;
  try {
    absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(anchor),
      ydoc,
    );
  } catch {
    // Awareness is other people's data: a state that does not decode is a
    // session we say nothing about, never a crash in the chrome.
    return null;
  }
  if (absolute === null) return null;
  // A caret is anchored in the block's Y.XmlText; the block is its parent.
  const element =
    absolute.type instanceof Y.XmlElement ? absolute.type : absolute.type.parent;
  if (!(element instanceof Y.XmlElement)) return null;
  // Not found means the caret is somewhere no reader is looking: outside a
  // block, or inside a shadowed duplicate. Both earn silence rather than a
  // number that disagrees with the document on screen.
  const index = blocks.indexOf(element);
  if (index === -1) return null;
  const id = element.getAttribute("id") ?? "";
  return { block: index + 1, blockId: id === "" ? null : id };
}

/**
 * Every remote session in this room, by client id.
 *
 * Each session says what kind it is in its `client` field (#494) and, where it
 * is an agent, which session it is in `session`. Both ride beside `user` and
 * are withdrawn with it, so a peer that is here at all is a peer this can
 * classify and name.
 *
 * A state carrying neither a `user` nor a cursor is skipped: there is nobody to
 * name and nowhere to point, and a row for it would be a session invented out
 * of an empty map entry.
 */
export function readPresence(ydoc: Y.Doc, awareness: Awareness): RemotePresence[] {
  const blocks = visibleBlocks(getBlocksFragment(ydoc));
  const found: RemotePresence[] = [];
  awareness.getStates().forEach((state, clientId) => {
    const peer = parseRemoteAwareness(awareness, clientId, state);
    if (peer === null) return;
    const { anchor } = peer;
    if (!peer.hasUser && (anchor === undefined || anchor === null)) {
      return;
    }
    const location =
      anchor === undefined || anchor === null
        ? null
        : blockOf(ydoc, blocks, anchor);
    found.push({
      clientId,
      name: peer.name,
      color: peer.color,
      kind: peer.kind,
      session: peer.session,
      block: location?.block ?? null,
      blockId: location?.blockId ?? null,
    });
  });
  found.sort((a, b) => a.clientId - b.clientId);
  return found;
}

/**
 * Whether two readings would draw the same chip.
 *
 * Every field the chip or its hover shows is compared, and that is a
 * correctness rule rather than thoroughness: this is what decides whether a
 * re-read is stored at all, so a projection that gains a field without gaining
 * a comparison here silently drops every update to it. A marker or a session id
 * that arrives after a session's first state is exactly that case.
 */
function sameSession(a: RemotePresence | null, b: RemotePresence | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.clientId === b.clientId &&
    a.block === b.block &&
    a.blockId === b.blockId &&
    a.name === b.name &&
    a.color === b.color &&
    a.kind === b.kind &&
    a.session === b.session
  );
}

/**
 * What a peer's avatar says on hover, and to a screen reader.
 *
 * Every control names the complete session and whether it is a person or an
 * agent. An agent also names its published session id, and either kind names a
 * resolved caret location. Optional tail parts drop out cleanly.
 */
export function presenceLabel(session: RemotePresence): string {
  const parts = [session.name, session.kind === "agent" ? "agent" : "person"];
  if (session.session !== null) parts.push(session.session);
  if (session.block !== null) parts.push(`editing block ${session.block}`);
  return parts.join(" · ");
}

/** Whether two readings would draw the same present-now list. */
export function samePresence(
  a: readonly RemotePresence[],
  b: readonly RemotePresence[],
): boolean {
  return (
    a.length === b.length &&
    a.every((session, at) => sameSession(session, b[at] ?? null))
  );
}

/** How much of the document rev the meta line shows. */
const REV_LENGTH = 8;

/** The top-level block containing an event, or null for a fragment event. */
function blockElementOf(
  target: Y.AbstractType<unknown>,
  fragment: Y.XmlFragment,
): Y.XmlElement | null {
  // Deep events name the changed type, including table cell text and rows.
  // The cache owns the fragment's direct children, not those nested elements.
  let current: Y.AbstractType<unknown> | null = target;
  while (current !== null) {
    if (current.parent === fragment) {
      return current instanceof Y.XmlElement ? current : null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * The document's rev, live: the fold of its block revs through the same hash
 * the blocks use, so "changed" means one thing at both levels.
 *
 * A change detector, not a version counter — exactly what a block `rev` is.
 * Block ids go into the fold as well as block revs, so reordering two blocks or
 * splitting one changes the document rev even when no character did.
 *
 * `blockRev` is that hash's only exported entry point, and a document rev is
 * chrome rather than a schema concern, so it is folded here rather than added
 * to `@uberblick/schema`.
 *
 * **Why this is an observer and not a function of the document.** The obvious
 * shape — read `getBlocks(ydoc)` whenever anything changes — reads and rehashes
 * every character of every block on every keystroke, which is the whole
 * document's worth of work for eight characters of chrome. So the revs are
 * cached and only the block an event landed in is re-read: `getBlocks` runs
 * once, to seed, and each later edit costs one `getBlock` plus the fold. The
 * fold itself walks the fragment reading `id` attributes — no text — so the
 * recurring cost is in blocks, never in characters.
 *
 * **The cache is keyed by element identity, not by block id**, and that is a
 * correctness rule rather than a preference. A `setBlockType` keeps the block's
 * id and *replaces its element* (Yjs element names are immutable), so the only
 * event it produces is a structural one on the fragment: nothing names the
 * block, and an id-keyed cache would answer with the old type's rev for as long
 * as the document stayed open. A replaced element is a different object, so it
 * is a cache miss for free — no invalidation rule to get wrong.
 *
 * The cache is rebuilt by the fold rather than pruned, so a block that leaves
 * the document takes its entry with it.
 *
 * **Shadowed duplicates are skipped** — the fold walks `visibleBlocks`, not the
 * raw fragment. Folding a hidden element would count it as content, and the
 * repair that later deletes it would move the rev with nothing on screen having
 * changed.
 */
export function observeDocRev(ydoc: Y.Doc, emit: (rev: string) => void): () => void {
  const fragment = getBlocksFragment(ydoc);
  let revs = new Map<Y.XmlElement, string>();

  const fold = (seeded?: ReadonlyMap<string, string>): string => {
    const next = new Map<Y.XmlElement, string>();
    const lines: string[] = [];
    for (const child of visibleBlocks(fragment)) {
      const id = child.getAttribute("id") ?? "";
      // A miss is an element this fold has not seen: a new block, one an event
      // invalidated, or the replacement a re-type left behind. `getBlock` is the
      // schema's own read, so a shadowed duplicate never supplies the rev.
      const rev = revs.get(child) ?? seeded?.get(id) ?? getBlock(ydoc, id)?.rev ?? "";
      next.set(child, rev);
      lines.push(`${id} ${rev}`);
    }
    revs = next;
    return blockRev({ type: "paragraph", text: lines.join("\n") }).slice(0, REV_LENGTH);
  };

  const onChange = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
    for (const event of events) {
      const element = blockElementOf(event.target, fragment);
      if (element !== null) revs.delete(element);
    }
    emit(fold());
  };

  // The one whole-document pass, handed to the first fold so it costs a single
  // read rather than a `getBlock` scan per block.
  emit(fold(new Map(getBlocks(ydoc).map((block) => [block.id, block.rev]))));
  fragment.observeDeep(onChange);
  return () => fragment.unobserveDeep(onChange);
}
