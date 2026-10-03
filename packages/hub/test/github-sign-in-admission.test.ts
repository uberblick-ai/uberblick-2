/** Sign-in issues credentials from the same authority composed admission reads. */
import { Server } from "@hocuspocus/server";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialAdmission, type CredentialContext } from "../src/credential-admission.js";
import { CredentialRegistry } from "../src/credentials.js";
import { GithubSignIn, type SignInCollection } from "../src/github-sign-in.js";
import { silentLogger } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { PrincipalRegistry } from "../src/principals.js";
import { SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import { importCredentialKey, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "../src/token.js";
import {
  createClient, OTHER_WORKSPACE, removeTempDatabases, tempDatabasePath,
  testRoom, type TestClient, waitForText, WORKSPACE,
} from "./helpers.js";

type CompletedSignIn = Extract<SignInCollection, { status: "complete" }>;
const FOREIGN_WORKSPACE = "7fba0bdd-04f0-4b37-9a74-c7fdd86695be";
const clients: TestClient[] = [];
const servers: Server<CredentialContext>[] = [];
const databases: HubDatabase[] = [];
const signIns: GithubSignIn[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const signIn of signIns.splice(0)) signIn.stop();
  for (const server of servers.splice(0)) await server.destroy();
  for (const database of databases.splice(0)) database.close();
  removeTempDatabases();
});

async function startServer() {
  const database = new HubDatabase(tempDatabasePath(), () => {});
  database.open();
  databases.push(database);
  const principals = new PrincipalRegistry(database);
  const credentials = new CredentialRegistry(database);
  const memberships = new MembershipRegistry(database);
  let now = 1000;
  const signIn = new GithubSignIn({
    clientId: "Iv1.0123456789abcdef", now: () => now,
    fetch: async (url) => {
      const body = String(url) === "https://github.com/login/device/code"
        ? { device_code: "github-private-device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }
        : String(url) === "https://github.com/login/oauth/access_token"
          ? { access_token: "github-private-token", token_type: "bearer", scope: "" }
          : String(url) === "https://api.github.com/user"
            ? { id: 1234, login: "signed-in-person", site_admin: true, public_repos: 1000 }
            : null;
      if (body === null) throw new Error("unexpected GitHub endpoint");
      return Response.json(body);
    },
  }, principals, credentials, memberships);
  signIns.push(signIn);
  const server = new Server<CredentialContext>({
    port: 0, address: "127.0.0.1", quiet: true, stopOnSignals: false,
    extensions: [database, new CredentialAdmission(credentials, memberships, {
      protocolVersion: SYNC_PROTOCOL_VERSION, log: silentLogger,
    })],
  });
  servers.push(server);
  await server.listen();
  return {
    port: server.address.port, database, principals, credentials, memberships,
    async completeSignIn(): Promise<CompletedSignIn> {
      const started = await signIn.start();
      if (started.status !== "pending") throw new Error("sign-in did not start");
      now += 1000;
      const collected = await signIn.collect(started.requestId, started.collectionSecret);
      if (collected.status !== "complete") throw new Error("sign-in did not complete");
      return collected;
    },
  };
}

function membershipSnapshot(database: HubDatabase) {
  return database.connection.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all();
}

async function credentialToken(signedIn: CompletedSignIn, workspace: string) {
  return mintToken(await importCredentialKey(Buffer.from(signedIn.credential.key, "base64url")), {
    typ: "room", sub: signedIn.identity.id, workspace, scope: "read-write",
    kid: signedIn.credential.record.id, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });
}

function connect(port: number, room: string, token: string) {
  const client = createClient({ port, room, token, reconnectDelayMs: 60_000 });
  clients.push(client);
  return client;
}

describe("signed-in credentials on composed admission", () => {
  it("identifies a nonmember without granting membership or admitting any workspace", async () => {
    const rig = await startServer();
    rig.memberships.grant({ workspaceId: WORKSPACE, principalId: "existing-admin", role: "admin" });
    const before = membershipSnapshot(rig.database);
    const signedIn = await rig.completeSignIn();
    expect(rig.principals.findByGithubAccountId("1234")).toEqual(signedIn.identity);
    expect(signedIn.credential.record.workspaces).toEqual([]);
    expect(rig.credentials.get(signedIn.credential.record.id)).toEqual(signedIn.credential.record);
    expect(membershipSnapshot(rig.database)).toEqual(before);
    for (const workspace of [WORKSPACE, OTHER_WORKSPACE]) {
      const refused = connect(rig.port, testRoom(workspace), await credentialToken(signedIn, workspace));
      await expect(refused.denied).resolves.toBe("invalid-token");
    }
  });

  it("issues exactly current memberships and admits only the member's own workspace rooms", async () => {
    const rig = await startServer();
    const principal = rig.principals.identify("1234", "previous-username");
    for (const workspaceId of [WORKSPACE, OTHER_WORKSPACE, FOREIGN_WORKSPACE]) {
      rig.memberships.grant({ workspaceId, principalId: "existing-admin", role: "admin" });
    }
    for (const workspaceId of [WORKSPACE, OTHER_WORKSPACE]) {
      rig.memberships.grant({ workspaceId, principalId: principal.id, role: "member" });
    }
    const before = membershipSnapshot(rig.database);
    const signedIn = await rig.completeSignIn();
    expect(signedIn.identity.id).toBe(principal.id);
    expect(signedIn.credential.record.workspaces).toEqual([WORKSPACE, OTHER_WORKSPACE].sort());
    expect(membershipSnapshot(rig.database)).toEqual(before);
    for (const workspace of [WORKSPACE, OTHER_WORKSPACE]) {
      const room = testRoom(workspace);
      const token = await credentialToken(signedIn, workspace);
      const writer = connect(rig.port, room, token);
      const observer = connect(rig.port, room, token);
      await Promise.all([writer.synced, observer.synced]);
      writer.text.insert(0, "member can edit own workspace");
      await waitForText("own-workspace observer", observer.text, "member can edit own workspace");
    }
    const refused = connect(rig.port, testRoom(FOREIGN_WORKSPACE), await credentialToken(signedIn, FOREIGN_WORKSPACE));
    await expect(refused.denied).resolves.toBe("invalid-token");
    expect(membershipSnapshot(rig.database)).toEqual(before);
  });
});
