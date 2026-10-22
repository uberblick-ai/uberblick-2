import { issueCredential, mintDeviceRequestProof as mintRequestProof, type TestCredential as IssuedCredential } from "./device-credentials.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MessageType, type onMessageParameters } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createTagCatalogEntry,
  getWorkspaceMainRepository,
  getWorkspaceName,
  listTagCatalog,
  retireTagCatalogEntry,
  setWorkspaceMainRepository,
  setWorkspaceName,
  settingsRoom,
  readOriginAck,
} from "@uberblick/schema";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { importCredentialKey, mintToken, type RequestAction, type TokenScope } from "@uberblick/schema/token";

import type { MembershipRole } from "../src/memberships.js";
import { createTeamHub, type TeamHub } from "../src/team.js";
import { createClient, removeTempDatabases, tempDatabasePath, TEST_SECRET, type TestClient,
  acknowledged, testRoom, waitUntil, WORKSPACE } from "./helpers.js";

type Action = Exclude<RequestAction, { operation: "renew-credential" }>;
const hubs: TeamHub[] = [];
const clients: TestClient[] = [];
const ROOM = settingsRoom(WORKSPACE);

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

async function teamHub(databasePath = tempDatabasePath()) {
  const hub = await createTeamHub({ address: "0.0.0.0", port: 0, databasePath,
    authSecret: TEST_SECRET, log: () => {},
    github: { clientId: "Iv1.0123456789abcdef", fetch: async () => { throw new Error("GitHub is unreachable"); } } });
  hubs.push(hub);
  return hub;
}

function person(hub: TeamHub, accountId: string, role: MembershipRole) {
  const principal = hub.principals!.identify(accountId, `user-${accountId}`);
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: principal.id, role });
  const issued = issueCredential(hub.credentials!, { principalId: principal.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
  return { principal, issued };
}

async function manage(hub: TeamHub, issued: IssuedCredential, action: Action) {
  const token = await mintRequestProof(await importCredentialKey(issued.keyBytes),
    { kid: issued.record.id, ...action, lifetimeSeconds: 60 });
  const response = await fetch(`http://127.0.0.1:${hub.port}/auth/manage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: SYNC_PROTOCOL_VERSION, token, ...action }),
  });
  return { code: response.status, result: await response.json() as Record<string, unknown> };
}

async function open(hub: TeamHub, issued: IssuedCredential, doc?: Y.Doc, room = ROOM, scope: TokenScope = "read-write") {
  const token = await mintToken(await importCredentialKey(issued.keyBytes), { typ: "room", sub: issued.record.principalId,
    workspace: WORKSPACE, scope, kid: issued.record.id, lifetimeSeconds: 60 });
  const client = createClient({ port: hub.port, room, token, reconnectDelayMs: 60_000,
    ...(doc === undefined ? {} : { doc }), originUpdates: true });
  clients.push(client);
  let refusals = 0;
  client.provider.on("message", ({ message }: onMessageParameters) => {
    message.readVarString();
    if (message.readVarUint() === MessageType.SyncStatus && message.readVarUint() === 0) refusals += 1;
  });
  client.provider.on("stateless", ({ payload }: { payload: string }) => {
    if (readOriginAck(payload)?.applied === false) refusals += 1;
  });
  await client.synced;
  return Object.assign(client, { getRefusals: () => refusals });
}

function close(client: TestClient): void {
  client.destroy();
  clients.splice(clients.indexOf(client), 1);
}

function hubSettings<T>(hub: TeamHub, read: (doc: Y.Doc) => T): T | undefined {
  const live = hub.hocuspocus.documents.get(ROOM);
  return live === undefined ? undefined : read(live);
}

async function demote(hub: TeamHub, actor: IssuedCredential, principalId: string) {
  expect(await manage(hub, actor, { operation: "change-role", workspaceId: WORKSPACE, principalId, role: "member" }))
    .toEqual({ code: 200, result: { status: "ok" } });
}

describe("current workspace-admin settings authority", () => {
  it.each(["before demotion", "after demotion"])("refuses an offline edit made %s when it arrives as a member", async (when) => {
    const hub = await teamHub();
    const alice = person(hub, "1001", "admin");
    const bob = person(hub, "1002", "admin");
    const replica = new Y.Doc();
    const first = await open(hub, alice.issued, replica);
    setWorkspaceName(replica, "Team");
    await acknowledged(first);
    close(first);
    const observer = await open(hub, bob.issued);

    if (when === "before demotion") setWorkspaceName(replica, "Refused offline rename");
    await demote(hub, bob.issued, alice.principal.id);
    if (when === "after demotion") setWorkspaceName(replica, "Refused offline rename");
    const reconnected = await open(hub, alice.issued, replica);
    await waitUntil("the offline settings diff to be refused", () => reconnected.getRefusals() > 0);
    expect(hubSettings(hub, getWorkspaceName)).toBe("Team");
    expect(getWorkspaceName(observer.doc)).toBe("Team");
    expect(reconnected.provider.isAuthenticated).toBe(true);
  });

  it("accepts an offline edit when the returning device is still admin", async () => {
    const hub = await teamHub();
    const admin = person(hub, "1001", "admin");
    const replica = new Y.Doc();
    const first = await open(hub, admin.issued, replica);
    await acknowledged(first);
    close(first);
    setWorkspaceName(replica, "Offline admin rename");
    const reconnected = await open(hub, admin.issued, replica);
    await acknowledged(reconnected);
    expect(hubSettings(hub, getWorkspaceName)).toBe("Offline admin rename");
    expect(reconnected.getRefusals()).toBe(0);
  });

  it("refuses a member's entire settings update, keeps clean handshakes acknowledged, and persists only the admin's values", async () => {
    const path = tempDatabasePath();
    const hub = await teamHub(path);
    const admin = person(hub, "1001", "admin");
    const member = person(hub, "1003", "member");
    hub.hubAdmins!.grant(admin.principal.id);
    const adminView = await open(hub, admin.issued);
    const curated = createTagCatalogEntry(adminView.doc, "curated");
    setWorkspaceName(adminView.doc, "Admin's name");
    setWorkspaceMainRepository(adminView.doc, "team/project");
    await acknowledged(adminView);
    const raw = await open(hub, member.issued);
    await acknowledged(raw, "the member's clean settings handshake");
    expect(raw.getRefusals()).toBe(0);
    raw.doc.transact(() => {
      setWorkspaceName(raw.doc, "Member's name");
      setWorkspaceMainRepository(raw.doc, "attacker/elsewhere");
      createTagCatalogEntry(raw.doc, "member-made");
      retireTagCatalogEntry(raw.doc, curated.id);
    });
    await waitUntil("the member's settings update to be refused", () => raw.getRefusals() === 1);
    expect(getWorkspaceName(adminView.doc)).toBe("Admin's name");
    expect(getWorkspaceMainRepository(adminView.doc)).toBe("team/project");
    expect(listTagCatalog(adminView.doc).map(({ name, state }) => ({ name, state })))
      .toEqual([{ name: "curated", state: "active" }]);
    const listed = await manage(hub, admin.issued, { operation: "list-hub-workspaces" });
    expect(JSON.stringify(listed.result)).toContain("Admin's name");
    expect(JSON.stringify(listed.result)).not.toContain("Member's name");
    close(raw);
    close(adminView);
    await hub.stop();
    const stored = new DatabaseSync(path, { readOnly: true });
    const settings = new Y.Doc();
    try {
      const row = stored.prepare("SELECT data FROM documents WHERE name = ?").get(ROOM);
      Y.applyUpdate(settings, row!.data as Uint8Array);
      expect(getWorkspaceName(settings)).toBe("Admin's name");
      expect(getWorkspaceMainRepository(settings)).toBe("team/project");
      expect(listTagCatalog(settings).map(({ name, state }) => ({ name, state })))
        .toEqual([{ name: "curated", state: "active" }]);
    } finally {
      settings.destroy();
      stored.close();
    }
  });

  it("fences an open settings connection on demotion while both roles retain document access", async () => {
    const hub = await teamHub();
    const alice = person(hub, "1001", "admin");
    const bob = person(hub, "1002", "admin");
    const live = await open(hub, alice.issued);
    setWorkspaceName(live.doc, "Team");
    await acknowledged(live);
    const room = testRoom();
    const aliceDocument = await open(hub, alice.issued, undefined, room);
    const bobDocument = await open(hub, bob.issued, undefined, room);
    await demote(hub, bob.issued, alice.principal.id);
    setWorkspaceName(live.doc, "Refused live rename");
    await waitUntil("the live settings write to be refused", () => live.getRefusals() > 0);
    expect(hubSettings(hub, getWorkspaceName)).toBe("Team");
    expect(live.provider.isAuthenticated).toBe(true);
    aliceDocument.text.insert(0, "member edit");
    await acknowledged(aliceDocument);
    await waitUntil("the admin to see the member's document edit", () => bobDocument.text.toString() === "member edit");
    bobDocument.text.insert(bobDocument.text.length, " and admin edit");
    await acknowledged(bobDocument);
    await waitUntil("the member to see the admin's document edit", () => aliceDocument.text.toString() === "member edit and admin edit");
  });

  it("allows a promoted member's live settings connection to write without widening a read-only room token", async () => {
    const hub = await teamHub();
    const admin = person(hub, "1001", "admin");
    const member = person(hub, "1003", "member");
    const writable = await open(hub, member.issued);
    const readOnly = await open(hub, member.issued, undefined, ROOM, "read-only");
    await manage(hub, admin.issued, { operation: "change-role", workspaceId: WORKSPACE, principalId: member.principal.id, role: "admin" });
    setWorkspaceName(writable.doc, "Promoted admin's name");
    await acknowledged(writable);
    await waitUntil("the read-only observer to receive the name", () => getWorkspaceName(readOnly.doc) === "Promoted admin's name");
    setWorkspaceName(readOnly.doc, "Refused token scope escalation");
    await waitUntil("the read-only token's settings write to be refused", () => readOnly.getRefusals() > 0);
    expect(hubSettings(hub, getWorkspaceName)).toBe("Promoted admin's name");
  });
});
