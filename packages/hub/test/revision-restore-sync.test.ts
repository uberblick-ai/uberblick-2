import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  createRevisionResponseReader, editBlock, encodeOriginUpdate, encodeRevisionRequest,
  getBlock, getMeta, getMetaMap, insertBlock, readOriginAck, snapshotRevision,
  type RevisionRequest, type RevisionResponse,
} from "@uberblick/schema";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/schema/protocol";
import { importCredentialKey, mintToken } from "@uberblick/schema/token";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { createTeamHub } from "../src/team.js";
import { issueCredential } from "./device-credentials.js";
import { removeTempDatabases, tempDatabasePath, WORKSPACE, waitUntil } from "./helpers.js";

it("persists a restore before replying and syncs it to peers that can keep editing and reconnect", async () => {
  const path = tempDatabasePath();
  const hub = await createTeamHub({
    address: "127.0.0.1", port: 0, databasePath: path, debounce: 60_000, maxDebounce: 120_000,
    github: { clientId: "Iv1.0123456789abcdef", fetch: () => { throw new Error("unexpected GitHub request"); } },
    log() {},
  }, { deviceCredentials: true });
  const providers: HocuspocusProvider[] = [];
  const docs: Y.Doc[] = [];
  const document = (): Y.Doc => { const doc = new Y.Doc(); docs.push(doc); return doc; };
  try {
    const { credentials, memberships, principals } = hub;
    if (credentials === undefined || memberships === undefined || principals === undefined) throw new Error("missing authority");
    const principal = principals.identify("12345", "restorer");
    memberships.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "admin" });
    const credential = issueCredential(credentials, { principalId: principal.id, deviceId: "computer", workspaces: [WORKSPACE] });
    const token = wrapToken(await mintToken(await importCredentialKey(credential.keyBytes), {
      typ: "room", sub: principal.id, workspace: WORKSPACE, scope: "read-write", kid: credential.record.id, lifetimeSeconds: 60,
    }), SYNC_PROTOCOL_VERSION);
    const room = `${WORKSPACE}/${randomUUID()}`;
    const connect = async () => {
      const doc = document();
      const frames: string[] = [];
      const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${hub.port}`, name: room, document: doc,
        token, awareness: null, onStateless: ({ payload }) => frames.push(payload) });
      providers.push(provider);
      await waitUntil("client admission", () => provider.synced);
      return { doc, provider, frames };
    };
    const writer = await connect();
    const peer = await connect();
    const request = async (operation: Omit<RevisionRequest, "requestId">): Promise<RevisionResponse> => {
      const requestId = randomUUID();
      const read = createRevisionResponseReader(requestId);
      let response: RevisionResponse | null = null;
      let cursor = writer.frames.length;
      writer.provider.sendStateless(encodeRevisionRequest({ requestId, ...operation }));
      await waitUntil("revision reply", () => {
        for (const frame of writer.frames.slice(cursor)) response = read(frame) ?? response;
        cursor = writer.frames.length;
        return response !== null;
      });
      if (response === null) throw new Error("missing revision reply");
      return response;
    };
    const send = async (client: typeof writer, change: (doc: Y.Doc) => void) => {
      const copy = document();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(client.doc));
      const vector = Y.encodeStateVector(copy);
      change(copy);
      const id = randomUUID();
      client.provider.sendStateless(encodeOriginUpdate(id, Y.encodeStateAsUpdate(copy, vector), {
        updateId: id, credentialId: credential.record.id, surface: { kind: "mcp", name: "Test client" },
      }));
      await waitUntil("attributed update acknowledgement", () => client.frames.some(frame => {
        const ack = readOriginAck(frame);
        return ack?.updateId === id && ack.applied;
      }));
      await waitUntil("peer content convergence", () => snapshotRevision(writer.doc).checksum === snapshotRevision(copy).checksum &&
        snapshotRevision(peer.doc).checksum === snapshotRevision(copy).checksum);
    };
    let changed = "";
    let kept = "";
    await send(writer, doc => {
      getMetaMap(doc).set("title", "Past title");
      changed = insertBlock(doc, null, { type: "paragraph", text: "Past text" });
      kept = insertBlock(doc, changed, { type: "paragraph", text: "Keep editing here" });
    });
    const listed = await request({ operation: "list" });
    if (!("revisions" in listed) || listed.revisions[0] === undefined) throw new Error("missing initial revision");
    const past = listed.revisions[0].id;
    const checksum = () => createHash("sha256").update(snapshotRevision(writer.doc).checksum).digest("hex");
    await request({ operation: "name", checksum: checksum(), name: "Past", surface: { kind: "browser", name: "browser" } });
    await send(writer, doc => {
      getMetaMap(doc).set("title", "Latest title");
      editBlock(doc, changed, "Past text", "Latest text");
    });
    const restored = await request({ operation: "restore", revisionId: past, checksum: checksum(),
      surface: { kind: "browser", name: "browser" } });
    expect(restored).toMatchObject({ ok: true, applied: true, revision: {
      author: { githubUsername: "restorer", surface: { kind: "browser", name: "browser" } }, endedAt: expect.any(Number),
    } });
    const stored = new DatabaseSync(path, { readOnly: true });
    try {
      const state = stored.prepare("SELECT data FROM documents WHERE name = ?").get(room)?.data;
      expect(state).toBeInstanceOf(Uint8Array);
      const saved = document();
      Y.applyUpdate(saved, state as Uint8Array);
      expect(getMeta(saved).title).toBe("Past title");
      expect(getBlock(saved, changed)?.text).toBe("Past text");
    } finally { stored.close(); }
    await waitUntil("restore on both clients", () => [writer, peer].every(client =>
      getMeta(client.doc).title === "Past title" && getBlock(client.doc, changed)?.text === "Past text"));
    const reconnected = await connect();
    expect(getMeta(reconnected.doc).title).toBe("Past title");
    await send(peer, doc => editBlock(doc, kept, "Keep editing here", "Edited after restore"));
    const later = await request({ operation: "list" });
    if (!("revisions" in later) || !("revision" in restored)) throw new Error("missing history");
    expect(later.revisions[0]?.id).not.toBe(restored.revision.id);
    expect(later.revisions[0]?.endedAt).toBeNull();
    expect(later.revisions[1]?.id).toBe(restored.revision.id);
    expect(later.revisions.some(entry => entry.id === past)).toBe(true);
  } finally {
    for (const provider of providers) provider.destroy();
    await hub.stop();
    for (const doc of docs) doc.destroy();
    removeTempDatabases();
  }
});
