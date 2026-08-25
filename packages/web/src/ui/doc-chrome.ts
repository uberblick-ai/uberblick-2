/**
 * The two derivations the doc chrome needs, both pure reads over the document.
 *
 * They live apart from the components that draw them because both are about
 * what is *true* — which session has a caret where, and whether the content has
 * changed — and neither needs React to say it.
 */

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { blockRev, getBlock, getBlocks, getBlocksFragment } from "@uberblick/schema";
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
): number | null {
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
  const blocks = visibleBlocks(getBlocksFragment(ydoc));
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

/** The block element an event happened in, or null when it happened above one. */
function blockElementOf(target: Y.AbstractType<unknown>): Y.XmlElement | null {
  if (target instanceof Y.XmlElement) return target;
  const parent = target.parent;
  return parent instanceof Y.XmlElement ? parent : null;
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
      const element = blockElementOf(event.target);
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
