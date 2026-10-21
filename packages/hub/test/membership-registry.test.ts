import { issueCredential } from "./device-credentials.js";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialRegistry } from "../src/credentials.js";
import { MembershipRegistry, type MembershipRole } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { MAX_TOKEN_LIFETIME_SECONDS, importCredentialKey, mintToken } from "@uberblick/schema/token";
import { OTHER_WORKSPACE, WORKSPACE, removeTempDatabases, tempDatabasePath } from "./helpers.js";

const databases: HubDatabase[] = [];

function database(path = ":memory:"): HubDatabase {
  const db = new HubDatabase(path, (error) => { throw error; });
  db.open();
  databases.push(db);
  return db;
}

function registry(path = ":memory:"): MembershipRegistry {
  return new MembershipRegistry(database(path));
}

function grant(store: MembershipRegistry, principalId: string, role: MembershipRole = "member", workspaceId = WORKSPACE): void {
  store.grant({ workspaceId, principalId, role });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  removeTempDatabases();
});

describe("hub-owned workspace memberships", () => {
  it.each(["member", "foreign-admin", "outsider"])("requires workspace admin authority from %s", (actorPrincipalId) => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    grant(store, "foreign-admin", "admin", OTHER_WORKSPACE);
    expect(() => store.requireAdmin(WORKSPACE, actorPrincipalId)).toThrow("workspace admin required");
  });

  it("serves only the current member's own role and returns detached management records", () => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    expect(store.ownRole(WORKSPACE, "admin")).toBe("admin");
    expect(store.ownRole(WORKSPACE, "member")).toBe("member");
    expect(() => store.ownRole(WORKSPACE, "outsider")).toThrow("workspace member required");
    expect(() => store.ownRole(OTHER_WORKSPACE, "admin")).toThrow("workspace member required");

    const members = store.listMembers(WORKSPACE);
    expect(members).toEqual([
      { workspaceId: WORKSPACE, principalId: "admin", role: "admin" },
      { workspaceId: WORKSPACE, principalId: "member", role: "member" },
    ]);
    const member = members[1];
    if (member === undefined) throw new Error("member missing");
    member.role = "admin";
    members.length = 0;
    expect(store.roleFor(WORKSPACE, "member")).toBe("member");
  });

  it.each(["demote", "remove"] as const)("can %s either admin while another remains", (operation) => {
    for (const principalId of ["other-admin", "acting-admin"]) {
      const store = registry();
      grant(store, "acting-admin", "admin");
      grant(store, "other-admin", "admin");
      grant(store, "member");
      const request = { workspaceId: WORKSPACE, principalId };
      if (operation === "demote") store.changeRole({ ...request, role: "member" });
      else expect(store.remove(request)).toBe(true);
      expect(store.roleFor(WORKSPACE, principalId)).toBe(operation === "demote" ? "member" : null);
      const remainingAdmin = principalId === "acting-admin" ? "other-admin" : "acting-admin";
      expect(store.roleFor(WORKSPACE, remainingAdmin)).toBe("admin");
      expect(store.roleFor(WORKSPACE, "member")).toBe("member");
    }
  });

  it.each(["demote", "remove"] as const)("refuses to %s the final admin without effects", (operation) => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    const before = store.listMembers(WORKSPACE);
    const removed: string[] = [];
    store.onRemove((_, principalId) => { removed.push(principalId); });
    const request = { workspaceId: WORKSPACE, principalId: "admin" };
    expect(() => {
      if (operation === "demote") store.changeRole({ ...request, role: "member" });
      else store.remove(request);
    }).toThrow("final workspace admin must remain");
    expect(store.listMembers(WORKSPACE)).toEqual(before);
    expect(removed).toEqual([]);
    // A later promotion provides a remaining administrator and
    // permits the same operation.
    store.changeRole({ workspaceId: WORKSPACE, principalId: "member", role: "admin" });
    if (operation === "demote") store.changeRole({ ...request, role: "member" });
    else expect(store.remove(request)).toBe(true);
    expect(store.roleFor(WORKSPACE, "member")).toBe("admin");
  });

  it("returns existing membership without overwriting its role through another grant", () => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    expect(store.grant({ workspaceId: WORKSPACE, principalId: "member", role: "admin" }))
      .toEqual({ workspaceId: WORKSPACE, principalId: "member", role: "member" });
    expect(store.grantMember({ workspaceId: WORKSPACE, principalId: "member", role: "admin" }))
      .toEqual({ workspaceId: WORKSPACE, principalId: "member", role: "member" });
    expect(store.grantMember({ workspaceId: WORKSPACE, principalId: "admin", role: "member" }))
      .toEqual({ workspaceId: WORKSPACE, principalId: "admin", role: "admin" });
    expect(store.roleFor(WORKSPACE, "admin")).toBe("admin");
    expect(store.roleFor(WORKSPACE, "member")).toBe("member");
    expect(() => store.changeRole({ workspaceId: WORKSPACE, principalId: "absent", role: "admin" }))
      .toThrow("member not found");
    expect(store.remove({ workspaceId: WORKSPACE, principalId: "absent" })).toBe(false);
    expect(store.roleFor(WORKSPACE, "absent")).toBeNull();
    store.remove({ workspaceId: WORKSPACE, principalId: "member" });
    expect(() => store.changeRole({ workspaceId: WORKSPACE, principalId: "member", role: "admin" }))
      .toThrow("member not found");
    expect(store.roleFor(WORKSPACE, "member")).toBeNull();
    grant(store, "member");
    expect(store.roleFor(WORKSPACE, "member")).toBe("member");
  });

  it("grants a new member or admin and returns detached records", () => {
    const store = registry();
    grant(store, "admin", "admin");
    for (const role of ["member", "admin"] as const) {
      const principalId = `new-${role}`;
      const membership = store.grantMember({ workspaceId: WORKSPACE, principalId, role });
      expect(membership).toEqual({ workspaceId: WORKSPACE, principalId, role });
      expect(store.listMembers(WORKSPACE)).toContainEqual(membership);
      expect(store.workspacesFor(principalId)).toEqual([WORKSPACE]);
      membership.role = role === "member" ? "admin" : "member";
      expect(store.roleFor(WORKSPACE, principalId)).toBe(role);
      expect(store.roleFor(OTHER_WORKSPACE, principalId)).toBeNull();
    }
  });

  it("checks current admin authority even after a successful earlier check", () => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "acting-admin", "admin");
    store.requireAdmin(WORKSPACE, "acting-admin");
    store.changeRole({ workspaceId: WORKSPACE, principalId: "acting-admin", role: "member" });
    expect(() => store.requireAdmin(WORKSPACE, "acting-admin")).toThrow("workspace admin required");
  });

  it("returns one membership across registry instances while preserving the first grant's role", () => {
    const path = tempDatabasePath();
    const first = registry(path);
    const second = registry(path);
    grant(first, "admin", "admin");
    const membership = { workspaceId: WORKSPACE, principalId: "new-member", role: "member" as const };
    expect(first.grantMember(membership)).toEqual(membership);
    expect(second.grantMember({ ...membership, role: "admin" })).toEqual(membership);
    expect(first.listMembers(WORKSPACE).filter((record) => record.principalId === "new-member"))
      .toEqual([membership]);
    expect(second.roleFor(WORKSPACE, "new-member")).toBe("member");
  });

  it("preserves membership and never notifies subscribers after a failed SQLite removal", () => {
    const db = database();
    const store = new MembershipRegistry(db);
    grant(store, "admin", "admin");
    grant(store, "member");
    const removed: string[] = [];
    store.onRemove((_, principalId) => { removed.push(principalId); });
    db.connection.exec(`CREATE TRIGGER refuse_membership_delete BEFORE DELETE ON hub_memberships
      BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END`);
    const request = { workspaceId: WORKSPACE, principalId: "member" };
    expect(() => store.remove(request)).toThrow("test deletion failure");
    expect(store.roleFor(WORKSPACE, "member")).toBe("member");
    expect(removed).toEqual([]);
    db.connection.exec("DROP TRIGGER refuse_membership_delete");
    expect(store.remove(request)).toBe(true);
    expect(removed).toEqual(["member"]);
  });

  it("removes membership before listeners, isolates workspaces, and retries all failed closures", () => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "person");
    grant(store, "other-member");
    grant(store, "person", "member", OTHER_WORKSPACE);
    const events: string[] = [];
    const unsubscribeFailing = store.onRemove(() => { throw new Error("first closure failed"); });
    const unsubscribeOtherFailing = store.onRemove(() => { throw new Error("second closure failed"); });
    store.onRemove((workspaceId, principalId) => {
      expect(store.roleFor(workspaceId, principalId)).toBeNull();
      events.push(`${workspaceId}/${principalId}`);
    });
    const request = { workspaceId: WORKSPACE, principalId: "person" };
    let failure: unknown;
    try { store.remove(request); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(store.roleFor(WORKSPACE, "person")).toBeNull();
    expect(events).toEqual([`${WORKSPACE}/person`]);
    expect(store.roleFor(OTHER_WORKSPACE, "person")).toBe("member");
    expect(store.roleFor(WORKSPACE, "other-member")).toBe("member");
    unsubscribeFailing();
    unsubscribeOtherFailing();
    expect(store.remove(request)).toBe(false);
    expect(events).toEqual([`${WORKSPACE}/person`, `${WORKSPACE}/person`]);
  });

  it("does not notify removal for role changes, and unsubscribes removal listeners", () => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    const removed: string[] = [];
    const unsubscribe = store.onRemove((_, principalId) => { removed.push(principalId); });
    store.changeRole({ workspaceId: WORKSPACE, principalId: "member", role: "admin" });
    store.changeRole({ workspaceId: WORKSPACE, principalId: "member", role: "member" });
    expect(removed).toEqual([]);
    unsubscribe();
    store.remove({ workspaceId: WORKSPACE, principalId: "member" });
    expect(removed).toEqual([]);
  });

  it("persists role changes before synchronously notifying every fence, and retries notifications without restoring authority", () => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "other-admin", "admin");
    const changes: string[] = [];
    const unsubscribeFailure = store.onRoleChange(() => { throw new Error("first fence failed"); });
    const unsubscribe = store.onRoleChange((workspaceId, principalId, role) => {
      expect(store.roleFor(workspaceId, principalId)).toBe(role);
      changes.push(`${workspaceId}/${principalId}/${role}`);
    });
    const request = { workspaceId: WORKSPACE, principalId: "other-admin", role: "member" as const };
    expect(() => store.changeRole(request)).toThrow("fencing failed");
    expect(store.roleFor(WORKSPACE, "other-admin")).toBe("member");
    expect(changes).toEqual([`${WORKSPACE}/other-admin/member`]);
    unsubscribeFailure();
    store.changeRole(request);
    expect(changes).toHaveLength(2);
    unsubscribe();
    store.changeRole({ ...request, role: "admin" });
    expect(changes).toHaveLength(2);
  });

  it("adds memberships to an existing document and credential database and preserves all state through restart", async () => {
    const path = tempDatabasePath();
    copyFileSync(fileURLToPath(new URL("./fixtures/extension-sqlite.sqlite", import.meta.url)), path);
    const firstDatabase = database(path);
    const credentials = new CredentialRegistry(firstDatabase);
    const issued = issueCredential(credentials, { principalId: "person", deviceId: "laptop", workspaces: [WORKSPACE, OTHER_WORKSPACE] });
    const signed = await mintToken(await importCredentialKey(issued.keyBytes), {
      typ: "room", sub: "client-asserted-admin", workspace: WORKSPACE, scope: "read-write",
      kid: issued.record.id, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    });
    const documents = firstDatabase.connection.prepare("SELECT name, data FROM documents ORDER BY name").all();
    const credentialRows = firstDatabase.connection.prepare("SELECT * FROM hub_credentials").all();
    expect(documents.length).toBeGreaterThan(0);
    const first = new MembershipRegistry(firstDatabase);
    grant(first, "admin", "admin");
    grant(first, "person");
    grant(first, "other-admin", "admin");
    grant(first, "person", "member", OTHER_WORKSPACE);
    first.grantMember({ workspaceId: WORKSPACE, principalId: "new-member", role: "member" });
    first.changeRole({ workspaceId: WORKSPACE, principalId: "other-admin", role: "member" });
    first.remove({ workspaceId: WORKSPACE, principalId: "person" });
    firstDatabase.close();

    const restartedDatabase = database(path);
    const restarted = new MembershipRegistry(restartedDatabase);
    expect(restarted.ownRole(WORKSPACE, "admin")).toBe("admin");
    expect(restarted.ownRole(WORKSPACE, "other-admin")).toBe("member");
    expect(restarted.roleFor(WORKSPACE, "person")).toBeNull();
    expect(restarted.ownRole(OTHER_WORKSPACE, "person")).toBe("member");
    expect(restarted.ownRole(WORKSPACE, "new-member")).toBe("member");
    expect(restartedDatabase.connection.prepare("SELECT name, data FROM documents ORDER BY name").all()).toEqual(documents);
    expect(restartedDatabase.connection.prepare("SELECT * FROM hub_credentials").all()).toEqual(credentialRows);
    expect(await new CredentialRegistry(restartedDatabase).verify(signed)).toHaveProperty("record", issued.record);
    expect(restarted.roleFor(WORKSPACE, "person")).toBeNull();
  });

  it("validates workspace, principal and role at the internal boundary", () => {
    const store = registry();
    expect(() => store.grant({ workspaceId: `slug-${WORKSPACE}`, principalId: "admin", role: "admin" }))
      .toThrow("workspaceId must be a bare UUID");
    expect(() => store.grant({ workspaceId: WORKSPACE, principalId: "", role: "admin" }))
      .toThrow("principalId must not be empty");
    expect(() => store.grant({ workspaceId: WORKSPACE, principalId: "admin", role: "owner" as MembershipRole }))
      .toThrow("role must be admin or member");
    grant(store, "admin", "admin");
    grant(store, "member");
    expect(() => store.grantMember({ workspaceId: WORKSPACE, principalId: "", role: "member" }))
      .toThrow("principalId must not be empty");
    expect(() => store.grantMember({ workspaceId: WORKSPACE, principalId: "new-member", role: "owner" as MembershipRole }))
      .toThrow("role must be admin or member");
    expect(() => store.changeRole({ workspaceId: WORKSPACE, principalId: "member", role: "owner" as MembershipRole }))
      .toThrow("role must be admin or member");
    expect(() => store.requireAdmin(WORKSPACE, "")).toThrow("principalId must not be empty");
    expect(() => store.remove({ workspaceId: WORKSPACE, principalId: "" }))
      .toThrow("principalId must not be empty");
    expect(store.roleFor(WORKSPACE, "member")).toBe("member");
  });
});
