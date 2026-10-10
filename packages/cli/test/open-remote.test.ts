/**
 * `ub open` against an upstream hub: device admission, recovery of remote
 * sharing, durable browser and MCP edits through the shared store, presence
 * across a reconnect, and the served search and status readings. Split from
 * `open.test.ts`, whose header explains the real-world rig; the fixtures are in
 * `open-fixtures.ts`.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { type StoredHubLogin, readHubLogins, writeHubLogin } from "@uberblick/hub/auth-store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  createHub,
  importRootSecret,
  mintToken,
  silentLogger,
} from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import { createMcpServer, resolveMcpConfig } from "@uberblick/mcp-server";
import {
  appendBlock,
  directoryRoom,
  editBlock,
  getBlocks,
  getDirectoryEntry,
  initDoc,
  roomForDoc,
} from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { localBrowserKey } from "../src/browser-key.js";
import { pointAt, sleep, waitUntil, WAIT_TIMEOUT_MS } from "./helpers.js";
import {
  FIRST_REMOTE,
  SECRET,
  WORKSPACE,
  authMessage,
  bearer,
  cleanUp,
  configDir,
  configured,
  freePort,
  get,
  hubs,
  open,
  openStore,
  startHub,
  writeCredentials,
} from "./open-fixtures.js";

afterEach(cleanUp);

/**
 * #752's budget: an MCP write reaches a served tab within 250 ms at p95.
 *
 * A round is 20 samples. Transient stalls on a host shared with other suites can
 * spoil a round without the product being slow, so a missed round is retaken,
 * up to three times. A slowdown affecting most writes misses every round;
 * intermittent regressions are less likely to fail with these retakes.
 */
async function expectP95Within250ms(
  label: string,
  sample: (index: number) => Promise<number>,
): Promise<void> {
  const rounds: number[][] = [];
  for (let round = 0; round < 3; round += 1) {
    const latencies: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      latencies.push(await sample(round * 20 + index));
    }
    rounds.push(latencies);
    if ([...latencies].sort((a, b) => a - b)[18]! < 250) return;
  }
  expect.fail(`${label} missed 250 ms at p95 in every round: ${JSON.stringify(rounds)}`);
}

describe("ub open: sharing through the upstream hub", () => {
  it("discovers loopback device admission and later login keeps the same serving binding", async () => {
    const { box, env } = configured();
    const hub = await createHub({ port: 0, address: "0.0.0.0", databasePath: join(box.cwd, "loopback-device-hub.sqlite"),
      github: { clientId: "Iv1.0123456789abcdef" }, log: silentLogger });
    hubs.push(hub);
    const origin = `http://127.0.0.1:${hub.port}`;
    pointAt(box, `ws://127.0.0.1:${hub.port}/custom-proxy-path`);
    const person = hub.principals!.identify("12345", "open-person");
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: person.id, role: "admin" });
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      expect(app.stdout()).toContain(`ub auth login ${origin}`);
      expect(app.stdout()).not.toContain("HUB_AUTH_TOKEN");
      const authorization = bearer(await authMessage(localBrowserKey(WORKSPACE, box.env)));
      const status = async () => await (await fetch(`${app.url}api/status`, { headers: authorization })).json() as { caughtUp: boolean; notSharedReason: string | null };
      await waitUntil("loopback origin sign-in reading", async () => (await status()).notSharedReason === "sign-in-required");
      const issued = hub.credentials!.issue({ principalId: person.id, deviceId: crypto.randomUUID(), workspaces: [WORKSPACE] });
      const { replacedAt: _replaced, ...record } = issued.record;
      await writeHubLogin(origin, { identity: person, credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") } }, box.env);
      await waitUntil("loopback origin login resumes sharing", async () => (await status()).caughtUp);
      expect(await (await get(`${app.url}uberblick-config.json`)).json()).not.toHaveProperty("rebound");
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it.each(["revocation", "membership"] as const)("recovers remote sharing with the same local copy and keeps serving after %s", async refusal => {
    const { box, env } = configured();
    const hub = await createHub({
      port: 0, address: "0.0.0.0", databasePath: join(box.cwd, "device-hub.sqlite"),
      github: { clientId: "Iv1.0123456789abcdef" }, log: silentLogger,
    });
    hubs.push(hub);
    const endpoint = `ws://0.0.0.0:${hub.port}`;
    const origin = `http://0.0.0.0:${hub.port}`;
    pointAt(box, endpoint);
    const person = hub.principals!.identify("12345", "open-person");
    const admin = hub.principals!.identify("67890", "open-admin");
    const login = (): StoredHubLogin => {
      const issued = hub.credentials!.issue({ principalId: person.id, deviceId: crypto.randomUUID(), workspaces: [] });
      const { replacedAt: _replaced, ...record } = issued.record;
      return { identity: person, credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") } };
    };
    const webPort = await freePort();
    let app = await open(box, ["--port", String(webPort)], env);
    const localKey = localBrowserKey(WORKSPACE, box.env);
    const authorization = bearer(await authMessage(localKey));
    const status = async () => await (await fetch(`${app.url}api/status`, { headers: authorization })).json() as {
      caughtUp: boolean; notSharedReason: string | null;
    };
    const document = new Y.Doc();
    const room = roomForDoc(WORKSPACE, "671ed55d-36de-42a9-bd85-701eff199942");
    const browser = new HocuspocusProvider({
      url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      name: room, document, token: await authMessage(localKey, "read-write"),
      ...{ WebSocketPolyfill: class extends WebSocket {
        constructor(url: string | URL) { super(url, { headers: { Origin: app.url.slice(0, -1) } } as unknown as string[]); }
      } },
    });
    try {
      await waitUntil("local browser admission", () => browser.isSynced);
      await waitUntil("remote sign-in-required reading", async () => (await status()).notSharedReason === "sign-in-required");
      initDoc(document, { uuid: "671ed55d-36de-42a9-bd85-701eff199942", title: "Retained browser document" });
      appendBlock(document, { type: "paragraph", text: "pending before login" });
      await waitUntil("local edit durable", () => !browser.hasUnsyncedChanges).catch(error => { throw new Error(`${error.message}: ${app.stderr()}`); });
      await writeHubLogin(origin, login(), box.env);
      await waitUntil("login-first no workspace access", async () => (await status()).notSharedReason === "no-workspace-access");
      // Advance the persisted cooldown, leaving the process and login intact.
      const configRoot = join(configDir(box));
      const { readdirSync } = await import("node:fs");
      const sidecar = readdirSync(configRoot).find(name => name.startsWith(".credential-renewal-") && name.endsWith(".json"));
      if (sidecar === undefined) throw new Error("no renewal cooldown sidecar");
      hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: admin.id, role: "admin" });
      hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: person.id, role: "member" });
      const outcomePath = join(configRoot, sidecar);
      const outcome = JSON.parse(readFileSync(outcomePath, "utf8"));
      outcome.retryAt = 0;
      writeFileSync(outcomePath, JSON.stringify(outcome), { mode: 0o600 });
      await waitUntil("later grant to sync without restart", async () => (await status()).caughtUp, 80_000);
      await waitUntil("pending browser edit at remote hub", () => getBlocks(hub.hocuspocus.documents.get(room)!)[0]?.text === "pending before login");
      expect(await (await get(`${app.url}uberblick-config.json`)).json()).not.toHaveProperty("rebound");
      const stored = readHubLogins(box.env).logins[origin]!;
      expect(await (await get(`${app.url}uberblick-config.json`)).text()).not.toContain(stored.credential.key);
      // Changes from another admitted client travel back through the serving replica.
      const remote = hub.hocuspocus.documents.get(room)!;
      const initial = getBlocks(remote)[0]!;
      editBlock(remote, initial.id, initial.text, "other client edit", { rev: initial.rev });
      await waitUntil("remote change in browser", () => getBlocks(document)[0]?.text === "other client edit");
      expect((await app.interrupt()).status).toBe(0);
      app = await open(box, ["--port", String(webPort)], env);
      await waitUntil("restart resumes stored login", async () => (await status()).caughtUp);
      expect(localBrowserKey(WORKSPACE, box.env)).toBe(localKey);
      const current = readHubLogins(box.env).logins[origin]!;
      if (refusal === "revocation") hub.credentials!.revoke(current.credential.record.id);
      else hub.memberships!.remove({ workspaceId: WORKSPACE, principalId: person.id, actorPrincipalId: admin.id });
      // Renewal cooldown plus the random polling ceiling can span two bands.
      await waitUntil("live remote authority ended", async () => (await status()).notSharedReason === (refusal === "revocation" ? "sign-in-required" : "no-workspace-access"), 80_000);
      await waitUntil("browser remains locally admitted", () => browser.isSynced);
      expect(getBlocks(document)[0]?.text).toBe("other client edit");
      const localBlock = getBlocks(document)[0]!;
      editBlock(document, localBlock.id, localBlock.text, "still local after refusal", { rev: localBlock.rev });
      await waitUntil("refused remote edit durable locally", () => !browser.hasUnsyncedChanges);
      expect((await status()).caughtUp).toBe(false);
      const remoteAfter = hub.hocuspocus.documents.get(room);
      expect(remoteAfter === undefined ? undefined : getBlocks(remoteAfter)[0]?.text).not.toBe("still local after refusal");
    } finally {
      browser.destroy(); document.destroy();
      expect((await app.interrupt()).status).toBe(0);
    }
  }, 220_000);

  it.each(["hub-down", "no-credentials"])("bridges durable browser and MCP edits through the shared store (%s)", async (mode) => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    if (mode === "no-credentials") {
      rmSync(join(configDir(box), "credentials.json"));
    }
    const webPort = await freePort();
    let app = await open(box, ["--port", String(webPort)], env);

    const instance = createMcpServer(
      resolveMcpConfig({
        ...box.env,
        ...env,
        WORKSPACE_ID: WORKSPACE,
        HUB_URL: FIRST_REMOTE,
        ...(mode === "hub-down" ? { HUB_AUTH_TOKEN: SECRET } : {}),
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ub-open-store-test", version: "0.0.0" });
    const doc = new Y.Doc();
    const directory = new Y.Doc();
    let provider: HocuspocusProvider | null = null;
    let directoryProvider: HocuspocusProvider | null = null;
    try {
      await Promise.all([
        instance.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as { text?: string }[];
        return JSON.parse(content[0]?.text ?? "null") as T;
      };
      const created = await call<{ uuid: string }>("create_doc", {
        title: "Browser durability boundary",
        description: "A document shared by ub open and an MCP session.",
        blocks: [{ type: "paragraph", text: "before" }],
      });

      provider = new HocuspocusProvider({
        url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
        name: roomForDoc(WORKSPACE, created.uuid),
        document: doc,
        token: wrapToken(
          await mintToken(await importRootSecret(localBrowserKey(WORKSPACE, box.env)), {
            typ: "room",
            sub: "open-test-browser",
            workspace: WORKSPACE,
            scope: "read-write",
            kid: null,
            lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
          }),
        ),
        ...{
          WebSocketPolyfill: class extends WebSocket {
            constructor(url: string | URL) {
              super(url, { headers: { Origin: app.url.slice(0, -1) } } as unknown as string[]);
            }
          },
        },
      });
      await waitUntil("the browser room to hydrate from the store", () =>
        provider?.isSynced === true,
      );
      directoryProvider = new HocuspocusProvider({
        url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
        name: directoryRoom(WORKSPACE),
        document: directory,
        token: wrapToken(
          await mintToken(await importRootSecret(localBrowserKey(WORKSPACE, box.env)), {
            typ: "room",
            sub: "open-test-directory",
            workspace: WORKSPACE,
            scope: "read-write",
            kid: null,
            lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
          }),
        ),
        ...{
          WebSocketPolyfill: class extends WebSocket {
            constructor(url: string | URL) {
              super(url, { headers: { Origin: app.url.slice(0, -1) } } as unknown as string[]);
            }
          },
        },
      });
      await waitUntil("the browser directory to hydrate from the store", () =>
        directoryProvider?.isSynced === true,
      );
      const block = getBlocks(doc)[0];
      if (block === undefined) throw new Error("the store-hydrated document has no block");
      expect(block.text).toBe("before");

      editBlock(doc, block.id, "before", "durable before acknowledgement", {
        rev: block.rev,
      });
      await waitUntil("the local server to acknowledge the browser edit", () =>
        provider?.hasUnsyncedChanges === false,
      );

      const read = await call<{ blocks: { text: string }[] }>("get_doc", {
        uuid: created.uuid,
      });
      expect(read.blocks[0]?.text).toBe("durable before acknowledgement");
      const auth = await authMessage(localBrowserKey(WORKSPACE, box.env));
      const readStatus = async () => await (await fetch(`${app.url}api/status`, {
        headers: bearer(auth),
      })).json() as { caughtUp: boolean; notSharedReason: string | null;
        rooms: Record<string, { hubAcked: boolean }> };
      expect(await readStatus()).toMatchObject({
        caughtUp: false,
        notSharedReason: null,
        rooms: { [roomForDoc(WORKSPACE, created.uuid)]: { hubAcked: false } },
      });
      const stored = openStore(instance.store.databasePath);
      try {
        expect(stored.prepare("SELECT COUNT(*) AS count FROM pending_rooms").get()?.count)
          .toBeGreaterThan(0);
      } finally { stored.close(); }


      const current = await call<{
        blocks: { id: string; text: string; rev: string }[];
      }>("get_doc", { uuid: created.uuid });
      const initialBlock = current.blocks[0];
      if (initialBlock === undefined) throw new Error("the MCP replica has no block");
      let currentBlock: { id: string; text: string; rev: string } = initialBlock;
      await expectP95Within250ms("live MCP edits", async (index) => {
        const newText = `agent edit arrived live ${index}`;
        const startedAt = performance.now();
        const edited: { block: { id: string; text: string; rev: string } } = await call<{
          block: { id: string; text: string; rev: string };
        }>("edit_block", {
          uuid: created.uuid,
          block_id: currentBlock.id,
          old_text: currentBlock.text,
          new_text: newText,
          rev: currentBlock.rev,
        });
        await waitUntil("the MCP edit to reach the live browser room", () =>
          getBlocks(doc)[0]?.text === newText,
        );
        currentBlock = edited.block;
        return performance.now() - startedAt;
      });

      await expectP95Within250ms("live MCP creations", async (index) => {
        const title = `Created by the agent ${index}`;
        const startedAt = performance.now();
        const added = await call<{ uuid: string }>("create_doc", {
          title,
          description: "A document whose directory entry arrives live.",
        });
        await waitUntil("the MCP-created document to reach the browser directory", () =>
          getDirectoryEntry(directory, added.uuid)?.title === title,
        );
        return performance.now() - startedAt;
      });
      if (mode === "no-credentials") {
        const key = localBrowserKey(WORKSPACE, box.env);
        const hub = await startHub(box);
        const hubUrl = `ws://127.0.0.1:${hub.port}`;
        writeCredentials(box, SECRET);
        expect(await (await get(`${app.url}uberblick-config.json`)).json())
          .toMatchObject({ hubAuthToken: key });
        pointAt(box, hubUrl);
        expect((await app.interrupt()).status).toBe(0);
        app = await open(box, ["--port", String(webPort)], env);
        expect(localBrowserKey(WORKSPACE, box.env)).toBe(key);
        await waitUntil("pending local-only edits to reach and be acknowledged by the hub", async () => {
          const status = await readStatus();
          return status.caughtUp && status.rooms[roomForDoc(WORKSPACE, created.uuid)]?.hubAcked === true;
        });
        const remoteDoc = new Y.Doc();
        const remote = new HocuspocusProvider({
          url: hubUrl, name: roomForDoc(WORKSPACE, created.uuid), document: remoteDoc,
          token: await authMessage(SECRET),
        });
        try {
          await waitUntil("a fresh hub peer to read the same pending document", () => remote.isSynced);
          expect(getBlocks(remoteDoc)[0]?.text).toBe(currentBlock.text);
          // The serving replica releases pending markers on its next quiet
          // poll, so a room other than this document (the directory, say) can
          // still be marked for a moment after the status reads caught up.
          await waitUntil("the shared store to release every pending room", () =>
            instance.store.pendingRooms().length === 0,
          );
        } finally { remote.destroy(); remoteDoc.destroy(); }

        // The still-open local providers keep their original key after losing hub auth too.
        rmSync(join(configDir(box), "credentials.json"));
        expect(await (await get(`${app.url}uberblick-config.json`)).json())
          .toMatchObject({ hubAuthToken: key, rebound: true });
        expect((await app.interrupt()).status).toBe(0);
        app = await open(box, ["--port", String(webPort)], env);
        await waitUntil("the same browser room to resume local-only after restart", () =>
          provider?.isSynced === true,
        );
        expect(await readStatus()).toMatchObject({
          notSharedReason: "no-hub-credentials", caughtUp: false,
          rooms: { [roomForDoc(WORKSPACE, created.uuid)]: { hubAcked: false } },
        });
      }

    } finally {
      provider?.destroy();
      directoryProvider?.destroy();
      doc.destroy();
      directory.destroy();
      await client.close().catch(() => {});
      await instance.close().catch(() => {});
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("relays presence across reconnect and lets a served tab expire upstream", async () => {
    const { box, env } = configured();
    const hub = await startHub(box);
    const hubUrl = `ws://127.0.0.1:${hub.port}`;
    pointAt(box, hubUrl);
    const app = await open(box, ["--port", String(await freePort())], env);
    const room = roomForDoc(WORKSPACE, "671ed55d-36de-42a9-bd85-701eff199942");
    const token = wrapToken(
      await mintToken(await importRootSecret(SECRET), {
        typ: "room",
        sub: "open-presence-test",
        workspace: WORKSPACE,
        scope: "read-write",
        kid: null,
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      }),
    );
    const browserDoc = new Y.Doc();
    const agentDoc = new Y.Doc();
    const browser = new HocuspocusProvider({
      url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      name: room,
      document: browserDoc,
      token: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-write"),
      ...{
        WebSocketPolyfill: class extends WebSocket {
          constructor(url: string | URL) {
            super(url, {
              headers: { Origin: app.url.slice(0, -1) },
            } as unknown as string[]);
          }
        },
      },
    });
    const agent = new HocuspocusProvider({
      url: hubUrl,
      name: room,
      document: agentDoc,
      token,
    });

    try {
      await waitUntil("both presence peers to sync", () =>
        [browser, agent].every((provider) => provider.isSynced),
      );
      browser.setAwarenessField("client", "web");
      browser.setAwarenessField("user", {
        name: "browser tab",
        color: "#112233",
      });
      agent.setAwarenessField("client", "agent");
      agent.setAwarenessField("user", {
        name: "coding agent",
        color: "#abcdef",
      });
      agent.setAwarenessField("cursor", {
        blockId: "block-1",
        anchor: 1,
        head: 1,
      });

      const browserId = browser.awareness?.clientID;
      const agentId = agent.awareness?.clientID;
      if (browserId === undefined || agentId === undefined) {
        throw new Error("the presence peers have no awareness");
      }
      // Each field sends its own update; a peer can exist before its user or
      // cursor has crossed the seam. Wait for the state we actually assert.
      await expect.poll(() => browser.awareness?.getStates().get(agentId), {
        timeout: WAIT_TIMEOUT_MS,
      }).toMatchObject({
        client: "agent",
        cursor: { blockId: "block-1", anchor: 1, head: 1 },
      });
      await expect.poll(() => agent.awareness?.getStates().get(browserId), {
        timeout: WAIT_TIMEOUT_MS,
      }).toMatchObject({
        client: "web",
        user: { name: "browser tab", color: "#112233" },
      });

      await hub.stop();
      await waitUntil("the disconnected agent to leave the served browser", () =>
        browser.awareness?.getStates().has(agentId) === false,
      );
      expect(browser.awareness?.getStates().has(browserId)).toBe(true);

      await startHub(box, hub.port);
      // These ordinary awareness updates stand in for each peer's periodic
      // renewal. Neither document nor provider is recreated across the loss.
      // They repeat until presence returns: one sent before the upstream has
      // reconnected would otherwise wait out y-protocols' 15 s renewal.
      let polls = 0;
      await waitUntil("presence to return after the upstream reconnects", () => {
        if (polls++ % 10 === 0) {
          browser.setAwarenessField("renewal", polls);
          agent.setAwarenessField("renewal", polls);
        }
        return browser.awareness?.getStates().has(agentId) === true &&
          agent.awareness?.getStates().has(browserId) === true;
      });

      browser.destroy();
      await sleep(1_000);
      expect(agent.awareness?.getStates().has(browserId)).toBe(true);
    } finally {
      browser.destroy();
      agent.destroy();
      browserDoc.destroy();
      agentDoc.destroy();
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("searches the shared store while the hub is unreachable and discloses its cap", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const app = await open(box, ["--port", String(await freePort())], env);
    const instance = createMcpServer(
      resolveMcpConfig({
        ...box.env,
        ...env,
        WORKSPACE_ID: WORKSPACE,
        HUB_URL: FIRST_REMOTE,
        HUB_AUTH_TOKEN: SECRET,
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ub-open-search-test", version: "0.0.0" });
    try {
      await Promise.all([
        instance.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: "create_doc",
        arguments: {
          title: "Offline badger",
          description: "A document written by another local process.",
          blocks: [{ type: "paragraph", text: "orchard telemetry" }],
        },
      });
      const content = result.content as { text?: string }[];
      const created = JSON.parse(content[0]?.text ?? "null") as { uuid: string };
      const auth = await authMessage(localBrowserKey(WORKSPACE, box.env));

      const found = await fetch(`${app.url}api/search?q=offline+badg*`, {
        headers: bearer(auth),
      });
      expect(found.status).toBe(200);
      expect(found.headers.get("cache-control")).toBe("no-store");
      expect(found.headers.get("access-control-allow-origin")).toBeNull();
      expect(await found.json()).toEqual({
        hits: [{ uuid: created.uuid }],
        limit: 100,
        capped: false,
      });

      for (let index = 0; index <= 100; index += 1) {
        instance.store.indexDoc(
          {
            uuid: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            title: `Capacity ${index}`,
            description: "",
            tags: [],
            links: [],
            body: "capacityneedle",
          },
          1,
        );
      }
      const capped = await fetch(`${app.url}api/search?q=capacityneedle`, {
        headers: bearer(auth),
      });
      const cappedBody = (await capped.json()) as {
        hits: { uuid: string }[];
        limit: number;
        capped: boolean;
      };
      expect(cappedBody).toMatchObject({
        limit: 100,
        capped: true,
      });
      expect(cappedBody.hits).toHaveLength(100);
      expect(cappedBody.hits.every((hit) => Object.keys(hit).join() === "uuid"))
        .toBe(true);

      const empty = await fetch(`${app.url}api/search?q=%F0%9F%8C%BF`, {
        headers: bearer(auth),
      });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ hits: [], limit: 100, capped: false });

      const missing = await fetch(`${app.url}api/search`, {
        headers: bearer(auth),
      });
      expect(missing.status).toBe(400);
      expect(missing.headers.get("cache-control")).toBe("no-store");
    } finally {
      await client.close().catch(() => {});
      await instance.close().catch(() => {});
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("reports loaded rooms and the full replica's upstream acknowledgement", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const hub = await startHub(box, hubPort);
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    pointAt(box, hubUrl);
    const app = await open(box, ["--port", String(await freePort())], env);
    const room = directoryRoom(WORKSPACE);
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      name: room,
      document: doc,
      token: await authMessage(localBrowserKey(WORKSPACE, box.env)),
      ...{
        WebSocketPolyfill: class extends WebSocket {
          constructor(url: string | URL) {
            super(url, {
              headers: { Origin: app.url.slice(0, -1) },
            } as unknown as string[]);
          }
        },
      },
    });
    const auth = await authMessage(localBrowserKey(WORKSPACE, box.env));
    const readStatus = async (): Promise<{
      response: Response;
      body: { caughtUp: boolean; rooms: Record<string, { hubAcked: boolean }> };
    }> => {
      const response = await fetch(`${app.url}api/status`, {
        headers: bearer(auth),
      });
      return {
        response,
        body: (await response.json()) as {
          caughtUp: boolean;
          rooms: Record<string, { hubAcked: boolean }>;
        },
      };
    };

    try {
      await waitUntil("the browser directory to load locally", () =>
        provider.isSynced,
      );
      await waitUntil("the serving replica to be caught up", async () => {
        const { body } = await readStatus();
        return body.caughtUp && body.rooms[room]?.hubAcked === true;
      });
      const current = await readStatus();
      expect(current.response.status).toBe(200);
      expect(current.response.headers.get("cache-control")).toBe("no-store");
      expect(current.response.headers.get("access-control-allow-origin")).toBeNull();
      expect(current.body).toEqual({
        notSharedReason: null,
        caughtUp: true,
        rooms: { [room]: { hubAcked: true } },
      });

      await hub.stop();
      await waitUntil("the status reading to notice the lost hub", async () => {
        const { body } = await readStatus();
        return !body.caughtUp && body.rooms[room]?.hubAcked === false;
      });

      await startHub(box, hubPort);
      await waitUntil("the serving replica to catch up after reconnect", async () => {
        const { body } = await readStatus();
        return body.caughtUp && body.rooms[room]?.hubAcked === true;
      });
    } finally {
      provider.destroy();
      doc.destroy();
      expect((await app.interrupt()).status).toBe(0);
    }
  });
});
