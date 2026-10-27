import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexedDoc } from "../src/store.js";
import { MirrorStore } from "../src/store.js";
import { PACKAGE_ROOT, WORKSPACE, removeTempDirs, tempDatabasePath } from "./helpers.js";
import { builtWorker } from "./process-helpers.js";

const stores: MirrorStore[] = [];
const execFileAsync = promisify(execFile);

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

function downgradeLanguages(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "BEGIN IMMEDIATE; " +
        "CREATE TEMP TABLE old_rows AS SELECT rowid, uuid, title, body, description, tag_names FROM docs_fts; " +
        "DROP TABLE docs_fts; " +
        "CREATE VIRTUAL TABLE docs_fts USING fts5(uuid UNINDEXED, title, body, description, tag_names, tokenize = 'porter unicode61'); " +
        "INSERT INTO docs_fts (rowid, uuid, title, body, description, tag_names) SELECT * FROM old_rows; DROP TABLE old_rows; " +
        "CREATE TEMP TABLE old_fragments AS SELECT rowid, uuid, title, body, description, tag_names, indexed_through_seq, catalog_through_seq FROM docs_fragment_fts; " +
        "DROP TABLE docs_fragment_fts; " +
        "CREATE VIRTUAL TABLE docs_fragment_fts USING fts5(uuid UNINDEXED, title, body, description, tag_names, indexed_through_seq UNINDEXED, catalog_through_seq UNINDEXED, tokenize = 'trigram remove_diacritics 1'); " +
        "INSERT INTO docs_fragment_fts (rowid, uuid, title, body, description, tag_names, indexed_through_seq, catalog_through_seq) SELECT * FROM old_fragments; " +
        "DROP TABLE old_fragments; COMMIT;",
    );
  } finally {
    db.close();
  }
}

describe("search index upgrade", () => {

  it.each(["original", "languages"] as const)("serializes simultaneous %s upgrades without losing indexed documents", async (format) => {
    const path = tempDatabasePath();
    const doc = row("1", "Launching", { tagNames: ["protocol"], blockLanguages: ["wireframe", "ts"] });
    const before = open(path);
    before.indexDoc(doc, 2, 7);
    before.indexDoc(row("2", "Existing document", { body: "workspace" }), 1, 7);
    before.close();
    if (format === "original") downgrade(path);
    else downgradeLanguages(path);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () =>
      execFileAsync(process.execPath, [builtWorker("store-upgrade"), path, WORKSPACE, JSON.stringify(doc)],
        { cwd: PACKAGE_ROOT, timeout: 20_000 }),
    ));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    const upgraded = open(path);
    expect(titles(upgraded, "protocol")).toEqual(["Launching"]);
    expect(upgraded.searchUuids("aunch")).toEqual(["1"]);
    expect(upgraded.searchUuids("proto")).toEqual(["1"]);
    expect(titles(upgraded, "wireframe")).toEqual(["Launching"]);
    expect(upgraded.searchUuids("wire")).toEqual(["1"]);
    expect(upgraded.searchUuids("ts")).toEqual(["1"]);
    expect(upgraded.searchUuids("worksp")).toEqual(["2"]);
  });
});
