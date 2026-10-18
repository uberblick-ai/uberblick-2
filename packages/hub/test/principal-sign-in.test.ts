import { afterEach, describe, expect, it } from "vitest";
import { BrowserSessions } from "../src/browser-sessions.js";
import { CREDENTIAL_SCHEMA } from "../src/credentials-schema.js";
import { CredentialRegistry } from "../src/credentials.js";
import { GithubSignIn } from "../src/github-sign-in.js";
import { silentLogger } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { PrincipalRegistry } from "../src/principals.js";
import { collectDeviceSignIn, startDeviceSignIn } from "./device-credentials.js";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

const databases: HubDatabase[] = [];
const flows: GithubSignIn[] = [];

afterEach(() => {
  for (const flow of flows.splice(0)) flow.stop();
  for (const database of databases.splice(0)) database.close();
  removeTempDatabases();
});

function open(path = tempDatabasePath()) {
  const database = new HubDatabase(path, () => {});
  database.open();
  databases.push(database);
  return database;
}

function legacyDatabase() {
  const database = open();
  database.connection.exec(`CREATE TABLE hub_principals (
    id TEXT PRIMARY KEY NOT NULL, github_account_id TEXT UNIQUE NOT NULL, github_username TEXT NOT NULL
  );
  INSERT INTO hub_principals VALUES ('device', '1', 'device-person'), ('browser', '2', 'browser-person'),
    ('expired', '3', 'expired-person'), ('lookup', '4', 'lookup-person');`);
  database.connection.exec(CREDENTIAL_SCHEMA);
  database.connection.exec(`INSERT INTO hub_credentials
    (id, principal_id, device_id, workspaces, issued_at, revoked_at)
    VALUES ('revoked', 'device', 'old-device', '[]', 1, 2)`);
  new BrowserSessions(database);
  database.connection.exec(`INSERT INTO hub_browser_sessions VALUES
    ('active', 'browser', 'https://hub.example', 3000),
    ('ended', 'expired', 'https://hub.example', 2000)`);
  return database;
}

describe("durable completed-sign-in eligibility", () => {
  it("does not treat identity lookup as sign-in and keeps sign-in attached to the durable account", () => {
    const database = open();
    const principals = new PrincipalRegistry(database);
    const old = principals.identify("1234", "shared-login");
    expect(principals.hasSignedIn(old.id)).toBe(false);
    principals.recordSignIn(old.id);
    const other = principals.identify("5678", "SHARED-LOGIN");
    expect(principals.findByGithubUsername("Shared-Login")).toEqual([old, other]);
    expect(principals.hasSignedIn(other.id)).toBe(false);
    expect(principals.identify("1234", "renamed").id).toBe(old.id);
    expect(principals.hasSignedIn(old.id)).toBe(true);
    expect(principals.hasSignedIn("unknown")).toBe(false);
  });

  it("backfills revoked devices and unexpired browser sessions once without changing either history", () => {
    const database = legacyDatabase();
    const credentials = database.connection.prepare("SELECT * FROM hub_credentials").all();
    const sessions = database.connection.prepare("SELECT * FROM hub_browser_sessions").all();
    const principals = new PrincipalRegistry(database, () => 2000);
    expect(["device", "browser", "expired", "lookup"].map(id => principals.hasSignedIn(id)))
      .toEqual([true, true, false, false]);
    expect(database.connection.prepare("SELECT * FROM hub_credentials").all()).toEqual(credentials);
    expect(database.connection.prepare("SELECT * FROM hub_browser_sessions").all()).toEqual(sessions);
    database.connection.exec("DELETE FROM hub_browser_sessions");
    const path = database.databasePath;
    database.close();
    const restarted = new PrincipalRegistry(open(path), () => 4000);
    expect(restarted.hasSignedIn("device")).toBe(true);
    expect(restarted.hasSignedIn("browser")).toBe(true);
    expect(restarted.hasSignedIn("expired")).toBe(false);
    expect(restarted.hasSignedIn("lookup")).toBe(false);
  });

  it("rolls back the eligibility migration when evidence cannot be read, allowing a complete retry", () => {
    const database = legacyDatabase();
    database.connection.exec("ALTER TABLE hub_browser_sessions RENAME COLUMN expires_at TO malformed_expiry");
    expect(() => new PrincipalRegistry(database, () => 2000)).toThrow();
    expect(database.connection.prepare("PRAGMA table_info(hub_principals)").all()
      .some(column => column.name === "has_signed_in")).toBe(false);
    database.connection.exec("ALTER TABLE hub_browser_sessions RENAME COLUMN malformed_expiry TO expires_at");
    const principals = new PrincipalRegistry(database, () => 2000);
    expect(principals.hasSignedIn("device")).toBe(true);
    expect(principals.hasSignedIn("browser")).toBe(true);
  });

  it.each(["device", "browser"])("commits eligibility only with successful %s sign-in issuance", async kind => {
    const database = open();
    const principals = new PrincipalRegistry(database);
    const account = principals.identify("1234", "signed-in-person");
    const credentials = new CredentialRegistry(database);
    const memberships = new MembershipRegistry(database);
    let now = 1000;
    const flow = new GithubSignIn({ clientId: "Iv1.0123456789abcdef", now: () => now,
      fetch: async input => Response.json(String(input).endsWith("/device/code")
        ? { device_code: "private", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }
        : String(input).endsWith("/access_token")
          ? { access_token: "private", token_type: "bearer", scope: "" }
          : { id: 1234, login: "signed-in-person" }),
    }, database, principals, credentials, memberships, silentLogger);
    flows.push(flow);
    const table = kind === "device" ? "hub_credentials" : "hub_browser_sessions";
    database.connection.exec(`CREATE TRIGGER fail_issuance BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'injected issuance failure'); END`);
    async function complete() {
      const started = kind === "device" ? await startDeviceSignIn(flow) : await flow.startBrowser("https://hub.example");
      if (started.status !== "pending") throw new Error("sign-in did not start");
      now += 1000;
      return kind === "device"
        ? collectDeviceSignIn(flow, started.requestId, started.collectionSecret)
        : flow.collectBrowser(started.requestId, started.collectionSecret, "https://hub.example");
    }
    expect(await complete()).toEqual({ status: "failed" });
    expect(principals.hasSignedIn(account.id)).toBe(false);
    database.connection.exec("DROP TRIGGER fail_issuance");
    const signedIn = await complete();
    expect(signedIn.status).toBe("complete");
    expect(principals.hasSignedIn(account.id)).toBe(true);
    if (signedIn.status !== "complete") throw new Error("sign-in did not complete");
    if ("credential" in signedIn) credentials.revoke(signedIn.credential.record.id);
    else flow.signOutBrowser(signedIn.session.token, "https://hub.example");
    expect(principals.hasSignedIn(account.id)).toBe(true);
    expect(memberships.workspacesFor(account.id)).toEqual([]);
    if (kind === "browser") expect(credentials.listDevices(account.id)).toEqual([]);
    const path = database.databasePath;
    database.close();
    expect(new PrincipalRegistry(open(path)).hasSignedIn(account.id)).toBe(true);
  });
});
