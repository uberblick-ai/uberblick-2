import { randomUUID } from "node:crypto";
import { setWorkspaceName } from "@uberblick/schema";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { SetupReceipts } from "../src/admin-setup.js";
import { CredentialRegistry } from "../src/credentials.js";
import { HubAdminRegistry } from "../src/hub-admins.js";
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
      { workspaceId: defaultId, name: "Default workspace", members: 0, admins: [] },
      { workspaceId: memberOnly, members: 1, admins: ["workspace-admin"] },
      { workspaceId: receiptOnly, members: 0, admins: [] },
      { workspaceId: promoted, members: 0, admins: [] },
      { workspaceId: docOnly, name: "Stored project", members: 0, admins: [] },
      { workspaceId: invalidName, members: 0, admins: [] },
      { workspaceId: unreadable, members: 0, admins: [] },
    ]));
    expect(JSON.stringify(inventory)).not.toContain("document content must stay private");
    expect(() => hubAdmins.listWorkspaces(workspaceAdmin.id)).toThrow("hub-admin-required");
    expect(claims.state(true)).toEqual({ unclaimed: true, canClaim: true });
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
