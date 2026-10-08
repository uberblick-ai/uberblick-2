import { settingsRoom, WORKSPACE_SETTINGS_KEY } from "@uberblick/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CredentialRecord, CredentialRenewal } from "../src/credentials.js";
import { HubDatabase } from "../src/persistence.js";
import { addWorkspaceNames, WorkspaceNameReader } from "../src/workspace-names.js";
import { OTHER_WORKSPACE, WORKSPACE } from "./helpers.js";

const databases: HubDatabase[] = [];
const documents: Y.Doc[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const document of documents.splice(0)) document.destroy();
  for (const database of databases.splice(0)) database.close();
});

function rig() {
  const database = new HubDatabase(":memory:", () => {});
  database.open();
  databases.push(database);
  return { database, reader: new WorkspaceNameReader(database) };
}

function settings(name?: unknown) {
  const document = new Y.Doc();
  documents.push(document);
  if (name !== undefined) document.getMap(WORKSPACE_SETTINGS_KEY).set("name", name);
  return document;
}

function store(database: HubDatabase, workspaceId: string, document: Y.Doc) {
  database.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
    .run(settingsRoom(workspaceId), Y.encodeStateAsUpdate(document));
}

const key = Buffer.alloc(32, 1).toString("base64url");
function reply(workspaces = [WORKSPACE, OTHER_WORKSPACE]): Extract<CredentialRenewal, { status: "renewed" }> {
  const record: CredentialRecord = { id: "7e0642bb-1c89-41b1-b615-b28191f17218",
    principalId: "7e0642bb-1c89-41b1-b615-b28191f17219", deviceId: "7e0642bb-1c89-41b1-b615-b28191f17220",
    workspaces, issuedAt: 1_000, revokedAt: null, replacedAt: null };
  return { status: "renewed", credential: { record, key } };
}

function completeReply(reserveBytes = 0, claimed = false) {
  const original = { ...reply(), status: "complete", ...(claimed ? { claimedWorkspaceId: WORKSPACE } : {}), identity: {
    id: "7e0642bb-1c89-41b1-b615-b28191f17219", githubAccountId: "1234", githubUsername: "s",
  } };
  const remaining = 65_536 - reserveBytes - Buffer.byteLength(JSON.stringify(original));
  // Each additional UUID occupies 39 JSON bytes. Keep the username under 40
  // characters so this bound is reached by a real-sized workspace list.
  original.credential.record.workspaces.push(...Array.from({ length: Math.floor(remaining / 39) }, (_, index) =>
    `9e0642bb-1c89-41b1-b615-${index.toString(16).padStart(12, "0")}`));
  original.identity.githubUsername += "x".repeat(remaining % 39);
  return original;
}

describe("credential workspace display names", () => {
  it("reads persisted full-state settings without writing any row", () => {
    const { database, reader } = rig();
    store(database, WORKSPACE, settings("Project snowman ☃"));
    const rows = database.connection.prepare("SELECT * FROM documents").all();
    expect(reader.read(WORKSPACE)).toBe("Project snowman ☃");
    expect(reader.read(OTHER_WORKSPACE)).toBeNull();
    expect(database.connection.prepare("SELECT * FROM documents").all()).toEqual(rows);
  });

  it("reads a loaded rename ahead of the stored row without changing the live room", () => {
    const { database } = rig();
    store(database, WORKSPACE, settings("Before rename"));
    const loaded = settings("After rename");
    const unnamed = settings();
    const reader = new WorkspaceNameReader(database,
      room => room === settingsRoom(WORKSPACE) ? loaded : unnamed);
    const state = Y.encodeStateAsUpdate(loaded);
    const roots = [...unnamed.share.keys()];
    expect(reader.read(WORKSPACE)).toBe("After rename");
    expect(reader.read(OTHER_WORKSPACE)).toBeNull();
    expect(Y.encodeStateAsUpdate(loaded)).toEqual(state);
    expect([...unnamed.share.keys()]).toEqual(roots);
    expect(new WorkspaceNameReader(database).read(WORKSPACE)).toBe("Before rename");
  });

  it("ignores undecodable, invalid and unreadable rooms", () => {
    const { database, reader } = rig();
    database.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
      .run(settingsRoom(WORKSPACE), new Uint8Array([255]));
    expect(reader.read(WORKSPACE)).toBeNull();
    for (const name of [123, "bad\u009bname", "bad\u202ename", "x".repeat(65)]) {
      const invalid = new WorkspaceNameReader(database, () => settings(name));
      expect(invalid.read(WORKSPACE)).toBeNull();
    }
    const wrongRoot = settings();
    wrongRoot.getArray(WORKSPACE_SETTINGS_KEY).insert(0, ["name"]);
    expect(new WorkspaceNameReader(database, () => wrongRoot).read(WORKSPACE)).toBeNull();
    const failed = new WorkspaceNameReader(database, () => { throw new Error("read failed"); });
    expect(failed.read(WORKSPACE)).toBeNull();
    database.close();
    expect(reader.read(WORKSPACE)).toBeNull();
  });

  it("adds names only for issued workspaces and suppresses terminal controls and both secrets", () => {
    const { database, reader } = rig();
    store(database, WORKSPACE, settings("Accepted"));
    store(database, OTHER_WORKSPACE, settings("Unissued"));
    expect(addWorkspaceNames(reply([WORKSPACE]), reader).credential.workspaceNames)
      .toEqual({ [WORKSPACE]: "Accepted" });
    const secret = "collection-secret-for-this-synthetic-request";
    for (const name of [key, `prefix ${secret}`, "bad\u009bname", "bad\u202ename"]) {
      vi.spyOn(reader, "read").mockReturnValueOnce(name);
      expect(addWorkspaceNames(reply([WORKSPACE]), reader, secret).credential.workspaceNames).toBeUndefined();
    }
  });

  it("keeps the issued key and workspaces even if reading names throws", () => {
    const { reader } = rig();
    vi.spyOn(reader, "read").mockImplementation(() => { throw new Error("name read failed"); });
    const original = reply();
    expect(addWorkspaceNames(original, reader)).toBe(original);
  });

  it("omits multibyte and JSON-escaped names to keep the entire renewal under 64 KiB", () => {
    const { reader } = rig();
    const workspaces = Array.from({ length: 1_000 }, (_, index) =>
      `8e0642bb-1c89-41b1-b615-${index.toString(16).padStart(12, "0")}`);
    const names = ["😀".repeat(64), '"\\'.repeat(32)];
    vi.spyOn(reader, "read").mockImplementation(id => names[workspaces.indexOf(id) % 2]!);
    const original = reply(workspaces);
    const named = addWorkspaceNames(original, reader);
    expect(Buffer.byteLength(JSON.stringify(original))).toBeLessThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(named))).toBeLessThanOrEqual(65_536);
    expect(Object.keys(named.credential.workspaceNames!)).not.toHaveLength(workspaces.length);
    expect(Object.keys(named.credential.workspaceNames!).length).toBeGreaterThan(0);
    expect(Object.values(named.credential.workspaceNames!)).toContain(names[0]);
    expect(Object.values(named.credential.workspaceNames!)).toContain(names[1]);
    expect(named.credential.record).toEqual(original.credential.record);
    expect(named.credential.key).toBe(key);
  });

  it("leaves a complete reply exactly at the byte bound intact, with no names", () => {
    const { reader } = rig();
    vi.spyOn(reader, "read").mockImplementation(id => id === WORKSPACE || id === OTHER_WORKSPACE ? "😀\"\\" : null);
    const original = completeReply(0, true);
    const workspaces = [...original.credential.record.workspaces];
    expect(Buffer.byteLength(JSON.stringify(original))).toBe(65_536);
    expect(addWorkspaceNames(original, reader)).toBe(original);
    expect(original.credential.record.workspaces).toEqual(workspaces);
    expect(workspaces.length).toBeGreaterThan(1_000);
  });

  it("skips an oversized name and includes a later smaller name exactly at the byte bound", () => {
    const { reader } = rig();
    vi.spyOn(reader, "read").mockImplementation(id => id === WORKSPACE ? "😀".repeat(64) : id === OTHER_WORKSPACE ? "n" : null);
    const oneNameBytes = Buffer.byteLength(',"workspaceNames":{}') + Buffer.byteLength(`${JSON.stringify(OTHER_WORKSPACE)}:"n"`);
    const original = completeReply(oneNameBytes);
    const workspaces = [...original.credential.record.workspaces];
    const named = addWorkspaceNames(original, reader);
    expect(named.credential.workspaceNames).toEqual({ [OTHER_WORKSPACE]: "n" });
    expect(Buffer.byteLength(JSON.stringify(named))).toBe(65_536);
    expect(named.credential.record.workspaces).toEqual(workspaces);
    expect(named.credential.key).toBe(key);
  });
});
