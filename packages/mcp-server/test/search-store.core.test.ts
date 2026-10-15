import { afterEach, describe, expect, it } from "vitest";
import type { IndexedDoc } from "../src/store.js";
import { MirrorStore } from "../src/store.js";
import { WORKSPACE, removeTempDirs } from "./core-helpers.js";

const stores: MirrorStore[] = [];

function open(path = ":memory:"): MirrorStore {
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

describe("complete UUID search", () => {
  it("keeps full-hit matching and relevance without limiting matches or reading their metadata", () => {
    const store = open();
    [
      row("title", "Launching guide", { body: "Background details." }),
      row("description", "Delivery guide", { description: "Launched changes." }),
      row("body", "Delivery overview", { body: "Launch details." }),
      row("tags", "Interface notes", { tagNames: ["protocol"], body: "École worktree workspace" }),
      row("decision", "What is the launch plan?", { kind: "decision" }),
    ].forEach((doc) => { store.indexDoc(doc, 1); });
    for (let n = 0; n < 150; n++) {
      store.indexDoc(row(`sync-${String(n).padStart(3, "0")}`, "Sync", { body: "Sync" }), 1);
    }
    for (const query of ["launch neverindexedword", "launched", "protocol", "ecole", "work*", "sync"]) {
      expect(store.searchUuids(query)).toEqual(store.search(query, 1_000).map(({ uuid }) => uuid));
    }
    expect(store.searchUuids("sync")).toHaveLength(150);
    expect(store.searchUuids("sync")[149]).toBe("sync-149");
    expect(store.searchUuids("launch")).toContain("decision");
    expect(store.searchUuids("🌿")).toEqual([]);
    expect(store.searchUuids("missingword")).toEqual([]);
  });

  it("drops unindexed documents and finds updated fields", () => {
    const store = open();
    store.indexDoc(row("live", "Old title", { body: "launching" }), 1);
    store.indexDoc(row("archived", "Launching"), 1);
    store.unindexDoc("archived");
    expect(store.searchUuids("launch")).toEqual(["live"]);
    store.indexDoc(row("live", "Changed title", { tagNames: ["renamed"] }), 2);
    expect(store.searchUuids("launch")).toEqual([]);
    expect(store.searchUuids("renamed")).toEqual(["live"]);
  });
});
