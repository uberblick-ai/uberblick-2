import { constants, DatabaseSync } from "node:sqlite";
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
    "DROP TABLE docs_fragment_fts; " +
      "CREATE TEMP TABLE old_rows AS SELECT uuid, title, body FROM docs_fts; " +
      "DROP TABLE docs_fts; CREATE VIRTUAL TABLE docs_fts USING fts5(uuid UNINDEXED, title, body); " +
      "INSERT INTO docs_fts SELECT * FROM old_rows; DROP TABLE old_rows; " +
      "ALTER TABLE doc_index DROP COLUMN kind; " +
      "ALTER TABLE doc_index_seq DROP COLUMN search_rowid;",
  );
  db.close();
}

function olderPeerIndex(db: DatabaseSync, doc: IndexedDoc, throughSeq: number, catalogThroughSeq: number): void {
  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    "INSERT INTO doc_index_seq (uuid, indexed_through_seq, catalog_through_seq, github_refs_indexed) VALUES (?, ?, ?, 1) " +
      "ON CONFLICT (uuid) DO UPDATE SET indexed_through_seq = excluded.indexed_through_seq, " +
      "catalog_through_seq = excluded.catalog_through_seq, github_refs_indexed = 1",
  ).run(doc.uuid, throughSeq, catalogThroughSeq);
  db.prepare(
    "INSERT INTO doc_index (uuid, title, description, kind) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (uuid) DO UPDATE SET title = excluded.title, description = excluded.description, kind = excluded.kind",
  ).run(doc.uuid, doc.title, doc.description, doc.kind ?? "regular");
  db.prepare("DELETE FROM doc_tags WHERE uuid = ?").run(doc.uuid);
  for (const tag of doc.tags) {
    db.prepare("INSERT INTO doc_tags (uuid, tag) VALUES (?, ?)").run(doc.uuid, tag);
  }
  db.prepare("DELETE FROM docs_fts WHERE uuid = ?").run(doc.uuid);
  const inserted = db.prepare(
    "INSERT INTO docs_fts (uuid, title, body, description, tag_names) VALUES (?, ?, ?, ?, ?)",
  ).run(doc.uuid, doc.title, doc.body, doc.description, (doc.tagNames ?? []).join("\n"));
  db.prepare("UPDATE doc_index_seq SET search_rowid = ? WHERE uuid = ?").run(inserted.lastInsertRowid, doc.uuid);
  db.exec("COMMIT");
}

describe("search index upgrade", () => {
  it("refreshes a topic title at unchanged record cuts and rejects stale directory derivations", () => {
    const path = tempDatabasePath();
    const store = open(path);
    const doc = row("1", "Orchard", { kind: "decision" });
    expect(store.indexDoc(doc, 2, 7, 10)).toBe(true);
    expect(store.indexDoc({ ...doc, title: "Meadow" }, 2, 7, 11)).toBe(true);
    expect(store.indexDoc({ ...doc, title: "Ignored at equal cuts" }, 2, 7, 11)).toBe(true);
    expect(titles(store, "orchard")).toEqual([]);
    expect(titles(store, "meadow")).toEqual(["Meadow"]);
    expect(store.indexDoc({ ...doc, title: "Stale" }, 3, 8, 10)).toBe(false);
    expect(titles(store, "stale")).toEqual([]);
    store.close();
    const reopened = open(path);
    expect(reopened.indexDoc({ ...doc, title: "Stale" }, 3, 8, 10)).toBe(false);
    expect(titles(reopened, "meadow")).toEqual(["Meadow"]);
  });

  it("preserves searches, rejects stale cuts and permits one unchanged-cut enrichment", () => {
    const path = tempDatabasePath();
    const doc = row("1", "Launching", { kind: "decision", tags: ["mcp"], tagNames: ["protocol"] });
    const before = open(path);
    before.indexDoc(doc, 2, 7);
    before.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("ALTER TABLE doc_index_seq DROP COLUMN directory_through_seq");
    legacy.close();
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
      expect(store.searchUuids("proto")).toEqual(["1"]);
      expect(store.searchUuids("untouch")).toEqual(["2"]);
    } finally {
      peer.close();
    }
  });
});

describe("fragment index upgrade", () => {
  it("backfills every existing search field before any replica re-derives a document", () => {
    const path = tempDatabasePath();
    const before = open(path);
    [
      row("title", "Workspace"),
      row("description", "Description document", { description: "Workspace" }),
      row("body", "Body document", { body: "Workspace" }),
      row("tag", "Tagged document", { tagNames: ["Workspace"] }),
    ].forEach((doc) => { before.indexDoc(doc, 2, 7); });
    before.close();
    const old = new DatabaseSync(path);
    old.exec("DROP TABLE docs_fragment_fts; DELETE FROM doc_index_seq WHERE uuid = 'body'");
    old.close();

    const upgraded = open(path);
    expect(upgraded.searchUuids("worksp").sort()).toEqual(["body", "description", "tag", "title"]);
    expect(upgraded.searchUuids("space").sort()).toEqual(["body", "description", "tag", "title"]);
    expect(upgraded.searchUuids("wo").sort()).toEqual(["tag", "title"]);
    upgraded.close();
    expect(open(path).searchUuids("worksp").sort()).toEqual(["body", "description", "tag", "title"]);
  });

  it.each([[2, 7], [0, 0]])("repairs incomplete legacy backfill after an older peer enriches the same rowid at cuts (%i, %i)", (throughSeq, catalogThroughSeq) => {
    const path = tempDatabasePath();
    const doc = row("1", "Unchanged title", {
      description: "Workspace description", tagNames: ["Protocol catalog"],
    });
    const before = open(path);
    before.indexDoc(doc, throughSeq, catalogThroughSeq);
    before.close();
    downgrade(path);

    const upgraded = open(path);
    expect(upgraded.searchUuids("worksp")).toEqual([]);
    expect(upgraded.searchUuids("proto")).toEqual([]);
    const old = new DatabaseSync(path);
    try {
      const previousRowid = old.prepare("SELECT rowid FROM docs_fragment_fts WHERE uuid = '1'").get();
      olderPeerIndex(old, doc, throughSeq, catalogThroughSeq);
      expect(old.prepare("SELECT rowid FROM docs_fts WHERE uuid = '1'").get()).toEqual(previousRowid);
      expect(titles(upgraded, "workspace")).toEqual(["Unchanged title"]);
      expect(titles(upgraded, "protocol")).toEqual(["Unchanged title"]);
      expect(upgraded.searchUuids("worksp")).toEqual([]);
      expect(upgraded.searchUuids("proto")).toEqual([]);

      upgraded.indexDoc(doc, throughSeq, catalogThroughSeq);
      expect(upgraded.searchUuids("worksp")).toEqual(["1"]);
      expect(upgraded.searchUuids("proto")).toEqual(["1"]);
      expect(upgraded.searchUuids("pr")).toEqual(["1"]);
      upgraded.close();
      const reopened = open(path);
      reopened.indexDoc({ ...doc, description: "Wrong derivation", tagNames: ["Wrong derivation"] }, throughSeq, catalogThroughSeq);
      expect(reopened.searchUuids("worksp")).toEqual(["1"]);
      expect(reopened.searchUuids("proto")).toEqual(["1"]);
      expect(reopened.searchUuids("wrong")).toEqual([]);
    } finally {
      old.close();
    }
  });

  it.each(["document", "catalog"] as const)("repairs a newer %s cut written by an older peer even when the search rowid is reused", (changed) => {
    const path = tempDatabasePath();
    const store = open(path);
    const doc = row("1", "Unchanged title", changed === "document"
      ? { body: "previous" }
      : { tagNames: ["previous"] });
    store.indexDoc(doc, 2, 7);
    const current = { ...doc, ...(changed === "document"
      ? { body: "current workspace" }
      : { tagNames: ["current workspace"] }) };
    const throughSeq = changed === "document" ? 3 : 2;
    const catalogThroughSeq = changed === "catalog" ? 8 : 7;
    const old = new DatabaseSync(path);
    try {
      const previousRowid = old.prepare("SELECT rowid FROM docs_fts WHERE uuid = '1'").get();
      olderPeerIndex(old, current, throughSeq, catalogThroughSeq);
      expect(old.prepare("SELECT rowid FROM docs_fts WHERE uuid = '1'").get()).toEqual(previousRowid);

      store.indexDoc({ ...current, title: "Stale derivation" }, throughSeq - 1, catalogThroughSeq);
      store.indexDoc({ ...current, title: "Stale derivation" }, throughSeq, catalogThroughSeq - 1);
      expect(store.search("current", 10)).toHaveLength(1);
      expect(store.searchUuids("stale")).toEqual([]);
      store.indexDoc(current, throughSeq, catalogThroughSeq);
      expect(store.searchUuids("worksp")).toEqual(["1"]);
      expect(store.searchUuids("previ")).toEqual([]);
      store.indexDoc({ ...current, title: "Wrong derivation" }, throughSeq, catalogThroughSeq);
      store.close();
      const reopened = open(path);
      reopened.indexDoc({ ...current, title: "Wrong derivation" }, throughSeq, catalogThroughSeq);
      expect(reopened.searchUuids("worksp")).toEqual(["1"]);
      expect(reopened.searchUuids("wrong")).toEqual([]);
    } finally {
      old.close();
    }
  });

  it("indexes documents an older peer creates after the upgrade at their unchanged cuts", () => {
    const path = tempDatabasePath();
    const store = open(path);
    const old = new DatabaseSync(path);
    const doc = row("new", "MCP workspace");
    try {
      olderPeerIndex(old, doc, 2, 7);
      store.indexDoc(doc, 2, 7);
      expect(store.searchUuids("worksp")).toEqual(["new"]);
      expect(store.searchUuids("mc")).toEqual(["new"]);
    } finally {
      old.close();
    }
  });

  it("removes archived, purged and cleared rows from fragment search", () => {
    const store = open();
    for (const uuid of ["archived", "purged", "live"]) {
      store.indexDoc(row(uuid, "MCP workspace"), 2, 7);
    }
    store.unindexDoc("archived");
    store.purgeDoc("unused-room", "purged");
    expect(store.searchUuids("worksp")).toEqual(["live"]);
    expect(store.searchUuids("mc")).toEqual(["live"]);
    store.clearDerived();
    expect(store.searchUuids("worksp")).toEqual([]);
    expect(store.searchUuids("mc")).toEqual([]);
  });

  it("rolls back both search indexes and their cuts when fragment indexing fails", () => {
    const store = open();
    const doc = row("1", "Workspace", { body: "previous" });
    store.indexDoc(doc, 2, 7);
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.setAuthorizer((action, table) => action === constants.SQLITE_INSERT && table === "docs_fragment_fts"
      ? constants.SQLITE_DENY : constants.SQLITE_OK);
    try {
      expect(() => store.indexDoc({ ...doc, title: "Replacement" }, 3, 8)).toThrow();
    } finally {
      db.setAuthorizer(null);
    }
    expect(store.searchUuids("worksp")).toEqual(["1"]);
    expect(store.searchUuids("replace")).toEqual([]);
    expect(titles(store, "workspace")).toEqual(["Workspace"]);
    expect(db.prepare("SELECT indexed_through_seq, catalog_through_seq FROM doc_index_seq WHERE uuid = ?").get("1"))
      .toEqual({ indexed_through_seq: 2, catalog_through_seq: 7 });
    store.indexDoc({ ...doc, title: "Replacement" }, 3, 8);
    expect(store.searchUuids("worksp")).toEqual([]);
    expect(store.searchUuids("replace")).toEqual(["1"]);
  });
});
