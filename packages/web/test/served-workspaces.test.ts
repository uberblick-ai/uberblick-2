// @vitest-environment node
/** A ub open page asks for each routed workspace's room token with its session; it never holds a key. */
import { afterEach, expect, it, vi } from "vitest";
import { MAX_TOKEN_LIFETIME_SECONDS, importRootSecret, mintToken, verifyToken } from "@uberblick/schema/token";
import { readAuthEnvelope } from "@uberblick/schema/protocol";
import { createHub, silentLogger } from "@uberblick/hub";
import { settingsRoom } from "@uberblick/schema";

const FIRST = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const SECOND = "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";
const UNKNOWN = "11111111-1111-4111-8111-111111111111";
const SESSION = "s".repeat(43);
const LAUNCH = "L".repeat(43);
const KEYS: Record<string, string> = { [FIRST]: "first-key", [SECOND]: "second-key" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

type Route = (request: { path: string; init: RequestInit | undefined }) => Promise<Response> | Response | undefined;

/** Answer the room-token route the way ub open does: only for its own session. */
async function roomToken(init: RequestInit | undefined, accepted = SESSION): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (headers.get("X-Uberblick-Session") !== accepted) return Response.json({ error: "session_required" }, { status: 401 });
  const body = JSON.parse(String(init?.body)) as { workspace: string; subject: string };
  const key = KEYS[body.workspace];
  if (key === undefined) return Response.json({ error: "invalid_request" }, { status: 400 });
  return Response.json({ token: await mintToken(await importRootSecret(key), {
    typ: "room", sub: body.subject, workspace: body.workspace, scope: "read-write", kid: null,
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  }) });
}

async function configure(document: unknown, options: { storage?: Storage; route?: Route } = {}) {
  vi.resetModules();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const storage = options.storage ?? memoryStorage({ "uberblick:ub-open-session": SESSION });
  vi.stubGlobal("localStorage", storage);
  const fetch = vi.fn(async (path: string, init?: RequestInit) =>
    await options.route?.({ path, init }) ??
      (path === "/api/room-token" ? await roomToken(init) : Response.json(document)));
  vi.stubGlobal("fetch", fetch);
  const config = await import("../src/config.js");
  await config.resolveClientConfig();
  return { config, fetch, storage };
}

function servingDocument() {
  return {
    hubUrl: "ws://127.0.0.1:4321",
    workspaces: [`startup-${FIRST}`, SECOND],
    hubAuthToken: "",
    remoteHubUrl: "wss://first.example/ws",
    servedWorkspaces: {
      [FIRST]: { remoteHubUrl: "wss://first.example/ws", name: "Startup" },
      [SECOND]: { remoteHubUrl: null, name: "Secondary" },
    },
  };
}

it("asks ub open for each workspace's room token with the page's session", async () => {
  const { config, fetch } = await configure(servingDocument());
  expect(config.configuredWorkspaces()).toEqual([`startup-${FIRST}`, SECOND]);
  expect(config.localServing()?.workspace).toBe(`startup-${FIRST}`);
  expect(config.localServing(SECOND)?.remoteHubUrl).toBeNull();
  expect(config.hubAuthToken()).toBe("");
  const { mintHubAuthMessage } = await import("../src/collab/rooms.js");
  const firstKey = await importRootSecret("first-key");
  const secondKey = await importRootSecret("second-key");
  for (const [workspace, key, other] of [[FIRST, firstKey, secondKey], [`startup-${SECOND}`, secondKey, firstKey]] as const) {
    const envelope = readAuthEnvelope(await mintHubAuthMessage(workspace, "browser"));
    expect(envelope).not.toBeNull();
    expect(await verifyToken(key, envelope?.token ?? "")).toMatchObject({ typ: "room", scope: "read-write", sub: "browser" });
    expect(await verifyToken(other, envelope?.token ?? "")).toBeNull();
  }
  const requests = fetch.mock.calls.filter(([path]) => path === "/api/room-token");
  expect(requests.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { workspace: FIRST, subject: "browser" }, { workspace: SECOND, subject: "browser" },
  ]);
  expect(config.localServing(UNKNOWN)).toBeNull();
  await expect(mintHubAuthMessage(UNKNOWN, "browser")).rejects.toThrow("cannot authenticate");
  expect(fetch.mock.calls.filter(([path]) => path === "/api/room-token")).toHaveLength(2);
});

it("forgets a session ub open refuses and reports the page as not connected", async () => {
  const { storage } = await configure(servingDocument(), { storage: memoryStorage({ "uberblick:ub-open-session": "x".repeat(43) }) });
  const { mintHubAuthMessage } = await import("../src/collab/rooms.js");
  const session = await import("../src/collab/local-session.js");
  expect(session.localSessionMissing()).toBe(false);
  await expect(mintHubAuthMessage(FIRST, "browser")).rejects.toThrow("cannot authenticate");
  expect(session.localSessionMissing()).toBe(true);
  expect(storage.getItem("uberblick:ub-open-session")).toBeNull();
});

it("trades the address's launch secret once for a stored session and strips it from the address", async () => {
  const exchanged: unknown[] = [];
  const { fetch, storage } = await configure(servingDocument(), {
    storage: memoryStorage(),
    route: ({ path, init }) => {
      if (path !== "/api/session") return undefined;
      exchanged.push(JSON.parse(String(init?.body)));
      return Response.json({ session: SESSION });
    },
  });
  const session = await import("../src/collab/local-session.js");
  const replaceState = vi.fn();
  const location = { hash: `#launch=${LAUNCH}`, pathname: "/", search: "" } as Location;
  session.takeLaunchSecret(location, { state: null, replaceState } as unknown as History);
  expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  await expect(session.localSession()).resolves.toBe(SESSION);
  expect(exchanged).toEqual([{ launch: LAUNCH }]);
  expect(storage.getItem("uberblick:ub-open-session")).toBe(SESSION);
  expect(await session.localSessionHeaders()).toEqual({ "X-Uberblick-Session": SESSION });
  session.takeLaunchSecret({ hash: "#heading", pathname: "/", search: "" } as Location, { state: null, replaceState } as unknown as History);
  expect(replaceState).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls.filter(([path]) => path === "/api/session")).toHaveLength(1);
});

it("denies unknown and malformed local entries without guessing a local hub", async () => {
  const document = servingDocument();
  const { config } = await configure({ ...document, servedWorkspaces: {
    ...document.servedWorkspaces,
    [SECOND]: { name: "Secondary" },
    [UNKNOWN]: { remoteHubUrl: null },
  } });
  expect(config.servedLocally(FIRST)).toBe(true);
  for (const workspace of [SECOND, UNKNOWN]) {
    expect(config.servedLocally(workspace)).toBe(false);
    expect(config.localServing(workspace)).toBeNull();
  }
});

it("keeps a project rebound scoped to startup and reads local menu names without room admission", async () => {
  const { config } = await configure({ ...servingDocument(), rebound: true });
  expect(config.localServing(FIRST)?.rebound).toBe(true);
  expect(config.localServing(SECOND)?.rebound).toBe(false);
  expect(config.servedWorkspaceNames()).toEqual(new Map([[FIRST, "Startup"], [SECOND, "Secondary"]]));
  const malformed = await configure({ ...servingDocument(), servedWorkspaces: {
    [FIRST]: { remoteHubUrl: null, name: "  Startup  " },
    [SECOND]: { remoteHubUrl: null, name: "bad\nname" },
  } });
  expect(malformed.config.servedWorkspaceNames()).toEqual(new Map([[FIRST, "Startup"], [SECOND, null]]));
});

it("retains the shared key for legacy multi-workspace development and strips all keys on remote pages", async () => {
  const legacy = await configure({ hubUrl: "ws://localhost:1234", workspaces: [FIRST, SECOND], hubAuthToken: "development-key" });
  expect(legacy.config.hubAuthToken()).toBe("development-key");
  const remote = await configure({ ...servingDocument(), hubUrl: "wss://remote.example/ws", hubAuthToken: "stale-key" });
  expect(remote.config.hubAuthToken()).toBe("");
  expect(remote.config.servedLocally(FIRST)).toBe(false);
  expect(remote.config.localServing(SECOND)).toBeNull();
});

it("an unserved secondary neither disables healthy rooms nor drops their shared connection", async () => {
  const hub = await createHub({ authSecret: "first-key", port: 0, databasePath: ":memory:", log: silentLogger });
  const document = servingDocument();
  const { fetch } = await configure({ ...document, hubUrl: `ws://127.0.0.1:${hub.port}`, servedWorkspaces: {
    ...document.servedWorkspaces, [SECOND]: { remoteHubUrl: 5 },
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
      expect(fetch.mock.calls.filter(([path, init]) => path === "/api/room-token" &&
        JSON.parse(String(init?.body)).workspace === SECOND)).toHaveLength(0);
    } finally { stop(); }
  } finally {
    missing?.release();
    healthy.release();
    await hub.stop();
  }
});
