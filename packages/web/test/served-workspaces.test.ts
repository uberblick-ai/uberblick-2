// @vitest-environment node
/** The routed workspace selects both its public upstream and its own signing key. */
import { afterEach, expect, it, vi } from "vitest";
import { importRootSecret, verifyToken } from "@uberblick/hub/token";
import { readAuthEnvelope } from "@uberblick/hub/protocol";
import { createHub, silentLogger } from "@uberblick/hub";
import { settingsRoom } from "@uberblick/schema";

const FIRST = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const SECOND = "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";
const UNKNOWN = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function configure(document: unknown) {
  vi.resetModules();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(document)));
  const config = await import("../src/config.js");
  await config.resolveClientConfig();
  return config;
}

function servingDocument() {
  return {
    hubUrl: "ws://127.0.0.1:4321",
    workspaces: [`startup-${FIRST}`, SECOND],
    hubAuthToken: "legacy-first-key",
    remoteHubUrl: "wss://first.example/ws",
    servedWorkspaces: {
      [FIRST]: { browserKey: "first-key", remoteHubUrl: "wss://first.example/ws", name: "Startup" },
      [SECOND]: { browserKey: "second-key", remoteHubUrl: null, name: "Secondary" },
    },
  };
}

it("uses each workspace key even after another key has already been imported", async () => {
  const config = await configure(servingDocument());
  expect(config.configuredWorkspaces()).toEqual([`startup-${FIRST}`, SECOND]);
  expect(config.localServing()?.workspace).toBe(`startup-${FIRST}`);
  expect(config.localServing(SECOND)?.remoteHubUrl).toBeNull();
  const { mintHubAuthMessage } = await import("../src/collab/rooms.js");
  const firstKey = await importRootSecret("first-key");
  const secondKey = await importRootSecret("second-key");
  for (const [workspace, key, other] of [[FIRST, firstKey, secondKey], [SECOND, secondKey, firstKey], [FIRST, firstKey, secondKey]] as const) {
    const envelope = readAuthEnvelope(await mintHubAuthMessage(workspace, "browser"));
    expect(envelope).not.toBeNull();
    expect(await verifyToken(key, envelope?.token ?? "")).toMatchObject({ workspace, typ: "room", scope: "read-write" });
    expect(await verifyToken(other, envelope?.token ?? "")).toBeNull();
  }
  expect(config.hubAuthToken(UNKNOWN)).toBe("");
  expect(config.localServing(UNKNOWN)).toBeNull();
  await expect(mintHubAuthMessage(UNKNOWN, "browser")).rejects.toThrow("cannot authenticate");
});

it("denies unknown and malformed local entries without using the startup key or guessing a local hub", async () => {
  const document = servingDocument();
  const config = await configure({ ...document, servedWorkspaces: {
    ...document.servedWorkspaces,
    [SECOND]: { browserKey: "second-key" },
    [UNKNOWN]: { browserKey: "unknown-key", remoteHubUrl: null },
  } });
  expect(config.hubAuthToken(FIRST)).toBe("first-key");
  for (const workspace of [SECOND, UNKNOWN]) {
    expect(config.hubAuthToken(workspace)).toBe("");
    expect(config.localServing(workspace)).toBeNull();
  }
});

it("keeps a project rebound scoped to startup and reads local menu names without room admission", async () => {
  const config = await configure({ ...servingDocument(), rebound: true });
  expect(config.localServing(FIRST)?.rebound).toBe(true);
  expect(config.localServing(SECOND)?.rebound).toBe(false);
  expect(config.servedWorkspaceNames()).toEqual(new Map([[FIRST, "Startup"], [SECOND, "Secondary"]]));
  const malformed = await configure({ ...servingDocument(), servedWorkspaces: {
    [FIRST]: { browserKey: "first-key", remoteHubUrl: null, name: "  Startup  " },
    [SECOND]: { browserKey: "second-key", remoteHubUrl: null, name: "bad\nname" },
  } });
  expect(malformed.servedWorkspaceNames()).toEqual(new Map([[FIRST, "Startup"], [SECOND, null]]));
});

it("retains the shared key for legacy multi-workspace development and strips all keys on remote pages", async () => {
  const legacy = await configure({ hubUrl: "ws://localhost:1234", workspaces: [FIRST, SECOND], hubAuthToken: "development-key" });
  expect(legacy.hubAuthToken(FIRST)).toBe("development-key");
  expect(legacy.hubAuthToken(SECOND)).toBe("development-key");
  const remote = await configure({ ...servingDocument(), hubUrl: "wss://remote.example/ws" });
  expect(remote.hubAuthToken(FIRST)).toBe("");
  expect(remote.hubAuthToken(SECOND)).toBe("");
  expect(remote.localServing(SECOND)).toBeNull();
});

it("a missing secondary key neither disables healthy rooms nor drops their shared connection", async () => {
  const hub = await createHub({ authSecret: "first-key", port: 0, databasePath: ":memory:", log: silentLogger });
  const document = servingDocument();
  await configure({ ...document, hubUrl: `ws://127.0.0.1:${hub.port}`, servedWorkspaces: {
    ...document.servedWorkspaces, [SECOND]: { browserKey: "", remoteHubUrl: null },
  } });
  const { acquireRoom } = await import("../src/collab/rooms.js");
  const identity = { name: "browser", color: "#006699" };
  const healthy = acquireRoom(settingsRoom(FIRST), identity, { presence: false });
  let missing: ReturnType<typeof acquireRoom> | null = null;
  try {
    await expect.poll(() => healthy.connection.status.writable).toBe(true);
    const disconnected = vi.fn();
    const stop = healthy.connection.onStatusChange((status) => { if (!status.connected) disconnected(); });
    try {
      missing = acquireRoom(settingsRoom(SECOND), identity, { presence: false });
      await expect.poll(() => missing?.connection.status.tokenMissing).toBe(true);
      expect(healthy.connection.status.tokenMissing).toBe(false);
      expect(healthy.connection.status.writable).toBe(true);
      expect(disconnected).not.toHaveBeenCalled();
    } finally { stop(); }
  } finally {
    missing?.release();
    healthy.release();
    await hub.stop();
  }
});
