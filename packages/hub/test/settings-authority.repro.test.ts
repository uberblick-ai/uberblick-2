/**
 * Audit reproduction (not for merge): workspace settings live in the shared
 * `<workspace>/_settings` CRDT room. These cases drive the production team hub
 * composition (device-credential admission, /auth/manage role changes, SQLite
 * persistence) with a raw Yjs client and record what the hub accepts.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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
} from "@uberblick/schema";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { importCredentialKey, mintRequestProof, mintToken, type RequestAction } from "@uberblick/schema/token";
import type { IssuedCredential } from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import type { MembershipRole } from "../src/memberships.js";
import { createTeamHub, type TeamHub } from "../src/team.js";
import { createClient, removeTempDatabases, tempDatabasePath, TEST_SECRET, type TestClient,
  acknowledged, waitUntil, WORKSPACE } from "./helpers.js";

type Action = Exclude<RequestAction, { operation: "renew-credential" }>;
const hubs: TeamHub[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

const ROOM = settingsRoom(WORKSPACE);

async function teamHub() {
  const logs: HubLogRecord[] = [];
  const hub = await createTeamHub({ address: "0.0.0.0", port: 0, databasePath: tempDatabasePath(),
    authSecret: TEST_SECRET, log: record => logs.push(record),
    github: { clientId: "Iv1.0123456789abcdef", fetch: async () => { throw new Error("GitHub is unreachable"); } } });
  hubs.push(hub);
  return { hub, logs };
}

function person(hub: TeamHub, accountId: string, role: MembershipRole) {
  const principal = hub.principals!.identify(accountId, `user-${accountId}`);
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: principal.id, role });
  const issued = hub.credentials!.issue({ principalId: principal.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
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

/** The same room token every device-login client mints from its stored credential key. */
async function roomToken(issued: IssuedCredential) {
  return mintToken(await importCredentialKey(issued.keyBytes), { typ: "room", sub: issued.record.principalId,
    workspace: WORKSPACE, scope: "read-write", kid: issued.record.id, lifetimeSeconds: 60 });
}

async function open(hub: TeamHub, issued: IssuedCredential, doc?: Y.Doc) {
  const client = createClient({ port: hub.port, room: ROOM, token: await roomToken(issued),
    reconnectDelayMs: 60_000, ...(doc === undefined ? {} : { doc }) });
  clients.push(client);
  await client.synced;
  return client;
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
  const changed = await manage(hub, actor, { operation: "change-role", workspaceId: WORKSPACE, principalId, role: "member" });
  expect(changed).toEqual({ code: 200, result: { status: "ok" } });
}

describe("settings-room authority (audit reproduction)", () => {
  it("accepts an offline rename made after demotion once the device reconnects", async () => {
    const { hub } = await teamHub();
    const alice = person(hub, "1001", "admin");
    const bob = person(hub, "1002", "admin");

    // Alice names the workspace while she is an admin, then goes offline with her replica.
    const replica = new Y.Doc();
    const first = await open(hub, alice.issued, replica);
    setWorkspaceName(replica, "Team");
    await acknowledged(first);
    close(first);

    const observer = await open(hub, bob.issued);
    expect(getWorkspaceName(observer.doc)).toBe("Team");

    await demote(hub, bob.issued, alice.principal.id);
    expect(await manage(hub, alice.issued, { operation: "own-role", workspaceId: WORKSPACE }))
      .toEqual({ code: 200, result: { status: "ok", role: "member" } });

    // Offline and now a member, Alice renames locally; her pending update syncs on reconnect.
    setWorkspaceName(replica, "Renamed by a member");
    const reconnected = await open(hub, alice.issued, replica);
    await acknowledged(reconnected, "the demoted rename");
    await waitUntil("the other admin to see the rename",
      () => getWorkspaceName(observer.doc) === "Renamed by a member");
    expect(hubSettings(hub, getWorkspaceName)).toBe("Renamed by a member");
    expect(reconnected.provider.isAuthenticated).toBe(true);
  });

  it("accepts an edit made while still an admin that arrives after demotion", async () => {
    const { hub } = await teamHub();
    const alice = person(hub, "1001", "admin");
    const bob = person(hub, "1002", "admin");
    const replica = new Y.Doc();
    const first = await open(hub, alice.issued, replica);
    await acknowledged(first);
    close(first);

    setWorkspaceName(replica, "Edited before demotion");
    await demote(hub, bob.issued, alice.principal.id);

    const observer = await open(hub, bob.issued);
    const reconnected = await open(hub, alice.issued, replica);
    await acknowledged(reconnected, "the pre-demotion rename");
    await waitUntil("the other admin to see it", () => getWorkspaceName(observer.doc) === "Edited before demotion");
  });

  it("keeps a live connection writable after demotion", async () => {
    const { hub } = await teamHub();
    const alice = person(hub, "1001", "admin");
    const bob = person(hub, "1002", "admin");
    const live = await open(hub, alice.issued);
    await demote(hub, bob.issued, alice.principal.id);
    setWorkspaceName(live.doc, "Written on a live connection after demotion");
    await acknowledged(live, "the post-demotion write");
    expect(hubSettings(hub, getWorkspaceName)).toBe("Written on a live connection after demotion");
    expect(live.provider.isAuthenticated).toBe(true);
  });

  it("lets a never-admin member change every Workspace settings value through raw sync", async () => {
    const { hub } = await teamHub();
    const admin = person(hub, "1001", "admin");
    const member = person(hub, "1003", "member");
    const adminView = await open(hub, admin.issued);
    const curated = createTagCatalogEntry(adminView.doc, "curated");
    setWorkspaceName(adminView.doc, "Admin's name");
    await acknowledged(adminView);

    const raw = await open(hub, member.issued);
    raw.doc.transact(() => {
      setWorkspaceName(raw.doc, "Member's name");
      setWorkspaceMainRepository(raw.doc, "attacker/elsewhere");
      createTagCatalogEntry(raw.doc, "member-made");
      retireTagCatalogEntry(raw.doc, curated.id);
    });
    await acknowledged(raw, "the member's settings writes");

    await waitUntil("the admin to see the member's writes", () => getWorkspaceName(adminView.doc) === "Member's name");
    expect(getWorkspaceMainRepository(adminView.doc)).toBe("attacker/elsewhere");
    expect(listTagCatalog(adminView.doc).map(({ name, state }) => ({ name, state }))).toEqual(
      expect.arrayContaining([{ name: "curated", state: "retired" }, { name: "member-made", state: "active" }]));
    // The hub-private role is unchanged; only the shared settings content moved.
    expect(await manage(hub, member.issued, { operation: "own-role", workspaceId: WORKSPACE }))
      .toEqual({ code: 200, result: { status: "ok", role: "member" } });
  });

  it("names the workspace in the hub-admin inventory from a member-written value", async () => {
    const { hub } = await teamHub();
    const admin = person(hub, "1001", "admin");
    hub.hubAdmins!.grant(admin.principal.id);
    const member = person(hub, "1003", "member");
    const raw = await open(hub, member.issued);
    setWorkspaceName(raw.doc, "Spoofed inventory name");
    await acknowledged(raw);
    const listed = await manage(hub, admin.issued, { operation: "list-hub-workspaces" });
    expect(JSON.stringify(listed.result)).toContain("Spoofed inventory name");
  });
});
