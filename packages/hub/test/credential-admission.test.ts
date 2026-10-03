/**
 * Credential admission is deliberately composed here, beside HubDatabase,
 * instead of enabled on createHub. These proofs drive the same Hocuspocus
 * apply and authentication seams a future remote cutover will use.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { Server, type Connection, type Hocuspocus, type ServerConfiguration } from "@hocuspocus/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  CredentialAdmission,
  type CredentialContext,
} from "../src/credential-admission.js";
import {
  CredentialRegistry,
} from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import { HubDatabase } from "../src/persistence.js";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "../src/protocol.js";
import {
  importCredentialKey,
  importRootSecret,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintToken,
} from "../src/token.js";
import {
  OTHER_WORKSPACE,
  TEST_SECRET,
  TEXT_KEY,
  WORKSPACE,
  testRoom,
  waitUntil,
} from "./helpers.js";

const providers: HocuspocusProvider[] = [];
const sockets: HocuspocusProviderWebsocket[] = [];
const servers: Server<CredentialContext>[] = [];
const databases: HubDatabase[] = [];
const directories: string[] = [];
type IssuedCredential = ReturnType<CredentialRegistry["issue"]>;

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.destroy();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function startServer(
  hooks: Partial<ServerConfiguration<CredentialContext>> = {},
) {
  const directory = mkdtempSync(
    join(tmpdir(), `credential-admission-${process.env.UB_AGENT_RUN ?? "test"}-`),
  );
  directories.push(directory);
  const database = new HubDatabase(join(directory, "hub.sqlite"), (error) => {
    throw error;
  });
  databases.push(database);
  database.open();
  const registry = new CredentialRegistry(database);
  const logs: HubLogRecord[] = [];
  const admission = new CredentialAdmission(registry, {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    log: (record) => logs.push(record),
  });
  const server = new Server<CredentialContext>({
    port: 0,
    address: "127.0.0.1",
    quiet: true,
    stopOnSignals: false,
    debounce: 60_000,
    maxDebounce: 60_000,
    ...hooks,
    extensions: [database, admission],
  });
  servers.push(server);
  const hocuspocus = await server.listen();
  return {
    port: server.address.port,
    database,
    registry,
    admission,
    hocuspocus,
    logs,
  };
}

function issue(registry: CredentialRegistry, deviceId: string, workspaces = [WORKSPACE]) {
  return registry.issue({ principalId: "person", deviceId, workspaces });
}

async function credentialToken(
  credential: IssuedCredential,
  workspace = WORKSPACE,
  options: { kid?: string | null; key?: CryptoKey; sub?: string } = {},
) {
  return mintToken(options.key ?? await importCredentialKey(credential.keyBytes), {
    typ: "room",
    sub: options.sub ?? "client-asserted-person-and-device",
    workspace,
    scope: "read-write",
    kid: options.kid === undefined ? credential.record.id : options.kid,
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });
}

function connect(options: {
  port: number;
  room: string;
  token: string;
  document?: Y.Doc;
  websocketProvider?: HocuspocusProviderWebsocket;
  protocolVersion?: number;
}) {
  const doc = options.document ?? new Y.Doc();
  const provider = new HocuspocusProvider({
    ...(options.websocketProvider === undefined
      ? { url: `ws://127.0.0.1:${options.port}` }
      : { websocketProvider: options.websocketProvider }),
    name: options.room,
    token: wrapToken(options.token, options.protocolVersion ?? SYNC_PROTOCOL_VERSION),
    document: doc,
    awareness: null,
    // Close assertions cannot be satisfied by a reconnect on a new connection.
    ...{ delay: 60_000, minDelay: 60_000 },
  });
  providers.push(provider);
  const synced = new Promise<void>((resolve) => provider.on("synced", resolve));
  const denied = new Promise<string>((resolve) => {
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => resolve(reason));
  });
  const closed = new Promise<void>((resolve) => provider.on("close", resolve));
  if (options.websocketProvider !== undefined) provider.attach();
  return { doc, provider, text: doc.getText(TEXT_KEY), synced, denied, closed };
}

function sharedSocket(port: number) {
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}`,
    autoConnect: false,
    delay: 60_000,
    minDelay: 60_000,
  });
  sockets.push(socket);
  return socket;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

async function waitFor<T>(label: string, barrier: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Count arrivals through the dependency's actual handler, before queued hooks run. */
function frameBarrier(target: { handleMessage(data: Uint8Array): void }, count: number) {
  const handle = target.handleMessage.bind(target);
  let arrived = 0;
  return new Promise<void>((resolve) => {
    target.handleMessage = (data) => {
      handle(data);
      if (++arrived === count) resolve();
    };
  });
}

function nextClientConnection(hocuspocus: Hocuspocus<CredentialContext>) {
  const handle = hocuspocus.handleConnection.bind(hocuspocus);
  return new Promise<{ handleMessage(data: Uint8Array): void }>((resolve) => {
    hocuspocus.handleConnection = (...args: Parameters<typeof handle>) => {
      hocuspocus.handleConnection = handle;
      const connection = handle(...args);
      resolve(connection);
      return connection;
    };
  });
}

describe("credential admission on a composed server", () => {
  it("opens every issued workspace and binds identity and workspaces to the hub record", async () => {
    const contexts = new Map<string, CredentialContext>();
    const rig = await startServer({
      connected: async ({ documentName, context }) => { contexts.set(documentName, context); },
    });
    const laptop = issue(rig.registry, "laptop", [WORKSPACE, OTHER_WORKSPACE]);
    const phone = issue(rig.registry, "phone");
    const rooms = [testRoom(), testRoom(OTHER_WORKSPACE), testRoom()];
    const laptopFirst = connect({ port: rig.port, room: rooms[0]!, token: await credentialToken(laptop) });
    const laptopSecond = connect({ port: rig.port, room: rooms[1]!, token: await credentialToken(laptop, OTHER_WORKSPACE) });
    const phoneFirst = connect({ port: rig.port, room: rooms[2]!, token: await credentialToken(phone) });
    await waitFor("all authorized rooms to sync", Promise.all([laptopFirst.synced, laptopSecond.synced, phoneFirst.synced]));
    await waitUntil("all connection identities to be recorded", () => contexts.size === 3);

    expect(laptop.record.id).not.toBe(phone.record.id);
    expect(contexts.get(rooms[0]!)).toEqual({
      credentialId: laptop.record.id,
      principalId: "person",
      deviceId: "laptop",
      workspaces: [WORKSPACE, OTHER_WORKSPACE],
      workspace: WORKSPACE,
      authorization: { active: true },
    });
    expect(contexts.get(rooms[1]!)).toEqual({ ...contexts.get(rooms[0]!), workspace: OTHER_WORKSPACE });
    expect(contexts.get(rooms[2]!)).toEqual({
      credentialId: phone.record.id,
      principalId: "person",
      deviceId: "phone",
      workspaces: [WORKSPACE],
      workspace: WORKSPACE,
      authorization: { active: true },
    });
    laptopSecond.text.insert(0, "second workspace");
    await waitUntil("the second workspace write to land", () =>
      rig.hocuspocus.documents.get(rooms[1]!)?.getText(TEXT_KEY).toString() === "second workspace");
  });

  it("refuses scope escalation and credential forgery with one public reason and distinct logged causes", async () => {
    const rig = await startServer();
    const laptop = issue(rig.registry, "laptop");
    const phone = issue(rig.registry, "phone", [OTHER_WORKSPACE]);
    const root = await importRootSecret(TEST_SECRET);
    const phoneKey = await importCredentialKey(phone.keyBytes);
    const revoked = issue(rig.registry, "revoked");
    rig.registry.revoke(revoked.record.id);
    const vectors = [
      { token: await credentialToken(laptop, OTHER_WORKSPACE), room: testRoom(OTHER_WORKSPACE), cause: "workspace-not-authorized" },
      { token: await credentialToken(laptop), room: testRoom(OTHER_WORKSPACE), cause: "workspace-mismatch" },
      { token: await credentialToken(laptop, WORKSPACE, { key: root }), room: testRoom(), cause: "bad-signature" },
      { token: await credentialToken(laptop, WORKSPACE, { key: root, kid: null }), room: testRoom(), cause: "root-key" },
      { token: await credentialToken(laptop, WORKSPACE, { key: phoneKey }), room: testRoom(), cause: "bad-signature" },
      { token: await credentialToken(laptop, WORKSPACE, { kid: randomUUID() }), room: testRoom(), cause: "unknown-credential" },
      { token: await credentialToken(revoked), room: testRoom(), cause: "revoked-credential" },
      { token: "not-a-token", room: testRoom(), cause: "unparseable" },
      { token: await credentialToken(laptop), room: "not-a-room", cause: "workspace-mismatch" },
    ];
    for (const vector of vectors) {
      const client = connect({ port: rig.port, room: vector.room, token: vector.token });
      expect(await waitFor("a generic credential refusal", client.denied)).toBe("invalid-token");
      expect(rig.logs.at(-1)).toMatchObject({ cause: vector.cause });
    }
    const logText = JSON.stringify(rig.logs);
    expect(logText).not.toContain(TEST_SECRET);
    expect(logText).not.toContain(Buffer.from(laptop.keyBytes).toString("base64url"));
    expect(logText).not.toContain(Buffer.from(phone.keyBytes).toString("base64url"));
    expect(logText).not.toContain("client-asserted-person-and-device");
  });

  it("keeps protocol skew distinct from the generic credential refusal", async () => {
    const rig = await startServer();
    const laptop = issue(rig.registry, "laptop");
    const client = connect({
      port: rig.port,
      room: testRoom(),
      token: await credentialToken(laptop),
      protocolVersion: SYNC_PROTOCOL_VERSION + 1,
    });
    expect(await waitFor("the protocol refusal", client.denied)).toBe(`protocol-mismatch:${SYNC_PROTOCOL_VERSION}`);
    expect(rig.logs.at(-1)).toMatchObject({ cause: "protocol-mismatch" });
  });

  it("cannot create, widen or restore credentials by synchronizing credential-shaped document content", async () => {
    const rig = await startServer();
    const laptop = issue(rig.registry, "laptop");
    const phone = issue(rig.registry, "phone");
    rig.registry.revoke(laptop.record.id);
    const revokedRecord = rig.registry.get(laptop.record.id);
    const phoneRecord = rig.registry.get(phone.record.id);
    const inventedId = randomUUID();
    const room = testRoom();
    const client = connect({ port: rig.port, room, token: await credentialToken(phone) });
    await waitFor("the authorized client to sync", client.synced);
    client.doc.transact(() => {
      const attemptedRegistry = client.doc.getMap("hub_credentials");
      attemptedRegistry.set(laptop.record.id, { ...revokedRecord, revokedAt: null });
      attemptedRegistry.set(phone.record.id, { ...phoneRecord, workspaces: [WORKSPACE, OTHER_WORKSPACE] });
      attemptedRegistry.set(inventedId, { ...phoneRecord, id: inventedId });
    });
    await waitUntil("the forged registry content to be synchronized and acknowledged", () =>
      rig.hocuspocus.documents.get(room)?.getMap("hub_credentials").size === 3 && !client.provider.hasUnsyncedChanges);
    expect(rig.registry.get(laptop.record.id)).toEqual(revokedRecord);
    expect(rig.registry.get(phone.record.id)).toEqual(phoneRecord);
    expect(rig.registry.get(inventedId)).toBeNull();
    const restored = connect({ port: rig.port, room: testRoom(), token: await credentialToken(laptop) });
    const widened = connect({ port: rig.port, room: testRoom(OTHER_WORKSPACE), token: await credentialToken(phone, OTHER_WORKSPACE) });
    expect(await waitFor("the attempted restoration to remain refused", restored.denied)).toBe("invalid-token");
    expect(await waitFor("the attempted widening to remain refused", widened.denied)).toBe("invalid-token");
  });

  it("revokes every room under one credential while another device on the same socket keeps writing", async () => {
    const rig = await startServer();
    const laptop = issue(rig.registry, "laptop", [WORKSPACE, OTHER_WORKSPACE]);
    const phone = issue(rig.registry, "phone");
    const socket = sharedSocket(rig.port);
    const rooms = [testRoom(), testRoom(OTHER_WORKSPACE), testRoom()];
    const first = connect({ port: rig.port, room: rooms[0]!, token: await credentialToken(laptop), websocketProvider: socket });
    const second = connect({ port: rig.port, room: rooms[1]!, token: await credentialToken(laptop, OTHER_WORKSPACE), websocketProvider: socket });
    const otherDevice = connect({ port: rig.port, room: rooms[2]!, token: await credentialToken(phone), websocketProvider: socket });
    await socket.connect();
    await waitFor("the multiplexed rooms to sync", Promise.all([first.synced, second.synced, otherDevice.synced]));
    const closedRooms = new Set<string>();
    for (const room of rooms.slice(0, 2)) {
      const connection = rig.hocuspocus.documents.get(room!)!.getConnections()[0]!;
      connection.onClose(() => { closedRooms.add(room!); });
    }

    expect(rig.registry.revoke(laptop.record.id)).toBe(true);
    expect([...closedRooms]).toEqual(rooms.slice(0, 2));
    expect(rig.hocuspocus.documents.get(rooms[0]!)?.getConnectionsCount()).toBe(0);
    expect(rig.hocuspocus.documents.get(rooms[1]!)?.getConnectionsCount()).toBe(0);
    expect(rig.hocuspocus.documents.get(rooms[2]!)?.getConnectionsCount()).toBe(1);
    expect(rig.registry.get(phone.record.id)?.revokedAt).toBeNull();
    otherDevice.text.insert(0, "still authorized");
    await waitUntil("the unaffected device's write to land and be acknowledged", () =>
      rig.hocuspocus.documents.get(rooms[2]!)?.getText(TEXT_KEY).toString() === "still authorized" && !otherDevice.provider.hasUnsyncedChanges);
    const refused = connect({ port: rig.port, room: testRoom(), token: await credentialToken(laptop) });
    expect(await waitFor("new admission after revoke to fail", refused.denied)).toBe("invalid-token");
  });

  it.each([
    ["a live update", messageYjsUpdate, false],
    ["a reconnect diff", messageYjsSyncStep2, false],
    ["a detached connection's live update", messageYjsUpdate, true],
    ["a detached connection's reconnect diff", messageYjsSyncStep2, true],
  ] as const)("fences %s already past the admission check and the burst queued behind it", async (_label, type, detachBeforeRevoke) => {
    const held = gate();
    const entered = gate();
    const completed = gate();
    let armed = false;
    let victimId = "";
    let queued!: Promise<void>;
    let victimConnection!: Connection<CredentialContext>;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const rig = await startServer({
      beforeSync: async ({ context, type: receivedType, connection }) => {
        if (!armed || context.credentialId !== victimId || receivedType !== type) return;
        armed = false;
        victimConnection = connection;
        // The admission extension has already accepted this frame. A later
        // async hook makes the check-to-apply gap observable over real sockets.
        queued = frameBarrier(connection, 12);
        entered.open();
        await held.opened;
      },
      afterHandleMessage: async ({ context }) => {
        if (context.credentialId === victimId && !context.authorization.active) completed.open();
      },
    });
    const laptop = issue(rig.registry, "laptop");
    const phone = issue(rig.registry, "phone");
    victimId = laptop.record.id;
    const room = testRoom();
    const observer = connect({ port: rig.port, room, token: await credentialToken(phone) });
    await waitFor("the unaffected observer to sync", observer.synced);
    observer.text.insert(0, "preserved content");
    await waitUntil("the preexisting document content to land", () =>
      rig.hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString() === "preserved content" && !observer.provider.hasUnsyncedChanges);
    let sender: ReturnType<typeof connect>;
    if (type === messageYjsUpdate) {
      sender = connect({ port: rig.port, room, token: await credentialToken(laptop) });
      await waitFor("the live sender to sync", sender.synced);
      armed = true;
      sender.text.insert(0, "held update");
    } else {
      const offline = new Y.Doc();
      offline.getText(TEXT_KEY).insert(0, "held reconnect diff");
      armed = true;
      sender = connect({ port: rig.port, room, token: await credentialToken(laptop), document: offline });
    }
    try {
      await waitFor("the already authorized sync frame to pause", entered.opened);
      for (let index = 0; index < 12; index += 1) {
        sender.text.insert(sender.text.length, ` queued-${index}`);
      }
      await waitFor("the full burst to queue behind the paused frame", queued);
      const serverDocument = rig.hocuspocus.documents.get(room)!;
      expect(serverDocument.getText(TEXT_KEY).toString()).toBe("preserved content");

      if (detachBeforeRevoke) {
        // Timeout and client departure remove a connection from the document
        // without cancelling this loop. Revocation must still fence its frame.
        victimConnection.close({ code: 1000, reason: "unrelated closure" });
        expect(serverDocument.getConnections().map((connection) => connection.context.credentialId)).toEqual([phone.record.id]);
      }
      rig.registry.revoke(laptop.record.id);
      expect(serverDocument.getConnections().map((connection) => connection.context.credentialId)).toEqual([phone.record.id]);
      const appliedAfterRevoke: Uint8Array[] = [];
      const onUpdate = (update: Uint8Array) => appliedAfterRevoke.push(update);
      serverDocument.on("update", onUpdate);
      held.open();
      await waitFor("the held frame to finish after revocation", completed.opened);
      await waitUntil("the queued frame to be rejected by its revoked admission", () =>
        rig.logs.some((record) => record.cause === "revoked-credential"));
      expect(serverDocument.getText(TEXT_KEY).toString()).toBe("preserved content");
      expect(observer.text.toString()).toBe("preserved content");
      expect(appliedAfterRevoke).toEqual([]);
      serverDocument.off("update", onUpdate);
      observer.text.insert(observer.text.length, " + other device still writes");
      await waitUntil("the other device's acknowledged update after the burst", () =>
        serverDocument.getText(TEXT_KEY).toString() === "preserved content + other device still writes" && !observer.provider.hasUnsyncedChanges);
    } finally {
      held.open();
      logged.mockRestore();
    }
  });

  it.each(["authentication", "document loading"] as const)("refuses queued writes when revoked during %s", async (phase) => {
    const held = gate();
    const entered = gate();
    const room = testRoom();
    const hooks: Partial<ServerConfiguration<CredentialContext>> = phase === "authentication"
      ? { onAuthenticate: async ({ documentName }) => {
          if (documentName === room) { entered.open(); await held.opened; }
        } }
      : { onLoadDocument: async ({ documentName }) => {
          if (documentName === room) { entered.open(); await held.opened; }
        } };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const rig = await startServer(hooks);
    const laptop = issue(rig.registry, "laptop");
    const phone = issue(rig.registry, "phone");
    const clientConnection = nextClientConnection(rig.hocuspocus);
    const offline = new Y.Doc();
    offline.getText(TEXT_KEY).insert(0, "offline write must not land");
    const sender = connect({ port: rig.port, room, token: await credentialToken(laptop), document: offline });
    try {
      await waitFor(`the credential to pause during ${phase}`, entered.opened);
      const queueArrival = frameBarrier(await waitFor("the authenticating socket", clientConnection), 12);
      for (let index = 0; index < 12; index += 1) sender.text.insert(sender.text.length, ` burst-${index}`);
      await waitFor("the burst to arrive during authentication", queueArrival);
      rig.registry.revoke(laptop.record.id);
      held.open();
      await waitFor("the suspended admission to be refused", sender.denied);
      const observer = connect({ port: rig.port, room, token: await credentialToken(phone) });
      await waitFor("the unaffected device to open the refused room", observer.synced);
      expect(observer.text.toString()).toBe("");
      expect(rig.hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString()).toBe("");
      expect(rig.hocuspocus.documents.get(room)?.getConnections().map((connection) => connection.context.credentialId)).toEqual([phone.record.id]);
    } finally {
      held.open();
      logged.mockRestore();
    }
  });

  it("closes selected admitted workspace rooms without revoking the credential or its other rooms", async () => {
    const rig = await startServer();
    const laptop = issue(rig.registry, "laptop", [WORKSPACE, OTHER_WORKSPACE]);
    const firstRoom = testRoom();
    const secondRoom = testRoom(OTHER_WORKSPACE);
    const first = connect({ port: rig.port, room: firstRoom, token: await credentialToken(laptop) });
    const second = connect({ port: rig.port, room: secondRoom, token: await credentialToken(laptop, OTHER_WORKSPACE) });
    await waitFor("both rooms to sync", Promise.all([first.synced, second.synced]));
    rig.admission.closeWhere((context) => context.workspace === WORKSPACE);
    expect(rig.hocuspocus.documents.get(firstRoom)?.getConnectionsCount()).toBe(0);
    expect(rig.hocuspocus.documents.get(secondRoom)?.getConnectionsCount()).toBe(1);
    expect(rig.registry.get(laptop.record.id)?.revokedAt).toBeNull();
    second.text.insert(0, "still in the other workspace");
    await waitUntil("the still authorized workspace to accept an update", () =>
      rig.hocuspocus.documents.get(secondRoom)?.getText(TEXT_KEY).toString() === "still in the other workspace");
  });
});
