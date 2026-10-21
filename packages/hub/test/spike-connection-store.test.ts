/**
 * Spike: vendor credentials live only in a hub table, encrypted, never in a
 * synced room. Throwaway prototype, never merged.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { settingsRoom } from "@uberblick/schema";
import type { Hub } from "../src/server.js";
import {
  WORKSPACE, OTHER_WORKSPACE, createClient, removeTempDatabases, startHub, tempDatabasePath, token,
  waitUntil, type TestClient,
} from "./helpers.js";

/** AES-256-GCM; the associated data binds a ciphertext to its workspace and connection name. */
class ConnectionStore {
  constructor(private readonly db: DatabaseSync, private readonly key: Buffer | null) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_connections (
      workspace_id TEXT NOT NULL, name TEXT NOT NULL, vendor TEXT NOT NULL,
      settings TEXT NOT NULL, secret BLOB NOT NULL, secret_hint TEXT NOT NULL,
      added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, name))`);
  }
  private aad(workspace: string, name: string): Buffer { return Buffer.from(JSON.stringify([workspace, name])); }
  set(workspace: string, name: string, vendor: string, settings: object, secret: string, addedBy: string): void {
    if (this.key === null) throw new Error("connections are off: no key configured");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(workspace, name));
    const sealed = Buffer.concat([iv, cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
    this.db.prepare(`INSERT INTO hub_connections VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, name) DO UPDATE SET vendor = excluded.vendor, settings = excluded.settings,
      secret = excluded.secret, secret_hint = excluded.secret_hint, added_by = excluded.added_by, added_at = excluded.added_at`)
      .run(workspace, name, vendor, JSON.stringify(settings), sealed, `…${secret.slice(-4)}`, addedBy, Date.now());
  }
  /** Only the runner calls this, in memory, for one request. */
  secret(workspace: string, name: string): string {
    if (this.key === null) throw new Error("connections are off: no key configured");
    const row = this.db.prepare("SELECT secret FROM hub_connections WHERE workspace_id = ? AND name = ?").get(workspace, name);
    if (row === undefined) throw new Error("no such connection");
    const sealed = row.secret as Uint8Array;
    const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.subarray(0, 12));
    decipher.setAAD(this.aad(workspace, name));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString("utf8");
  }
  /** What members and Settings may see. */
  list(workspace: string) {
    return this.db.prepare("SELECT name, vendor, settings, secret_hint, added_by, added_at FROM hub_connections WHERE workspace_id = ?").all(workspace);
  }
}

const clients: TestClient[] = [];
const hubs: Hub[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.provider.destroy();
  for (const h of hubs.splice(0)) await h.stop().catch(() => {});
  removeTempDatabases();
});

const SECRET = "NRAK-SPIKE0FAKE0KEY0FOR0TESTS00000000";

describe("spike: connection credentials", () => {
  it("never reach a synced room, a backup without the key, or another workspace", async () => {
    const databasePath = tempDatabasePath();
    const hub = await startHub({ databasePath });
    hubs.push(hub);
    const key = randomBytes(32);
    const db = new DatabaseSync(databasePath);
    const store = new ConnectionStore(db, key);
    store.set(WORKSPACE, "newrelic", "newrelic", { region: "us", accountId: 1234567 }, SECRET, "bk-one");

    // A member's local copy syncs the settings room; the descriptor may go there, the secret never.
    const member = createClient({ port: hub.port, room: settingsRoom(WORKSPACE), token: await token("read-write") });
    clients.push(member);
    await member.synced;
    member.doc.getMap("connections").set("newrelic", { vendor: "newrelic", region: "us", hint: "…0000" });
    await waitUntil("hub has the descriptor", () =>
      hub.hocuspocus.documents.get(settingsRoom(WORKSPACE))?.getMap("connections").has("newrelic") === true);
    await hub.flush();
    const replicaBytes = Buffer.from(Y.encodeStateAsUpdate(member.doc));

    const fileBytes = readFileSync(databasePath);
    const plaintextInDb = fileBytes.includes(Buffer.from(SECRET));
    const plaintextInReplica = replicaBytes.includes(Buffer.from(SECRET));
    const roundTrip = store.secret(WORKSPACE, "newrelic") === SECRET;

    // A ciphertext copied to another workspace's row does not open.
    const row = db.prepare("SELECT secret FROM hub_connections WHERE workspace_id = ?").get(WORKSPACE);
    db.prepare("INSERT INTO hub_connections VALUES (?, 'newrelic', 'newrelic', '{}', ?, '…', 'mallory', 0)").run(OTHER_WORKSPACE, row?.secret as Uint8Array);
    let movedRowOpens = true;
    try { store.secret(OTHER_WORKSPACE, "newrelic"); } catch { movedRowOpens = false; }

    // A backup alone is not enough: without the key nothing opens.
    const backup = `${databasePath}.backup`;
    copyFileSync(databasePath, backup);
    let backupOpensWithoutKey = true;
    try { new ConnectionStore(new DatabaseSync(backup), randomBytes(32)).secret(WORKSPACE, "newrelic"); } catch { backupOpensWithoutKey = false; }
    const backupOpensWithKey = new ConnectionStore(new DatabaseSync(backup), key).secret(WORKSPACE, "newrelic") === SECRET;

    // What Settings shows.
    const listed = store.list(WORKSPACE);
    console.log(JSON.stringify({ spike: "credential store", plaintextInDb, plaintextInReplica, roundTrip,
      movedRowOpens, backupOpensWithoutKey, backupOpensWithKey, listed,
      // Management requests sign operation and targets; a secret digest keeps the token out of the proof.
      setConnectionProofBinds: createHash("sha256").update(SECRET).digest("base64url").length + " chars of digest" }));
    expect(plaintextInDb).toBe(false);
    expect(plaintextInReplica).toBe(false);
    expect(roundTrip).toBe(true);
    expect(movedRowOpens).toBe(false);
    expect(backupOpensWithoutKey).toBe(false);
    expect(backupOpensWithKey).toBe(true);
    db.close();
  });
});
