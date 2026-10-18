import { issueCredential } from "./device-credentials.js";
import { randomUUID } from "node:crypto";
import { setWorkspaceName } from "@uberblick/schema";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { SetupReceipts } from "../src/admin-setup.js";
import { CredentialRegistry } from "../src/credentials.js";
import { HubAdminRegistry, type HubAdminRecord, type HubWorkspaceRecord } from "../src/hub-admins.js";
import { HubClaimState } from "../src/hub-claim.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { PrincipalRegistry } from "../src/principals.js";
import { WorkspacePromotions } from "../src/workspace-promotion.js";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

afterEach(removeTempDatabases);

it("lists every inventory source without exposing document content, and tolerates unreadable or invalid names", () => {
  const database = new HubDatabase(tempDatabasePath(), error => { throw error; });
  database.open();
  try {
    const principals = new PrincipalRegistry(database);
    const memberships = new MembershipRegistry(database);
    new CredentialRegistry(database);
    const hubAdmins = new HubAdminRegistry(database);
    const claims = new HubClaimState(database, hubAdmins);
    const owner = principals.identify("1234", "hub-admin");
    hubAdmins.grant(owner.id);
    const defaultId = database.connection.prepare("SELECT default_workspace_id FROM hub_claim_state").get()!.default_workspace_id as string;
    const memberOnly = randomUUID();
    const workspaceAdmin = principals.identify("5678", "workspace-admin");
    memberships.grant({ workspaceId: memberOnly, principalId: workspaceAdmin.id, role: "admin" });
    const receiptOnly = randomUUID();
    new SetupReceipts(database).save({ status: "complete", setupId: randomUUID(), workspaceId: receiptOnly,
      identity: owner, hadDocuments: false });
    const promoted = randomUUID();
    new WorkspacePromotions(database, memberships, () => false, hubAdmins).reserve(promoted, randomUUID(), owner.id);
    database.connection.prepare("DELETE FROM hub_memberships WHERE workspace_id = ?").run(promoted);
    const docOnly = randomUUID();
    const invalidName = randomUUID();
    const unreadable = randomUUID();
    const document = new Y.Doc();
    setWorkspaceName(document, "Stored project");
    document.getText("private-content").insert(0, "document content must stay private");
    database.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
      .run(`${docOnly}/_settings`, Y.encodeStateAsUpdate(document));
    document.destroy();
    const invalid = new Y.Doc();
    invalid.getMap("workspace-settings").set("name", "bad\u202ename");
    database.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
      .run(`${invalidName}/_settings`, Y.encodeStateAsUpdate(invalid));
    invalid.destroy();
    database.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
      .run(`${unreadable}/_settings`, new Uint8Array([255]));
    database.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
      .run("not-a-uuid/_settings", new Uint8Array());
    const inventory = hubAdmins.listWorkspaces(owner.id);
    expect(inventory).toHaveLength(7);
    expect(inventory).toEqual(expect.arrayContaining([
      { workspaceId: defaultId, status: "active", name: "Default workspace", members: 0, admins: [] },
      { workspaceId: memberOnly, status: "active", members: 1, admins: ["workspace-admin"] },
      { workspaceId: receiptOnly, status: "active", members: 0, admins: [] },
      { workspaceId: promoted, status: "active", members: 0, admins: [] },
      { workspaceId: docOnly, status: "active", name: "Stored project", members: 0, admins: [] },
      { workspaceId: invalidName, status: "active", members: 0, admins: [] },
      { workspaceId: unreadable, status: "active", members: 0, admins: [] },
    ]));
    expect(JSON.stringify(inventory)).not.toContain("document content must stay private");
    expect(() => hubAdmins.listWorkspaces(workspaceAdmin.id)).toThrow("hub-admin-required");
    expect(claims.state(true)).toEqual({ unclaimed: true, canClaim: true });
  } finally { database.close(); }
});

it("persists suspension through restart, preserves workspace data and commits before every closure listener", () => {
  const path = tempDatabasePath();
  const database = new HubDatabase(path, error => { throw error; });
  database.open();
  const memberships = new MembershipRegistry(database);
  const principals = new PrincipalRegistry(database);
  const credentials = new CredentialRegistry(database);
  const registry = new HubAdminRegistry(database);
  const owner = principals.identify("1234", "owner");
  registry.grant(owner.id);
  const workspaceId = randomUUID();
  memberships.grant({ workspaceId, principalId: owner.id, role: "admin" });
  const issued = issueCredential(credentials, { principalId: owner.id, deviceId: randomUUID(), workspaces: [workspaceId] });
  const directory = new Y.Doc();
  database.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(`${workspaceId}/_directory`, Y.encodeStateAsUpdate(directory));
  directory.destroy();
  const before = {
    documents: database.connection.prepare("SELECT * FROM documents").all(),
    members: database.connection.prepare("SELECT * FROM hub_memberships").all(),
    credentials: database.connection.prepare("SELECT * FROM hub_credentials").all(),
  };
  const calls: string[] = [];
  const unsubscribe = registry.onSuspend(id => {
    expect(registry.isSuspended(id)).toBe(true);
    calls.push("first");
    throw new Error("closure fixture");
  });
  registry.onSuspend(() => { calls.push("second"); });
  expect(() => registry.setWorkspaceStatus(owner.id, workspaceId, "suspended")).toThrow(AggregateError);
  expect(calls).toEqual(["first", "second"]);
  expect(registry.availableWorkspaces([workspaceId])).toEqual([]);
  unsubscribe();
  registry.setWorkspaceStatus(owner.id, workspaceId, "suspended");
  expect(calls).toEqual(["first", "second", "second"]);
  expect(credentials.get(issued.record.id)).toEqual(issued.record);
  expect(registry.listWorkspaces(owner.id)).toEqual([{ workspaceId, status: "suspended", members: 1, admins: ["owner"] }]);
  database.close();
  const reopened = new HubDatabase(path, error => { throw error; });
  reopened.open();
  try {
    const restored = new HubAdminRegistry(reopened);
    expect(restored.isSuspended(workspaceId)).toBe(true);
    expect(reopened.connection.prepare("SELECT * FROM documents").all()).toEqual(before.documents);
    expect(reopened.connection.prepare("SELECT * FROM hub_memberships").all()).toEqual(before.members);
    expect(reopened.connection.prepare("SELECT * FROM hub_credentials").all()).toEqual(before.credentials);
    restored.setWorkspaceStatus(owner.id, workspaceId, "active");
    expect(restored.availableWorkspaces([workspaceId])).toEqual([workspaceId]);
    expect(restored.listWorkspaces(owner.id)).toEqual([{ workspaceId, status: "active", members: 1, admins: ["owner"] }]);
  } finally { reopened.close(); }
});

it("storage failure applies no suspension and notifies no closure listener", () => {
  const database = new HubDatabase(tempDatabasePath(), error => { throw error; });
  database.open();
  try {
    const memberships = new MembershipRegistry(database);
    const registry = new HubAdminRegistry(database);
    registry.grant("owner");
    const workspaceId = randomUUID();
    memberships.grant({ workspaceId, principalId: "owner", role: "admin" });
    const calls: string[] = [];
    registry.onSuspend(id => { calls.push(id); });
    database.connection.exec("CREATE TRIGGER refuse_suspension BEFORE INSERT ON hub_workspace_suspensions BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect(() => registry.setWorkspaceStatus("owner", workspaceId, "suspended")).toThrow("fixture");
    expect(registry.isSuspended(workspaceId)).toBe(false);
    expect(calls).toEqual([]);
  } finally { database.close(); }
});

it("retains private hub roles through restart and rolls back a failed removal", () => {
  const path = tempDatabasePath();
  const database = new HubDatabase(path, error => { throw error; });
  database.open();
  const hubAdmins = new HubAdminRegistry(database);
  hubAdmins.grant("first");
  hubAdmins.grant("second");
  database.connection.exec("CREATE TRIGGER refuse_hub_admin_removal BEFORE DELETE ON hub_admins BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  expect(() => hubAdmins.remove("first", "second")).toThrow("fixture");
  expect(hubAdmins.isAdmin("second")).toBe(true);
  database.close();
  const reopened = new HubDatabase(path, error => { throw error; });
  reopened.open();
  try {
    const registry = new HubAdminRegistry(reopened);
    expect(registry.isAdmin("first")).toBe(true);
    expect(registry.isAdmin("second")).toBe(true);
    reopened.connection.exec("DROP TRIGGER refuse_hub_admin_removal");
    registry.remove("first", "second");
    expect(registry.isAdmin("second")).toBe(false);
    expect(() => registry.remove("first", "first")).toThrow("self-admin");
    expect(() => registry.remove("second", "first")).toThrow("hub-admin-required");
    expect(registry.isAdmin("first")).toBe(true);
  } finally { reopened.close(); }
});

it("retrieves inventories larger than the transport bound through bounded pages, including one workspace's many admins", () => {
  const database = new HubDatabase(tempDatabasePath(), error => { throw error; });
  database.open();
  try {
    const principals = new PrincipalRegistry(database);
    const memberships = new MembershipRegistry(database);
    const credentials = new CredentialRegistry(database);
    const registry = new HubAdminRegistry(database);
    const owner = principals.identify("999999999", "owner");
    registry.grant(owner.id);
    const issued = issueCredential(credentials, { principalId: owner.id, deviceId: randomUUID(), workspaces: [] });
    const settings = new Y.Doc();
    setWorkspaceName(settings, "A".repeat(64));
    settings.getText("private-content").insert(0, "private document content");
    const bytes = Y.encodeStateAsUpdate(settings);
    settings.destroy();
    const giant = randomUUID();
    database.connection.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 2_000; index++) {
      const principal = principals.identify(String(index + 1), `account-${String(index).padStart(31, "0")}`);
      memberships.grant({ workspaceId: giant, principalId: principal.id, role: "admin" });
      if (index < 400) {
        registry.grant(principal.id);
        const workspaceId = randomUUID();
        memberships.grant({ workspaceId, principalId: principal.id, role: "admin" });
        database.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(`${workspaceId}/_settings`, bytes);
      }
    }
    database.connection.exec("COMMIT");

    const expectedAdmins = registry.listAdmins(owner.id);
    const expectedWorkspaces = registry.listWorkspaces(owner.id);
    expect(Buffer.byteLength(JSON.stringify(expectedAdmins))).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(expectedWorkspaces))).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(expectedWorkspaces.find(row => row.workspaceId === giant)))).toBeGreaterThan(65_536);

    const admins: HubAdminRecord[] = [];
    let cursor: string | undefined;
    let adminPages = 0;
    do {
      const page = registry.pageAdmins(owner.id, cursor);
      expect(Buffer.byteLength(JSON.stringify({ status: "ok", ...page }))).toBeLessThanOrEqual(49_152);
      admins.push(...page.admins);
      cursor = page.nextCursor ?? undefined;
      expect(++adminPages).toBeLessThan(10);
    } while (cursor !== undefined);
    expect(adminPages).toBeGreaterThan(1);
    expect(admins).toEqual(expectedAdmins);

    const workspaces = new Map<string, HubWorkspaceRecord>();
    let workspacePages = 0;
    let giantFragments = 0;
    do {
      const page = registry.pageWorkspaces(owner.id, cursor);
      expect(Buffer.byteLength(JSON.stringify({ status: "ok", ...page }))).toBeLessThanOrEqual(49_152);
      expect(JSON.stringify(page)).not.toContain("private document content");
      expect(JSON.stringify(page)).not.toContain(Buffer.from(issued.keyBytes).toString("base64url"));
      for (const row of page.workspaces) {
        if (row.workspaceId === giant) giantFragments++;
        const prior = workspaces.get(row.workspaceId);
        if (prior === undefined) workspaces.set(row.workspaceId, { ...row, admins: [...row.admins] });
        else {
          expect({ ...row, admins: [] }).toEqual({ ...prior, admins: [] });
          prior.admins.push(...row.admins);
        }
      }
      cursor = page.nextCursor ?? undefined;
      expect(++workspacePages).toBeLessThan(10);
    } while (cursor !== undefined);
    expect(workspacePages).toBeGreaterThan(1);
    expect(giantFragments).toBeGreaterThan(1);
    expect([...workspaces.values()]).toEqual(expectedWorkspaces);

    registry.remove(expectedAdmins.find(row => !row.current)!.principalId, owner.id);
    expect(() => registry.pageAdmins(owner.id, "WzFd")).toThrow("hub-admin-required");
    expect(() => registry.pageWorkspaces(owner.id, "WzAsMV0")).toThrow("hub-admin-required");
  } finally { database.close(); }
});
