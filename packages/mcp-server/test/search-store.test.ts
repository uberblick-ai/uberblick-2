import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexedDoc } from "../src/store.js";
import { MirrorStore } from "../src/store.js";
import { WORKSPACE, removeTempDirs, tempDatabasePath } from "./helpers.js";

const stores: MirrorStore[] = [];

function open(path = tempDatabasePath()): MirrorStore {
  const store = new MirrorStore(path, WORKSPACE);
  stores.push(store);
  return store;
}

function row(uuid: string, title: string, fields: Partial<IndexedDoc> = {}): IndexedDoc {
  return { uuid, title, description: "", body: "", tags: [], links: [], ...fields };
}

function titles(store: MirrorStore, query: string): string[] {
  return store.search(query, 100).map((hit) => hit.title);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  removeTempDirs();
});

function downgrade(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TEMP TABLE old_rows AS SELECT uuid, title, body FROM docs_fts; " +
      "DROP TABLE docs_fts; CREATE VIRTUAL TABLE docs_fts USING fts5(uuid UNINDEXED, title, body); " +
      "INSERT INTO docs_fts SELECT * FROM old_rows; DROP TABLE old_rows; " +
      "ALTER TABLE doc_index DROP COLUMN kind; " +
      "ALTER TABLE doc_index_seq DROP COLUMN search_rowid;",
  );
  db.close();
}

describe("search index upgrade", () => {
  it("preserves searches, rejects stale cuts and permits one unchanged-cut enrichment", () => {
    const path = tempDatabasePath();
    const doc = row("1", "Launching", { kind: "decision", tags: ["mcp"], tagNames: ["protocol"] });
    const before = open(path);
    before.indexDoc(doc, 2, 7);
    before.close();
    downgrade(path);

    const store = open(path);
    expect(titles(store, "launch")).toEqual(["Launching"]);
    expect(titles(store, "protocol")).toEqual([]);
    store.indexDoc({ ...doc, title: "stale" }, 1, 7);
    store.indexDoc({ ...doc, title: "stale" }, 2, 6);
    expect(titles(store, "launch")).toEqual(["Launching"]);
    store.indexDoc(doc, 2, 7);
    expect(store.search("protocol", 10, undefined, "decision")).toHaveLength(1);
    store.indexDoc({ ...doc, tagNames: ["wrong"] }, 2, 7);
    store.close();
    const reopened = open(path);
    reopened.indexDoc({ ...doc, tagNames: ["wrong"] }, 2, 7);
    expect(titles(reopened, "protocol")).toEqual(["Launching"]);
    expect(titles(reopened, "wrong")).toEqual([]);
  });

  it("keeps prepared older-peer writes and snippets usable, then repairs their incomplete rows", () => {
    const path = tempDatabasePath();
    const doc = row("1", "Launching", { body: "launching", tagNames: ["protocol"] });
    const before = open(path);
    before.indexDoc(doc, 2, 7);
    before.close();
    downgrade(path);
    const old = new DatabaseSync(path);
    const insert = old.prepare("INSERT INTO docs_fts (uuid, title, body) VALUES (?, ?, ?)");
    const search = old.prepare("SELECT snippet(docs_fts, 2, '', '', '…', 16) AS snippet FROM docs_fts WHERE docs_fts MATCH ?");
    try {
      const store = open(path);
      store.indexDoc(doc, 2, 7);
      old.prepare("DELETE FROM docs_fts WHERE uuid = ?").run(doc.uuid);
      insert.run(doc.uuid, doc.title, doc.body);
      expect(search.get("launching")).toEqual({ snippet: "launching" });
      expect(titles(store, "protocol")).toEqual([]);
      store.indexDoc(doc, 2, 7);
      expect(titles(store, "protocol")).toEqual(["Launching"]);
    } finally {
      old.close();
    }
  });

  it("repairs a missing row even when another document reuses its cached rowid", () => {
    const path = tempDatabasePath();
    const store = open(path);
    const doc = row("1", "Launching", { tagNames: ["protocol"] });
    store.indexDoc(doc, 2, 7);
    const peer = new DatabaseSync(path);
    try {
      peer.prepare("DELETE FROM docs_fts WHERE uuid = ?").run(doc.uuid);
      store.indexDoc(row("2", "Unrelated", { tagNames: ["untouched"] }), 1, 7);
      expect(peer.prepare("SELECT rowid FROM docs_fts WHERE uuid = '2'").get()).toEqual(
        peer.prepare("SELECT search_rowid AS rowid FROM doc_index_seq WHERE uuid = '1'").get(),
      );
      store.indexDoc(doc, 2, 7);
      expect(titles(store, "protocol")).toEqual(["Launching"]);
      expect(titles(store, "untouched")).toEqual(["Unrelated"]);
    } finally {
      peer.close();
    }
  });
});
