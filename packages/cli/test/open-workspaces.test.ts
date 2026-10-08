/** Several recorded replicas share one browser server, with separate authority and sync. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { createHub, silentLogger } from "@uberblick/hub";
import { writeHubLogin, type StoredHubLogin } from "@uberblick/hub/auth-store";
import { createMcpEngine, defaultDatabasePath, resolveMcpConfig, type ServingSyncStatus } from "@uberblick/mcp-server";
import { appendBlock, directoryRoom, editBlock, getBlocks, getDirectoryEntry, initDoc,
  roomForDoc, upsertDirectoryEntry } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { localBrowserKey } from "../src/browser-key.js";
import { probePort } from "../src/probes.js";
import { rememberWorkspaceBinding } from "../src/workspace-registry.js";
import { pointAt, runUbAsync, waitUntil, type Sandbox } from "./helpers.js";
import { authMessage, bearer, cleanUp, configured, FIRST_REMOTE, freePort, get, hubs, open,
  openStore, SECRET, WORKSPACE, type Running } from "./open-fixtures.js";

// Sorts before WORKSPACE: the startup binding must nevertheless remain first.
const SECOND = "04f8cafa-054d-450d-9a2e-50b3aee79ac5";
const UNKNOWN = "03082086-b6ef-44b0-a0b2-e34fa6192681";
const NO_REPLICA = "ea4059f2-1e37-4021-ad64-ff6cfeef2a2d";
const LOCAL = "fa96f476-312a-46a0-9812-14d7b4149f99";
const DOC = "671ed55d-36de-42a9-bd85-701eff199942";

afterEach(cleanUp);

interface BrowserConfig {
  workspaces: string[];
  servedWorkspaces: Record<string, { browserKey: string; remoteHubUrl: string | null }>;
}

async function config(app: Running): Promise<BrowserConfig> {
  return await (await get(`${app.url}uberblick-config.json`)).json() as BrowserConfig;
}

/** Seed the same UUID in different local replicas before either hub has seen it. */
async function seed(box: Sandbox, workspace: string, title: string) {
  const engine = await createMcpEngine(resolveMcpConfig({ ...box.env,
    WORKSPACE_ID: workspace, HUB_URL: FIRST_REMOTE }));
  const document = new Y.Doc();
  const directory = new Y.Doc();
  try {
    initDoc(document, { uuid: DOC, title });
    appendBlock(document, { type: "paragraph", text: `${title} local text` });
    upsertDirectoryEntry(directory, { uuid: DOC, title });
    engine.store.appendUpdate(roomForDoc(workspace, DOC), Y.encodeStateAsUpdate(document), "local");
    engine.store.appendUpdate(directoryRoom(workspace), Y.encodeStateAsUpdate(directory), "local");
  } finally {
    document.destroy(); directory.destroy();
    await engine.close();
  }
}

async function deviceHub(box: Sandbox, workspace: string, handle: string, permitted = true) {
  const hub = await createHub({ port: 0, address: "127.0.0.1", log: silentLogger,
    databasePath: join(box.cwd, `${handle}-hub.sqlite`),
    github: { clientId: "Iv1.0123456789abcdef" } }, { deviceCredentials: true });
  hubs.push(hub);
  const identity = hub.principals!.identify(permitted ? "1234" : "5678", handle);
  if (permitted) hub.memberships!.grant({ workspaceId: workspace, principalId: identity.id, role: "admin" });
  const issued = hub.credentials!.issue({ principalId: identity.id, deviceId: crypto.randomUUID(),
    workspaces: permitted ? [workspace] : [] });
  const { replacedAt: _replaced, ...record } = issued.record;
  const login: StoredHubLogin = { identity, credential: {
    record, key: Buffer.from(issued.keyBytes).toString("base64url"),
  } };
  const origin = `http://127.0.0.1:${hub.port}`;
  const endpoint = `ws://127.0.0.1:${hub.port}/ws`;
  await writeHubLogin(origin, login, box.env);
  return { hub, endpoint, origin, login };
}

async function browser(app: Running, box: Sandbox, workspace: string, room: string,
  key = localBrowserKey(workspace, box.env), claim = workspace) {
  const document = new Y.Doc();
  let refused = false;
  const provider = new HocuspocusProvider({
    url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
    name: room, document, token: await authMessage(key, "read-write", { workspace: claim }),
    onAuthenticationFailed: () => { refused = true; },
    ...{ WebSocketPolyfill: class extends WebSocket {
      constructor(url: string | URL) {
        super(url, { headers: { Origin: app.url.slice(0, -1) } } as unknown as string[]);
      }
    } },
  });
  return { document, provider, refused: () => refused,
    close: () => { provider.destroy(); document.destroy(); } };
}

async function headers(box: Sandbox, workspace: string) {
  return bearer(await authMessage(localBrowserKey(workspace, box.env), "read-write", { workspace }));
}

describe("ub open: this machine's workspaces", () => {
  it("offers only recorded replicas, keeps the startup workspace first and leaves project bindings alone", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const secondaryPort = await freePort();
    const secondaryHub = `ws://127.0.0.1:${secondaryPort}`;
    await Promise.all([seed(box, SECOND, "Secondary"), seed(box, UNKNOWN, "Unknown"), seed(box, LOCAL, "Local")]);
    await rememberWorkspaceBinding({ workspaceId: SECOND, hubUrl: secondaryHub }, box.env);
    await rememberWorkspaceBinding({ workspaceId: NO_REPLICA, hubUrl: FIRST_REMOTE }, box.env);
    await rememberWorkspaceBinding({ workspaceId: LOCAL, hubUrl: null }, box.env);
    const binding = readFileSync(join(box.cwd, ".uberblick.json"), "utf8");
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      const document = await config(app);
      expect(document.workspaces).toEqual([WORKSPACE, SECOND, LOCAL]);
      expect(document.servedWorkspaces).toEqual({
        [WORKSPACE]: { browserKey: localBrowserKey(WORKSPACE, box.env), remoteHubUrl: FIRST_REMOTE },
        [SECOND]: { browserKey: localBrowserKey(SECOND, box.env), remoteHubUrl: secondaryHub },
        [LOCAL]: { browserKey: localBrowserKey(LOCAL, box.env), remoteHubUrl: null },
      });
      const selected = await browser(app, box, SECOND, directoryRoom(SECOND));
      const local = await browser(app, box, LOCAL, directoryRoom(LOCAL));
      try {
        await waitUntil("secondary and local directories", () => selected.provider.isSynced && local.provider.isSynced);
        expect(getDirectoryEntry(selected.document, DOC)?.title).toBe("Secondary");
        expect(getDirectoryEntry(local.document, DOC)?.title).toBe("Local");
        expect((await probePort("127.0.0.1", secondaryPort)).state).toBe("free");
        expect(await (await fetch(`${app.url}api/account`, { headers: await headers(box, LOCAL) })).json())
          .toEqual({ state: "signed-out" });
      } finally { selected.close(); local.close(); }
      expect((await get(app.url)).status).toBe(200);
      expect((await config(app)).workspaces[0]).toBe(WORKSPACE);
      expect(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).toBe(binding);
      // The existing CLI spells its binding reading `ub workspace` (without a subcommand).
      const status = await runUbAsync(["workspace"], box);
      expect(status.status, status.output).toBe(0);
      expect(status.stdout).toContain(WORKSPACE);
      expect(status.stdout).not.toContain(SECOND);
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("serves each replica and hub with its own key, search, account and access while both tabs keep syncing", async () => {
    const { box, env } = configured();
    await Promise.all([seed(box, WORKSPACE, "Primary"), seed(box, SECOND, "Secondary")]);
    const primary = await deviceHub(box, WORKSPACE, "primary-person");
    const secondary = await deviceHub(box, SECOND, "secondary-person");
    pointAt(box, primary.endpoint);
    await rememberWorkspaceBinding({ workspaceId: SECOND, hubUrl: secondary.endpoint }, box.env);
    const binding = readFileSync(join(box.cwd, ".uberblick.json"), "utf8");
    const app = await open(box, ["--port", String(await freePort())], env);
    const tabs = await Promise.all([browser(app, box, WORKSPACE, roomForDoc(WORKSPACE, DOC)),
      browser(app, box, SECOND, roomForDoc(SECOND, DOC))]);
    const auth = await Promise.all([headers(box, WORKSPACE), headers(box, SECOND)]);
    const targets = [primary, secondary];
    const workspaces = [WORKSPACE, SECOND];
    try {
      await waitUntil("both locally seeded browser documents", () => tabs.every(tab => tab.provider.isSynced));
      expect(tabs.map(tab => getBlocks(tab.document)[0]?.text)).toEqual(["Primary local text", "Secondary local text"]);
      const status = async (index: number) => await (await fetch(`${app.url}api/status`, { headers: auth[index]! })).json() as ServingSyncStatus;
      const document = await config(app);
      for (const [index, workspace] of workspaces.entries()) {
        const target = targets[index]!;
        await waitUntil(`${workspace} sharing through its own hub`, async () => (await status(index)).caughtUp);
        const ownStatus = await status(index);
        expect(document.servedWorkspaces[workspace]!.remoteHubUrl).toBe(target.endpoint);
        expect(Object.keys(ownStatus.rooms).every(room => room.startsWith(`${workspace}/`))).toBe(true);
        const search = async (q: string) => await (await fetch(`${app.url}api/search?q=${q}`, { headers: auth[index]! })).json() as { hits: { uuid: string }[] };
        await waitUntil(`${workspace} replica search index`, async () => (await search(index === 0 ? "Primary" : "Secondary")).hits.length === 1);
        expect((await search(index === 0 ? "Secondary" : "Primary")).hits).toEqual([]);
        expect(await (await fetch(`${app.url}api/account`, { headers: auth[index]! })).json())
          .toEqual({ state: "signed-in", handle: `${index === 0 ? "primary" : "secondary"}-person` });
        const access = await fetch(`${app.url}api/access`, { method: "POST",
          headers: { ...auth[index], "content-type": "application/json", origin: new URL(app.url).origin },
          body: JSON.stringify({ operation: "own-role", workspaceId: workspace }) });
        expect(await access.json()).toEqual({ status: "ok", role: "admin", hub: target.origin });
        const wrongWorkspace = await fetch(`${app.url}api/access`, { method: "POST",
          headers: { ...auth[index], "content-type": "application/json", origin: new URL(app.url).origin },
          body: JSON.stringify({ operation: "own-role", workspaceId: workspaces[1 - index] }) });
        expect(wrongWorkspace.status).toBe(403);
        for (const path of ["status", "search?q=Primary", "account", "access"]) {
          const separator = path.includes("?") ? "&" : "?";
          const response = await fetch(`${app.url}api/${path}${separator}workspace=${workspaces[1 - index]}`, { headers: auth[index]! });
          expect(response.status, path).toBe(401);
          const otherClaim = await fetch(`${app.url}api/${path}`, { headers: bearer(await authMessage(
            localBrowserKey(workspace, box.env), "read-only", { workspace: workspaces[1 - index]! })) });
          expect(otherClaim.status, `${path}: workspace claim signed with the other key`).toBe(401);
        }
      }
      // Both live browser rooms remain independently active after a second workspace opens.
      for (const [index, tab] of tabs.entries()) {
        const block = getBlocks(tab.document)[0]!;
        editBlock(tab.document, block.id, block.text, `edit from tab ${index}`, { rev: block.rev });
      }
      await waitUntil("both tabs' edits at their own hubs", () => targets.every((target, index) =>
        getBlocks(target.hub.hocuspocus.documents.get(roomForDoc(workspaces[index]!, DOC))!)[0]?.text === `edit from tab ${index}`));
      for (const [index, target] of targets.entries()) {
        const remote = target.hub.hocuspocus.documents.get(roomForDoc(workspaces[index]!, DOC))!;
        const block = getBlocks(remote)[0]!;
        editBlock(remote, block.id, block.text, `remote edit ${index}`, { rev: block.rev });
        expect(target.hub.hocuspocus.documents.has(roomForDoc(workspaces[1 - index]!, DOC))).toBe(false);
      }
      await waitUntil("each remote edit back at its own tab", () => tabs.every((tab, index) =>
        getBlocks(tab.document)[0]?.text === `remote edit ${index}`));
      for (const request of [
        { workspace: SECOND, room: roomForDoc(SECOND, DOC), key: localBrowserKey(WORKSPACE, box.env), claim: WORKSPACE },
        { workspace: SECOND, room: roomForDoc(SECOND, DOC), key: localBrowserKey(WORKSPACE, box.env), claim: SECOND },
        { workspace: UNKNOWN, room: directoryRoom(UNKNOWN), key: localBrowserKey(WORKSPACE, box.env), claim: UNKNOWN },
      ]) {
        const refused = await browser(app, box, request.workspace, request.room, request.key, request.claim);
        try { await waitUntil("cross-workspace browser refusal", refused.refused); expect(refused.provider.isSynced).toBe(false); }
        finally { refused.close(); }
      }
      const unserved = await fetch(`${app.url}api/account`, { headers: bearer(await authMessage(
        localBrowserKey(WORKSPACE, box.env), "read-only", { workspace: UNKNOWN })) });
      expect(unserved.status).toBe(401);
      const visible = JSON.stringify(await (await get(`${app.url}uberblick-config.json`)).json());
      expect(visible).not.toContain(SECRET);
      expect(visible).not.toContain(primary.login.credential.key);
      expect(visible).not.toContain(secondary.login.credential.key);
      expect(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).toBe(binding);
    } finally { for (const tab of tabs) tab.close(); expect((await app.interrupt()).status).toBe(0); }
  });

  it("makes an older replica with no record switchable after its first bound open", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    await seed(box, SECOND, "Older replica");
    const binding = readFileSync(join(box.cwd, ".uberblick.json"), "utf8");
    let app = await open(box, ["--port", String(await freePort())], env);
    try {
      expect((await config(app)).workspaces).toEqual([WORKSPACE]);
      expect((await app.interrupt()).status).toBe(0);
      const cwd = join(box.cwd, "older-project");
      mkdirSync(cwd);
      writeFileSync(join(cwd, ".uberblick.json"), JSON.stringify({ workspaceId: SECOND, hubUrl: FIRST_REMOTE }));
      app = await open({ ...box, cwd }, ["--port", String(await freePort())], env);
      expect((await config(app)).workspaces).toEqual([SECOND, WORKSPACE]);
      expect((await app.interrupt()).status).toBe(0);
      app = await open(box, ["--port", String(await freePort())], env);
      expect((await config(app)).workspaces).toEqual([WORKSPACE, SECOND]);
      expect(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).toBe(binding);
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("keeps serving the startup workspace when another serving replica holds a secondary", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    await seed(box, SECOND, "Held secondary");
    await rememberWorkspaceBinding({ workspaceId: SECOND, hubUrl: FIRST_REMOTE }, box.env);
    const holder = await createMcpEngine(resolveMcpConfig({ ...box.env,
      WORKSPACE_ID: SECOND, HUB_URL: FIRST_REMOTE }), { serving: true });
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      const unavailable = await fetch(`${app.url}api/status`, { headers: await headers(box, SECOND) });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ error: "replica_unavailable", reason: "replica-held" });
      expect((await fetch(`${app.url}api/status`, { headers: await headers(box, WORKSPACE) })).status).toBe(200);
      expect((await get(app.url)).status).toBe(200);
    } finally { expect((await app.interrupt()).status).toBe(0); await holder.close(); }
  });

  it("contains a secondary replica quarantine while the startup replica keeps syncing", async () => {
    const { box, env } = configured();
    await Promise.all([seed(box, WORKSPACE, "Primary"), seed(box, SECOND, "Secondary")]);
    const primary = await deviceHub(box, WORKSPACE, "healthy-person");
    const secondary = await deviceHub(box, SECOND, "quarantined-person");
    pointAt(box, primary.endpoint);
    await rememberWorkspaceBinding({ workspaceId: SECOND, hubUrl: secondary.endpoint }, box.env);
    const app = await open(box, ["--port", String(await freePort())], env);
    const tabs = await Promise.all([browser(app, box, WORKSPACE, roomForDoc(WORKSPACE, DOC)),
      browser(app, box, SECOND, roomForDoc(SECOND, DOC))]);
    const secondaryHeaders = await headers(box, SECOND);
    const readStatus = async () => await fetch(`${app.url}api/status`, { headers: secondaryHeaders });
    let database: ReturnType<typeof openStore> | null = null;
    try {
      await waitUntil("both browser rooms before quarantine", () => tabs.every(tab => tab.provider.isSynced));
      await waitUntil("secondary hub acknowledgement before quarantine", async () =>
        (await (await readStatus()).json() as ServingSyncStatus).caughtUp);
      database = openStore(defaultDatabasePath(SECOND, box.env));
      database.exec("CREATE TRIGGER refuse_replica_append BEFORE INSERT ON updates BEGIN SELECT RAISE(ABORT, 'simulated disk refusal'); END");
      const remote = secondary.hub.hocuspocus.documents.get(roomForDoc(SECOND, DOC))!;
      const remoteBlock = getBlocks(remote)[0]!;
      editBlock(remote, remoteBlock.id, remoteBlock.text, "ahead of refused log", { rev: remoteBlock.rev });
      await waitUntil("secondary quarantine reading", async () => (await readStatus()).status === 503);
      expect(await (await readStatus()).json()).toEqual({ error: "replica_unavailable", reason: "replica-quarantined" });
      const block = getBlocks(tabs[0]!.document)[0]!;
      editBlock(tabs[0]!.document, block.id, block.text, "primary still sharing", { rev: block.rev });
      await waitUntil("healthy primary hub edit after secondary quarantine", () =>
        getBlocks(primary.hub.hocuspocus.documents.get(roomForDoc(WORKSPACE, DOC))!)[0]?.text === "primary still sharing");
      expect((await fetch(`${app.url}api/status`, { headers: await headers(box, WORKSPACE) })).status).toBe(200);
    } finally {
      database?.exec("DROP TRIGGER IF EXISTS refuse_replica_append"); database?.close();
      for (const tab of tabs) tab.close(); expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("reports a secondary hub's refusal without stopping other workspaces", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    await seed(box, SECOND, "Refused secondary");
    const secondary = await deviceHub(box, SECOND, "refused-person", false);
    await rememberWorkspaceBinding({ workspaceId: SECOND, hubUrl: secondary.endpoint }, box.env);
    const app = await open(box, ["--port", String(await freePort())], env);
    const selected = await browser(app, box, SECOND, roomForDoc(SECOND, DOC));
    try {
      await waitUntil("locally readable refused workspace", () => selected.provider.isSynced);
      const secondaryHeaders = await headers(box, SECOND);
      const status = async () => await (await fetch(`${app.url}api/status`, { headers: secondaryHeaders })).json() as ServingSyncStatus;
      await waitUntil("refusal from the secondary hub", async () => (await status()).notSharedReason === "no-workspace-access");
      expect((await status()).caughtUp).toBe(false);
      expect((await config(app)).servedWorkspaces[SECOND]!.remoteHubUrl)
        .toBe(secondary.endpoint);
      expect(await (await fetch(`${app.url}api/account`, { headers: secondaryHeaders })).json()).toEqual({ state: "unavailable" });
      expect(getBlocks(selected.document)[0]?.text).toBe("Refused secondary local text");
      expect((await fetch(`${app.url}api/status`, { headers: await headers(box, WORKSPACE) })).status).toBe(200);
    } finally { selected.close(); expect((await app.interrupt()).status).toBe(0); }
  });
});
