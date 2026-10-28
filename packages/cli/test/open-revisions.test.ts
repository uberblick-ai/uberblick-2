import { join } from "node:path";
import { createHash } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { silentLogger } from "@uberblick/hub";
import { createTeamHub } from "@uberblick/hub/team";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { writeHubLogin } from "@uberblick/mcp-server/auth-store";
import {
  appendBlock, encodeRevisionResponseFrames, getBlocks, getMeta, initDoc,
  readRevisionRequest, roomForDoc, snapshotRevision, type RevisionEntry, type RevisionRequest, type RevisionResponse,
} from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { localBrowserKey } from "../src/browser-key.js";
import { pointAt, waitUntil } from "./helpers.js";
import {
  WORKSPACE, authMessage, bearer, cleanUp, configured, freePort,
  getWithHost, holdDefaultHub, hubs, open,
} from "./open-fixtures.js";

afterEach(cleanUp);

describe("ub open automatic revisions", () => {
  it("reads cached revisions and detached content only through the workspace and session boundary", async () => {
    const { box, env } = configured();
    const hub = await createTeamHub({ port: 0, databasePath: join(box.cwd, "revision-hub.sqlite"),
      github: { clientId: "Iv1.0123456789abcdef" }, log: silentLogger }, { deviceCredentials: true });
    hubs.push(hub);
    const endpoint = `ws://127.0.0.1:${hub.port}`;
    pointAt(box, endpoint);
    const person = hub.principals!.identify("12345", "revision-person");
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: person.id, role: "admin" });
    const issued = issueCredential(hub.credentials!, { principalId: person.id, deviceId: crypto.randomUUID(), workspaces: [WORKSPACE] });
    const { replacedAt: _replaced, ...record } = issued.record;
    await writeHubLogin(`http://127.0.0.1:${hub.port}`, { identity: person,
      credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") } }, box.env);
    const app = await open(box, ["--port", String(await freePort())], env);
    const uuid = "7a819902-f86e-45d1-84d3-58d8f979a503";
    const token = await authMessage(localBrowserKey(WORKSPACE, box.env));
    const headers = bearer(token);
    const path = `${app.url}api/revisions?uuid=${uuid}`;
    const document = new Y.Doc();
    const snapshot = new Y.Doc();
    const browser = new HocuspocusProvider({
      url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      name: roomForDoc(WORKSPACE, uuid), document,
      token: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-write"),
      ...{ WebSocketPolyfill: class extends WebSocket {
        constructor(url: string | URL) { super(url, { headers: { Origin: app.url.slice(0, -1) } } as unknown as string[]); }
      } },
    });
    try {
      expect((await fetch(path, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
      expect((await getWithHost(path, "attacker.example", token)).status).toBe(421);
      const empty = await fetch(path, { headers });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({ revisions: [], history: {
        complete: true, refreshFailed: false, offline: false, newestDownloadedRevision: null,
      } });
      expect(empty.headers.get("cache-control")).toBe("no-store");
      expect(empty.headers.get("access-control-allow-origin")).toBeNull();
      expect((await fetch(path, { method: "POST", headers })).status).toBe(403);
      for (const query of ["", "?uuid=not-a-document"]) {
        const invalid = await fetch(`${app.url}api/revisions${query}`, { headers });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ error: "invalid_document" });
      }
      expect((await fetch(`${path}&revision=`, { headers })).status).toBe(400);

      await waitUntil("the revision writer to synchronize", () => browser.isSynced);
      document.transact(() => {
        initDoc(document, { uuid, title: "Historical title" });
        appendBlock(document, { type: "paragraph", text: "Historical text" });
        document.getMap("data").set('["record","sales","first"]', { amount: 42 });
      });
      await waitUntil("the historical content to reach the hub", () => {
        const current = hub.hocuspocus.documents.get(roomForDoc(WORKSPACE, uuid));
        return current !== undefined && getMeta(current).title === "Historical title";
      });
      const listed = await fetch(`${path}&refresh=true`, { headers });
      const { revisions } = await listed.json() as { revisions: RevisionEntry[] };
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ author: { githubUsername: "revision-person", surface: { kind: "browser" } },
        endedAt: null, title: "Historical title" });
      const content = await fetch(`${path}&revision=${revisions[0]!.id}`, { headers });
      expect(content.status).toBe(200);
      const { state } = await content.json() as { state: string };
      Y.applyUpdate(snapshot, Buffer.from(state, "base64"));
      expect(getMeta(snapshot).title).toBe("Historical title");
      expect(getBlocks(snapshot)).toMatchObject([{ text: "Historical text" }]);
      expect(snapshot.getMap("data").get('["record","sales","first"]')).toEqual({ amount: 42 });
      snapshot.getMap("meta").set("title", "Detached change");
      expect(getMeta(document).title).toBe("Historical title");

      const mutationHeaders = { ...headers, origin: app.url.slice(0, -1), "content-type": "application/json" };
      const nameRequest = { uuid, operation: "name", name: "Reviewed in the browser",
        expectedHash: createHash("sha256").update(snapshotRevision(document).checksum).digest("hex") };
      expect((await fetch(path, { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ ...nameRequest, surface: { kind: "mcp", name: "forged" } }) })).status).toBe(400);
      const stale = await fetch(path, { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ ...nameRequest, expectedHash: "0".repeat(64) }) });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ reason: "stale-state" });
      const named = await fetch(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify(nameRequest) });
      expect(named.status).toBe(200);
      const { revision: namedRevision } = await named.json() as { revision: RevisionEntry };
      expect(namedRevision).toMatchObject({ id: revisions[0]!.id, author: revisions[0]!.author, endedAt: expect.any(Number),
        name: { text: "Reviewed in the browser", namer: { githubUsername: "revision-person", surface: { kind: "browser" } },
          namedAt: expect.any(Number), canManage: true } });
      expect(namedRevision.endedAt).toBe(namedRevision.name!.namedAt);
      const duplicate = await fetch(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify(nameRequest) });
      expect(await duplicate.json()).toMatchObject({ reason: "already-named", existingName: { text: "Reviewed in the browser" } });
      const renameStartedAt = Date.now();
      expect((await fetch(path, { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ uuid, operation: "rename", revisionId: namedRevision.id, name: "Review accepted",
          surface: { kind: "mcp", name: "forged" } }) })).status).toBe(400);
      const renamed = await fetch(path, { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ uuid, operation: "rename", revisionId: namedRevision.id, name: "Review accepted" }) });
      const { revision: renamedRevision } = await renamed.json() as { revision: RevisionEntry };
      expect(renamedRevision.name).toMatchObject({ text: "Review accepted",
        namer: { githubUsername: "revision-person", surface: { kind: "browser", name: "browser" } } });
      expect(renamedRevision.name!.namedAt).toBeGreaterThanOrEqual(renameStartedAt);
      expect(renamedRevision.name!.namedAt).toBeLessThanOrEqual(Date.now());
      const removed = await fetch(path, { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ uuid, operation: "remove_name", revisionId: namedRevision.id }) });
      expect(await removed.json()).toMatchObject({ revision: { id: namedRevision.id, author: namedRevision.author,
        startedAt: namedRevision.startedAt, endedAt: namedRevision.endedAt, name: null } });
      expect(getMeta(document).title).toBe("Historical title");

      document.transact(() => {
        document.getMap("meta").set("title", "Latest browser title");
        appendBlock(document, { type: "paragraph", text: "Latest browser text" });
      });
      await waitUntil("the newer browser state to reach the hub", () =>
        getMeta(hub.hocuspocus.documents.get(roomForDoc(WORKSPACE, uuid))!).title === "Latest browser title");
      const restoreRequest = { uuid, operation: "restore", revisionId: namedRevision.id,
        expectedHash: createHash("sha256").update(snapshotRevision(document).checksum).digest("hex") };
      expect((await fetch(path, { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ ...restoreRequest, surface: { kind: "mcp", name: "forged" } }) })).status).toBe(400);
      const staleRestore = await fetch(path, { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ ...restoreRequest, expectedHash: nameRequest.expectedHash }) });
      expect(staleRestore.status).toBe(409);
      expect(await staleRestore.json()).toMatchObject({ error: "revision_restore_failed", reason: "stale-state" });
      const restored = await fetch(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify(restoreRequest) });
      expect(restored.status).toBe(200);
      const { revision: restoredRevision, applied } = await restored.json() as { revision: RevisionEntry; applied: boolean };
      expect(applied).toBe(true);
      expect(restoredRevision).toMatchObject({ endedAt: expect.any(Number), name: null,
        author: { githubUsername: "revision-person", surface: { kind: "browser", name: "browser" } } });
      await waitUntil("the restore to reach the open browser", () => getMeta(document).title === "Historical title");
      expect(getBlocks(document)).toMatchObject([{ text: "Historical text" }]);
      const unchanged = await fetch(path, { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ ...restoreRequest, expectedHash: nameRequest.expectedHash }) });
      expect(await unchanged.json()).toEqual({ revision: restoredRevision, applied: false });

      const connection = hub.hocuspocus.documents.get(roomForDoc(WORKSPACE, uuid))?.getConnections()[0];
      if (connection === undefined) throw new Error("Missing revision connection");
      const original = connection.callbacks.statelessCallback;
      let error: Extract<RevisionResponse, { ok: false }>["error"] = "unsupported";
      let listRequest: RevisionRequest | null = null;
      let refuseList = false;
      let sentRestore: RevisionRequest | null = null;
      const legacyEntry = { id: namedRevision.id, author: namedRevision.author, startedAt: namedRevision.startedAt,
        endedAt: namedRevision.endedAt, name: null };
      connection.onStatelessCallback(async payload => {
        const request = readRevisionRequest(payload.payload);
        if (request === null) { await original(payload); return; }
        if (request.operation === "restore") { sentRestore = request; return; }
        if (request.operation === "list" && !refuseList) {
          listRequest = request;
          for (const frame of encodeRevisionResponseFrames({ requestId: request.requestId, ok: true,
            revisions: [legacyEntry] })) connection.sendStateless(frame);
          return;
        }
        for (const frame of encodeRevisionResponseFrames({ requestId: request.requestId, ok: false, error })) connection.sendStateless(frame);
      });
      const legacyList = await fetch(`${path}&refresh=true`, { headers });
      expect(legacyList.status).toBe(200);
      expect(await legacyList.json()).toMatchObject({ revisions: [legacyEntry], history: { complete: true } });
      expect(listRequest).toMatchObject({ operation: "list", includeNames: true, includeTitles: true });
      const lostRestoreReply = await fetch(path, { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ ...restoreRequest, expectedHash: nameRequest.expectedHash }) });
      expect(sentRestore).toMatchObject({ operation: "restore", revisionId: namedRevision.id });
      expect(lostRestoreReply.status).toBe(409);
      expect(await lostRestoreReply.json()).toEqual({ error: "revision_restore_failed",
        reason: "restore-outcome-unknown", cause: "unsupported", applied: null });
      refuseList = true;
      for (const [failure, reason] of [["unsupported", "unsupported"], ["forbidden", "forbidden"],
        ["deleted", "deleted"], ["revision-not-found", "revision-not-found"], ["unavailable", "unreachable"]] as const) {
        error = failure;
        const refused = await fetch(`${path}&revision=unknown&refresh=true`, { headers });
        expect(refused.status).toBe(503);
        expect(await refused.json()).toMatchObject({ error: "history_unavailable", reason, uuid });
      }
    } finally {
      browser.destroy(); document.destroy(); snapshot.destroy();
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("serves downloaded history after the hub stops and identifies each offline cache miss", async () => {
    const { box, env } = configured();
    const hub = await createTeamHub({ port: 0, databasePath: join(box.cwd, "offline-revision-hub.sqlite"),
      github: { clientId: "Iv1.0123456789abcdef" }, log: silentLogger }, { deviceCredentials: true });
    hubs.push(hub);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const person = hub.principals!.identify("12345", "offline-history-person");
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: person.id, role: "admin" });
    const issued = issueCredential(hub.credentials!, { principalId: person.id, deviceId: crypto.randomUUID(), workspaces: [WORKSPACE] });
    const { replacedAt: _replaced, ...record } = issued.record;
    await writeHubLogin(`http://127.0.0.1:${hub.port}`, { identity: person,
      credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") } }, box.env);
    const app = await open(box, ["--port", String(await freePort())], env);
    const uuid = "7a819902-f86e-45d1-84d3-58d8f979a503";
    const headers = bearer(await authMessage(localBrowserKey(WORKSPACE, box.env)));
    const path = `${app.url}api/revisions?uuid=${uuid}`;
    const document = new Y.Doc();
    const browser = new HocuspocusProvider({
      url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      name: roomForDoc(WORKSPACE, uuid), document,
      token: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-write"),
      ...{ WebSocketPolyfill: class extends WebSocket {
        constructor(url: string | URL) { super(url, { headers: { Origin: app.url.slice(0, -1) } } as unknown as string[]); }
      } },
    });
    try {
      await waitUntil("the offline history writer to synchronize", () => browser.isSynced);
      initDoc(document, { uuid, title: "Keep this downloaded history" });
      await waitUntil("the offline history content to reach the hub", () => {
        const current = hub.hocuspocus.documents.get(roomForDoc(WORKSPACE, uuid));
        return current !== undefined && getMeta(current).title === "Keep this downloaded history";
      });
      const listed = await fetch(`${path}&refresh=true`, { headers });
      const { revisions } = await listed.json() as { revisions: RevisionEntry[] };
      expect(revisions).toHaveLength(1);
      const downloaded = await fetch(`${path}&revision=${revisions[0]!.id}`, { headers });
      expect(downloaded.status).toBe(200);
      const { state } = await downloaded.json() as { state: string };

      await hub.stop();
      hubs.splice(hubs.indexOf(hub), 1);
      await waitUntil("ub open to read cached history while offline", async () => {
        const response = await fetch(path, { headers });
        const body = await response.json() as { history?: { offline: boolean } };
        return response.status === 200 && body.history?.offline === true;
      });
      const cached = await fetch(`${path}&revision=${revisions[0]!.id}`, { headers });
      expect(cached.status).toBe(200);
      expect(await cached.json()).toMatchObject({ state, history: { offline: true, complete: true,
        newestDownloadedRevision: revisions[0]!.id } });
      const missingRevision = await fetch(`${path}&revision=not-downloaded`, { headers });
      expect(missingRevision.status).toBe(503);
      expect(await missingRevision.json()).toMatchObject({ error: "history_unavailable", reason: "not-downloaded",
        uuid, revision: "not-downloaded", history: { offline: true } });
      const missingHistory = await fetch(`${app.url}api/revisions?uuid=857eff05-19fc-42e0-baf1-b367096408a4`, { headers });
      expect(missingHistory.status).toBe(503);
      expect(await missingHistory.json()).toMatchObject({ error: "history_unavailable", reason: "not-downloaded",
        history: { complete: false, lastRefresh: null, offline: true, newestDownloadedRevision: null } });
    } finally {
      browser.destroy(); document.destroy();
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("reports undownloaded signed-out history separately from an empty history", async () => {
    const { box, env } = configured();
    const hub = await createTeamHub({ port: 0, databasePath: join(box.cwd, "signed-out-revision-hub.sqlite"),
      github: { clientId: "Iv1.0123456789abcdef" }, log: silentLogger }, { deviceCredentials: true });
    hubs.push(hub);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      const response = await fetch(`${app.url}api/revisions?uuid=7a819902-f86e-45d1-84d3-58d8f979a503`, {
        headers: bearer(await authMessage(localBrowserKey(WORKSPACE, box.env))),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "history_unavailable", reason: "not-downloaded" });
      const refresh = await fetch(`${app.url}api/revisions?uuid=7a819902-f86e-45d1-84d3-58d8f979a503&refresh=true`, {
        headers: bearer(await authMessage(localBrowserKey(WORKSPACE, box.env))),
      });
      expect(await refresh.json()).toMatchObject({ error: "history_unavailable", reason: "sign-in-required" });
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("never treats local-only history as an empty hub history", async () => {
    await holdDefaultHub();
    const { box, env } = configured();
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      const response = await fetch(`${app.url}api/revisions?uuid=7a819902-f86e-45d1-84d3-58d8f979a503`, {
        headers: bearer(await authMessage(localBrowserKey(WORKSPACE, box.env))),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "history_unavailable", reason: "local-only" });
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });
});
