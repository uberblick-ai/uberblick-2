import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getWorkspaceName, setWorkspaceName, validateWorkspaceName } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { SetupReceipts } from "../src/admin-setup.js";
import { CredentialRegistry } from "../src/credentials.js";
import { GithubSignIn, type SignInCollection } from "../src/github-sign-in.js";
import { HubClaimState } from "../src/hub-claim.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { PrincipalRegistry } from "../src/principals.js";
import { createHub, type Hub } from "../src/server.js";
import { silentLogger } from "../src/log.js";
import { TEST_SECRET, WORKSPACE } from "./helpers.js";

const CLIENT_ID = "Iv1.0123456789abcdef";
const directories: string[] = [];
const databases: HubDatabase[] = [];
const flows: GithubSignIn[] = [];
const hubs: Hub[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), `ub-${process.env.UB_AGENTS_RUN ?? "test"}-claim-`));
  directories.push(directory);
  return join(directory, "hub.sqlite");
}

function rig(path = databasePath(), initialize = true) {
  const database = new HubDatabase(path, () => {});
  database.open();
  databases.push(database);
  const principals = new PrincipalRegistry(database);
  const memberships = new MembershipRegistry(database);
  const credentials = new CredentialRegistry(database);
  const receipts = new SetupReceipts(database);
  const claims = initialize ? new HubClaimState(database) : undefined;
  return { database, principals, memberships, credentials, receipts, claims };
}

function rows(testRig: ReturnType<typeof rig>) {
  const db = testRig.database.connection;
  return Object.fromEntries([
    "documents", "hub_principals", "hub_memberships", "hub_credentials", "hub_admin_setup_grants", "hub_claim_state",
  ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
}

function defaultWorkspace(testRig: ReturnType<typeof rig>): string {
  const id = testRig.database.connection.prepare("SELECT default_workspace_id FROM hub_claim_state WHERE id = 1")
    .get()?.default_workspace_id;
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return id as string;
}

function storedSettings(testRig: ReturnType<typeof rig>, workspaceId: string): Y.Doc {
  const row = testRig.database.connection.prepare("SELECT data FROM documents WHERE name = ?")
    .get(`${workspaceId}/_settings`);
  expect(row?.data).toBeInstanceOf(Uint8Array);
  const settings = new Y.Doc();
  Y.applyUpdate(settings, row!.data as Uint8Array);
  return settings;
}

/** Distinct requests retain their approving account even while another one finishes. */
class GithubFake {
  time = 1000;
  account = { id: 1234, login: "first-approver" };
  pauseIdentity: ((accountId: number) => Promise<void>) | undefined;
  private readonly accounts = new Map<string, { id: number; login: string }>();
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/device/code") {
      const code = `private-device-code-${this.accounts.size}`;
      this.accounts.set(code, { ...this.account });
      return Response.json({ device_code: code, user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      const code = new URLSearchParams(String(init?.body)).get("device_code");
      expect(this.accounts.has(code!)).toBe(true);
      return Response.json({ access_token: code, token_type: "bearer", scope: "" });
    }
    expect(url).toBe("https://api.github.com/user");
    const code = new Headers(init?.headers).get("Authorization")!.slice("Bearer ".length);
    const account = this.accounts.get(code)!;
    await this.pauseIdentity?.(account.id);
    return Response.json(account);
  };
}

function signIn(testRig: ReturnType<typeof rig>, github = new GithubFake()) {
  const flow = new GithubSignIn({ clientId: CLIENT_ID, fetch: github.fetch, now: () => github.time },
    testRig.database, testRig.principals, testRig.credentials, testRig.memberships, silentLogger, testRig.claims);
  flows.push(flow);
  return { flow, github };
}

async function pending(flow: GithubSignIn) {
  const request = await flow.start();
  if (request.status !== "pending") throw new Error("sign-in did not start");
  return request;
}

type Complete = Extract<SignInCollection, { status: "complete" }>;
async function complete(flow: GithubSignIn, github: GithubFake): Promise<Complete> {
  const request = await pending(flow);
  github.time += 1000;
  const result = await flow.collect(request.requestId, request.collectionSecret);
  if (result.status !== "complete") throw new Error(`sign-in ended with ${result.status}`);
  return result;
}

afterEach(async () => {
  for (const flow of flows.splice(0)) flow.stop();
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("fresh deployed hub initialization", () => {
  it("the deployed entry point initializes an empty hub and reuses its state on replacement", async () => {
    const path = databasePath();
    const startDeployment = async () => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
        fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
        cwd: tmpdir(), timeout: 5000, stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, HUB_AUTH_TOKEN: TEST_SECRET, HUB_DB_PATH: path, HUB_HOST: "127.0.0.1", PORT: "0", HUB_GITHUB_CLIENT_ID: "" },
      });
      const exited = once(child, "exit");
      try {
        const port = await new Promise<number>((resolve, reject) => {
          let output = "";
          child.on("error", reject);
          child.once("exit", () => reject(new Error("deployed hub exited before listening")));
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            output += chunk;
            for (;;) {
              const newline = output.indexOf("\n");
              if (newline < 0) break;
              const line = output.slice(0, newline);
              output = output.slice(newline + 1);
              try {
                const record = JSON.parse(line);
                if (record.event === "hub.listen") resolve(record.port);
              } catch { /* Node warnings are not hub log records. */ }
            }
          });
        });
        const response = await fetch(`http://127.0.0.1:${port}/auth/claim-state`, { signal: AbortSignal.timeout(2000) });
        expect(await response.json()).toEqual({ unclaimed: true, canClaim: true });
        const database = new DatabaseSync(path, { readOnly: true });
        try { return database.prepare("SELECT * FROM hub_claim_state").all(); }
        finally { database.close(); }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
      }
    };
    const first = await startDeployment();
    expect(first).toHaveLength(1);
    expect(first[0]!.default_workspace_id).toEqual(expect.any(String));
    expect(await startDeployment()).toEqual(first);
  });

  it("initializes empty schemas once and preserves the workspace and later rename across restart", () => {
    const first = rig();
    const workspaceId = defaultWorkspace(first);
    const settings = storedSettings(first, workspaceId);
    try {
      const name = getWorkspaceName(settings);
      expect(name).not.toBeNull();
      expect(validateWorkspaceName(name!)).toBe(name);
      setWorkspaceName(settings, "Renamed team workspace");
      first.database.connection.prepare("UPDATE documents SET data = ? WHERE name = ?")
        .run(Y.encodeStateAsUpdate(settings), `${workspaceId}/_settings`);
    } finally { settings.destroy(); }
    expect(first.claims!.state(true)).toEqual({ unclaimed: true, canClaim: true });
    expect(first.claims!.state(false)).toEqual({ unclaimed: true, canClaim: false });
    new HubClaimState(first.database);
    const before = rows(first);
    const path = first.database.databasePath;
    first.database.close();
    const restarted = rig(path);
    expect(defaultWorkspace(restarted)).toBe(workspaceId);
    expect(rows(restarted)).toEqual(before);
    expect(rows(restarted).documents).toHaveLength(1);
    const renamed = storedSettings(restarted, workspaceId);
    try { expect(getWorkspaceName(renamed)).toBe("Renamed team workspace"); }
    finally { renamed.destroy(); }
  });

  it.each(["documents", "principals", "credentials", "memberships", "receipts"])(
    "seals an existing installation with only %s, permanently even if those rows are removed", (family) => {
      const old = rig(undefined, false);
      if (family === "documents") old.database.connection.prepare("INSERT INTO documents(name, data) VALUES (?, ?)")
        .run(`${WORKSPACE}/_settings`, Uint8Array.of(0, 0));
      if (family === "principals") old.principals.identify("1234", "existing-identity");
      if (family === "credentials") old.credentials.issue({ principalId: "existing-principal", deviceId: "old-device", workspaces: [] });
      if (family === "memberships") old.memberships.grant({ workspaceId: WORKSPACE, principalId: "existing-principal", role: "member" });
      if (family === "receipts") old.receipts.save({ status: "complete", setupId: crypto.randomUUID(), workspaceId: WORKSPACE,
        identity: { id: "old-principal", githubAccountId: "1234", githubUsername: "existing-identity" }, hadDocuments: false });
      const documents = old.database.connection.prepare("SELECT * FROM documents").all();
      const claims = new HubClaimState(old.database);
      expect(claims.state(true)).toEqual({ unclaimed: false, canClaim: false });
      expect(old.database.connection.prepare("SELECT default_workspace_id FROM hub_claim_state").get()?.default_workspace_id).toBeNull();
      expect(old.database.connection.prepare("SELECT * FROM documents").all()).toEqual(documents);
      for (const table of ["documents", "hub_principals", "hub_credentials", "hub_memberships", "hub_admin_setup_grants"]) {
        old.database.connection.exec(`DELETE FROM ${table}`);
      }
      const path = old.database.databasePath;
      old.database.close();
      const restarted = rig(path);
      expect(restarted.claims!.state(true)).toEqual({ unclaimed: false, canClaim: false });
      expect(rows(restarted).documents).toEqual([]);
    },
  );

  it("rolls back an interrupted initialization and retries without a partial workspace", () => {
    const testRig = rig(undefined, false);
    testRig.database.connection.exec(`CREATE TABLE hub_claim_state (
      id INTEGER PRIMARY KEY CHECK(id = 1), default_workspace_id TEXT,
      unclaimed INTEGER NOT NULL CHECK(unclaimed IN (0, 1))
    ); CREATE TRIGGER initialize_failure BEFORE INSERT ON hub_claim_state
      BEGIN SELECT RAISE(ABORT, 'injected initialization failure'); END`);
    expect(() => new HubClaimState(testRig.database)).toThrow("injected initialization failure");
    expect(testRig.database.connection.prepare("SELECT * FROM documents").all()).toEqual([]);
    expect(testRig.database.connection.prepare("SELECT * FROM hub_claim_state").all()).toEqual([]);
    testRig.database.connection.exec("DROP TRIGGER initialize_failure");
    expect(new HubClaimState(testRig.database).state(true)).toEqual({ unclaimed: true, canClaim: true });
    expect(testRig.database.connection.prepare("SELECT * FROM documents").all()).toHaveLength(1);
  });
});

describe("first-completed GitHub sign-in claim", () => {
  it("claims with the issued credential and never changes membership on later sign-ins", async () => {
    const testRig = rig();
    const workspaceId = defaultWorkspace(testRig);
    const { flow, github } = signIn(testRig);
    const claim = await complete(flow, github);
    expect(claim.claimedWorkspaceId).toBe(workspaceId);
    expect(claim.credential.record.workspaces).toEqual([workspaceId]);
    expect(rows(testRig).hub_memberships).toEqual([{ workspace_id: workspaceId, principal_id: claim.identity.id, role: "admin" }]);
    const membership = rows(testRig).hub_memberships;
    const again = await complete(flow, github);
    expect(again).not.toHaveProperty("claimedWorkspaceId");
    expect(again.credential.record.workspaces).toEqual([workspaceId]);
    github.account = { id: 5678, login: "later-account" };
    const other = await complete(flow, github);
    expect(other).not.toHaveProperty("claimedWorkspaceId");
    expect(other.credential.record.workspaces).toEqual([]);
    expect(rows(testRig).hub_memberships).toEqual(membership);
    expect(testRig.claims!.state(true)).toEqual({ unclaimed: false, canClaim: false });
  });

  it("reserves nothing at start and lets a later-started approval complete first", async () => {
    const testRig = rig();
    const workspaceId = defaultWorkspace(testRig);
    const { flow, github } = signIn(testRig);
    const first = await pending(flow);
    github.account = { id: 5678, login: "faster-approver" };
    const second = await pending(flow);
    expect(testRig.claims!.state(true)).toEqual({ unclaimed: true, canClaim: true });
    expect(rows(testRig).hub_memberships).toEqual([]);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    github.pauseIdentity = async (accountId) => { if (accountId === 1234) { enter(); await resumed; } };
    github.time += 1000;
    const collectingFirst = flow.collect(first.requestId, first.collectionSecret);
    await entered;
    const winner = await flow.collect(second.requestId, second.collectionSecret);
    expect(winner).toMatchObject({ status: "complete", claimedWorkspaceId: workspaceId, identity: { githubAccountId: "5678" } });
    resume();
    const loser = await collectingFirst;
    expect(loser).toMatchObject({ status: "complete", identity: { githubAccountId: "1234" }, credential: { record: { workspaces: [] } } });
    expect(loser).not.toHaveProperty("claimedWorkspaceId");
    expect(rows(testRig).hub_memberships).toHaveLength(1);
    expect(rows(testRig).hub_credentials).toHaveLength(2);
  });

  it("rolls back identity, membership and claim if credential issuance fails, then permits another claimant", async () => {
    const testRig = rig();
    const { flow, github } = signIn(testRig);
    const before = rows(testRig);
    testRig.database.connection.exec(`CREATE TRIGGER credential_failure BEFORE INSERT ON hub_credentials
      BEGIN SELECT RAISE(ABORT, 'injected credential failure'); END`);
    const request = await pending(flow);
    github.time += 1000;
    expect(await flow.collect(request.requestId, request.collectionSecret)).toEqual({ status: "failed" });
    expect(rows(testRig)).toEqual(before);
    testRig.database.connection.exec("DROP TRIGGER credential_failure");
    github.account = { id: 5678, login: "successful-approver" };
    expect(await complete(flow, github)).toMatchObject({ claimedWorkspaceId: defaultWorkspace(testRig), identity: { githubAccountId: "5678" } });
  });

  it.each(["cancel", "expire", "stop"])("%s before completion leaves claiming open", async (action) => {
    const testRig = rig();
    const { flow, github } = signIn(testRig);
    const before = rows(testRig);
    const request = await pending(flow);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    github.pauseIdentity = async () => { enter(); await resumed; };
    github.time += 1000;
    const collecting = flow.collect(request.requestId, request.collectionSecret);
    await entered;
    if (action === "cancel") flow.cancel(request.requestId, request.collectionSecret);
    if (action === "expire") github.time += 900_000;
    if (action === "stop") flow.stop();
    resume();
    expect(await collecting).toEqual({ status: action === "cancel" ? "abandoned" : action === "expire" ? "expired" : "failed" });
    expect(rows(testRig)).toEqual(before);
    expect(testRig.claims!.state(true)).toEqual({ unclaimed: true, canClaim: true });
  });

  it("keeps an uncollected response's committed claim after restart and restores access on the account's next login", async () => {
    const first = rig();
    const workspaceId = defaultWorkspace(first);
    const { flow, github } = signIn(first);
    const request = await pending(flow);
    github.time += 1000;
    // Completion commits independently of delivery to the machine. Drop its
    // one-time result, then destroy all in-memory approval state by restarting.
    await flow.collect(request.requestId, request.collectionSecret);
    flow.stop();
    const path = first.database.databasePath;
    first.database.close();
    const restarted = rig(path);
    const next = signIn(restarted);
    const result = await complete(next.flow, next.github);
    expect(result).not.toHaveProperty("claimedWorkspaceId");
    expect(result.credential.record.workspaces).toEqual([workspaceId]);
    expect(restarted.claims!.state(true)).toEqual({ unclaimed: false, canClaim: false });
    expect(rows(restarted).hub_memberships).toHaveLength(1);
  });
});

describe("credential-free claim-state report", () => {
  it.each([true, false])("reports only the two facts with GitHub configured=%s and mutates nothing", async (configured) => {
    const path = databasePath();
    const hub = await createHub({ authSecret: TEST_SECRET, databasePath: path, address: "127.0.0.1", port: 0, log: silentLogger,
      ...(configured ? { github: { clientId: CLIENT_ID } } : {}),
    }, { initializeDefaultWorkspace: true });
    hubs.push(hub);
    const inspect = rig(path);
    const before = rows(inspect);
    const response = await fetch(`http://127.0.0.1:${hub.port}/auth/claim-state`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ unclaimed: true, canClaim: configured });
    expect(rows(inspect)).toEqual(before);
  });

  it("leaves local hubs uninitialized even when GitHub is configured", async () => {
    const path = databasePath();
    const github = new GithubFake();
    const hub = await createHub({ authSecret: TEST_SECRET, databasePath: path, address: "127.0.0.1", port: 0,
      log: silentLogger, github: { clientId: CLIENT_ID, fetch: github.fetch, now: () => github.time } });
    hubs.push(hub);
    expect(await (await fetch(`http://127.0.0.1:${hub.port}/auth/claim-state`)).json())
      .toEqual({ unclaimed: false, canClaim: false });
    const inspect = rig(path, false);
    expect(inspect.database.connection.prepare("SELECT * FROM documents").all()).toEqual([]);
    expect(inspect.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'hub_claim_state'").get()).toBeUndefined();
    const post = (route: string, body: unknown) => fetch(`http://127.0.0.1:${hub.port}/auth/github/${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const login = await (await post("start", {})).json() as Awaited<ReturnType<GithubSignIn["start"]>>;
    if (login.status !== "pending") throw new Error("sign-in did not start");
    github.time += 1000;
    const result = await (await post("collect", { requestId: login.requestId, collectionSecret: login.collectionSecret })).json() as Complete;
    expect(result.status).toBe("complete");
    expect(result).not.toHaveProperty("claimedWorkspaceId");
    expect(result.credential.record.workspaces).toEqual([]);
    expect(inspect.database.connection.prepare("SELECT * FROM hub_memberships").all()).toEqual([]);
  });
});
