import * as Y from "yjs";
import { getBlock, getBlocksFragment } from "../src/index.js";

/**
 * Exchange updates between two replicas in both directions, the way the hub
 * would. Both diffs are computed before either is applied, so neither side sees
 * a half-synced peer.
 */
export function syncDocs(a: Y.Doc, b: Y.Doc): void {
  const aToB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const bToA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, aToB);
  Y.applyUpdate(a, bToA);
}

/** A pair of replicas that already share `seed`'s state. */
export function replicaPair(seed: (doc: Y.Doc) => void): [Y.Doc, Y.Doc] {
  const a = new Y.Doc();
  const b = new Y.Doc();
  seed(a);
  syncDocs(a, b);
  return [a, b];
}

/**
 * A peer's retype as the web editor writes it: Yjs node names are immutable,
 * so a same-id element carrying the block's text replaces the old one.
 */
export function retype(doc: Y.Doc, id: string, type: string): void {
  const fragment = getBlocksFragment(doc);
  const index = fragment.toArray().findIndex((node) => (node as Y.XmlElement).getAttribute("id") === id);
  const replacement = new Y.XmlElement(type);
  replacement.setAttribute("id", id);
  replacement.insert(0, [new Y.XmlText(getBlock(doc, id)?.text ?? "")]);
  doc.transact(() => {
    fragment.insert(index + 1, [replacement]);
    fragment.delete(index, 1);
  });
}
