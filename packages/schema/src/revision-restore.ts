import * as Y from "yjs";
import { partitionById } from "./blocks.js";
import { DATA_KEY, getDocDataEntries } from "./data.js";
import { getBlocksFragment, getMeta, getMetaMap } from "./doc.js";
import { contentKey, snapshotBlocks } from "./revision-blocks.js";
import { matchSequence } from "./revision-sequence.js";

/** Replace authored state while retaining unchanged elements and current metadata. */
export function restoreRevisionContent(document: Y.Doc, revision: Y.Doc): void {
  const fragment = getBlocksFragment(document);
  const current = partitionById(fragment).visible;
  const target = partitionById(getBlocksFragment(revision)).visible;
  const before = snapshotBlocks(document);
  const after = snapshotBlocks(revision);
  const keys = (blocks: typeof before) => blocks.map(block => ({ key: contentKey([block.id, block.key]) }));
  const retained = new Map<number, Y.XmlElement>();
  for (const pair of matchSequence(keys(before), keys(after))) {
    const element = current[pair.before];
    if (element !== undefined) retained.set(pair.after, element);
  }
  const keep = new Set(retained.values());
  const byId = new Map<string, { key: string; element: Y.XmlElement }>();
  before.forEach((block, index) => {
    const element = current[index];
    if (block.id !== "" && element !== undefined) byId.set(block.id, { key: block.key, element });
  });
  const copies = target.map((element, index) => {
    if (retained.has(index)) return null;
    const block = after[index];
    const live = block === undefined ? undefined : byId.get(block.id);
    // A moved unchanged block carries its current comment marks, as moveBlocks does.
    return (live !== undefined && live.key === block?.key ? live.element : element).clone();
  });
  const title = getMeta(revision).title;
  const data = new Map(getDocDataEntries(revision));
  document.transact(() => {
    if (getMeta(document).title !== title) getMetaMap(document).set("title", title);
    const removed = fragment.toArray().flatMap((node, index) =>
      node instanceof Y.XmlElement && keep.has(node) ? [] : [index]);
    for (const index of removed.reverse()) fragment.delete(index, 1);
    for (let index = 0; index < copies.length; index++) {
      const copy = copies[index];
      if (copy !== null && copy !== undefined) fragment.insert(index, [copy]);
    }
    const root = document.getMap(DATA_KEY);
    for (const key of root.keys()) if (!data.has(key)) root.delete(key);
    for (const [key, value] of data) {
      if (!root.has(key) || contentKey(root.get(key)) !== contentKey(value)) root.set(key, value);
    }
  });
}
