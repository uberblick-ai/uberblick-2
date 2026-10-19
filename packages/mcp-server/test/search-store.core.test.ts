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

describe("web fragment UUID search", () => {
  it("matches long fragments anywhere in all four fields and gives title matches more weight", () => {
    const store = open();
    [
      row("title", "ub workspace use"),
      row("description", "Other guide", { description: "workspace" }),
      row("tags", "Other guide", { tagNames: ["workspace"] }),
      row("body", "Other guide", { body: "workspace" }),
    ].forEach((doc) => { store.indexDoc(doc, 1); });
    for (const query of ["worksp", "space"]) {
      const hits = store.searchUuids(query);
      expect(hits[0]).toBe("title");
      expect(hits.toSorted()).toEqual(["body", "description", "tags", "title"]);
    }
  });

  it("matches one- and two-character fragments only in titles and tag names, with titles first", () => {
    const store = open();
    [
      row("title", "MCP server tools"),
      row("tags", "Guide", { tagNames: ["mcp"] }),
      row("description", "Reference", { description: "MCP" }),
      row("body", "Notes", { body: "MCP" }),
    ].forEach((doc) => { store.indexDoc(doc, 1); });
    expect(store.searchUuids("m")).toEqual(["title", "tags"]);
    expect(store.searchUuids("mc")).toEqual(["title", "tags"]);
    expect(store.searchUuids("mcp").toSorted()).toEqual(["body", "description", "tags", "title"]);
  });

  it("folds case and accents for every fragment length and eligible field", () => {
    const store = open();
    [
      row("title", "ÜBERBLICK"),
      row("tags", "Notes", { tagNames: ["ÜBERBLICK"] }),
      row("description", "Reference", { description: "ÜBERBLICK" }),
      row("body", "Notes", { body: "ÜBERBLICK" }),
      row("accent", "Café"),
    ].forEach((doc) => { store.indexDoc(doc, 1); });
    for (const query of ["u", "Ü", "u\u0308", "ub", "ÜB", "U\u0308B"]) {
      expect(store.searchUuids(query)).toEqual(["title", "tags"]);
    }
    for (const query of ["uber", "ÜBER", "U\u0308BER"]) {
      expect(store.searchUuids(query).toSorted()).toEqual(["body", "description", "tags", "title"]);
    }
    expect(store.searchUuids("cafe")).toEqual(["accent"]);
    store.indexDoc(row("unrelated", "Uplink", { body: "September" }), 1);
    expect(store.searchUuids("U\u0308BER").toSorted()).toEqual(["body", "description", "tags", "title"]);
  });

  it("counts non-Latin characters and does not match only part of a composed character", () => {
    const store = open();
    store.indexDoc(row("different-syllable", "각자 문서"), 1);
    store.indexDoc(row("title", "가나다 문서"), 1);
    store.indexDoc(row("body", "Reference", { body: "가나다" }), 1);
    expect(store.searchUuids("가")).toEqual(["title"]);
    expect(store.searchUuids("가나다")).toEqual(["title", "body"]);
  });

  it("matches any query word while applying each word's fragment-length rule", () => {
    const store = open();
    [
      row("title", "MCP server tools"),
      row("tags", "Guide", { tagNames: ["mcp"] }),
      row("short-description", "Reference", { description: "MCP" }),
      row("short-body", "Notes", { body: "MCP" }),
      row("long-body", "Details", { body: "workspace" }),
    ].forEach((doc) => { store.indexDoc(doc, 1); });
    expect(store.searchUuids("mc, worksp neverindexedword").toSorted())
      .toEqual(["long-body", "tags", "title"]);
  });

  it("uses unstemmed fragments while MCP keeps whole-word and wildcard matching", () => {
    const store = open();
    store.indexDoc(row("workspace", "Workspace"), 1);
    store.indexDoc(row("singular", "Decision"), 1);
    store.indexDoc(row("plural", "Decisions"), 1);
    expect(store.searchUuids("worksp")).toEqual(["workspace"]);
    expect(store.search("worksp", 100)).toEqual([]);
    expect(store.search("worksp*", 100).map((hit) => hit.uuid)).toEqual(["workspace"]);
    expect(store.searchUuids("decision").toSorted()).toEqual(["plural", "singular"]);
    expect(store.searchUuids("decisions")).toEqual(["plural"]);
    expect(store.search("decisions", 100).map((hit) => hit.uuid).toSorted())
      .toEqual(["plural", "singular"]);
  });

  it("returns every match, including decisions, without a result limit", () => {
    const store = open();
    store.indexDoc(row("decision", "What is the sync plan?", { kind: "decision" }), 1);
    for (let n = 0; n < 150; n++) {
      store.indexDoc(row(`sync-${String(n).padStart(3, "0")}`, "Sync", { body: "Sync" }), 1);
    }
    const hits = store.searchUuids("sync");
    expect(hits).toHaveLength(151);
    expect(hits).toContain("sync-149");
    expect(hits).toContain("decision");
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
