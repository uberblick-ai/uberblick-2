// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HocuspocusProviderWebsocket, MessageType } from "@hocuspocus/provider";
import {
  createHub,
  importRootSecret,
  mintToken,
  silentLogger,
} from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import { getWorkspaceName, setWorkspaceName, settingsRoom } from "@uberblick/schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { PacedRoomProvider, RoomAdmission } from "../src/collab/room-admission.js";

const SECRET = "room-admission-test-secret";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

async function token(workspace = WORKSPACE): Promise<string> {
  return wrapToken(await mintToken(await importRootSecret(SECRET), {
    typ: "room", sub: "test", workspace, scope: "read-write", kid: null,
    lifetimeSeconds: 60,
  }));
}

it("paces live name rooms below the hub ceiling, including after a reconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), `room-admission-${process.env.UB_AGENT_RUN ?? process.pid}-`));
  const hub = await createHub({
    authSecret: SECRET, port: 0, databasePath: join(dir, "hub.sqlite"),
    maxPendingDocuments: 3, log: silentLogger,
    debounce: 10, maxDebounce: 50, shutdownTimeoutMs: 2_000,
  });
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${hub.port}`, delay: 10, minDelay: 5, maxDelay: 20,
  });
  const admission = new RoomAdmission(2);
  const providers: PacedRoomProvider[] = [];
  let disconnects = 0;
  socket.on("disconnect", () => { disconnects += 1; });
  try {
    for (let index = 0; index < 8; index += 1) {
      const workspace = randomUUID();
      const doc = new Y.Doc();
      const provider = new PacedRoomProvider(admission, {
        name: settingsRoom(workspace), document: doc, websocketProvider: socket,
        token: () => token(workspace),
      });
      providers.push(provider);
      provider.attach();
      // A queued room's first frame must be the admitted token, even if its
      // document and awareness change before the async token has returned.
      setWorkspaceName(doc, `Workspace ${index}`);
      provider.awareness?.setLocalStateField("user", { name: "test" });
    }
    await expect.poll(() => providers.every((provider) => provider.isSynced), { timeout: 10_000 }).toBe(true);
    expect(disconnects).toBe(0);
    for (const [index, provider] of providers.entries()) {
      expect(getWorkspaceName(hub.hocuspocus.documents.get(provider.configuration.name)!)).toBe(`Workspace ${index}`);
    }

    socket.disconnect();
    await expect.poll(() => disconnects).toBe(1);
    await socket.connect();
    await expect.poll(() => providers.every((provider) => provider.isSynced && provider.isAuthenticated), { timeout: 10_000 }).toBe(true);
    expect(disconnects).toBe(1);
    expect(hub.hocuspocus.documents.size).toBe(8);
  } finally {
    for (const provider of providers) {
      provider.destroy();
      provider.document.destroy();
    }
    socket.destroy();
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it("discards a token that resolves after its socket generation ended", async () => {
  const dir = mkdtempSync(join(tmpdir(), `room-admission-${process.env.UB_AGENT_RUN ?? process.pid}-`));
  const hub = await createHub({
    authSecret: SECRET, port: 0, databasePath: join(dir, "hub.sqlite"), log: silentLogger,
    shutdownTimeoutMs: 2_000,
  });
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${hub.port}`, delay: 10, minDelay: 5, maxDelay: 20,
  });
  let finishOld!: (value: string) => void;
  const oldToken = new Promise<string>((resolve) => { finishOld = resolve; });
  let calls = 0;
  let authFrames = 0;
  let disconnects = 0;
  const doc = new Y.Doc();
  const provider = new PacedRoomProvider(new RoomAdmission(1), {
    name: settingsRoom(WORKSPACE), document: doc, websocketProvider: socket,
    token: () => ++calls === 1 ? oldToken : token(),
  });
  provider.on("outgoingMessage", ({ message }: { message: { type: number } }) => {
    if (message.type === MessageType.Auth) authFrames += 1;
  });
  socket.on("disconnect", () => { disconnects += 1; });
  try {
    provider.attach();
    await expect.poll(() => calls).toBe(1);
    setWorkspaceName(doc, "Queued name");
    expect(authFrames).toBe(0);
    expect(hub.hocuspocus.documents.size).toBe(0);
    socket.disconnect();
    await expect.poll(() => disconnects).toBe(1);
    await socket.connect();
    await expect.poll(() => provider.isSynced, { timeout: 10_000 }).toBe(true);
    expect(authFrames).toBe(1);
    finishOld(await token());
    await oldToken;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(authFrames).toBe(1);
    expect(getWorkspaceName(hub.hocuspocus.documents.get(settingsRoom(WORKSPACE))!)).toBe("Queued name");
  } finally {
    finishOld("");
    provider.destroy();
    doc.destroy();
    socket.destroy();
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
