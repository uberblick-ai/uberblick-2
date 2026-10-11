/**
 * Pure derivations shared by document chrome; presence and content revision
 * need no React state.
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
   * Count as an agent only with its explicit marker; all other sessions
   * remain people.
   */
  kind: SessionKind;
  /**
   * Use a published agent-UUID session ID; humans and agents without the
   * field return null.
   */
  session: string | null;
  /** A locally retained departure, never a claim published in awareness. */
  departed?: boolean;
  /**
   * Use one-based visible block positions. An absent or unresolvable caret
   * returns null and omits location text.
   */
  block: number | null;
  /**
   * Stable visible block ID supports a one-shot jump when earlier blocks
   * move; null means no resolvable target.
   */
  blockId: string | null;
}

/**
 * Match schema partitionById visibility: the first claimed ID wins, later
 * duplicates are shadowed, and separate ID-less elements remain visible.
 * Presence numbering and revision folding must agree with getBlocks.
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
 * Sort remote sessions by client ID. Read explicit client/session markers
 * beside user; skip states carrying neither user nor cursor instead of
 * inventing a person.
 */
export function readPresence(
  ydoc: Y.Doc,
  awareness: Awareness,
  isDeparted: (clientId: number) => boolean = () => false,
): RemotePresence[] {
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
      ...(isDeparted(clientId) ? { departed: true } : {}),
      block: location?.block ?? null,
      blockId: location?.blockId ?? null,
    });
  });
  found.sort((a, b) => a.clientId - b.clientId);
  return found;
}

/**
 * Compare every rendered and hover field before storing. Adding a projection
 * field without its comparison would silently discard later updates.
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
    a.session === b.session &&
    (a.departed === true) === (b.departed === true)
  );
}

/**
 * Name the complete session, person or agent, published agent ID and
 * resolvable live caret. Retained departures say left rather than claiming
 * ongoing edits.
 */
export function presenceLabel(session: RemotePresence): string {
  const parts = [session.name, session.kind === "agent" ? "agent" : "person"];
  if (session.session !== null) parts.push(session.session);
  if (session.departed) parts.push("left");
  else if (session.block !== null) parts.push(`editing block ${session.block}`);
  return parts.join(" · ");
}

/** Whether two readings would draw the same presence list. */
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
 * Fold visible block IDs and revisions as a change detector, so order and
 * splits matter without text edits. Seed with one document read, then cache
 * by element identity and reread only invalidated blocks: retyping preserves
 * IDs but replaces elements. Rebuild the cache during folding to drop
 * departed elements, and skip shadowed duplicates so hidden repairs cannot
 * change the visible revision.
 */
export function observeDocRev(ydoc: Y.Doc, emit: (rev: string) => void): () => void {
  const fragment = getBlocksFragment(ydoc);
  let revs = new Map<Y.XmlElement, string>();

  const fold = (seeded?: ReadonlyMap<string, string>): string => {
    const next = new Map<Y.XmlElement, string>();
    const lines: string[] = [];
    for (const child of visibleBlocks(fragment)) {
      const id = child.getAttribute("id") ?? "";
      // A missing cache entry may be new, invalidated or retyped. getBlock
      // supplies the schema read and excludes shadowed duplicates.
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
