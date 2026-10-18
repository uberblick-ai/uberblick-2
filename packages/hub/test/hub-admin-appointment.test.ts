import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adminSocketPath } from "../src/admin-setup.js";
import type { HubLogRecord } from "../src/log.js";
import { requestOperator } from "../src/operator-client.js";
import { runOperatorCommand } from "../src/operator-command.js";
import { createTeamHub, type TeamHub } from "../src/team.js";
import { createClient, removeTempDatabases, tempDatabasePath, TEST_SECRET, testRoom, token,
  waitUntil, WORKSPACE, type TestClient } from "./helpers.js";

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
  const hub = await createTeamHub({ databasePath: options.path ?? tempDatabasePath(), port: 0,
    authSecret: TEST_SECRET, log: record => { logs.push(record); options.onLog?.(record); },
    github: { clientId: "Iv1.0123456789abcdef", fetch: async () => { throw new Error("GitHub is unreachable"); } },
  }, { operatorSetup: true });
  hubs.push(hub);
  return { hub, logs };
}

function person(hub: TeamHub, accountId: string, username: string, signedIn = true) {
  const principal = hub.principals!.identify(accountId, username);
  if (signedIn) hub.principals!.recordSignIn(principal.id);
  return principal;
}

function snapshot(hub: TeamHub) {
  const database = new DatabaseSync(hub.databasePath, { readOnly: true });
  try {
    return { admins: database.prepare("SELECT * FROM hub_admins ORDER BY principal_id").all(),
      memberships: database.prepare("SELECT * FROM hub_memberships").all(),
      credentials: database.prepare("SELECT * FROM hub_credentials").all() };
  } finally { database.close(); }
}

function appoint(hub: TeamHub, account: string) {
  return requestOperator(hub.databasePath, { action: "hub-admin-add", account });
}

function appointId(hub: TeamHub, accountId: string) {
  return requestOperator(hub.databasePath, { action: "hub-admin-add", accountId });
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
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
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

it("appoints a signed-in login without case sensitivity, membership or a device credential, and retries without another event", async () => {
  const { hub, logs } = await rig();
  const principal = person(hub, "1234", "Host-Choice");
  expect(await appoint(hub, "host-choice")).toEqual({ status: "complete", identity: principal });
  expect(await appoint(hub, "HOST-CHOICE")).toEqual({ status: "already-admin", identity: principal });
  expect(logs.filter(record => record.event === "hub.admin.appointed"))
    .toEqual([{ event: "hub.admin.appointed", ...principal }]);
  expect(snapshot(hub)).toEqual({ admins: [{ principal_id: principal.id }], memberships: [], credentials: [] });

  await hub.stop();
  const restarted = await rig({ path: hub.databasePath });
  expect(await appointId(restarted.hub, "1234")).toEqual({ status: "already-admin", identity: principal });
  expect(snapshot(restarted.hub)).toEqual({ admins: [{ principal_id: principal.id }], memberships: [], credentials: [] });
  expect(restarted.logs.some(record => record.event === "hub.admin.appointed")).toBe(false);
});

it("uses the durable account ID after renames, preserves an existing admin and permits the appointed admin to remove it", async () => {
  const { hub } = await rig();
  const unintended = person(hub, "1234", "unintended-admin");
  hub.hubAdmins!.grant(unintended.id);
  const chosen = person(hub, "5678", "old-login");
  const renamed = hub.principals!.identify("5678", "new-login");
  expect(await appointId(hub, "5678")).toEqual({ status: "complete", identity: renamed });
  expect(hub.hubAdmins!.isAdmin(unintended.id)).toBe(true);
  expect(hub.hubAdmins!.isAdmin(chosen.id)).toBe(true);
  const renamedAgain = hub.principals!.identify("5678", "latest-login");
  expect(await appointId(hub, "5678")).toEqual({ status: "already-admin", identity: renamedAgain });
  hub.hubAdmins!.remove(chosen.id, unintended.id);
  expect(snapshot(hub)).toEqual({ admins: [{ principal_id: chosen.id }], memberships: [], credentials: [] });
});

it("separately refuses unknown accounts, recorded accounts without sign-in, and ambiguous logins without granting anything", async () => {
  const { hub, logs } = await rig();
  const unsigned = person(hub, "1234", "not-signed-in", false);
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: unsigned.id, role: "admin" });
  person(hub, "5678", "reused-login");
  person(hub, "9012", "REUSED-LOGIN", false);
  const before = snapshot(hub);
  expect(await appoint(hub, "never-recorded")).toEqual({ status: "account-not-found" });
  expect(await appointId(hub, "9999")).toEqual({ status: "account-not-found" });
  expect(await appoint(hub, "not-signed-in")).toEqual({ status: "sign-in-required" });
  expect(await appointId(hub, "1234")).toEqual({ status: "sign-in-required" });
  expect(await appoint(hub, "reused-login")).toEqual({ status: "ambiguous-account" });
  expect(snapshot(hub)).toEqual(before);
  expect(logs.some(record => record.event === "hub.admin.appointed")).toBe(false);
  expect(await appointId(hub, "5678")).toMatchObject({ status: "complete", identity: { githubAccountId: "5678" } });
  expect(await appointId(hub, "9012")).toEqual({ status: "sign-in-required" });
  hub.principals!.recordSignIn(unsigned.id);
  expect(await appointId(hub, "1234")).toEqual({ status: "complete", identity: unsigned });
});

it("treats numeric logins as logins and requires an explicit account ID to select a different account", async () => {
  const { hub } = await rig();
  const numericLogin = person(hub, "1234", "5678");
  const matchingId = person(hub, "5678", "different-login");
  expect(await appoint(hub, "5678")).toEqual({ status: "complete", identity: numericLogin });
  expect(hub.hubAdmins!.isAdmin(matchingId.id)).toBe(false);
  expect(await appointId(hub, "5678")).toEqual({ status: "complete", identity: matchingId });
  person(hub, "9012", "5678");
  expect(await appoint(hub, "5678")).toEqual({ status: "ambiguous-account" });
});

it("reports an existing legacy admin without requiring new sign-in evidence or changing its role", async () => {
  const { hub, logs } = await rig();
  const legacy = person(hub, "1234", "legacy-admin", false);
  hub.hubAdmins!.grant(legacy.id);
  const before = snapshot(hub);
  expect(await appoint(hub, "legacy-admin")).toEqual({ status: "already-admin", identity: legacy });
  expect(await appointId(hub, "1234")).toEqual({ status: "already-admin", identity: legacy });
  expect(snapshot(hub)).toEqual(before);
  expect(hub.principals!.hasSignedIn(legacy.id)).toBe(false);
  expect(logs.some(record => record.event === "hub.admin.appointed")).toBe(false);
});

it("the host command prints the login and ID and gives each refusal a nonzero exit and its own recovery message", async () => {
  const { hub } = await rig();
  person(hub, "1234", "chosen-login");
  person(hub, "5678", "unsigned-login", false);
  person(hub, "9012", "duplicate-login");
  person(hub, "3456", "duplicate-login");
  const success = command(hub.databasePath, ["hub-admin", "add", "chosen-login"]);
  expect(await success.ended).toBe(0);
  expect(success.output()).toContain("appointed hub admin  chosen-login (GitHub account 1234)");
  expect(success.errors()).not.toContain("ub-hub:");
  const repeated = command(hub.databasePath, ["hub-admin", "add", "--account-id", "1234"]);
  expect(await repeated.ended).toBe(0);
  expect(repeated.output()).toContain("already hub admin  chosen-login (GitHub account 1234)");
  for (const [args, message] of [
    [["unknown-login"], "hub has never recorded this account"],
    [["unsigned-login"], "sign in to this hub and retry"],
    [["--account-id", "5678"], "sign in to this hub and retry"],
    [["duplicate-login"], "login matches more than one recorded account"],
  ] as const) {
    const refused = command(hub.databasePath, ["hub-admin", "add", ...args]);
    expect(await refused.ended).toBe(1);
    expect(refused.errors()).toContain(message);
    expect(refused.output()).toBe("");
  }
  expect(snapshot(hub).admins).toHaveLength(1);
}, 10_000);

it("help documents appointment, malformed command arguments exit with usage, and an absent socket leaves the result unknown", async () => {
  const path = tempDatabasePath();
  vi.stubEnv("HUB_DB_PATH", path);
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
  vi.spyOn(console, "error").mockImplementation(value => { errors.push(String(value)); });
  await runOperatorCommand(["--help"]);
  expect(output.join("\n")).toContain("hub-admin add <github-login>");
  expect(output.join("\n")).toContain("--account-id");
  for (const args of [["hub-admin"], ["hub-admin", "add"], ["hub-admin", "remove", "login"],
    ["hub-admin", "add", "login", "extra"], ["hub-admin", "add", "--login"], ["hub-admin", "add", "bad login"],
    ["hub-admin", "add", "--account-id"], ["hub-admin", "add", "--account-id", "not-an-id"]]) {
    process.exitCode = 0;
    await runOperatorCommand(args);
    expect(process.exitCode).toBe(2);
  }
  expect(errors.join("\n")).toContain("usage: ub-hub");
  const missing = command(path, ["hub-admin", "add", "login"]);
  expect(await missing.ended).toBe(1);
  expect(missing.errors()).toContain("appointment result unknown; retry the same account to check");
  expect(missing.output()).toBe("");
  expect(existsSync(path)).toBe(false);
});

it.each([
  { action: "hub-admin-add" },
  { action: "hub-admin-add", account: 1234 },
  { action: "hub-admin-add", account: null },
  { action: "hub-admin-add", account: "" },
  { action: "hub-admin-add", account: "chosen login" },
  { action: "hub-admin-add", account: "chosen-login", workspaceId: WORKSPACE },
  { action: "hub-admin-add", account: "chosen-login", ignored: true },
  { action: "hub-admin-add", accountId: 1234 },
  { action: "hub-admin-add", accountId: "" },
  { action: "hub-admin-add", accountId: "chosen-login" },
  { action: "hub-admin-add", account: "chosen-login", accountId: "1234" },
])("malformed operator arguments %j cannot appoint", async message => {
  const { hub, logs } = await rig();
  person(hub, "1234", "chosen-login");
  expect(await rawRequest(hub, message)).toEqual({ status: "invalid-request" });
  expect(snapshot(hub)).toEqual({ admins: [], memberships: [], credentials: [] });
  expect(logs.some(record => record.event === "hub.admin.appointed")).toBe(false);
});

it("keeps a committed appointment when logging fails, and retry reports the existing role", async () => {
  const { hub } = await rig({ onLog: record => {
    if (record.event === "hub.admin.appointed") throw new Error("injected log failure");
  } });
  const principal = person(hub, "1234", "chosen-login");
  expect(await appoint(hub, "chosen-login")).toEqual({ status: "complete", identity: principal });
  expect(await appointId(hub, "1234")).toEqual({ status: "already-admin", identity: principal });
  expect(snapshot(hub).admins).toEqual([{ principal_id: principal.id }]);
});

it("reports a failed database write without an appointment event or a false success, then permits retry", async () => {
  const { hub, logs } = await rig();
  const principal = person(hub, "1234", "chosen-login");
  const database = new DatabaseSync(hub.databasePath);
  try {
    database.exec("CREATE TRIGGER fail_appointment BEFORE INSERT ON hub_admins BEGIN SELECT RAISE(ABORT, 'injected appointment failure'); END");
    const result = await appoint(hub, "chosen-login");
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("injected appointment failure") });
    expect(snapshot(hub).admins).toEqual([]);
    expect(logs.some(record => record.event === "hub.admin.appointed")).toBe(false);
    database.exec("DROP TRIGGER fail_appointment");
  } finally { database.close(); }
  expect(await appointId(hub, "1234")).toEqual({ status: "complete", identity: principal });
});

it("HTTP, management requests and authenticated WebSocket messages cannot appoint", async () => {
  const { hub, logs } = await rig();
  person(hub, "1234", "chosen-login");
  const appointment = { action: "hub-admin-add", account: "chosen-login" };
  for (const path of ["/auth/hub-admin-add", "/auth/hub-admin/add", "/auth/operator", "/auth/admin-setup"]) {
    const response = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(appointment),
    });
    expect(response.status).toBe(404);
  }
  for (const fields of [appointment, { operation: "hub-admin-add", account: "chosen-login" },
    { operation: "add-hub-admin", githubUsername: "chosen-login" }]) {
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
  await waitUntil("WebSocket continues after unsupported appointment", () =>
    hub.hocuspocus.documents.get(room)?.getText("body").toString() === "still serving after the unsupported message");
  expect(snapshot(hub)).toEqual({ admins: [], memberships: [], credentials: [] });
  expect(logs.some(record => record.event === "hub.admin.appointed")).toBe(false);
});
