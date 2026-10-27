// @vitest-environment node
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { freePort, startOpen, stopChild } from "../e2e/harness.js";

const launches = vi.hoisted(() => ({
  children: [] as ChildProcessWithoutNullStreams[],
  substitute: null as ((port: string) => string) | null,
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const script = launches.substitute?.(args.at(-1) ?? "");
      const child = actual.spawn(command, script === undefined ? args : ["-e", script], options) as ChildProcessWithoutNullStreams;
      launches.children.push(child);
      return child;
    },
  };
});

const roots: string[] = [];
const hubs: Hub[] = [];
const listeners: ReturnType<typeof createServer>[] = [];
const SECRET = "harness-startup-test-signing-secret";

function fixture(hubUrl = "ws://127.0.0.1:1") {
  const runDir = mkdtempSync(join(tmpdir(), "uberblick-harness-open-"));
  roots.push(runDir);
  const workspace = randomUUID();
  const bundleDir = join(runDir, "bundle");
  mkdirSync(bundleDir);
  writeFileSync(join(bundleDir, "index.html"), "<!doctype html><title>harness fixture</title>");
  writeFileSync(join(bundleDir, "uberblick-build.json"), JSON.stringify({ syncProtocolVersion: SYNC_PROTOCOL_VERSION }));
  writeFileSync(join(runDir, ".uberblick.json"), JSON.stringify({ workspaceId: workspace, hubUrl }));
  const config = join(runDir, "config", "uberblick");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "credentials.json"), JSON.stringify({ signingSecret: SECRET }), { mode: 0o600 });
  return { runDir, bundleDir, workspace };
}

async function realHub(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "uberblick-harness-hub-"));
  roots.push(root);
  const hub = await createHub({ authSecret: SECRET, port: 0, databasePath: join(root, "hub.sqlite"),
    log: silentLogger, shutdownTimeoutMs: 5_000 });
  hubs.push(hub);
  return `ws://127.0.0.1:${hub.port}`;
}

function expectStopped(): void {
  expect(launches.children.length).toBeGreaterThan(0);
  for (const child of launches.children) {
    expect(child.exitCode !== null || child.signalCode !== null, `child ${child.pid} still running`).toBe(true);
  }
}

async function exchange(app: Awaited<ReturnType<typeof startOpen>>): Promise<Response> {
  return await fetch(new URL("api/session", app.appUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(app.appUrl).origin },
    body: JSON.stringify({ launch: new URL(app.printed).hash.slice("#launch=".length) }),
  });
}

afterEach(async () => {
  vi.useRealTimers();
  launches.substitute = null;
  const cleanup = await Promise.allSettled([
    ...launches.children.splice(0).map(stopChild),
    ...hubs.splice(0).map((hub) => hub.stop()),
    ...listeners.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
      server.closeAllConnections();
    })),
  ]);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const result of cleanup) if (result.status === "rejected") throw result.reason;
});

it("retries a fresh port held by another real ub open and preserves both isolated launch secrets", async () => {
  const hubUrl = await realHub();
  const holderFixture = fixture(hubUrl);
  const ownFixture = fixture(hubUrl);
  const holder = await startOpen(holderFixture.runDir, holderFixture.bundleDir);
  const heldPort = Number(new URL(holder.appUrl).port);
  const choosePort = vi.fn(async () => choosePort.mock.calls.length === 1 ? heldPort : await freePort());

  const own = await startOpen(ownFixture.runDir, ownFixture.bundleDir, undefined, ownFixture.runDir, choosePort);

  expect(choosePort).toHaveBeenCalledTimes(2);
  expect(launches.children).toHaveLength(3);
  expect(launches.children[1]?.exitCode).toBe(1);
  expect(own.appUrl).not.toBe(holder.appUrl);
  const ownConfig = await (await fetch(new URL("uberblick-config.json", own.appUrl))).json();
  const holderConfig = await (await fetch(new URL("uberblick-config.json", holder.appUrl))).json();
  expect(ownConfig).toMatchObject({ workspaces: [ownFixture.workspace] });
  expect(holderConfig).toMatchObject({ workspaces: [holderFixture.workspace] });
  expect((await exchange(own)).status).toBe(200);
  expect((await exchange(holder)).status).toBe(200);
  await Promise.all([stopChild(own.child), stopChild(holder.child)]);
  expectStopped();
});

it("still retries a fresh port held by a foreign server", async () => {
  const box = fixture(await realHub());
  const foreign = createServer((_request, response) => response.end("foreign server"));
  listeners.push(foreign);
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const address = foreign.address();
  if (address === null || typeof address === "string") throw new Error("foreign server has no TCP address");
  const choosePort = vi.fn(async () => choosePort.mock.calls.length === 1 ? address.port : await freePort());

  const own = await startOpen(box.runDir, box.bundleDir, undefined, box.runDir, choosePort);

  expect(choosePort).toHaveBeenCalledTimes(2);
  expect(Number(new URL(own.appUrl).port)).not.toBe(address.port);
  await stopChild(own.child);
  expectStopped();
});

it("keeps a taken fixed restart port loud without choosing another port", async () => {
  const hubUrl = await realHub();
  const holderFixture = fixture(hubUrl);
  const ownFixture = fixture(hubUrl);
  const holder = await startOpen(holderFixture.runDir, holderFixture.bundleDir);
  const port = Number(new URL(holder.appUrl).port);
  const choosePort = vi.fn(freePort);

  const failure = await startOpen(ownFixture.runDir, ownFixture.bundleDir, port, ownFixture.runDir, choosePort).catch((error: Error) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("stdout:\n");
  expect(String(failure)).toContain(`stderr:\nerror: port ${port} is already serving Uberblick, from another ub open`);
  expect(choosePort).not.toHaveBeenCalled();
  expect(launches.children).toHaveLength(2);
  expect(launches.children[1]?.exitCode).toBe(1);
  await stopChild(holder.child);
  expectStopped();
});

it.each([0, 23])("does not retry unrelated startup exit %s and includes both output streams", async (code) => {
  const box = fixture();
  launches.substitute = () => `process.stdout.write("startup stdout\\n"); process.stderr.write("startup stderr\\n"); process.exitCode = ${code};`;
  const choosePort = vi.fn(async () => 41001);

  const failure = await startOpen(box.runDir, box.bundleDir, undefined, box.runDir, choosePort).catch((error: Error) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("exited during startup\nstdout:\nstartup stdout\n\nstderr:\nstartup stderr\n");
  expect(choosePort).toHaveBeenCalledTimes(1);
  expectStopped();
});

it("exhausts five fresh-port attempts and includes the final child's output", async () => {
  const box = fixture();
  launches.substitute = (port) => `process.stdout.write("startup stdout ${port}\\n"); process.stderr.write("error: port ${port} is already serving Uberblick, from another ub open\\n"); process.exitCode = 1;`;
  const choosePort = vi.fn(async () => 41000 + choosePort.mock.calls.length);

  const failure = await startOpen(box.runDir, box.bundleDir, undefined, box.runDir, choosePort).catch((error: Error) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("exited during startup\nstdout:\nstartup stdout 41005\n");
  expect(String(failure)).toContain("stderr:\nerror: port 41005 is already serving Uberblick, from another ub open");
  expect(choosePort).toHaveBeenCalledTimes(5);
  expect(launches.children).toHaveLength(5);
  expectStopped();
});

it("bounds readiness and forced shutdown while reporting both output streams", async () => {
  const box = fixture();
  launches.substitute = () => `process.on("SIGTERM", () => {}); process.stdout.write("startup stdout\\n"); process.stderr.write("startup stderr\\n"); setInterval(() => {}, 1000);`;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const choosePort = vi.fn(async () => 41001);
    const pending = startOpen(box.runDir, box.bundleDir, undefined, box.runDir, choosePort).catch((error: Error) => error);
    await Promise.resolve();
    const child = launches.children[0];
    if (child === undefined) throw new Error("startup spawned no child");
    await Promise.all([once(child.stdout, "data"), once(child.stderr, "data")]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(child.signalCode).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.signalCode).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const failure = await pending;

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("did not become ready\nstdout:\nstartup stdout\n\nstderr:\nstartup stderr\n");
    expect(child.signalCode).toBe("SIGKILL");
    expect(choosePort).toHaveBeenCalledTimes(1);
    expectStopped();
  } finally {
    vi.useRealTimers();
  }
});

it("stops a ready child with no launch address and reports both output streams", async () => {
  const box = fixture();
  launches.substitute = (port) => `process.stdout.write("startup stdout\\n"); process.stderr.write("startup stderr\\n"); process.stdin.once("data", () => process.stdout.write("web        http://127.0.0.1:${port}/\\n"));`;
  const choosePort = vi.fn(async () => 41001);
  const pending = startOpen(box.runDir, box.bundleDir, undefined, box.runDir, choosePort).catch((error: Error) => error);
  await Promise.resolve();
  const child = launches.children[0];
  if (child === undefined) throw new Error("startup spawned no child");
  await Promise.all([once(child.stdout, "data"), once(child.stderr, "data")]);
  child.stdin.write("print ready\n");
  const failure = await pending;

  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("printed no launch address\nstdout:\nstartup stdout\nweb        http://127.0.0.1:41001/\n");
  expect(String(failure)).toContain("stderr:\nstartup stderr\n");
  expect(choosePort).toHaveBeenCalledTimes(1);
  expectStopped();
});
