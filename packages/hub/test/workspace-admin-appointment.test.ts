import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { importCredentialKey } from "@uberblick/schema/token";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CredentialRenewal } from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import { requestOperator } from "../src/operator-client.js";
import { runOperatorCommand } from "../src/operator-command.js";
import { adminSocketPath } from "../src/operator-socket.js";
import { createTeamHub, type TeamHub } from "../src/team.js";
import { deviceFetch, issueCredential, mintDeviceRequestProof } from "./device-credentials.js";
import { createClient, OTHER_WORKSPACE, removeTempDatabases, tempDatabasePath, TEST_SECRET, testRoom,
  token, waitUntil, WORKSPACE, type TestClient } from "./helpers.js";

const hubs: TeamHub[] = [];
const clients: TestClient[] = [];
const sockets: Socket[] = [];
const processes: ChildProcess[] = [];
let originalDirectory: string;

beforeEach(() => {
  originalDirectory = process.cwd();
  process.chdir(tmpdir());
});

afterEach(async () => {
  try {
    for (const child of processes.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise(resolve => child.once("exit", resolve));
        child.kill("SIGKILL");
        await ended;
      }
    }
    for (const client of clients.splice(0)) client.destroy();
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const hub of hubs.splice(0)) await hub.stop();
    removeTempDatabases();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = 0;
    process.chdir(originalDirectory);
  }
});

async function rig(options: { path?: string; onLog?: (record: HubLogRecord) => void } = {}) {
  const logs: HubLogRecord[] = [];
  const github = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("GitHub is unreachable"); });
  const hub = await createTeamHub({ databasePath: options.path ?? tempDatabasePath(), port: 0,
    authSecret: TEST_SECRET, log: record => { logs.push(record); options.onLog?.(record); },
    github: { clientId: "Iv1.0123456789abcdef", fetch: github },
  }, { operatorSetup: true });
  hubs.push(hub);
  return { hub, logs, github };
}

function person(hub: TeamHub, accountId: string, username: string, signedIn = true) {
  const principal = hub.principals!.identify(accountId, username);
  if (signedIn) hub.principals!.recordSignIn(principal.id);
  return principal;
}

function inventory(hub: TeamHub, workspaceId = WORKSPACE) {
  const document = new Y.Doc();
  const database = new DatabaseSync(hub.databasePath);
  try {
    database.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
      .run(testRoom(workspaceId), Y.encodeStateAsUpdate(document));
  } finally { database.close(); document.destroy(); }
}

function accessState(hub: TeamHub) {
  const database = new DatabaseSync(hub.databasePath, { readOnly: true });
  try {
    return { memberships: database.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all(),
      admins: database.prepare("SELECT * FROM hub_admins").all(),
      credentials: database.prepare("SELECT * FROM hub_credentials").all(),
      documents: database.prepare("SELECT name, hex(data) AS data FROM documents ORDER BY name").all() };
  } finally { database.close(); }
}

function add(hub: TeamHub, account: string, workspaceId = WORKSPACE) {
  return requestOperator(hub.databasePath, { action: "workspace-admin-add", workspaceId, account });
}

function addId(hub: TeamHub, accountId: string, workspaceId = WORKSPACE) {
  return requestOperator(hub.databasePath, { action: "workspace-admin-add", workspaceId, accountId });
}

function events(logs: HubLogRecord[]) {
  return logs.filter(record => record.event === "hub.workspace-admin.add");
}

function rawRequest(hub: TeamHub, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(adminSocketPath(hub.databasePath));
    sockets.push(socket);
    let input = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1000, () => socket.destroy(new Error("operator response timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try { resolve(JSON.parse(input.slice(0, newline))); }
      catch (error) { reject(error); }
      socket.destroy();
    });
  });
}

function command(databasePath: string, args: string[]) {
  const child = spawn(process.execPath, ["--no-experimental-webstorage", "--import", import.meta.resolve("tsx"),
    fileURLToPath(new URL("../src/operator-command.ts", import.meta.url)), ...args], {
    cwd: tmpdir(), timeout: 5000, env: { ...process.env, HUB_DB_PATH: databasePath }, stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let output = "";
  let errors = "";
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { errors += String(chunk); });
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { ended, output: () => output, errors: () => errors };
}

it("adds or promotes only the named member, persists the marker, and logs successful retries with their time", async () => {
  const { hub, logs } = await rig();
  const lost = person(hub, "1234", "lost-admin");
  const chosen = person(hub, "5678", "chosen-login");
  const unrelated = person(hub, "9012", "other-member");
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: lost.id, role: "admin" });
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: chosen.id, role: "member" });
  hub.memberships!.grant({ workspaceId: OTHER_WORKSPACE, principalId: unrelated.id, role: "member" });
  const before = accessState(hub);
  expect(await add(hub, "CHOSEN-LOGIN")).toEqual({ status: "complete", identity: chosen });
  expect(await addId(hub, "5678")).toEqual({ status: "already-admin", identity: chosen });
  expect(hub.memberships!.listMembers(WORKSPACE)).toEqual(expect.arrayContaining([
    { workspaceId: WORKSPACE, principalId: chosen.id, role: "admin", addedOnHost: true },
    { workspaceId: WORKSPACE, principalId: lost.id, role: "admin" },
  ]));
  expect(hub.memberships!.listMembers(OTHER_WORKSPACE))
    .toEqual([{ workspaceId: OTHER_WORKSPACE, principalId: unrelated.id, role: "member" }]);
  const after = accessState(hub);
  expect({ ...after, memberships: before.memberships }).toEqual(before);
  expect(events(logs)).toEqual([
    { event: "hub.workspace-admin.add", workspaceId: WORKSPACE, account: "CHOSEN-LOGIN", identity: chosen,
      outcome: "complete", time: expect.any(String) },
    { event: "hub.workspace-admin.add", workspaceId: WORKSPACE, accountId: "5678", identity: chosen,
      outcome: "already-admin", time: expect.any(String) },
  ]);
  for (const record of events(logs)) expect(new Date(String(record.time)).toISOString()).toBe(record.time);
  await hub.stop();
  const restarted = await rig({ path: hub.databasePath });
  expect(await addId(restarted.hub, "5678")).toEqual({ status: "already-admin", identity: chosen });
  expect(restarted.hub.memberships!.listMembers(WORKSPACE))
    .toContainEqual({ workspaceId: WORKSPACE, principalId: chosen.id, role: "admin", addedOnHost: true });
});

it("uses the hub inventory for memberless and suspended workspaces and never creates an unknown workspace", async () => {
  const { hub, logs } = await rig();
  const chosen = person(hub, "1234", "chosen-login");
  inventory(hub);
  inventory(hub, OTHER_WORKSPACE);
  hub.hubAdmins!.setWorkspaceStatus(OTHER_WORKSPACE, "suspended");
  expect(await add(hub, "chosen-login")).toEqual({ status: "complete", identity: chosen });
  expect(await addId(hub, "1234", OTHER_WORKSPACE)).toEqual({ status: "complete", identity: chosen });
  expect(hub.hubAdmins!.isSuspended(OTHER_WORKSPACE)).toBe(true);
  const missing = randomUUID();
  const before = accessState(hub);
  expect(await add(hub, "chosen-login", missing)).toEqual({ status: "workspace-not-found" });
  expect(hub.hubAdmins!.hasWorkspace(missing)).toBe(false);
  expect(accessState(hub)).toEqual(before);
  expect(events(logs)).toContainEqual({ event: "hub.workspace-admin.add", workspaceId: missing,
    account: "chosen-login", outcome: "workspace-not-found", time: expect.any(String) });
});

it("requires recorded sign-in, refuses ambiguous logins, and distinguishes numeric logins from durable IDs", async () => {
  const { hub, logs } = await rig();
  inventory(hub);
  const unsigned = person(hub, "1234", "unsigned-login", false);
  const numericLogin = person(hub, "5678", "9012");
  const matchingId = person(hub, "9012", "new-login");
  person(hub, "3456", "duplicate-login");
  person(hub, "7890", "DUPLICATE-LOGIN", false);
  const before = accessState(hub);
  expect(await add(hub, "unknown-login")).toEqual({ status: "account-not-found" });
  expect(await addId(hub, "9999")).toEqual({ status: "account-not-found" });
  expect(await addId(hub, "1234")).toEqual({ status: "sign-in-required" });
  expect(await add(hub, "duplicate-login")).toEqual({ status: "ambiguous-account" });
  expect(accessState(hub)).toEqual(before);
  expect(events(logs).map(record => record.outcome))
    .toEqual(["account-not-found", "account-not-found", "sign-in-required", "ambiguous-account"]);
  expect(events(logs)[2]).toMatchObject({ identity: unsigned });
  expect(await add(hub, "9012")).toEqual({ status: "complete", identity: numericLogin });
  expect(hub.memberships!.roleFor(WORKSPACE, matchingId.id)).toBeNull();
  expect(await addId(hub, "9012")).toEqual({ status: "complete", identity: matchingId });
  hub.principals!.recordSignIn(unsigned.id);
  expect(await addId(hub, "1234")).toEqual({ status: "complete", identity: unsigned });
  const renamed = hub.principals!.identify("9012", "renamed-login");
  expect(await addId(hub, "9012")).toEqual({ status: "already-admin", identity: renamed });
});

it("retrying an ordinary admin changes no membership and does not label that admin as supplied by the host", async () => {
  const { hub, logs } = await rig();
  const chosen = person(hub, "1234", "existing-admin");
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: chosen.id, role: "admin" });
  const before = accessState(hub);
  expect(await add(hub, "existing-admin")).toEqual({ status: "already-admin", identity: chosen });
  expect(accessState(hub)).toEqual(before);
  expect(hub.memberships!.listMembers(WORKSPACE))
    .toEqual([{ workspaceId: WORKSPACE, principalId: chosen.id, role: "admin" }]);
  expect(events(logs)).toHaveLength(1);
});

it("the CLI prints each contracted result and exits 1 for account and workspace refusals", async () => {
  const { hub } = await rig();
  inventory(hub);
  person(hub, "1234", "chosen-login");
  person(hub, "5678", "unsigned-login", false);
  person(hub, "9012", "duplicate-login");
  person(hub, "3456", "duplicate-login");
  const added = command(hub.databasePath, ["workspace-admin", "add", WORKSPACE, "chosen-login"]);
  expect(await added.ended).toBe(0);
  expect(added.output()).toBe("added workspace admin  chosen-login (GitHub account 1234)\n");
  expect(added.errors()).toBe("");
  const repeated = command(hub.databasePath, ["workspace-admin", "add", WORKSPACE, "--account-id", "1234"]);
  expect(await repeated.ended).toBe(0);
  expect(repeated.output()).toBe("already workspace admin  chosen-login (GitHub account 1234)\n");
  const missingWorkspace = randomUUID();
  for (const [workspaceId, args, message] of [
    [WORKSPACE, ["unknown-login"], "hub has never recorded this account"],
    [WORKSPACE, ["unsigned-login"], "account has no recorded sign-in; sign in to this hub and retry"],
    [WORKSPACE, ["duplicate-login"], "login matches more than one recorded account; use --account-id <GitHub account ID>"],
    [missingWorkspace, ["chosen-login"], `hub has no workspace ${missingWorkspace}`],
  ] as const) {
    const refused = command(hub.databasePath, ["workspace-admin", "add", workspaceId, ...args]);
    expect(await refused.ended).toBe(1);
    expect(refused.errors()).toBe(`ub-hub: Error: ${message}\n`);
    expect(refused.output()).toBe("");
  }
}, 10_000);

it("help replaces setup, malformed arguments print usage with exit 2, and an absent socket reports an unknown result", async () => {
  const path = tempDatabasePath();
  vi.stubEnv("HUB_DB_PATH", path);
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
  vi.spyOn(console, "error").mockImplementation(value => { errors.push(String(value)); });
  await runOperatorCommand(["--help"]);
  expect(output.join("\n")).toContain("workspace-admin add <ws-uuid> <gh-login>");
  expect(output.join("\n")).toContain("Add a workspace admin");
  expect(output.join("\n")).not.toContain("admin-setup");
  for (const args of [["workspace-admin"], ["workspace-admin", "add"],
    ["workspace-admin", "remove", WORKSPACE, "login"], ["workspace-admin", "add", "invalid-uuid", "login"],
    ["workspace-admin", "add", WORKSPACE, "bad login"], ["workspace-admin", "add", WORKSPACE, "login", "extra"],
    ["workspace-admin", "add", WORKSPACE, "--account-id"], ["workspace-admin", "add", WORKSPACE, "--account-id", "login"],
    ["admin-setup", WORKSPACE], ["admin-setup", "status", randomUUID()]]) {
    process.exitCode = 0;
    await runOperatorCommand(args);
    expect(process.exitCode).toBe(2);
    expect(errors.at(-1)).toContain("usage: ub-hub");
  }
  const missing = command(path, ["workspace-admin", "add", WORKSPACE, "login"]);
  expect(await missing.ended).toBe(1);
  expect(missing.errors()).toContain("addition result unknown; retry the same workspace and account to check");
  expect(missing.output()).toBe("");
  expect(existsSync(path)).toBe(false);
});

it("rejects malformed socket requests without changing access", async () => {
  const { hub } = await rig();
  inventory(hub);
  person(hub, "1234", "chosen-login");
  const before = accessState(hub);
  for (const message of [
    { action: "workspace-admin-add", account: "chosen-login" },
    { action: "workspace-admin-add", workspaceId: "not-a-uuid", account: "chosen-login" },
    { action: "workspace-admin-add", workspaceId: WORKSPACE, account: 1234 },
    { action: "workspace-admin-add", workspaceId: WORKSPACE, account: "chosen login" },
    { action: "workspace-admin-add", workspaceId: WORKSPACE, accountId: "not-an-id" },
    { action: "workspace-admin-add", workspaceId: WORKSPACE, account: "chosen-login", accountId: "1234" },
    { action: "workspace-admin-add", workspaceId: WORKSPACE, account: "chosen-login", ignored: true },
    { action: "admin-setup", workspaceId: WORKSPACE },
  ]) expect(await rawRequest(hub, message)).toEqual({ status: "invalid-request" });
  expect(accessState(hub)).toEqual(before);
});

it("commits the membership and marker before logging or a lost reply can fail, so retry finds the same admin", async () => {
  let abandoned: Socket | undefined;
  let committed: unknown;
  const { hub, logs } = await rig({ onLog: record => {
    if (record.event !== "hub.workspace-admin.add" || record.outcome !== "complete") return;
    committed = hub.memberships!.listMembers(WORKSPACE);
    abandoned?.destroy();
    throw new Error("injected log failure");
  } });
  inventory(hub);
  const chosen = person(hub, "1234", "chosen-login");
  abandoned = createConnection(adminSocketPath(hub.databasePath));
  sockets.push(abandoned);
  const received: string[] = [];
  abandoned.on("data", chunk => received.push(String(chunk)));
  abandoned.once("connect", () => abandoned!.write(`${JSON.stringify({ action: "workspace-admin-add",
    workspaceId: WORKSPACE, account: "chosen-login" })}\n`));
  await waitUntil("host grant is logged before losing the reply", () => events(logs).length === 1);
  expect(received).toEqual([]);
  expect(committed).toEqual([{ workspaceId: WORKSPACE, principalId: chosen.id, role: "admin", addedOnHost: true }]);
  expect(await addId(hub, "1234")).toEqual({ status: "already-admin", identity: chosen });
});

it("a rejected database write rolls back both role and marker, logs failure, and permits retry", async () => {
  const { hub, logs } = await rig();
  const chosen = person(hub, "1234", "chosen-login");
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: chosen.id, role: "member" });
  const before = accessState(hub);
  const database = new DatabaseSync(hub.databasePath);
  try {
    database.exec("CREATE TRIGGER fail_host_promotion BEFORE UPDATE ON hub_memberships BEGIN SELECT RAISE(ABORT, 'injected host grant failure'); END");
    expect(await add(hub, "chosen-login"))
      .toMatchObject({ status: "failed", error: expect.stringContaining("injected host grant failure") });
    expect(accessState(hub)).toEqual(before);
    expect(events(logs)).toEqual([{ event: "hub.workspace-admin.add", workspaceId: WORKSPACE,
      account: "chosen-login", identity: chosen, outcome: "failed", time: expect.any(String) }]);
    database.exec("DROP TRIGGER fail_host_promotion");
  } finally { database.close(); }
  expect(await addId(hub, "1234")).toEqual({ status: "complete", identity: chosen });
});

it("HTTP, management and authenticated WebSocket messages cannot grant host admin access", async () => {
  const { hub, logs } = await rig();
  const chosen = person(hub, "1234", "chosen-login");
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: chosen.id, role: "member" });
  const before = accessState(hub);
  const appointment = { action: "workspace-admin-add", workspaceId: WORKSPACE, account: "chosen-login" };
  for (const path of ["/auth/workspace-admin-add", "/auth/workspace-admin/add", "/auth/operator", "/auth/admin-setup"]) {
    const response = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(appointment),
    });
    expect(response.status).toBe(404);
  }
  for (const fields of [appointment, { operation: "workspace-admin-add", workspaceId: WORKSPACE, account: "chosen-login" }]) {
    const response = await fetch(`http://127.0.0.1:${hub.port}/auth/manage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: SYNC_PROTOCOL_VERSION, token: "unused", ...fields }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "invalid-request" });
  }
  const room = testRoom();
  const client = createClient({ port: hub.port, room, token: await token() });
  clients.push(client);
  await client.synced;
  client.provider.sendStateless(JSON.stringify(appointment));
  client.text.insert(0, "still serving after the unsupported message");
  await waitUntil("WebSocket continues after unsupported host grant", () =>
    hub.hocuspocus.documents.get(room)?.getText("body").toString() === "still serving after the unsupported message");
  expect(accessState(hub).memberships).toEqual(before.memberships);
  expect(accessState(hub).admins).toEqual(before.admins);
  expect(events(logs)).toEqual([]);
});

it("an already signed-in device discovers a host grant on credential renewal without GitHub approval", async () => {
  const { hub, github } = await rig();
  inventory(hub);
  const chosen = person(hub, "1234", "chosen-login");
  const original = issueCredential(hub.credentials!, { principalId: chosen.id, deviceId: randomUUID(), workspaces: [] });
  expect(await add(hub, "chosen-login")).toEqual({ status: "complete", identity: chosen });
  expect(hub.credentials!.get(original.record.id)?.workspaces).toEqual([]);
  const renewalProof = await mintDeviceRequestProof(await importCredentialKey(original.keyBytes), {
    kid: original.record.id, operation: "renew-credential", lifetimeSeconds: 60,
  });
  const response = await deviceFetch(`http://127.0.0.1:${hub.port}/auth/credential/renew`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: SYNC_PROTOCOL_VERSION, token: renewalProof }),
  });
  expect(response.status).toBe(200);
  const renewed = await response.json() as CredentialRenewal;
  expect(renewed).toMatchObject({ status: "renewed", credential: { record: {
    principalId: chosen.id, deviceId: original.record.deviceId, workspaces: [WORKSPACE],
  } } });
  expect(github).not.toHaveBeenCalled();
});
