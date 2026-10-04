import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminSocketPath, SetupReceipts, startAdminSetup, type SetupGrant } from "../src/admin-setup.js";
import { CredentialRegistry } from "../src/credentials.js";
import { GithubSignIn } from "../src/github-sign-in.js";
import { HubClaimState } from "../src/hub-claim.js";
import type { HubLogRecord } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { PrincipalRegistry } from "../src/principals.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "00000000-0000-4000-8000-000000000002";
const THIRD_WORKSPACE = "00000000-0000-4000-8000-000000000003";
const CLIENT_ID = "Iv23AbCdEF0123456789";
const TOKEN = "ghu_private-setup-token";
const REFRESH_TOKEN = "ghr_private-refresh-token";
const DEVICE_CODE = "private-github-device-code";
const directories: string[] = [];
const controls: TestRig[] = [];
const clients: HostClient[] = [];
const signIns: GithubSignIn[] = [];
let originalDirectory: string;

class GithubFake {
  time = 1000;
  account = { id: 1234, login: "approving-account" };
  tokenResult: Record<string, unknown> | undefined;
  failedUrl: string | undefined;
  pauseIdentity: ((signal: AbortSignal) => Promise<void>) | undefined;
  calls: string[] = [];
  private accounts = new Map<string, { id: number; login: string }>();
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.calls.push(url);
    if (this.failedUrl === url) throw new Error(`${TOKEN} ${REFRESH_TOKEN}`);
    if (url === "https://github.com/login/device/code") {
      const code = `${DEVICE_CODE}-${this.accounts.size}`;
      this.accounts.set(code, { ...this.account });
      return Response.json({ device_code: code, user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      const code = new URLSearchParams(String(init?.body)).get("device_code");
      expect(this.accounts.has(code!)).toBe(true);
      return Response.json(this.tokenResult ?? { access_token: `${TOKEN}:${code}`, refresh_token: REFRESH_TOKEN, token_type: "bearer", scope: "" });
    }
    expect(url).toBe("https://api.github.com/user");
    const token = new Headers(init?.headers).get("Authorization")!;
    const code = token.slice(`Bearer ${TOKEN}:`.length);
    expect(this.accounts.has(code)).toBe(true);
    await this.pauseIdentity?.(init!.signal!);
    return Response.json(this.accounts.get(code));
  };
}

type Message = Record<string, unknown>;

class HostClient {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  readonly output: Message[] = [];
  private waiting: ((value: Message) => void)[] = [];
  private queued: Message[] = [];
  constructor(path: string) {
    this.socket = createConnection(path);
    this.socket.setEncoding("utf8");
    let input = "";
    this.socket.on("data", (chunk: string) => {
      input += chunk;
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(input.slice(0, newline)) as Message;
        input = input.slice(newline + 1);
        this.output.push(message);
        const waiter = this.waiting.shift();
        if (waiter === undefined) this.queued.push(message);
        else waiter(message);
      }
    });
    this.socket.on("error", () => {});
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));
    clients.push(this);
  }
  send(message: unknown): void { this.socket.write(`${JSON.stringify(message)}\n`); }
  async next(): Promise<Message> {
    const queued = this.queued.shift();
    return queued ?? new Promise((resolve) => this.waiting.push(resolve));
  }
}

interface TestRig {
  database: HubDatabase;
  principals: PrincipalRegistry;
  memberships: MembershipRegistry;
  credentials: CredentialRegistry;
  claims: HubClaimState | undefined;
  github: GithubFake;
  logs: HubLogRecord[];
  liveWorkspaces: Set<string>;
  control: Awaited<ReturnType<typeof startAdminSetup>>;
  stop(): Promise<void>;
}

async function rig(options: { databasePath?: string; configured?: boolean; onGrant?: () => void; initialize?: boolean } = {}): Promise<TestRig> {
  const directory = options.databasePath === undefined
    ? mkdtempSync(join(tmpdir(), `ub-${process.env.UB_AGENTS_RUN ?? "admin-setup"}-`)) : undefined;
  if (directory !== undefined) directories.push(directory);
  const database = new HubDatabase(options.databasePath ?? join(directory!, "hub.sqlite"), () => {});
  database.open();
  const claims = options.initialize ? new HubClaimState(database) : undefined;
  const principals = new PrincipalRegistry(database);
  const memberships = new MembershipRegistry(database);
  const credentials = new CredentialRegistry(database);
  const github = new GithubFake();
  const logs: HubLogRecord[] = [];
  const liveWorkspaces = new Set<string>();
  let control: Awaited<ReturnType<typeof startAdminSetup>>;
  try {
    control = await startAdminSetup({ database, principals, memberships, claims,
      ...(options.configured === false ? {} : { github: { clientId: CLIENT_ID, fetch: github.fetch, now: () => github.time } }),
      hasLiveDocuments: (workspaceId) => liveWorkspaces.has(workspaceId),
      log: (record) => { logs.push(record); if (record.event === "hub.admin-setup.granted") options.onGrant?.(); },
    });
  } catch (error) {
    database.close();
    throw error;
  }
  let stopped = false;
  const result = { database, principals, memberships, credentials, claims, github, logs, liveWorkspaces, control,
    async stop() {
      if (stopped) return;
      stopped = true;
      await control.stop();
      database.close();
    },
  };
  controls.push(result);
  return result;
}

async function pending(testRig: TestRig, workspaceId = WORKSPACE) {
  const client = new HostClient(testRig.control.path);
  client.send({ action: "start", workspaceId });
  const starting = await client.next();
  expect(starting).toMatchObject({ status: "starting", workspaceId });
  const approval = await client.next();
  expect(approval).toEqual({ status: "pending", setupId: starting.setupId, workspaceId,
    verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", expiresIn: 900 });
  return { client, setupId: starting.setupId as string };
}

async function tick(testRig: TestRig, milliseconds = 1000) {
  testRig.github.time += milliseconds;
  await vi.advanceTimersByTimeAsync(milliseconds);
}

function rows(testRig: TestRig) {
  const db = testRig.database.connection;
  return { documents: db.prepare("SELECT * FROM documents ORDER BY name").all(),
    principals: db.prepare("SELECT * FROM hub_principals ORDER BY id").all(),
    memberships: db.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all(),
    credentials: db.prepare("SELECT * FROM hub_credentials ORDER BY id").all(),
    receipts: db.prepare("SELECT * FROM hub_admin_setup_grants ORDER BY setup_id").all(),
    claimState: testRig.claims === undefined ? undefined : db.prepare("SELECT * FROM hub_claim_state").all() };
}

function publicSignIn(testRig: TestRig) {
  const flow = new GithubSignIn({ clientId: CLIENT_ID, fetch: testRig.github.fetch, now: () => testRig.github.time },
    testRig.database, testRig.principals, testRig.credentials, testRig.memberships, () => {}, testRig.claims);
  signIns.push(flow);
  return flow;
}

function defaultWorkspace(testRig: TestRig): string {
  return testRig.database.connection.prepare("SELECT default_workspace_id FROM hub_claim_state").get()!.default_workspace_id as string;
}

function identityPause(github: GithubFake) {
  let enter!: () => void;
  let resume!: () => void;
  let abort!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  const aborted = new Promise<void>((resolve) => { abort = resolve; });
  github.pauseIdentity = async (signal) => {
    signal.addEventListener("abort", abort, { once: true });
    enter();
    await resumed;
  };
  return { entered, aborted, resume };
}

beforeEach(() => {
  originalDirectory = process.cwd();
  // Private run scratch can have a long absolute path. Use short relative
  // socket paths inside it without weakening the production sockaddr guard.
  process.chdir(tmpdir());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(async () => {
  try {
    for (const flow of signIns.splice(0)) flow.stop();
    for (const client of clients.splice(0)) client.socket.destroy();
    for (const testRig of controls.splice(0)) await testRig.stop();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  } finally {
    vi.useRealTimers();
    process.chdir(originalDirectory);
  }
});

describe("host-only first-admin setup", () => {
  it.each(["insecure-directory", "symlink-directory", "occupied-path"])("refuses %s rather than exposing or replacing control", async (obstruction) => {
    const directory = mkdtempSync(join(tmpdir(), `ub-${process.env.UB_AGENTS_RUN ?? "admin-setup"}-`));
    directories.push(directory);
    const databasePath = join(directory, "hub.sqlite");
    const privateDirectory = `${databasePath}.admin`;
    if (obstruction === "symlink-directory") {
      const target = join(directory, "other");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, privateDirectory);
    } else {
      mkdirSync(privateDirectory, { mode: 0o700 });
      if (obstruction === "insecure-directory") chmodSync(privateDirectory, 0o755);
      else writeFileSync(join(privateDirectory, "control.sock"), "do not replace");
    }
    await expect(rig({ databasePath })).rejects.toThrow(obstruction === "occupied-path" ? "not a socket" : "mode 0700");
  });

  it("refuses another live listener without unlinking it", async () => {
    const testRig = await rig();
    await expect(startAdminSetup({ database: testRig.database, principals: testRig.principals,
      memberships: testRig.memberships, log: () => {}, hasLiveDocuments: () => false,
    })).rejects.toThrow("another hub owns");
    const request = await pending(testRig);
    await tick(testRig);
    expect(await request.client.next()).toMatchObject({ status: "complete" });
  });

  it("replaces a socket left by a killed process and serves setup", async () => {
    const directory = mkdtempSync(join(tmpdir(), `ub-${process.env.UB_AGENTS_RUN ?? "admin-setup"}-`));
    directories.push(directory);
    const databasePath = join(directory, "hub.sqlite");
    mkdirSync(`${databasePath}.admin`, { mode: 0o700 });
    const stalePath = adminSocketPath(databasePath);
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      "import {createServer} from 'node:net'; createServer().listen(process.argv[1], () => process.stdout.write('ready'));", stalePath],
      { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("socket fixture exited before listening"); })]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    const testRig = await rig({ databasePath });
    const request = await pending(testRig);
    await tick(testRig);
    expect(await request.client.next()).toMatchObject({ status: "complete" });
  });

  it("adopts existing and live documents or establishes a new workspace without changing content or credentials", async () => {
    const testRig = await rig();
    expect(statSync(testRig.control.path).mode & 0o777).toBe(0o600);
    const principal = testRig.principals.identify("1234", "old-login");
    testRig.credentials.issue({ principalId: principal.id, deviceId: "existing-device", workspaces: [] });
    testRig.memberships.grant({ workspaceId: OTHER_WORKSPACE, principalId: "unrelated-member", role: "member" });
    testRig.database.connection.prepare("INSERT INTO documents(name, data) VALUES (?, ?)")
      .run(`${WORKSPACE}/document`, Uint8Array.of(1, 2, 3));
    const before = rows(testRig);
    for (const [workspaceId, hadDocuments] of [[WORKSPACE, true], [THIRD_WORKSPACE, false]] as const) {
      const request = await pending(testRig, workspaceId);
      await tick(testRig);
      expect(await request.client.next()).toEqual({ status: "complete", setupId: request.setupId,
        workspaceId, identity: { ...principal, githubUsername: "approving-account" }, hadDocuments });
    }
    const liveWorkspace = "00000000-0000-4000-8000-000000000004";
    const live = await pending(testRig, liveWorkspace);
    // A room arriving during approval still makes this an adoption.
    testRig.liveWorkspaces.add(liveWorkspace);
    await tick(testRig);
    expect(await live.client.next()).toMatchObject({ status: "complete", hadDocuments: true });
    const after = rows(testRig);
    expect(after.documents).toEqual(before.documents);
    expect(after.credentials).toEqual(before.credentials);
    expect(testRig.memberships.roleFor(OTHER_WORKSPACE, "unrelated-member")).toBe("member");
    expect(after.principals).toHaveLength(1);
    expect(testRig.logs.filter((line) => line.event === "hub.admin-setup.granted")).toHaveLength(3);
    const disclosed = JSON.stringify({ output: clients.flatMap((client) => client.output), logs: testRig.logs, rows: after });
    for (const secret of [TOKEN, REFRESH_TOKEN, DEVICE_CODE, "collectionSecret"]) expect(disclosed).not.toContain(secret);
    expect(JSON.stringify(clients.flatMap((client) => client.output))).not.toContain("credential");
  });

  it.each(["admin", "member"] as const)("refuses a workspace with any %s membership before contacting GitHub", async (role) => {
    const testRig = await rig();
    testRig.memberships.grant({ workspaceId: WORKSPACE, principalId: "existing-person", role });
    const before = rows(testRig);
    const client = new HostClient(testRig.control.path);
    client.send({ action: "start", workspaceId: WORKSPACE });
    expect(await client.next()).toMatchObject({ status: "workspace-has-membership", workspaceId: WORKSPACE });
    expect(testRig.github.calls).toEqual([]);
    expect(rows(testRig)).toEqual(before);
  });

  it("rechecks membership at completion and rolls back the approving identity on refusal", async () => {
    const testRig = await rig();
    const request = await pending(testRig);
    const pause = identityPause(testRig.github);
    const polling = tick(testRig);
    await pause.entered;
    testRig.memberships.grant({ workspaceId: WORKSPACE, principalId: "intervening-person", role: "member" });
    pause.resume();
    await polling;
    expect(await request.client.next()).toMatchObject({ status: "workspace-has-membership" });
    expect(rows(testRig).principals).toEqual([]);
    expect(rows(testRig).receipts).toEqual([]);
    expect(rows(testRig).memberships).toEqual([{ workspace_id: WORKSPACE, principal_id: "intervening-person", role: "member" }]);
  });

  it("allows exactly one of two concurrent approvals, then refuses repeats by either account", async () => {
    const testRig = await rig();
    const first = await pending(testRig);
    testRig.github.account = { id: 5678, login: "other-approver" };
    const second = await pending(testRig);
    await tick(testRig);
    const results = [await first.client.next(), await second.client.next()];
    expect(results.map((result) => result.status).sort()).toEqual(["complete", "workspace-has-membership"]);
    const winner = results.find((result) => result.status === "complete") as unknown as SetupGrant;
    expect(testRig.memberships.listMembers(WORKSPACE, winner.identity.id)).toEqual([
      { workspaceId: WORKSPACE, principalId: winner.identity.id, role: "admin" },
    ]);
    expect(rows(testRig).principals).toHaveLength(1);
    expect(rows(testRig).receipts).toHaveLength(1);
    for (const account of [{ id: 1234, login: "approving-account" }, { id: 5678, login: "other-approver" }]) {
      testRig.github.account = account;
      const repeat = new HostClient(testRig.control.path);
      repeat.send({ action: "start", workspaceId: WORKSPACE });
      expect(await repeat.next()).toMatchObject({ status: "workspace-has-membership" });
    }
    expect(rows(testRig).memberships).toHaveLength(1);
  });

  it.each(["denied", "expired", "failed"])("%s approval grants nothing and discloses no upstream secret", async (status) => {
    const testRig = await rig();
    const request = await pending(testRig);
    if (status === "denied") testRig.github.tokenResult = { error: "access_denied" };
    if (status === "failed") testRig.github.failedUrl = "https://github.com/login/oauth/access_token";
    await tick(testRig, status === "expired" ? 900_000 : 1000);
    expect(await request.client.next()).toMatchObject({ status, setupId: request.setupId });
    expect(rows(testRig).memberships).toEqual([]);
    expect(rows(testRig).principals).toEqual([]);
    expect(rows(testRig).credentials).toEqual([]);
    expect(new SetupReceipts(testRig.database).find(request.setupId)).toEqual({ status: "unknown", setupId: request.setupId });
    expect(JSON.stringify({ output: request.client.output, logs: testRig.logs })).not.toContain(TOKEN);
  });

  it("bounds an abandoned pending approval even when GitHub asks for polling beyond expiry", async () => {
    const testRig = await rig();
    const request = await pending(testRig);
    testRig.github.tokenResult = { error: "slow_down", interval: 100_000 };
    await tick(testRig);
    expect(testRig.github.calls).toHaveLength(2);
    await tick(testRig, 899_000);
    expect(await request.client.next()).toMatchObject({ status: "expired", setupId: request.setupId });
    expect(testRig.github.calls).toHaveLength(2);
    expect(rows(testRig).memberships).toEqual([]);
  });

  it.each(["cancel", "disconnect", "stop", "expire"])("%s during identity fetch fences a later approval", async (action) => {
    const testRig = await rig();
    const request = await pending(testRig);
    const pause = identityPause(testRig.github);
    const polling = tick(testRig);
    await pause.entered;
    if (action === "cancel") {
      request.client.send({ action: "cancel" });
      expect(await request.client.next()).toMatchObject({ status: "cancelled", setupId: request.setupId });
    } else if (action === "disconnect") {
      request.client.socket.destroy();
      await pause.aborted;
    } else if (action === "stop") {
      await testRig.control.stop();
      await pause.aborted;
    } else testRig.github.time += 900_000;
    pause.resume();
    await polling;
    if (action === "expire") expect(await request.client.next()).toMatchObject({ status: "expired" });
    expect(rows(testRig).memberships).toEqual([]);
    expect(rows(testRig).principals).toEqual([]);
    expect(rows(testRig).receipts).toEqual([]);
    // stop() above exercises the transport fence while keeping the DB open for inspection.
    if (action === "stop") {
      testRig.database.close();
      controls.splice(controls.indexOf(testRig), 1);
    }
  });

  it("keeps a committed grant and its receipt after output is lost and the hub restarts", async () => {
    let disconnected: HostClient | undefined;
    const testRig = await rig({ onGrant: () => { disconnected!.socket.destroy(); throw new Error("logging unavailable"); } });
    const request = await pending(testRig);
    disconnected = request.client;
    await tick(testRig);
    await request.client.closed;
    const before = new SetupReceipts(testRig.database).find(request.setupId);
    expect(before).toMatchObject({ status: "complete", workspaceId: WORKSPACE, hadDocuments: false });
    const databasePath = testRig.database.databasePath;
    await testRig.stop();
    const restarted = await rig({ databasePath });
    const status = new HostClient(restarted.control.path);
    status.send({ action: "status", setupId: request.setupId });
    expect(await status.next()).toEqual(before);
    const unknownId = crypto.randomUUID();
    const unknown = new HostClient(restarted.control.path);
    unknown.send({ action: "status", setupId: unknownId });
    expect(await unknown.next()).toEqual({ status: "unknown", setupId: unknownId });
    expect(rows(restarted).memberships).toHaveLength(1);
    expect(restarted.github.calls).toEqual([]);
  });

  it("rolls back identity refresh and membership if the durable receipt cannot be committed", async () => {
    const testRig = await rig({ initialize: true });
    testRig.principals.identify("1234", "original-login");
    const before = rows(testRig);
    testRig.database.connection.exec(`CREATE TRIGGER receipt_failure BEFORE INSERT ON hub_admin_setup_grants
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`);
    const request = await pending(testRig);
    await tick(testRig);
    expect(await request.client.next()).toMatchObject({ status: "failed", setupId: request.setupId });
    expect(rows(testRig)).toEqual(before);
    expect(testRig.claims!.state(true)).toEqual({ unclaimed: true, canClaim: true });
  });

  it.each(["default", "other"])("a committed host grant on the %s workspace closes claiming before a pending public login", async (workspace) => {
    const testRig = await rig({ initialize: true });
    const defaultId = defaultWorkspace(testRig);
    const flow = publicSignIn(testRig);
    const login = await flow.start();
    if (login.status !== "pending") throw new Error("sign-in did not start");
    testRig.github.account = { id: 5678, login: "host-approver" };
    const setup = await pending(testRig, workspace === "default" ? defaultId : WORKSPACE);
    await tick(testRig);
    expect(await setup.client.next()).toMatchObject({ status: "complete" });
    expect(testRig.claims!.state(true)).toEqual({ unclaimed: false, canClaim: false });
    const result = await flow.collect(login.requestId, login.collectionSecret);
    expect(result).toMatchObject({ status: "complete", identity: { githubAccountId: "1234" }, credential: { record: { workspaces: [] } } });
    expect(result).not.toHaveProperty("claimedWorkspaceId");
    const grants = rows(testRig).memberships;
    expect(grants).toHaveLength(1);
    expect(grants[0]!.workspace_id).toBe(workspace === "default" ? defaultId : WORKSPACE);
  });

  it("a public claim wins over an earlier host approval still fetching identity", async () => {
    const testRig = await rig({ initialize: true });
    const defaultId = defaultWorkspace(testRig);
    const setup = await pending(testRig, defaultId);
    const pause = identityPause(testRig.github);
    const polling = tick(testRig);
    await pause.entered;
    testRig.github.pauseIdentity = undefined;
    testRig.github.account = { id: 5678, login: "public-approver" };
    const flow = publicSignIn(testRig);
    const login = await flow.start();
    if (login.status !== "pending") throw new Error("sign-in did not start");
    testRig.github.time += 1000;
    const result = await flow.collect(login.requestId, login.collectionSecret);
    expect(result).toMatchObject({ status: "complete", claimedWorkspaceId: defaultId });
    pause.resume();
    await polling;
    expect(await setup.client.next()).toMatchObject({ status: "workspace-has-membership" });
    expect(rows(testRig).memberships).toHaveLength(1);
    expect(rows(testRig).receipts).toEqual([]);
    expect(rows(testRig).principals).toHaveLength(1);
    expect(testRig.claims!.state(true)).toEqual({ unclaimed: false, canClaim: false });
  });

  it("refuses an unconfigured hub distinctly without changing private state", async () => {
    const testRig = await rig({ configured: false });
    const before = rows(testRig);
    const client = new HostClient(testRig.control.path);
    client.send({ action: "start", workspaceId: WORKSPACE });
    expect(await client.next()).toEqual({ status: "not-configured" });
    expect(rows(testRig)).toEqual(before);
  });
});
