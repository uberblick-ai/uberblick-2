import * as Y from "yjs";

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
