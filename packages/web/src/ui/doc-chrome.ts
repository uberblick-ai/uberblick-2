/**
 * The two derivations the doc chrome needs, both pure reads over the document.
 *
 * They live apart from the components that draw them because both are about
 * what is *true* — which session has a caret where, and whether the content has
 * changed — and neither needs React to say it.
 */

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { blockRev, getBlocks, getBlocksFragment } from "@uberblick/schema";
import { AWARENESS_FALLBACK_COLOR } from "../collab/identity.js";

/** A remote session with a caret in this document, and the block it sits in. */
export interface RemoteActivity {
  /** Stable key: names collide, client ids do not. */
  clientId: number;
  name: string;
  /** The session's own presence colour — the pill is drawn in it. */
  color: string;
  /** 1-based position of the block in the document. */
  block: number;
}

/** The block a relative position lands in, 1-based, or null if it lands nowhere. */
function blockOf(ydoc: Y.Doc, blocks: unknown[], anchor: unknown): number | null {
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
  const index = blocks.indexOf(element);
  return index === -1 ? null : index + 1;
}

/**
 * The one remote session to name in the chrome, or null when nobody has a caret
 * here.
 *
 * Awareness carries no "this is an agent" marker today — an MCP session
 * publishes the same `user` and `cursor` fields a browser tab does (#73's
 * `lastAction` is what would tell them apart), so this reports whichever remote
 * session has a caret in this document and lets the name say who it is. In the
 * spike that session is the agent: a second human is already a cursor in the
 * prose and a chip in the presence strip, and naming them here as well costs
 * nothing and lies about nothing.
 *
 * One session, lowest client id, so two carets do not swap the pill back and
 * forth between them; the presence strip is where everyone is listed.
 */
export function readActivity(
  ydoc: Y.Doc,
  awareness: Awareness,
): RemoteActivity | null {
  const blocks = getBlocksFragment(ydoc).toArray();
  const found: RemoteActivity[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const fields = state as {
      user?: Partial<{ name: string; color: string }>;
      cursor?: { anchor?: unknown } | null;
    };
    const anchor = fields.cursor?.anchor;
    if (anchor === undefined || anchor === null) return;
    const block = blockOf(ydoc, blocks, anchor);
    if (block === null) return;
    found.push({
      clientId,
      name:
        typeof fields.user?.name === "string"
          ? fields.user.name
          : `client ${clientId}`,
      color:
        typeof fields.user?.color === "string"
          ? fields.user.color
          : AWARENESS_FALLBACK_COLOR,
      block,
    });
  });
  found.sort((a, b) => a.clientId - b.clientId);
  return found[0] ?? null;
}

/** Whether two readings would draw the same pill. */
export function sameActivity(
  a: RemoteActivity | null,
  b: RemoteActivity | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.clientId === b.clientId &&
    a.block === b.block &&
    a.name === b.name &&
    a.color === b.color
  );
}

/** How much of the document rev the meta line shows. */
const REV_LENGTH = 8;

/**
 * The document's rev: the fold of its block revs through the same hash the
 * blocks use, so "changed" means one thing at both levels.
 *
 * A change detector, not a version counter — exactly what a block `rev` is.
 * Block ids go into the fold as well as block revs, so reordering two blocks or
 * splitting one changes the document rev even when no character did.
 *
 * `blockRev` is that hash's only exported entry point, and a document rev is
 * chrome rather than a schema concern, so it is folded here rather than added
 * to `@uberblick/schema`.
 */
export function docRev(ydoc: Y.Doc): string {
  const fold = getBlocks(ydoc)
    .map((block) => `${block.id} ${block.rev}`)
    .join("\n");
  return blockRev({ type: "paragraph", text: fold }).slice(0, REV_LENGTH);
}
