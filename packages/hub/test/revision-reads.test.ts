import { createHash, randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Document, type Connection } from "@hocuspocus/server";
import {
  compareRevisions,
  createRevisionResponseReader,
  deleteDirectoryEntry,
  directoryRoom,
  encodeOriginUpdate,
  encodeRevisionRequest,
  getDirectoryMap,
  getMeta,
  getMetaMap,
  readOriginAck,
  type RevisionRequest,
  type RevisionResponse,
  snapshotRevision,
  tombstoneDirectoryEntry,
} from "@uberblick/schema";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/schema/protocol";
import { importCredentialKey, mintToken } from "@uberblick/schema/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { HubDatabase } from "../src/persistence.js";
import { RevisionReads } from "../src/revision-reads.js";
import type { HubContext } from "../src/server.js";
import { createTeamHub, type TeamHub } from "../src/team.js";
import type { UpdateAttribution } from "../src/update-attribution.js";
import { issueCredential } from "./device-credentials.js";
import { WORKSPACE, waitUntil } from "./helpers.js";

const databases: HubDatabase[] = [];
const documents: Y.Doc[] = [];
const providers: HocuspocusProvider[] = [];
const hubs: TeamHub[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const document of documents.splice(0)) document.destroy();
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

function document(): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  return doc;
}

function database(revisions = true): HubDatabase {
  const db = new HubDatabase(":memory:", error => { throw error; }, { revisions, now: () => 1_000 });
  db.open();
  databases.push(db);
  return db;
}

function seed(db: HubDatabase, room: string, title: string, principalId: string | null = "ben") {
  const doc = document();
  db.revisions.observe(room, doc);
  const attribution: UpdateAttribution = {
    updateId: randomUUID(),
    author: principalId === null ? null : { principalId, surface: { kind: "mcp", name: "Claude Code" } },
    deliveredBy: { principalId: "ben", credentialId: "credential", deviceId: "computer" },
  };
  doc.transact(() => getMetaMap(doc).set("title", title), { attribution });
  return { doc, id: db.revisions.list(room)[0]?.id ?? "missing" };
}

function receiver(readOnly = false, signedIn = true) {
  const sent: string[] = [];
  const connection = {
    context: signedIn ? { principalId: "reader" } : { sub: "local-reader" },
    readOnly,
    sendStateless(payload: string) { sent.push(payload); },
  } as unknown as Connection<HubContext>;
  return { connection, sent };
}

async function request(reads: RevisionReads, connection: Connection<HubContext>, room: string,
  value: Omit<RevisionRequest, "requestId">, sent: string[], current = document()): Promise<RevisionResponse> {
  const requestId = randomUUID();
  const start = sent.length;
  await reads.onStateless({ connection, document: current, documentName: room,
    payload: encodeRevisionRequest({ ...value, requestId }) } as Parameters<RevisionReads["onStateless"]>[0]);
  const read = createRevisionResponseReader(requestId);
  const response = sent.slice(start).map(read).find(result => result !== null);
  expect(response, "a request receives one complete addressed response").toBeDefined();
  if (response === undefined) throw new Error("no revision response");
  return response;
}

describe("revision replies on admitted document rooms", () => {
  it("restores by revision ID under current write authority and returns the closed attributed entry", async () => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const saved = seed(db, room, "Past title");
    const checksum = () => createHash("sha256").update(snapshotRevision(saved.doc).checksum).digest("hex");
    expect(db.revisions.name(room, saved.doc, checksum(), "Past", {
      principalId: "ben", surface: { kind: "mcp", name: "Claude Code" },
    }).ok).toBe(true);
    getMetaMap(saved.doc).set("title", "Present title");
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: id => id });
    const writer = receiver();
    const readOnly = receiver(true);
    const restore = { operation: "restore" as const, revisionId: saved.id, checksum: checksum(),
      surface: { kind: "browser", name: "browser" } };
    expect(await request(reads, readOnly.connection, room, restore, readOnly.sent, saved.doc))
      .toMatchObject({ ok: false, error: "forbidden" });
    expect(await request(reads, writer.connection, room, { ...restore, checksum: "0".repeat(64) }, writer.sent, saved.doc))
      .toMatchObject({ ok: false, error: "stale-state" });
    expect(await request(reads, writer.connection, room, { ...restore, revisionId: "foreign" }, writer.sent, saved.doc))
      .toMatchObject({ ok: false, error: "revision-not-found" });
    const restored = await request(reads, writer.connection, room, restore, writer.sent, saved.doc);
    expect(restored).toMatchObject({ ok: true, applied: true, revision: { author: {
      githubUsername: "reader", surface: { kind: "browser", name: "browser" },
    }, startedAt: 1_000, endedAt: 1_000, name: null } });
    expect(getMeta(saved.doc).title).toBe("Past title");
    if (!("revision" in restored)) throw new Error("expected restore entry");
    expect(restored.revision.id).not.toBe(saved.id);
    expect(await request(reads, writer.connection, room, { ...restore, checksum: checksum() }, writer.sent, saved.doc))
      .toEqual({ ...restored, requestId: expect.any(String), applied: false });
  });

  it("reads titles from active and closed snapshots only when a list opts in", async () => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const saved = seed(db, room, "First");
    saved.doc.transact(() => getMetaMap(saved.doc).set("title", "Second"), {
      attribution: { author: { principalId: "other", surface: { kind: "browser", name: "browser" } } },
    });
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: id => id });
    const reader = receiver(true);
    const get = vi.spyOn(db.revisions, "get");
    for (const value of [{ operation: "list" as const }, { operation: "list" as const, includeNames: true as const }]) {
      const legacy = await request(reads, reader.connection, room, value, reader.sent);
      if (!("revisions" in legacy)) throw new Error("expected list");
      expect(legacy.revisions).toHaveLength(2);
      expect(legacy.revisions.every(revision => !("title" in revision))).toBe(true);
    }
    expect(get).not.toHaveBeenCalled();
    const response = await request(reads, reader.connection, room, { operation: "list", includeTitles: true }, reader.sent);
    expect(response).toMatchObject({ ok: true, revisions: [{ title: "Second" }, { id: saved.id, title: "First" }] });
    expect(get).toHaveBeenCalledTimes(2);
    if (!("revisions" in response)) throw new Error("expected list");
    expect(response.revisions.every(revision => !("state" in revision) && !("name" in revision))).toBe(true);
    expect(await request(reads, reader.connection, room,
      { operation: "list", includeTitles: true, includeNames: true }, reader.sent))
      .toMatchObject({ revisions: [{ title: "Second", name: null }, { title: "First", name: null }] });
  });

  it.each(["missing", "corrupt", "throw"])("keeps history readable when one title lookup is %s", async failure => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const saved = seed(db, room, "First");
    saved.doc.transact(() => getMetaMap(saved.doc).set("title", "Second"), {
      attribution: { author: { principalId: "other", surface: { kind: "browser", name: "browser" } } },
    });
    const middle = db.revisions.list(room)[0]!.id;
    saved.doc.transact(() => getMetaMap(saved.doc).set("title", "Third"), {
      attribution: { author: { principalId: "ben", surface: { kind: "browser", name: "browser" } } },
    });
    const originalGet = db.revisions.get.bind(db.revisions);
    vi.spyOn(db.revisions, "get").mockImplementation((requestedRoom, id) => {
      if (id !== middle) return originalGet(requestedRoom, id);
      if (failure === "throw") throw new Error("snapshot unavailable");
      return failure === "missing" ? null : Uint8Array.of(255);
    });
    const destroy = vi.spyOn(Y.Doc.prototype, "destroy");
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: id => id });
    const reader = receiver(true);
    const response = await request(reads, reader.connection, room, { operation: "list", includeTitles: true }, reader.sent);
    expect(response).toMatchObject({ ok: true, revisions: [{ title: "Third" }, { id: middle }, { title: "First" }] });
    if (!("revisions" in response)) throw new Error("expected list");
    expect(response.revisions[1]).not.toHaveProperty("title");
    expect(destroy).toHaveBeenCalledTimes(3);
  });

  it("opts into naming metadata and enforces write authority and account-owned management", async () => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const saved = seed(db, room, "Reviewed content");
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: id => id });
    const namer = receiver();
    const checksum = createHash("sha256").update(snapshotRevision(saved.doc).checksum).digest("hex");
    const naming: Omit<RevisionRequest, "requestId"> = { operation: "name", name: "Reviewed", checksum,
      surface: { kind: "browser", name: "browser" } };
    const readOnly = receiver(true);
    expect(await request(reads, readOnly.connection, room, naming, readOnly.sent, saved.doc))
      .toMatchObject({ ok: false, error: "forbidden" });
    expect(await request(reads, namer.connection, room, { ...naming, checksum: "0".repeat(64) }, namer.sent, saved.doc))
      .toMatchObject({ ok: false, error: "stale-state" });
    expect(await request(reads, namer.connection, room, { ...naming, name: "" }, namer.sent, saved.doc))
      .toMatchObject({ ok: false, error: "invalid-name" });
    const named = await request(reads, namer.connection, room, naming, namer.sent, saved.doc);
    const name = { text: "Reviewed", namer: { githubUsername: "reader", surface: { kind: "browser", name: "browser" } },
      namedAt: 1_000, canManage: true };
    expect(named).toMatchObject({ ok: true, revision: { id: saved.id, endedAt: 1_000, name,
      author: { githubUsername: "ben", surface: { kind: "mcp", name: "Claude Code" } } } });
    expect(await request(reads, namer.connection, room, naming, namer.sent, saved.doc))
      .toMatchObject({ ok: false, error: "already-named", name });
    const legacy = await request(reads, namer.connection, room, { operation: "list" }, namer.sent);
    if (!("revisions" in legacy)) throw new Error("expected list");
    expect(Object.keys(legacy.revisions[0]!).sort()).toEqual(["author", "endedAt", "id", "startedAt"]);
    expect(await request(reads, namer.connection, room, { operation: "list", includeNames: true }, namer.sent))
      .toMatchObject({ revisions: [{ name }] });
    expect(await request(reads, readOnly.connection, room, { operation: "list", includeNames: true }, readOnly.sent))
      .toMatchObject({ revisions: [{ name: { canManage: false } }] });
    const other = receiver();
    (other.connection.context as { principalId: string }).principalId = "other-account";
    expect(await request(reads, other.connection, room, { operation: "list", includeNames: true }, other.sent))
      .toMatchObject({ revisions: [{ name: { canManage: false } }] });
    for (const operation of ["rename", "remove-name"] as const) {
      expect(await request(reads, other.connection, room, { operation, revisionId: saved.id, name: "Other" }, other.sent))
        .toMatchObject({ ok: false, error: "not-namer" });
      expect(await request(reads, readOnly.connection, room, { operation, revisionId: saved.id, name: "Other" }, readOnly.sent))
        .toMatchObject({ ok: false, error: "forbidden" });
    }
    expect(await request(reads, namer.connection, room, { operation: "rename", revisionId: saved.id, name: "Renamed" }, namer.sent))
      .toMatchObject({ revision: { name: { ...name, text: "Renamed" } } });
    expect(await request(reads, namer.connection, room, { operation: "remove-name", revisionId: saved.id }, namer.sent))
      .toMatchObject({ revision: { id: saved.id, endedAt: 1_000, name: null } });
    const fetched = await request(reads, namer.connection, room, { operation: "get", revisionId: saved.id }, namer.sent);
    if (!("state" in fetched)) throw new Error("expected historical state");
    expect(fetched.state).toEqual(db.revisions.get(room, saved.id));
  });

  it("refuses writes to archived documents from live and stored directory state while keeping names readable", async () => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const saved = seed(db, room, "Before archive");
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: id => id });
    const reader = receiver();
    const naming: Omit<RevisionRequest, "requestId"> = { operation: "name", name: "Preserved",
      checksum: createHash("sha256").update(snapshotRevision(saved.doc).checksum).digest("hex"),
      surface: { kind: "browser", name: "browser" } };
    expect(await request(reads, reader.connection, room, naming, reader.sent, saved.doc)).toMatchObject({ ok: true });
    const directory = new Document(directoryRoom(WORKSPACE));
    documents.push(directory);
    await db.onLoadDocument({ document: directory, documentName: directoryRoom(WORKSPACE) });
    const uuid = room.split("/")[1]!;
    getDirectoryMap(directory).set(uuid, { title: "Archived", tags: [] });
    tombstoneDirectoryEntry(directory, uuid);
    for (const operation of ["name", "rename", "remove-name", "restore"] as const) {
      expect(await request(reads, reader.connection, room, { ...naming, operation, revisionId: saved.id }, reader.sent, saved.doc))
        .toMatchObject({ ok: false, error: "archived" });
    }
    expect(await request(reads, reader.connection, room, { operation: "list", includeNames: true }, reader.sent))
      .toMatchObject({ revisions: [{ name: { text: "Preserved", canManage: false } }] });
    await db.onStoreDocument({ document: directory, documentName: directoryRoom(WORKSPACE) });
    directory.destroy();
    expect(await request(reads, reader.connection, room, naming, reader.sent, saved.doc)).toMatchObject({ ok: false, error: "archived" });
  });

  it("serves read-only readers newest first, resolving current usernames and preserving unknown authors", async () => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const first = seed(db, room, "First", null);
    first.doc.transact(() => getMetaMap(first.doc).set("title", "Second"), {
      attribution: { author: { principalId: "ben", surface: { kind: "mcp", name: "Claude Code" } } },
    });
    let username = "before-rename";
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: () => username });
    const reader = receiver(true);
    const response = await request(reads, reader.connection, room, { operation: "list" }, reader.sent);
    expect(response).toMatchObject({ ok: true, revisions: [
      { author: { githubUsername: "before-rename", surface: { kind: "mcp", name: "Claude Code" } },
        startedAt: 1_000, endedAt: null },
      { author: null, startedAt: 1_000, endedAt: 1_000 },
    ] });
    username = "after-rename";
    expect(await request(reads, reader.connection, room, { operation: "list" }, reader.sent))
      .toMatchObject({ revisions: [{ author: { githubUsername: "after-rename" } }, { author: null }] });
    expect(await request(reads, reader.connection, `${WORKSPACE}/${randomUUID()}`, { operation: "list" }, reader.sent))
      .toMatchObject({ ok: true, revisions: [] });
  });

  it("addresses each reply only to its requester and returns a detached comparable snapshot", async () => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const saved = seed(db, room, "Private revision");
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: () => "ben" });
    const requester = receiver();
    const bystander = receiver();
    const response = await request(reads, requester.connection, room,
      { operation: "get", revisionId: saved.id }, requester.sent);
    expect(bystander.sent).toEqual([]);
    expect(response).toMatchObject({ ok: true });
    if (!("state" in response)) throw new Error("expected revision content");
    const revision = document();
    Y.applyUpdate(revision, response.state);
    expect(getMeta(revision).title).toBe("Private revision");
    expect(compareRevisions(saved.doc, revision).changed).toBe(false);
    getMetaMap(revision).set("title", "Changed only in detached copy");
    expect(getMeta(saved.doc).title).toBe("Private revision");
    expect(db.revisions.get(room, saved.id)).toEqual(response.state);
  });

  it("refuses unknown and foreign revision IDs without disclosing their content", async () => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const otherRoom = `${WORKSPACE}/${randomUUID()}`;
    seed(db, room, "Readable document");
    const hidden = seed(db, otherRoom, "Another document's historical secret");
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: () => "ben" });
    const reader = receiver();
    for (const revisionId of ["unknown", hidden.id]) {
      expect(await request(reads, reader.connection, room, { operation: "get", revisionId }, reader.sent))
        .toMatchObject({ ok: false, error: "revision-not-found" });
    }
    expect(reader.sent.join("")).not.toContain("historical secret");
  });

  it("checks current authority before reading or resolving historical authors", async () => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const saved = seed(db, room, "Never disclosed");
    const list = vi.spyOn(db.revisions, "list");
    const get = vi.spyOn(db.revisions, "get");
    const username = vi.fn(() => "ben");
    const assertCurrent = vi.fn(() => { throw new Error("membership removed"); });
    const reads = new RevisionReads({ database: db, assertCurrent, username });
    const reader = receiver();
    for (const value of [{ operation: "list" as const, includeTitles: true as const }, { operation: "get" as const, revisionId: saved.id }]) {
      expect(await request(reads, reader.connection, room, value, reader.sent))
        .toMatchObject({ ok: false, error: "forbidden" });
    }
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(username).not.toHaveBeenCalled();
    expect(reader.sent.join("")).not.toContain("Never disclosed");
  });

  it("distinguishes signed-out and unsupported rooms from empty history", async () => {
    const db = database(false);
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: () => "ben" });
    const room = `${WORKSPACE}/${randomUUID()}`;
    const local = receiver(false, false);
    const signedIn = receiver();
    expect(await request(reads, local.connection, room, { operation: "list" }, local.sent))
      .toMatchObject({ ok: false, error: "forbidden" });
    expect(await request(reads, signedIn.connection, room, { operation: "list" }, signedIn.sent))
      .toMatchObject({ ok: false, error: "unsupported" });
    const enabled = new RevisionReads({ database: database(), assertCurrent() {}, username: () => "ben" });
    expect(await request(enabled, signedIn.connection, directoryRoom(WORKSPACE), { operation: "list" }, signedIn.sent))
      .toMatchObject({ ok: false, error: "unsupported" });
  });

  it.each(["open", "decided", "rejected", "withdrawn"] as const)("refuses every revision operation for %s decisions before directory updates and while archived", async status => {
    const db = database();
    const uuid = randomUUID();
    const room = `${WORKSPACE}/${uuid}`;
    const saved = seed(db, room, "Earlier regular page");
    const checksum = () => createHash("sha256").update(snapshotRevision(saved.doc).checksum).digest("hex");
    expect(db.revisions.name(room, saved.doc, checksum(), "Before conversion", {
      principalId: "reader", surface: { kind: "browser", name: "browser" },
    }).ok).toBe(true);
    getMetaMap(saved.doc).set("title", "Later regular page");
    saved.doc.transact(() => {
      getMetaMap(saved.doc).set("kind", "decision");
      getMetaMap(saved.doc).set("status", status);
      getMetaMap(saved.doc).set("title", "Converted decision");
    });
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: id => id });
    const reader = receiver();
    const directory = new Document(directoryRoom(WORKSPACE));
    documents.push(directory);
    await db.onLoadDocument({ document: directory, documentName: directoryRoom(WORKSPACE) });
    const operations: Array<Omit<RevisionRequest, "requestId">> = [
      { operation: "list", includeNames: true, includeTitles: true },
      { operation: "get", revisionId: saved.id },
      { operation: "name", name: "New name", checksum: checksum(), surface: { kind: "browser", name: "browser" } },
      { operation: "rename", revisionId: saved.id, name: "Changed name" },
      { operation: "remove-name", revisionId: saved.id },
      { operation: "restore", revisionId: saved.id, checksum: checksum(), surface: { kind: "browser", name: "browser" } },
    ];
    const accesses = [vi.spyOn(db.revisions, "list"), vi.spyOn(db.revisions, "get"), vi.spyOn(db.revisions, "names"),
      vi.spyOn(db.revisions, "name"), vi.spyOn(db.revisions, "rename"), vi.spyOn(db.revisions, "removeName"),
      vi.spyOn(db, "restoreRevision")];
    for (const archived of [false, true]) {
      if (archived) {
        getDirectoryMap(directory).set(uuid, { title: "Converted decision", tags: [], kind: "decision", topic: uuid, status });
        tombstoneDirectoryEntry(directory, uuid);
      }
      const content = Y.encodeStateAsUpdate(saved.doc);
      const revisions = db.connection.prepare("SELECT * FROM document_revisions WHERE room = ?").all(room);
      const heads = db.connection.prepare("SELECT * FROM document_revision_heads WHERE room = ?").all(room);
      const names = db.connection.prepare("SELECT * FROM document_revision_names WHERE room = ?").all(room);
      for (const operation of operations) {
        expect(await request(reads, reader.connection, room, operation, reader.sent, saved.doc))
          .toMatchObject({ ok: false, error: "unsupported" });
        expect(Y.encodeStateAsUpdate(saved.doc)).toEqual(content);
        expect(db.connection.prepare("SELECT * FROM document_revisions WHERE room = ?").all(room)).toEqual(revisions);
        expect(db.connection.prepare("SELECT * FROM document_revision_heads WHERE room = ?").all(room)).toEqual(heads);
        expect(db.connection.prepare("SELECT * FROM document_revision_names WHERE room = ?").all(room)).toEqual(names);
      }
    }
    for (const access of accesses) expect(access).not.toHaveBeenCalled();
  });

  it("keeps archived history readable, then returns deleted without a stale snapshot", async () => {
    const db = database();
    const uuid = randomUUID();
    const room = `${WORKSPACE}/${uuid}`;
    const saved = seed(db, room, "Deleted historical content");
    db.connection.prepare("INSERT INTO documents(name, data) VALUES (?, ?)").run(room, Y.encodeStateAsUpdate(saved.doc));
    const directory = document();
    getDirectoryMap(directory).set(uuid, { title: "Deleted historical content", tags: [], deleted: true });
    await db.onLoadDocument({ document: directory, documentName: directoryRoom(WORKSPACE) } as Parameters<HubDatabase["onLoadDocument"]>[0]);
    const reads = new RevisionReads({ database: db, assertCurrent() { db.requireRoom(room); }, username: () => "ben" });
    const reader = receiver();
    expect(await request(reads, reader.connection, room, { operation: "list" }, reader.sent))
      .toMatchObject({ ok: true, revisions: [{ id: saved.id }] });
    expect(await request(reads, reader.connection, room, { operation: "get", revisionId: saved.id }, reader.sent))
      .toMatchObject({ ok: true, state: db.revisions.get(room, saved.id) });
    reader.sent.length = 0;
    deleteDirectoryEntry(directory, uuid);
    expect(db.isDeletedRoom(room)).toBe(true);
    for (const value of [{ operation: "list" as const }, { operation: "get" as const, revisionId: saved.id }]) {
      expect(await request(reads, reader.connection, room, value, reader.sent))
        .toMatchObject({ ok: false, error: "deleted" });
    }
    expect(reader.sent.join("")).not.toContain("Deleted historical content");
  });

  it("chunks a large snapshot below the frame ceiling and assembles its exact bytes", async () => {
    const db = database();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const saved = seed(db, room, "Large title ".repeat(80_000));
    const reads = new RevisionReads({ database: db, assertCurrent() {}, username: () => "ben" });
    const reader = receiver(true);
    const response = await request(reads, reader.connection, room,
      { operation: "get", revisionId: saved.id }, reader.sent);
    expect(reader.sent.length).toBeGreaterThan(1);
    expect(reader.sent.every(frame => Buffer.byteLength(frame) < 16 * 1024 * 1024)).toBe(true);
    if (!("state" in response)) throw new Error("expected revision content");
    expect(response.state).toEqual(db.revisions.get(room, saved.id));
  });
});

it("records and serves team-hub history to read-only members with current usernames and private replies", async () => {
  const hub = await createTeamHub({
    address: "127.0.0.1", port: 0, databasePath: ":memory:",
    github: { clientId: "Iv1.0123456789abcdef", fetch: vi.fn(() => { throw new Error("unexpected GitHub request"); }) },
    log() {},
  }, { deviceCredentials: true });
  hubs.push(hub);
  const { credentials, memberships, principals } = hub;
  if (credentials === undefined || memberships === undefined || principals === undefined) throw new Error("team authority missing");
  const author = principals.identify("12345", "before-rename");
  memberships.grant({ workspaceId: WORKSPACE, principalId: author.id, role: "admin" });
  const issued = issueCredential(credentials, { principalId: author.id, deviceId: "computer", workspaces: [WORKSPACE] });
  const room = `${WORKSPACE}/${randomUUID()}`;
  const key = await importCredentialKey(issued.keyBytes);
  const tokens = await Promise.all((["read-write", "read-only"] as const).map(scope => mintToken(key, {
    typ: "room", sub: author.id, workspace: WORKSPACE, scope, kid: issued.record.id, lifetimeSeconds: 60,
  })));
  const arrivals: string[][] = [[], []];
  const clients = arrivals.map((received, index) => {
    const doc = document();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${hub.port}`, name: room, document: doc,
      token: wrapToken(tokens[index] ?? "", SYNC_PROTOCOL_VERSION), awareness: null,
      onStateless: ({ payload }) => { received.push(payload); },
    });
    providers.push(provider);
    return provider;
  });
  await waitUntil("both admitted rooms to synchronize", () => clients.every(client => client.synced));
  const connections = [...(hub.hocuspocus.documents.get(room)?.getConnections() ?? [])];
  expect(connections).toHaveLength(2);
  expect(connections.filter(connection => connection.readOnly)).toHaveLength(1);
  const authored = document();
  getMetaMap(authored).set("title", "Team historical content");
  const updateId = randomUUID();
  clients[0]?.sendStateless(encodeOriginUpdate(updateId, Y.encodeStateAsUpdate(authored), {
    updateId, credentialId: issued.record.id, surface: { kind: "mcp", name: "Claude Code" },
  }));
  await waitUntil("the attributed update to be acknowledged", () => arrivals[0]?.some(frame => readOriginAck(frame)?.applied) === true);
  arrivals[0]?.splice(0);
  const reader = clients[1];
  if (reader === undefined) throw new Error("read-only provider missing");
  async function read(value: Omit<RevisionRequest, "requestId">, index = 1): Promise<RevisionResponse> {
    const requestId = randomUUID();
    const decode = createRevisionResponseReader(requestId);
    let response: RevisionResponse | null = null;
    let consumed = arrivals[index]?.length ?? 0;
    clients[index]?.sendStateless(encodeRevisionRequest({ requestId, ...value }));
    await waitUntil("the requested team-hub history", () => {
      for (const frame of arrivals[index]?.slice(consumed) ?? []) response = decode(frame) ?? response;
      consumed = arrivals[index]?.length ?? 0;
      return response !== null;
    });
    if (response === null) throw new Error("no team revision response");
    return response;
  }
  const listed = await read({ operation: "list" });
  expect(listed).toMatchObject({ ok: true, revisions: [{
    author: { githubUsername: "before-rename", surface: { kind: "mcp", name: "Claude Code" } }, endedAt: null,
  }] });
  if (!("revisions" in listed) || listed.revisions[0] === undefined) throw new Error("missing recorded revision");
  const id = listed.revisions[0].id;
  principals.identify("12345", "after-rename");
  expect(await read({ operation: "list" }))
    .toMatchObject({ revisions: [{ id, author: { githubUsername: "after-rename" } }] });
  const fetched = await read({ operation: "get", revisionId: id });
  if (!("state" in fetched)) throw new Error("missing team revision content");
  const revision = document();
  Y.applyUpdate(revision, fetched.state);
  expect(getMeta(revision).title).toBe("Team historical content");
  expect(compareRevisions(authored, revision).changed).toBe(false);
  expect(arrivals[0]).toEqual([]);
  const naming: Omit<RevisionRequest, "requestId"> = { operation: "name", name: "Reviewed in browser",
    checksum: createHash("sha256").update(snapshotRevision(authored).checksum).digest("hex"),
    surface: { kind: "browser", name: "browser" } };
  expect(await read(naming)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await read(naming, 0)).toMatchObject({ ok: true, revision: { id,
    author: { githubUsername: "after-rename", surface: { kind: "mcp", name: "Claude Code" } },
    name: { text: "Reviewed in browser", namer: { githubUsername: "after-rename", surface: { kind: "browser", name: "browser" } },
      canManage: true, namedAt: expect.any(Number) }, endedAt: expect.any(Number) } });
  expect(await read({ operation: "list", includeNames: true, includeTitles: true }))
    .toMatchObject({ revisions: [{ title: "Team historical content", name: { canManage: false } }] });
  expect(await read({ operation: "rename", revisionId: id, name: "Renamed across surfaces" }, 0))
    .toMatchObject({ revision: { id, name: { text: "Renamed across surfaces", namer: { surface: { kind: "browser" } } } } });
});
