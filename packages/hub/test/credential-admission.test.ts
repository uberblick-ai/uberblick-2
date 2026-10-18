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
  MessageType,
  type onCloseParameters,
  type onMessageParameters,
} from "@hocuspocus/provider";
import { Server, type Connection, type Hocuspocus, type ServerConfiguration } from "@hocuspocus/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { getWorkspaceName, setWorkspaceName, settingsRoom } from "@uberblick/schema";
import {
  CredentialAdmission,
  type CredentialContext,
} from "../src/credential-admission.js";
import {
  CredentialRegistry,
} from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubAdminRegistry } from "../src/hub-admins.js";
import { HubDatabase } from "../src/persistence.js";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/schema/protocol";
import {
  importCredentialKey,
  importRootSecret,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintRequestProof,
  mintToken,
} from "@uberblick/schema/token";
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
    join(tmpdir(), `credential-admission-${process.env.UB_AGENTS_RUN ?? "test"}-`),
  );
  directories.push(directory);
  const database = new HubDatabase(join(directory, "hub.sqlite"), (error) => {
    throw error;
  });
  databases.push(database);
  database.open();
  const registry = new CredentialRegistry(database);
  const memberships = new MembershipRegistry(database);
  const hubAdmins = new HubAdminRegistry(database);
  hubAdmins.grant("hub-admin");
  for (const workspaceId of [WORKSPACE, OTHER_WORKSPACE]) {
    memberships.grant({ workspaceId, principalId: "admin", role: "admin" });
    memberships.grant({ workspaceId, principalId: "person", role: "member" });
    memberships.grant({ workspaceId, principalId: "observer", role: "member" });
  }
  const logs: HubLogRecord[] = [];
  const admission = new CredentialAdmission(registry, memberships, {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    log: (record) => logs.push(record),
  }, hubAdmins);
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
    memberships,
    hubAdmins,
    admission,
    hocuspocus,
    logs,
  };
}

function issue(registry: CredentialRegistry, deviceId: string, workspaces = [WORKSPACE], principalId = "person") {
  return registry.issue({ principalId, deviceId, workspaces });
}

type AccessEnd = "revocation" | "membership removal" | "replacement" | "suspension";

async function endAccess(rig: Awaited<ReturnType<typeof startServer>>, kind: AccessEnd, credential: IssuedCredential) {
  if (kind === "revocation") {
    rig.registry.revoke(credential.record.id);
  } else if (kind === "membership removal") {
    rig.memberships.remove({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: credential.record.principalId });
  } else if (kind === "suspension") {
    rig.hubAdmins.setWorkspaceStatus("hub-admin", WORKSPACE, "suspended");
  } else {
    const proof = await mintRequestProof(await importCredentialKey(credential.keyBytes), {
      kid: credential.record.id,
      operation: "renew-credential",
      lifetimeSeconds: 60,
    });
    expect(await rig.registry.renew(proof, rig.memberships)).toMatchObject({ status: "renewed" });
  }
}

function accessEndCause(kind: AccessEnd) {
  if (kind === "membership removal") return "missing-membership";
  if (kind === "suspension") return "workspace-suspended";
  return kind === "revocation" ? "revoked-credential" : "replaced-credential";
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
  const authenticated = vi.fn();
  provider.on("authenticated", authenticated);
  const synced = new Promise<void>((resolve) => provider.on("synced", resolve));
  const denied = new Promise<string>((resolve) => {
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => resolve(reason));
  });
  const closed = new Promise<void>((resolve) => provider.on("close", resolve));
  if (options.websocketProvider !== undefined) provider.attach();
  return { doc, provider, text: doc.getText(TEXT_KEY), authenticated, synced, denied, closed };
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
  it("requires both current membership and the credential's issued workspace limit, regardless of identity claims", async () => {
    const rig = await startServer();
    const nonMember = issue(rig.registry, "outsider-device", [WORKSPACE], "outsider");
    const refused = connect({ port: rig.port, room: testRoom(), token: await credentialToken(nonMember, WORKSPACE, { sub: "admin" }) });
    expect(await waitFor("missing membership to refuse admission", refused.denied)).toBe("device-credential-refused");
    expect(refused.authenticated).not.toHaveBeenCalled();
    expect(rig.logs.at(-1)).toMatchObject({ cause: "missing-membership" });
    rig.memberships.grant({ workspaceId: WORKSPACE, principalId: "outsider", role: "member" });
    const admitted = connect({ port: rig.port, room: testRoom(), token: await credentialToken(nonMember) });
    await waitFor("a new hub grant to admit the issued workspace", admitted.synced);
    rig.memberships.grant({ workspaceId: OTHER_WORKSPACE, principalId: "outsider", role: "admin" });
    const outsideLimit = connect({ port: rig.port, room: testRoom(OTHER_WORKSPACE), token: await credentialToken(nonMember, OTHER_WORKSPACE) });
    expect(await waitFor("membership alone to remain insufficient", outsideLimit.denied)).toBe("device-credential-refused");
    expect(rig.logs.at(-1)).toMatchObject({ cause: "workspace-not-authorized" });
  });

  it("gives admins and members equal document access while demotion immediately ends management authority from every device", async () => {
    const rig = await startServer();
    rig.memberships.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "person", role: "admin" });
    const room = testRoom();
    const laptop = issue(rig.registry, "laptop");
    const phone = issue(rig.registry, "phone");
    const peer = issue(rig.registry, "peer", [WORKSPACE], "observer");
    const clients = await Promise.all([laptop, phone, peer].map(async (credential) =>
      connect({ port: rig.port, room, token: await credentialToken(credential) })));
    await waitFor("both roles and all devices to sync", Promise.all(clients.map((client) => client.synced)));
    rig.memberships.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "person", principalId: "person", role: "member" });
    expect(rig.hocuspocus.documents.get(room)?.getConnectionsCount()).toBe(3);
    for (const connection of rig.hocuspocus.documents.get(room)!.getConnections()) {
      if (connection.context.principalId === "person") {
        expect(() => rig.memberships.requireAdmin(WORKSPACE, connection.context.principalId)).toThrow();
        expect(() => rig.memberships.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: connection.context.principalId, principalId: "person", role: "admin" })).toThrow();
      }
    }
    for (const [index, client] of clients.entries()) {
      client.text.insert(client.text.length, `device-${index} `);
      await waitUntil("the demoted admin and member to keep writing", () =>
        !client.provider.hasUnsyncedChanges && clients.every((other) => other.text.toString() === client.text.toString()));
    }
    expect(rig.memberships.ownRole(WORKSPACE, "person")).toBe("member");
  });

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
      authorization: { active: true, readOnly: false },
    });
    expect(contexts.get(rooms[1]!)).toEqual({ ...contexts.get(rooms[0]!), workspace: OTHER_WORKSPACE });
    expect(contexts.get(rooms[2]!)).toEqual({
      credentialId: phone.record.id,
      principalId: "person",
      deviceId: "phone",
      workspaces: [WORKSPACE],
      workspace: WORKSPACE,
      authorization: { active: true, readOnly: false },
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
      expect(await waitFor("a generic credential refusal", client.denied)).toBe("device-credential-refused");
      expect(rig.logs.at(-1)).toMatchObject({ cause: vector.cause });
    }
    const logText = JSON.stringify(rig.logs);
    expect(logText).not.toContain(TEST_SECRET);
    expect(logText).not.toContain(Buffer.from(laptop.keyBytes).toString("base64url"));
    expect(logText).not.toContain(Buffer.from(phone.keyBytes).toString("base64url"));
    expect(logText).not.toContain("client-asserted-person-and-device");
  });

  // Keep the incompatible table writer's protocol fixed at 2 so an independent
  // version bump cannot erase this compatibility check.
  it.each([2, SYNC_PROTOCOL_VERSION + 1])("refuses protocol %s before credential room writes", async (protocolVersion) => {
    const rig = await startServer();
    const laptop = issue(rig.registry, "laptop");
    const room = testRoom();
    const document = new Y.Doc();
    document.getText(TEXT_KEY).insert(0, "queued before admission");
    const client = connect({
      port: rig.port,
      room,
      token: await credentialToken(laptop),
      protocolVersion,
      document,
    });
    expect(await waitFor("the protocol refusal", client.denied)).toBe(`protocol-mismatch:${SYNC_PROTOCOL_VERSION}`);
    expect(client.authenticated).not.toHaveBeenCalled();
    expect(client.provider.synced).toBe(false);
    expect(client.provider.hasUnsyncedChanges).toBe(true);
    expect(rig.hocuspocus.documents.has(room)).toBe(false);
    expect(rig.logs.at(-1)).toMatchObject({ cause: "protocol-mismatch" });
  });

  it("refuses a renewal proof as room authority", async () => {
    const rig = await startServer();
    const laptop = issue(rig.registry, "laptop");
    const proof = await mintRequestProof(await importCredentialKey(laptop.keyBytes), {
      kid: laptop.record.id,
      operation: "renew-credential",
      lifetimeSeconds: 60,
    });
    const client = connect({ port: rig.port, room: testRoom(), token: proof });
    expect(await waitFor("the operation-bound proof to open no room", client.denied)).toBe("device-credential-refused");
    expect(client.authenticated).not.toHaveBeenCalled();
    expect(rig.registry.get(laptop.record.id)).toEqual(laptop.record);
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
    expect(await waitFor("the attempted restoration to remain refused", restored.denied)).toBe("device-credential-refused");
    expect(await waitFor("the attempted widening to remain refused", widened.denied)).toBe("device-credential-refused");
  });

  it("cannot create, promote or restore memberships by syncing membership-shaped content or claiming an admin identity", async () => {
    const rig = await startServer();
    rig.memberships.remove({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "person" });
    const removed = issue(rig.registry, "removed");
    const outsider = issue(rig.registry, "outsider", [WORKSPACE], "outsider");
    const peer = issue(rig.registry, "peer", [WORKSPACE], "observer");
    const room = testRoom();
    const client = connect({ port: rig.port, room, token: await credentialToken(peer, WORKSPACE, { sub: "admin" }) });
    await waitFor("the member to sync", client.synced);
    client.doc.transact(() => {
      const attemptedMemberships = client.doc.getMap("hub_memberships");
      for (const principalId of ["person", "observer", "outsider"]) {
        attemptedMemberships.set(principalId, { workspaceId: WORKSPACE, principalId, role: "admin" });
      }
    });
    await waitUntil("forged membership content to sync and be acknowledged", () =>
      rig.hocuspocus.documents.get(room)?.getMap("hub_memberships").size === 3 && !client.provider.hasUnsyncedChanges);
    expect(rig.memberships.roleFor(WORKSPACE, "person")).toBeNull();
    expect(rig.memberships.roleFor(WORKSPACE, "outsider")).toBeNull();
    expect(rig.memberships.ownRole(WORKSPACE, "observer")).toBe("member");
    expect(() => rig.memberships.requireAdmin(WORKSPACE, "observer")).toThrow();
    for (const credential of [removed, outsider]) {
      const refused = connect({ port: rig.port, room: testRoom(), token: await credentialToken(credential, WORKSPACE, { sub: "admin" }) });
      expect(await waitFor("forged grants to remain refused", refused.denied)).toBe("device-credential-refused");
      expect(rig.logs.at(-1)).toMatchObject({ cause: "missing-membership" });
    }
  });

  it.each(["revocation", "membership removal", "suspension"] as const)("reads authority after verification's final await so %s during verification wins", async (accessEnd) => {
    const rig = await startServer();
    const held = gate();
    const verified = gate();
    const verify = rig.registry.verify.bind(rig.registry);
    const spy = vi.spyOn(rig.registry, "verify").mockImplementationOnce(async (token) => {
      const result = await verify(token);
      verified.open();
      await held.opened;
      return result;
    });
    const laptop = issue(rig.registry, "laptop");
    const room = testRoom();
    const offline = new Y.Doc();
    offline.getText(TEXT_KEY).insert(0, "authenticating write must not land");
    const sender = connect({ port: rig.port, room, token: await credentialToken(laptop), document: offline });
    try {
      await waitFor("signature verification to finish before admission resumes", verified.opened);
      await endAccess(rig, accessEnd, laptop);
      held.open();
      expect(await waitFor("the authenticating device to be refused", sender.denied)).toBe("device-credential-refused");
      expect(sender.authenticated).not.toHaveBeenCalled();
      expect(rig.logs.at(-1)).toMatchObject({ cause: accessEndCause(accessEnd) });
      if (accessEnd === "suspension") rig.hubAdmins.setWorkspaceStatus("hub-admin", WORKSPACE, "active");
      const peer = issue(rig.registry, "peer", [WORKSPACE], "observer");
      const observer = connect({ port: rig.port, room, token: await credentialToken(peer) });
      await waitFor("the unaffected member to open the room", observer.synced);
      expect(observer.text.toString()).toBe("");
      if (accessEnd === "membership removal") expect(rig.registry.get(laptop.record.id)).toEqual(laptop.record);
    } finally {
      held.open();
      spy.mockRestore();
    }
  });

  it("replacement closes every room under one credential while another device on the same socket keeps writing", async () => {
    const accessEnd = "replacement";
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

    await endAccess(rig, accessEnd, laptop);
    expect(closedRooms).toEqual(new Set(rooms.slice(0, 2)));
    expect(rig.hocuspocus.documents.get(rooms[0]!)?.getConnectionsCount()).toBe(0);
    expect(rig.hocuspocus.documents.get(rooms[1]!)?.getConnectionsCount()).toBe(0);
    expect(rig.hocuspocus.documents.get(rooms[2]!)?.getConnectionsCount()).toBe(1);
    expect(rig.registry.get(phone.record.id)).toEqual(phone.record);
    otherDevice.text.insert(0, "still authorized");
    await waitUntil("the unaffected device's write to land and be acknowledged", () =>
      rig.hocuspocus.documents.get(rooms[2]!)?.getText(TEXT_KEY).toString() === "still authorized" && !otherDevice.provider.hasUnsyncedChanges);
    const refused = connect({ port: rig.port, room: testRoom(), token: await credentialToken(laptop) });
    expect(await waitFor("new admission after access ends to fail", refused.denied)).toBe("device-credential-refused");
    expect(rig.logs.at(-1)).toMatchObject({ cause: accessEndCause(accessEnd) });
  });

  // Held apply hooks expose the gap after authorization through real sockets;
  // both update forms must respect the shared apply fence after access ends.
  it.each([messageYjsUpdate, messageYjsSyncStep2])("demotion fences settings frame type %s already past authorization and its queued updates without closing the room", async (type) => {
    const held = gate();
    const entered = gate();
    let armed = false;
    let victimId = "";
    let queued!: Promise<void>;
    let victimConnection!: Connection<CredentialContext>;
    const rig = await startServer({
      beforeSync: async ({ context, type: receivedType, connection }) => {
        if (!armed || context.credentialId !== victimId || receivedType !== type) return;
        armed = false;
        victimConnection = connection;
        queued = frameBarrier(connection, 4);
        entered.open();
        await held.opened;
      },
    });
    rig.memberships.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "person", role: "admin" });
    const laptop = issue(rig.registry, "laptop");
    const peer = issue(rig.registry, "peer", [WORKSPACE], "admin");
    victimId = laptop.record.id;
    const room = settingsRoom(WORKSPACE);
    const observer = connect({ port: rig.port, room, token: await credentialToken(peer) });
    await waitFor("the settings admin to sync", observer.synced);
    setWorkspaceName(observer.doc, "Preserved settings");
    await waitUntil("the existing settings to settle", () => !observer.provider.hasUnsyncedChanges);
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(observer.doc));
    if (type === messageYjsSyncStep2) setWorkspaceName(offline, "Held reconnect rename");
    armed = type === messageYjsSyncStep2;
    const sender = connect({ port: rig.port, room, token: await credentialToken(laptop), document: offline });
    let refusals = 0;
    sender.provider.on("message", ({ message }: onMessageParameters) => {
      message.readVarString();
      if (message.readVarUint() === MessageType.SyncStatus && message.readVarUint() === 0) refusals += 1;
    });
    if (type === messageYjsUpdate) {
      await waitFor("the settings sender to sync", sender.synced);
      armed = true;
      setWorkspaceName(sender.doc, "Held live rename");
    }
    try {
      await waitFor("the authorized settings frame to pause", entered.opened);
      for (let index = 0; index < 4; index += 1) setWorkspaceName(sender.doc, `Queued rename ${index}`);
      await waitFor("settings updates to queue behind the paused frame", queued);
      rig.memberships.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "person", role: "member" });
      expect(victimConnection.readOnly).toBe(true);
      held.open();
      await waitFor("the held and queued settings frames to finish", victimConnection.waitForPendingMessages());
      await waitUntil("settings writes to receive room-local refusals", () => refusals >= 1);
      expect(getWorkspaceName(rig.hocuspocus.documents.get(room)!)).toBe("Preserved settings");
      expect(getWorkspaceName(observer.doc)).toBe("Preserved settings");
      expect(sender.provider.isAuthenticated).toBe(true);
      expect(rig.hocuspocus.documents.get(room)?.getConnectionsCount()).toBe(2);
    } finally {
      held.open();
    }
  });

  describe("ended access fences", () => {
    it.each([
      ["revocation", "a live update", messageYjsUpdate, false],
      ["revocation", "a reconnect diff", messageYjsSyncStep2, false],
      ["revocation", "a detached connection's live update", messageYjsUpdate, true],
      ["revocation", "a detached connection's reconnect diff", messageYjsSyncStep2, true],
      ["membership removal", "a live update", messageYjsUpdate, false],
      ["suspension", "a live update", messageYjsUpdate, false],
      ["suspension", "a reconnect diff", messageYjsSyncStep2, false],
      ["suspension", "a detached connection's live update", messageYjsUpdate, true],
      ["suspension", "a detached connection's reconnect diff", messageYjsSyncStep2, true],
    ] as const)("%s fences %s already past the admission check and the burst queued behind it", async (accessEnd, _label, type, detachBeforeAccessEnd) => {
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
      const phone = issue(rig.registry, "phone", [WORKSPACE], "observer");
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

        if (detachBeforeAccessEnd) {
          // Timeout and client departure remove a connection from the document
          // without cancelling this loop. Ended access must still fence its frame.
          victimConnection.close({ code: 1000, reason: "unrelated closure" });
          expect(serverDocument.getConnections().map((connection) => connection.context.credentialId)).toEqual([phone.record.id]);
        }
        await endAccess(rig, accessEnd, laptop);
        expect(serverDocument.getConnections().map((connection) => connection.context.credentialId))
          .toEqual(accessEnd === "suspension" ? [] : [phone.record.id]);
        const appliedAfterAccessEnd: Uint8Array[] = [];
        const onUpdate = (update: Uint8Array) => appliedAfterAccessEnd.push(update);
        serverDocument.on("update", onUpdate);
        held.open();
        await waitFor("the held frame to finish after access ends", completed.opened);
        await waitUntil("the queued frame to be rejected by current authority", () =>
          rig.logs.some((record) => record.cause === accessEndCause(accessEnd)));
        expect(serverDocument.getText(TEXT_KEY).toString()).toBe("preserved content");
        expect(observer.text.toString()).toBe("preserved content");
        expect(appliedAfterAccessEnd).toEqual([]);
        serverDocument.off("update", onUpdate);
        let activeObserver = observer;
        if (accessEnd === "suspension") {
          rig.hubAdmins.setWorkspaceStatus("hub-admin", WORKSPACE, "active");
          activeObserver = connect({ port: rig.port, room, token: await credentialToken(phone) });
          await waitFor("the restored workspace to admit the same device", activeObserver.synced);
        }
        activeObserver.text.insert(activeObserver.text.length, " + other device still writes");
        await waitUntil("the other device's acknowledged update after the burst", () =>
          rig.hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString() === "preserved content + other device still writes" && !activeObserver.provider.hasUnsyncedChanges);
      } finally {
        held.open();
        logged.mockRestore();
      }
    });

    it.each([
      ["revocation", "authentication"], ["revocation", "document loading"],
      ["membership removal", "authentication"], ["membership removal", "document loading"],
      ["suspension", "authentication"], ["suspension", "document loading"],
    ] as const)("refuses queued writes when %s happens during %s", async (accessEnd, phase) => {
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
      const phone = issue(rig.registry, "phone", [WORKSPACE], "observer");
      const clientConnection = nextClientConnection(rig.hocuspocus);
      const offline = new Y.Doc();
      offline.getText(TEXT_KEY).insert(0, "offline write must not land");
      const sender = connect({ port: rig.port, room, token: await credentialToken(laptop), document: offline });
      const events: string[] = [];
      sender.provider.on("authenticated", () => events.push("authenticated"));
      sender.provider.on("close", ({ event }: onCloseParameters) => {
        events.push(`close:${event.reason}`);
      });
      sender.provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
        events.push(`authenticationFailed:${reason}`);
      });
      try {
        await waitFor(`the credential to pause during ${phase}`, entered.opened);
        const queueArrival = frameBarrier(await waitFor("the authenticating socket", clientConnection), 12);
        for (let index = 0; index < 12; index += 1) sender.text.insert(sender.text.length, ` burst-${index}`);
        await waitFor("the burst to arrive during authentication", queueArrival);
        await endAccess(rig, accessEnd, laptop);
        held.open();
        expect(await waitFor("the pending admission to be refused", sender.denied)).toBe("device-credential-refused");
        expect(events).toEqual([
          "authenticated",
          "close:device-credential-refused",
          "authenticationFailed:device-credential-refused",
        ]);
        if (accessEnd === "suspension") rig.hubAdmins.setWorkspaceStatus("hub-admin", WORKSPACE, "active");
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
  });

  it("suspends every account's rooms while preserving the same devices' other workspace, local edits and sign-ins", async () => {
    const rig = await startServer();
    const laptop = issue(rig.registry, "laptop", [WORKSPACE, OTHER_WORKSPACE]);
    const phone = issue(rig.registry, "phone");
    const peer = issue(rig.registry, "peer", [WORKSPACE], "observer");
    const socket = sharedSocket(rig.port);
    const rooms = [testRoom(), testRoom(OTHER_WORKSPACE), testRoom()];
    const first = connect({ port: rig.port, room: rooms[0]!, token: await credentialToken(laptop), websocketProvider: socket });
    const other = connect({ port: rig.port, room: rooms[1]!, token: await credentialToken(laptop, OTHER_WORKSPACE), websocketProvider: socket });
    const second = connect({ port: rig.port, room: rooms[2]!, token: await credentialToken(phone), websocketProvider: socket });
    const observer = connect({ port: rig.port, room: rooms[0]!, token: await credentialToken(peer) });
    await socket.connect();
    await waitFor("all devices and rooms to sync", Promise.all([first.synced, other.synced, second.synced, observer.synced]));
    first.text.insert(0, "retained content");
    await waitUntil("the original document to converge", () => observer.text.toString() === "retained content" && !first.provider.hasUnsyncedChanges);
    other.doc.getMap("hub_workspace_suspensions").set(WORKSPACE, { suspended: true });
    await waitUntil("suspension-shaped content to be acknowledged without governing the hub", () => !other.provider.hasUnsyncedChanges);
    expect(rig.hubAdmins.isSuspended(WORKSPACE)).toBe(false);
    const memberships = rig.database.connection.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all();
    const closedConnections = rooms.filter(room => room !== rooms[1]).flatMap(room => rig.hocuspocus.documents.get(room!)!.getConnections());
    rig.hubAdmins.setWorkspaceStatus("hub-admin", WORKSPACE, "suspended");
    expect(closedConnections.every(connection => !connection.context.authorization.active && connection.readOnly)).toBe(true);
    expect(rig.hocuspocus.documents.get(rooms[0]!)!.getConnectionsCount()).toBe(0);
    expect(rig.hocuspocus.documents.get(rooms[2]!)!.getConnectionsCount()).toBe(0);
    expect(rig.hocuspocus.documents.get(rooms[1]!)!.getConnectionsCount()).toBe(1);
    for (const credential of [laptop, phone, peer]) expect(rig.registry.get(credential.record.id)).toEqual(credential.record);
    expect(rig.database.connection.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all()).toEqual(memberships);
    first.text.insert(first.text.length, " + offline edit");
    expect(first.text.toString()).toBe("retained content + offline edit");
    expect(rig.hocuspocus.documents.get(rooms[0]!)!.getText(TEXT_KEY).toString()).toBe("retained content");
    other.doc.getMap("hub_workspace_suspensions").set(WORKSPACE, { suspended: false });
    other.text.insert(0, "other workspace stays writable");
    await waitUntil("the same device's other workspace to acknowledge updates", () => !other.provider.hasUnsyncedChanges);
    expect(rig.hubAdmins.isSuspended(WORKSPACE)).toBe(true);
    for (const credential of [laptop, phone, peer]) {
      const refused = connect({ port: rig.port, room: rooms[0]!, token: await credentialToken(credential) });
      expect(await waitFor("every member to be refused while suspended", refused.denied)).toBe("device-credential-refused");
    }
    rig.hubAdmins.setWorkspaceStatus("hub-admin", WORKSPACE, "active");
    const restored = connect({ port: rig.port, room: rooms[0]!, token: await credentialToken(laptop), document: first.doc });
    await waitFor("the same device to resume without signing in", restored.synced);
    await waitUntil("the local edit to arrive after restore", () =>
      rig.hocuspocus.documents.get(rooms[0]!)!.getText(TEXT_KEY).toString() === "retained content + offline edit" && !restored.provider.hasUnsyncedChanges);
    expect(closedConnections.every(connection => !connection.context.authorization.active)).toBe(true);
  });

  it("removes every device's workspace rooms while preserving credentials, peers, other memberships and content", async () => {
    const rig = await startServer();
    const laptop = issue(rig.registry, "laptop", [WORKSPACE, OTHER_WORKSPACE]);
    const phone = issue(rig.registry, "phone");
    const peer = issue(rig.registry, "peer", [WORKSPACE], "observer");
    const firstRoom = testRoom();
    const secondRoom = testRoom(OTHER_WORKSPACE);
    const thirdRoom = testRoom();
    const socket = sharedSocket(rig.port);
    const first = connect({ port: rig.port, room: firstRoom, token: await credentialToken(laptop), websocketProvider: socket });
    const second = connect({ port: rig.port, room: secondRoom, token: await credentialToken(laptop, OTHER_WORKSPACE), websocketProvider: socket });
    const third = connect({ port: rig.port, room: thirdRoom, token: await credentialToken(phone), websocketProvider: socket });
    const observer = connect({ port: rig.port, room: firstRoom, token: await credentialToken(peer) });
    await socket.connect();
    await waitFor("all rooms to sync", Promise.all([first.synced, second.synced, third.synced, observer.synced]));
    first.text.insert(0, "retained document");
    await waitUntil("existing content to converge", () => observer.text.toString() === "retained document" && !first.provider.hasUnsyncedChanges);
    const removedConnections = [
      rig.hocuspocus.documents.get(firstRoom)!.getConnections().find((connection) => connection.context.credentialId === laptop.record.id)!,
      rig.hocuspocus.documents.get(thirdRoom)!.getConnections()[0]!,
    ];
    const closed: string[] = [];
    for (const connection of removedConnections) connection.onClose(() => { closed.push(connection.context.deviceId); });
    expect(rig.memberships.remove({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "person" })).toBe(true);
    expect(closed.sort()).toEqual(["laptop", "phone"]);
    expect(removedConnections.every((connection) => !connection.context.authorization.active && connection.readOnly)).toBe(true);
    expect(rig.hocuspocus.documents.get(firstRoom)?.getConnections().map((connection) => connection.context.principalId)).toEqual(["observer"]);
    expect(rig.hocuspocus.documents.get(secondRoom)?.getConnectionsCount()).toBe(1);
    expect(rig.hocuspocus.documents.get(thirdRoom)?.getConnectionsCount()).toBe(0);
    expect(rig.memberships.roleFor(OTHER_WORKSPACE, "person")).toBe("member");
    for (const credential of [laptop, phone, peer]) expect(rig.registry.get(credential.record.id)).toEqual(credential.record);
    expect(() => rig.memberships.requireAdmin(WORKSPACE, "person")).toThrow();
    second.text.insert(0, "still in the other workspace");
    await waitUntil("the still authorized workspace to accept an update", () =>
      rig.hocuspocus.documents.get(secondRoom)?.getText(TEXT_KEY).toString() === "still in the other workspace");
    observer.text.insert(observer.text.length, " + peer writes");
    await waitUntil("the remaining member to keep writing", () =>
      rig.hocuspocus.documents.get(firstRoom)?.getText(TEXT_KEY).toString() === "retained document + peer writes" && !observer.provider.hasUnsyncedChanges);
    for (const credential of [laptop, phone]) {
      const refused = connect({ port: rig.port, room: firstRoom, token: await credentialToken(credential) });
      expect(await waitFor("all removed devices to be refused", refused.denied)).toBe("device-credential-refused");
      expect(refused.authenticated).not.toHaveBeenCalled();
      expect(rig.logs.at(-1)).toMatchObject({ cause: "missing-membership" });
    }
    rig.memberships.grant({ workspaceId: WORKSPACE, principalId: "person", role: "member" });
    const restored = connect({ port: rig.port, room: firstRoom, token: await credentialToken(laptop) });
    await waitFor("a hub-side grant to admit a fresh connection", restored.synced);
    expect(restored.text.toString()).toBe("retained document + peer writes");
    expect(removedConnections.every((connection) => !connection.context.authorization.active)).toBe(true);
  });
});
