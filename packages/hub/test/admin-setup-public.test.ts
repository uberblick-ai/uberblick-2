/** Public identity flows cannot invoke or collect host setup; command results are honest. */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { adminSocketPath } from "../src/admin-setup.js";
import { createHub, type Hub } from "../src/server.js";
import { removeTempDatabases, tempDatabasePath, TEST_SECRET, WORKSPACE } from "./helpers.js";

const hubs: Hub[] = [];
const sockets: Socket[] = [];
const processes: ChildProcess[] = [];
const CLIENT_ID = "Iv23AbCdEF0123456789";
const TOKEN = "ghu_never-output";
let now = 1000;

function host(path: string, body: unknown) {
  const socket = createConnection(path);
  sockets.push(socket);
  const queued: any[] = [];
  const waiters: ((result: any) => void)[] = [];
  let input = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk: string) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      const waiting = waiters.shift();
      if (waiting) waiting(message); else queued.push(message);
    }
  });
  socket.write(`${JSON.stringify(body)}\n`);
  return { socket, next: () => queued.length ? Promise.resolve(queued.shift()) : new Promise<any>((resolve) => waiters.push(resolve)) };
}

async function rig(configured = true) {
  let account = 1234;
  let sequence = 0;
  const identities = new Map<string, number>();
  now = 1000;
  const hub = await createHub({ authSecret: TEST_SECRET, port: 0, databasePath: tempDatabasePath(), log: () => {},
    ...(configured ? { github: { clientId: CLIENT_ID, now: () => now, fetch: (async (url, init) => {
      if (String(url) === "https://github.com/login/device/code") {
        const code = String(++sequence);
        identities.set(code, account);
        return Response.json({ device_code: code, user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 });
      }
      if (String(url) === "https://github.com/login/oauth/access_token") {
        const code = new URLSearchParams(String(init?.body)).get("device_code");
        return Response.json({ access_token: `${TOKEN}:${code}`, token_type: "bearer", scope: "" });
      }
      const code = new Headers(init?.headers).get("Authorization")!.split(":")[1]!;
      const id = identities.get(code)!;
      return Response.json({ id, login: `account-${id}` });
    }) as typeof fetch } } : {}),
  }, { operatorSetup: true });
  hubs.push(hub);
  const post = async (path: string, body: unknown, authorization?: string) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(authorization === undefined ? {} : { Authorization: authorization }) },
      body: JSON.stringify(body),
    });
    return { code: response.status, body: await response.json() as any };
  };
  const signIn = async (id: number) => {
    account = id;
    const start = (await post("/auth/github/start", {})).body;
    now += 1000;
    const result = (await post("/auth/github/collect", { requestId: start.requestId, collectionSecret: start.collectionSecret })).body;
    expect(result.status).toBe("complete");
    return result;
  };
  return { hub, post, signIn, setAccount: (id: number) => { account = id; } };
}

function snapshot(hub: Hub) {
  const db = new DatabaseSync(hub.databasePath, { readOnly: true });
  try {
    return { memberships: db.prepare("SELECT * FROM hub_memberships").all(),
      credentials: db.prepare("SELECT * FROM hub_credentials").all() };
  } finally { db.close(); }
}

afterEach(async () => {
  for (const process of processes.splice(0)) {
    if (process.exitCode === null && process.signalCode === null) {
      const exited = new Promise((resolve) => process.once("exit", resolve));
      process.kill("SIGKILL");
      await exited;
    }
  }
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

it("public sign-in remains membership-neutral before/during/after setup and cannot collect/cancel it", async () => {
  const r = await rig();
  const approving = await r.signIn(1234);
  expect(approving.credential.record.workspaces).toEqual([]);
  expect(snapshot(r.hub).memberships).toEqual([]);
  r.setAccount(1234);
  const setup = host(adminSocketPath(r.hub.databasePath), { action: "start", workspaceId: WORKSPACE });
  const starting = await setup.next();
  const pending = await setup.next();
  const visitor = await r.signIn(5678);
  expect(visitor.credential.record.workspaces).toEqual([]);
  expect(snapshot(r.hub).memberships).toEqual([]);
  for (const authorization of [TEST_SECRET, `Bearer ${visitor.credential.key}`, `Bearer ${TOKEN}`]) {
    expect((await r.post("/auth/admin-setup/start", { workspaceId: WORKSPACE }, authorization)).code).toBe(404);
    expect((await r.post("/auth/github/start", { workspaceId: WORKSPACE }, authorization)).code).toBe(400);
  }
  for (const action of ["collect", "cancel"]) {
    expect((await r.post(`/auth/github/${action}`, { requestId: starting.setupId, collectionSecret: pending.userCode })).body.status).toBe("unknown-request");
    expect((await r.post(`/auth/admin-setup/${action}`, { setupId: starting.setupId })).code).toBe(404);
  }
  const countBefore = snapshot(r.hub).credentials.length;
  now += 1000;
  const completed = await setup.next();
  expect(completed).toMatchObject({ status: "complete", identity: approving.identity, workspaceId: WORKSPACE, hadDocuments: false });
  expect(snapshot(r.hub).credentials).toHaveLength(countBefore);
  expect(snapshot(r.hub).memberships).toEqual([{ workspace_id: WORKSPACE, principal_id: approving.identity.id, role: "admin" }]);
  expect((await r.signIn(5678)).credential.record.workspaces).toEqual([]);
  expect((await r.signIn(1234)).identity).toEqual(approving.identity);
  expect(snapshot(r.hub).memberships).toHaveLength(1);
  const result = host(adminSocketPath(r.hub.databasePath), { action: "status", setupId: starting.setupId });
  expect(await result.next()).toEqual(completed);
}, 10_000);

function command(hub: Hub, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/admin-setup-command.ts", ...args], {
    cwd: new URL("../", import.meta.url), env: { ...process.env, HUB_DB_PATH: hub.databasePath }, stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let output = "";
  let errors = "";
  child.stdout!.on("data", (chunk) => { output += String(chunk); });
  child.stderr!.on("data", (chunk) => { errors += String(chunk); });
  const ended = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, ended, output: () => output, errors: () => errors };
}

it("the browserless command prints identity/adoption and status, with distinct not-configured and unknown results", async () => {
  const r = await rig();
  const c = command(r.hub, [WORKSPACE]);
  const approved = new Promise<void>((resolve) => {
    c.child.stdout!.on("data", () => {
      if (c.output().includes("ABCD-EFGH")) { now += 1000; resolve(); }
    });
  });
  await approved;
  expect(await c.ended).toBe(0);
  expect(c.output()).toContain("https://github.com/login/device");
  expect(c.output()).toContain(`account-1234 (GitHub account 1234) is the first admin of workspace ${WORKSPACE}`);
  expect(c.output()).toContain("hub held no documents");
  expect(c.output() + c.errors()).not.toContain(TOKEN);
  const id = /Setup ([0-9a-f-]{36})/.exec(c.output())![1]!;
  const lookup = command(r.hub, ["status", id]);
  expect(await lookup.ended).toBe(0);
  expect(lookup.output()).toContain("complete:");
  const unknown = command(r.hub, ["status", crypto.randomUUID()]);
  expect(await unknown.ended).toBe(1);
  expect(unknown.errors()).toContain("does not establish that nothing changed");
  const missing = await rig(false);
  const unavailable = command(missing.hub, [WORKSPACE]);
  expect(await unavailable.ended).toBe(1);
  expect(unavailable.output()).toContain("not-configured");
}, 10_000);

it("command cancellation fences approval, and a lost connection reports an unknown result", async () => {
  const r = await rig();
  const waitForCode = (c: ReturnType<typeof command>) => new Promise<void>((resolve) => {
    c.child.stdout!.on("data", () => { if (c.output().includes("ABCD-EFGH")) resolve(); });
  });
  const cancelled = command(r.hub, [WORKSPACE]);
  await waitForCode(cancelled);
  cancelled.child.kill("SIGINT");
  expect(await cancelled.ended).toBe(1);
  expect(cancelled.output()).toContain("cancelled");
  now += 1000;
  expect(snapshot(r.hub).memberships).toEqual([]);
  const lost = command(r.hub, [WORKSPACE]);
  await waitForCode(lost);
  await r.hub.stop();
  expect(await lost.ended).toBe(1);
  expect(lost.errors()).toContain("result unknown");
  expect(lost.errors()).toContain("does not establish that nothing changed");
  expect(lost.output()).not.toContain("no administrator was granted");
}, 10_000);
