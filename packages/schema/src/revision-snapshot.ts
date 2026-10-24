import * as Y from "yjs";
import { partitionById } from "./blocks.js";
import { DATA_KEY, getDocDataEntries } from "./data.js";
import { getBlocksFragment, getMeta, getMetaMap } from "./doc.js";
import { contentKey, snapshotBlocks } from "./revision-blocks.js";
import { COMMENT_MARK } from "./types.js";

export interface RevisionSnapshot {
  state: Uint8Array;
  /** Canonical authored content, independent of CRDT clocks and comment splits. */
  checksum: string;
  empty: boolean;
}

function copyChildren(source: Y.XmlFragment, target: Y.XmlFragment): void {
  for (const child of source.toArray()) {
    if (child instanceof Y.XmlElement) {
      const copy = new Y.XmlElement(child.nodeName);
      target.insert(target.length, [copy]);
      for (const [name, value] of Object.entries(child.getAttributes())) {
        if (value !== undefined) copy.setAttribute(name, value);
      }
      copyChildren(child, copy);
    } else if (child instanceof Y.XmlText) {
      const copy = new Y.XmlText();
      target.insert(target.length, [copy]);
      copy.applyDelta((child.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>).map((operation) => {
        const attributes = { ...operation.attributes };
        delete attributes[COMMENT_MARK];
        return { ...operation, attributes };
      }));
    }
  }
}

/** A fresh document contains no live-room history, annotations or excluded metadata. */
export function snapshotRevision(document: Y.Doc): RevisionSnapshot {
  const title = getMeta(document).title;
  const blocks = snapshotBlocks(document);
  const data = getDocDataEntries(document);
  const copy = new Y.Doc();
  try {
    copy.transact(() => {
      getMetaMap(copy).set("title", title);
      const target = getBlocksFragment(copy);
      for (const element of partitionById(getBlocksFragment(document)).visible) {
        const block = new Y.XmlElement(element.nodeName);
        target.insert(target.length, [block]);
        for (const [name, value] of Object.entries(element.getAttributes())) {
          if (value !== undefined) block.setAttribute(name, value);
        }
        copyChildren(element, block);
      }
      const root = copy.getMap(DATA_KEY);
      for (const [key, value] of data) root.set(key, value);
    });
    return {
      state: Y.encodeStateAsUpdate(copy),
      checksum: contentKey({ title, blocks: blocks.map((block) => block.key), data }),
      empty: title === "" && blocks.length === 0 && data.length === 0,
    };
  } finally {
    copy.destroy();
  }
}
