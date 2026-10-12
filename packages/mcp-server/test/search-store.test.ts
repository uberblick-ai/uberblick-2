import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MirrorStore } from "../src/store.js";
import type { IndexedDoc } from "../src/store.js";
import { PACKAGE_ROOT, WORKSPACE, removeTempDirs, tempDatabasePath } from "./helpers.js";

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

describe("title-weighted search relevance", () => {
  it("orders the hub login scenario without a strict matched-word sort", () => {
    const store = open();
    [
      row("1", "Hub login", { body: "Connect your account." }),
      row("2", "Signing in", { body: "Use hub login to connect your account." }),
      row("3", "Running a hub", { body: "Host your workspace." }),
      row("4", "Sync problems", { body: "Check the hub connection." }),
    ].forEach((doc) => { store.indexDoc(doc, 1); });
    expect(titles(store, "hub login")).toEqual([
      "Hub login", "Signing in", "Running a hub", "Sync problems",
    ]);
  });

  it("favours a single title occurrence over equal-length matches in each other field", () => {
    const store = open();
    [
      row("1", "launch guide", { body: "background" }),
      row("2", "other guide", { description: "launch" }),
      row("3", "other guide", { body: "launch" }),
      row("4", "other guide", { tagNames: ["launch"] }),
    ].forEach((doc) => { store.indexDoc(doc, 1); });
    expect(store.search("launch", 100).map((hit) => hit.uuid)[0]).toBe("1");
    expect(store.search("launch", 100)).toHaveLength(4);
  });

  it("finds the coding-agent decision near the top of a long query", () => {
    const store = open();
    [
      row("1", "Does Uberblick run coding agents?", {
        kind: "decision", body: "Ub organizes documents in a project worktree; coding agents run separately.",
      }),
      row("2", "Launching the viewer", { body: "Use ub open to launch the web viewer." }),
      row("3", "Project setup", { body: "A worktree binds the workspace." }),
      row("4", "Working offline", { body: "An agent reads documents locally." }),
    ].forEach((doc) => { store.indexDoc(doc, 1); });
    expect(titles(store, "ub launch worktree agent").slice(0, 2)).toContain(
      "Does Uberblick run coding agents?",
    );
  });

  it("filters kind before the limit and ranks the account topic first", () => {
    const store = open();
    for (let n = 0; n < 25; n++) {
      store.indexDoc(row(`regular-${n}`, "account start", { body: "account start" }), 1);
    }
    store.indexDoc(row("decision-1", "Do people need an account to start?", { kind: "decision" }), 1);
    store.indexDoc(row("decision-2", "First steps", { kind: "decision", body: "Start with a document." }), 1);
    expect(store.search("account start", 1, undefined, "decision")).toEqual([
      expect.objectContaining({ uuid: "decision-1", kind: "decision" }),
    ]);
    expect(store.search("account start", 100, undefined, "regular")).toHaveLength(25);
  });

  it("combines tag overlap with relevance, deduplicates filters and keeps a scalar equivalent", () => {
    const store = open();
    store.indexDoc(row("one", "decision records", { tags: ["mcp"], tagNames: ["mcp filler"] }), 1);
    store.indexDoc(row("both", "decision records", { tags: ["mcp", "rfc"], tagNames: ["mcp", "rfc"] }), 1);
    store.indexDoc(row("neither", "decision records"), 1);
    expect(store.search("decision records", 100, ["mcp", "rfc"]).map((hit) => hit.uuid))
      .toEqual(["both", "one"]);
    expect(store.search("decision records", 100, "mcp"))
      .toEqual(store.search("decision records", 100, ["mcp", "mcp"]));
    expect(store.search("decision records", 100, []))
      .toEqual(store.search("decision records", 100));
  });
});

function downgrade(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TEMP TABLE old_rows AS SELECT uuid, title, body FROM docs_fts; " +
      "DROP TABLE docs_fts; CREATE VIRTUAL TABLE docs_fts USING fts5(uuid UNINDEXED, title, body); " +
      "INSERT INTO docs_fts SELECT * FROM old_rows; DROP TABLE old_rows; " +
      "ALTER TABLE doc_index DROP COLUMN kind; " +
      "ALTER TABLE doc_index_seq DROP COLUMN search_indexed;",
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

  it("serializes simultaneous upgrades without losing indexed documents", async () => {
    const path = tempDatabasePath();
    const doc = row("1", "Launching", { tagNames: ["protocol"] });
    const before = open(path);
    before.indexDoc(doc, 2, 7);
    before.close();
    downgrade(path);
    const source = `
      import { MirrorStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      const store = new MirrorStore(${JSON.stringify(path)}, ${JSON.stringify(WORKSPACE)});
      store.indexDoc(${JSON.stringify(doc)}, 2, 7);
      store.close();
    `;
    const results = await Promise.allSettled(Array.from({ length: 4 }, () =>
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source],
        { cwd: PACKAGE_ROOT, timeout: 20_000 }),
    ));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    expect(titles(open(path), "protocol")).toEqual(["Launching"]);
  });
});
