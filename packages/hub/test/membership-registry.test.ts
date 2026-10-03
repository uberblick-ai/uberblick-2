import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialRegistry } from "../src/credentials.js";
import { MembershipRegistry, type MembershipRole } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  importCredentialKey,
  mintToken,
} from "../src/token.js";
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
  it.each(["member", "outsider", "foreign-admin"])("refuses management by %s without changing or revealing members", (actorPrincipalId) => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    grant(store, "foreign-admin", "admin", OTHER_WORKSPACE);
    const before = store.listMembers(WORKSPACE, "admin");
    const removed: string[] = [];
    store.onRemove((_, principalId) => { removed.push(principalId); });

    for (const principalId of ["member", "absent"]) {
      expect(() => store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId, principalId, role: "admin" }))
        .toThrow("workspace admin required");
      expect(() => store.remove({ workspaceId: WORKSPACE, actorPrincipalId, principalId }))
        .toThrow("workspace admin required");
    }
    expect(() => store.requireAdmin(WORKSPACE, actorPrincipalId)).toThrow("workspace admin required");
    expect(() => store.listMembers(WORKSPACE, actorPrincipalId)).toThrow("workspace admin required");
    expect(store.listMembers(WORKSPACE, "admin")).toEqual(before);
    expect(removed).toEqual([]);
  });

  it("serves only the current member's own role and returns detached management records", () => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    expect(store.ownRole(WORKSPACE, "admin")).toBe("admin");
    expect(store.ownRole(WORKSPACE, "member")).toBe("member");
    expect(() => store.ownRole(WORKSPACE, "outsider")).toThrow("workspace member required");
    expect(() => store.ownRole(OTHER_WORKSPACE, "admin")).toThrow("workspace member required");

    const members = store.listMembers(WORKSPACE, "admin");
    expect(members).toEqual([
      { workspaceId: WORKSPACE, principalId: "admin", role: "admin" },
      { workspaceId: WORKSPACE, principalId: "member", role: "member" },
    ]);
    const member = members[1];
    if (member === undefined) throw new Error("member missing");
    member.role = "admin";
    members.length = 0;
    expect(store.roleFor(WORKSPACE, "member")).toBe("member");
    expect(() => store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "member", principalId: "member", role: "admin" }))
      .toThrow("workspace admin required");
  });

  it.each(["demote", "remove"] as const)("lets an admin %s another admin or themselves while another remains", (operation) => {
    for (const principalId of ["other-admin", "acting-admin"]) {
      const store = registry();
      grant(store, "acting-admin", "admin");
      grant(store, "other-admin", "admin");
      grant(store, "member");
      const request = { workspaceId: WORKSPACE, actorPrincipalId: "acting-admin", principalId };
      if (operation === "demote") store.changeRole({ ...request, role: "member" });
      else expect(store.remove(request)).toBe(true);
      expect(store.roleFor(WORKSPACE, principalId)).toBe(operation === "demote" ? "member" : null);
      const remainingAdmin = principalId === "acting-admin" ? "other-admin" : "acting-admin";
      expect(store.roleFor(WORKSPACE, remainingAdmin)).toBe("admin");
      expect(store.roleFor(WORKSPACE, "member")).toBe("member");
      expect(() => store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: principalId, principalId: "member", role: "admin" }))
        .toThrow("workspace admin required");
      expect(() => store.remove({ workspaceId: WORKSPACE, actorPrincipalId: principalId, principalId: "member" }))
        .toThrow("workspace admin required");
    }
  });

  it.each(["demote", "remove"] as const)("refuses to %s the final admin without effects", (operation) => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    const before = store.listMembers(WORKSPACE, "admin");
    const removed: string[] = [];
    store.onRemove((_, principalId) => { removed.push(principalId); });
    const request = { workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "admin" };
    expect(() => {
      if (operation === "demote") store.changeRole({ ...request, role: "member" });
      else store.remove(request);
    }).toThrow("final workspace admin must remain");
    expect(store.listMembers(WORKSPACE, "admin")).toEqual(before);
    expect(removed).toEqual([]);
    // A later authorized promotion provides a remaining administrator and
    // permits the same operation.
    store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "member", role: "admin" });
    if (operation === "demote") store.changeRole({ ...request, role: "member" });
    else expect(store.remove(request)).toBe(true);
    expect(store.roleFor(WORKSPACE, "member")).toBe("admin");
  });

  it("never grants through management or overwrites an existing role through another grant", () => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    expect(() => grant(store, "member", "admin")).toThrow();
    expect(store.roleFor(WORKSPACE, "member")).toBe("member");
    expect(() => store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "absent", role: "admin" }))
      .toThrow("member not found");
    expect(store.remove({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "absent" })).toBe(false);
    expect(store.roleFor(WORKSPACE, "absent")).toBeNull();
    store.remove({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "member" });
    expect(() => store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "member", role: "admin" }))
      .toThrow("member not found");
    expect(store.roleFor(WORKSPACE, "member")).toBeNull();
    grant(store, "member");
    expect(store.roleFor(WORKSPACE, "member")).toBe("member");
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
    const request = { workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "member" };
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
    const request = { workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "person" };
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
    expect(() => store.remove({ ...request, actorPrincipalId: "person" })).toThrow("workspace admin required");
    expect(events).toHaveLength(2);
  });

  it("does not notify removal for role changes, and unsubscribes removal listeners", () => {
    const store = registry();
    grant(store, "admin", "admin");
    grant(store, "member");
    const removed: string[] = [];
    const unsubscribe = store.onRemove((_, principalId) => { removed.push(principalId); });
    store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "member", role: "admin" });
    store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "member", role: "member" });
    expect(removed).toEqual([]);
    unsubscribe();
    store.remove({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "member" });
    expect(removed).toEqual([]);
  });

  it("adds memberships to an existing document and credential database and preserves all state through restart", async () => {
    const path = tempDatabasePath();
    copyFileSync(fileURLToPath(new URL("./fixtures/extension-sqlite.sqlite", import.meta.url)), path);
    const firstDatabase = database(path);
    const credentials = new CredentialRegistry(firstDatabase);
    const issued = credentials.issue({ principalId: "person", deviceId: "laptop", workspaces: [WORKSPACE, OTHER_WORKSPACE] });
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
    first.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "other-admin", role: "member" });
    first.remove({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "person" });
    firstDatabase.close();

    const restartedDatabase = database(path);
    const restarted = new MembershipRegistry(restartedDatabase);
    expect(restarted.ownRole(WORKSPACE, "admin")).toBe("admin");
    expect(restarted.ownRole(WORKSPACE, "other-admin")).toBe("member");
    expect(restarted.roleFor(WORKSPACE, "person")).toBeNull();
    expect(restarted.ownRole(OTHER_WORKSPACE, "person")).toBe("member");
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
    expect(() => store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "member", role: "owner" as MembershipRole }))
      .toThrow("role must be admin or member");
    expect(() => store.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: "", principalId: "member", role: "admin" }))
      .toThrow("principalId must not be empty");
    expect(() => store.remove({ workspaceId: WORKSPACE, actorPrincipalId: "admin", principalId: "" }))
      .toThrow("principalId must not be empty");
    expect(store.roleFor(WORKSPACE, "member")).toBe("member");
  });
});
