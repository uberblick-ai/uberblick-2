/**
 * Disposable daemon candidate for #704.
 *
 * One process owns MirrorStore, Replicas, and the only remote-hub socket. A
 * local Hocuspocus ingress lets the unmodified web application use those
 * replicas, while Unix-socket MCP sessions let real `ub mcp serve` processes
 * remain stdio shims with no database or hub handle of their own.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createServer as createIpcServer } from "node:net";
import type { Server as IpcServer, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Server as HocuspocusServer } from "@hocuspocus/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  importRootSecret,
  mintToken as mintSpikeBridgeToken,
  verifyToken,
} from "@uberblick/hub";
import { clampToken } from "@uberblick/hub/token";
import {
  SYNC_PROTOCOL_VERSION,
  readAuthEnvelope,
  wrapToken,
} from "@uberblick/hub/protocol";
import { parseRoom } from "@uberblick/schema";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";
import type { McpConfig } from "../src/config.js";
import {
  AGENT_CLIENT,
  Replicas,
  blockText,
} from "../src/replica.js";
import type { Replica } from "../src/replica.js";
import { seedSidebarOnce } from "../src/sidebar-tools.js";
import { MirrorStore } from "../src/store.js";
import type { UpdateOrigin } from "../src/store.js";
import { registerTools } from "../src/tools.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`daemon spike: ${name} is required`);
  return value;
};

const WORKSPACE = required("SPIKE_WORKSPACE");
const SECRET = required("SPIKE_SECRET");
const REMOTE_HUB_URL = required("SPIKE_REMOTE_HUB_URL");
const DATABASE_PATH = required("SPIKE_DATABASE_PATH");
const SOCKET_PATH = required("SPIKE_DAEMON_SOCKET");
const FAIL_MARKER = required("SPIKE_FAIL_MARKER");
const CRASH_MARKER = required("SPIKE_CRASH_MARKER");
const BROWSER_ORIGIN = required("SPIKE_BROWSER_ORIGIN");
const LOCAL_PORT = Number(required("SPIKE_LOCAL_PORT"));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForEvent(server: IpcServer, event: "listening" | "close"): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once(event, resolve);
    server.once("error", reject);
  });
}

/** One deliberate append refusal, armed by the driver through a marker file. */
class ProbeStore extends MirrorStore {
  override appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    if (existsSync(FAIL_MARKER)) {
      unlinkSync(FAIL_MARKER);
      throw new Error("daemon-authority-probe-refused-append");
    }
    return super.appendUpdate(room, payload, origin);
  }
}

/** Newline-delimited JSON-RPC over one accepted Unix socket. */
class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly buffer = new ReadBuffer();
  private readonly crashRequests = new Set<RequestId>();
  private started = false;
  private closed = false;

  constructor(private readonly socket: Socket) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("daemon socket transport already started");
    this.started = true;
    this.socket.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (;;) {
          const frame = this.buffer.readMessage();
          if (frame === null) break;
          if (
            "id" in frame &&
            frame.id !== undefined &&
            "method" in frame &&
            frame.method === "tools/call" &&
            (frame.params as { name?: unknown } | undefined)?.name === "edit_block" &&
            existsSync(CRASH_MARKER)
          ) {
            unlinkSync(CRASH_MARKER);
            this.crashRequests.add(frame.id);
          }
          this.onmessage?.(frame);
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.socket.once("error", (error) => this.onerror?.(error));
    this.socket.once("close", () => this.finish());
  }

  async send(frame: JSONRPCMessage): Promise<void> {
    if (
      "id" in frame &&
      frame.id !== undefined &&
      this.crashRequests.delete(frame.id)
    ) {
      // The tool handler has finished, so the synchronous append is durable;
      // die before its response reaches the caller to make the ambiguity real.
      process.stderr.write("daemon spike: crashing after durable append, before reply\n");
      process.kill(process.pid, "SIGKILL");
      await new Promise<void>(() => {});
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.write(serializeMessage(frame), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}

interface PresenceSlot {
  doc: Y.Doc;
  awareness: Awareness;
  replica: Replica;
}

/** Per-MCP-session identity multiplexed into the daemon's shared providers. */
class SessionPresence {
  name = "agent";
  private readonly slots = new Map<string, PresenceSlot>();
  private readonly cursorTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly sessionId: string,
    private readonly color: string,
  ) {}

  setName(name: string): void {
    this.name = name;
    for (const slot of this.slots.values()) {
      const current = slot.awareness.getLocalState();
      if (current?.user === undefined) continue;
      this.publish(slot, { ...current, user: this.user() });
    }
  }

  touch(replica: Replica): void {
    const slot = this.slot(replica);
    this.publish(slot, {
      ...slot.awareness.getLocalState(),
      user: this.user(),
      client: AGENT_CLIENT,
      session: this.sessionId,
    });
  }

  publishCursor(replica: Replica, blockId: string, index: number): void {
    const text = blockText(replica.doc, blockId);
    if (text === null) return;
    const clamped = Math.max(0, Math.min(text.length, index));
    const position = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, clamped),
    );
    const slot = this.slot(replica);
    this.publish(slot, {
      ...slot.awareness.getLocalState(),
      cursor: { anchor: position, head: position },
    });
    this.touch(replica);

    const old = this.cursorTimers.get(replica.room);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.cursorTimers.delete(replica.room);
      const current = slot.awareness.getLocalState();
      if (current !== null) this.publish(slot, { ...current, cursor: null });
    }, 30_000);
    timer.unref?.();
    this.cursorTimers.set(replica.room, timer);
  }

  close(): void {
    for (const timer of this.cursorTimers.values()) clearTimeout(timer);
    this.cursorTimers.clear();
    for (const slot of this.slots.values()) {
      // Keep the awareness client clock alive but remove every field readers
      // count or draw, matching Replicas.touch's immediate-withdrawal rule.
      this.publish(slot, {});
      slot.awareness.destroy();
      slot.doc.destroy();
    }
    this.slots.clear();
  }

  private user(): { name: string; color: string } {
    return { name: this.name, color: this.color };
  }

  private slot(replica: Replica): PresenceSlot {
    let slot = this.slots.get(replica.room);
    if (slot) return slot;
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState(null);
    slot = { doc, awareness, replica };
    this.slots.set(replica.room, slot);
    return slot;
  }

  private publish(slot: PresenceSlot, state: Record<string, unknown>): void {
    slot.awareness.setLocalState(state);
    applyAwarenessUpdate(
      slot.replica.awareness,
      encodeAwarenessUpdate(slot.awareness, [slot.awareness.clientID]),
      this,
    );
  }
}

/** A Replicas-shaped session view: state is shared, identity is not. */
function sessionReplicas(
  replicas: Replicas,
  presence: SessionPresence,
  sessionId: string,
  color: string,
): Replicas {
  const config = { ...replicas.config, sessionId, color };
  return new Proxy(replicas, {
    get(target, property) {
      if (property === "config") return config;
      if (property === "name") return presence.name;
      if (property === "setAgentName") return (name: string) => presence.setName(name);
      if (property === "touch") return (replica: Replica) => presence.touch(replica);
      if (property === "publishCursor") {
        return (replica: Replica, blockId: string, index: number) =>
          presence.publishCursor(replica, blockId, index);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function bridgeToken(rootKey: CryptoKey): Promise<string> {
  return wrapToken(
    await mintSpikeBridgeToken(rootKey, {
      typ: "room",
      sub: "daemon-local-bridge",
      workspace: WORKSPACE,
      scope: "read-write",
      kid: null,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    }),
  );
}

async function main(): Promise<void> {
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

  const rootKey = await importRootSecret(SECRET);
  const store = new ProbeStore(DATABASE_PATH, WORKSPACE);
  const config: McpConfig = {
    workspaceId: WORKSPACE,
    hubUrl: REMOTE_HUB_URL,
    authSecret: SECRET,
    databasePath: DATABASE_PATH,
    sessionId: `daemon-${randomUUID()}`,
    color: "#7b5ec7",
    connectTimeoutMs: 75,
    syncTimeoutMs: 250,
    reconnectMaxDelayMs: 250,
    cursorTtlMs: 30_000,
    compactAfter: 500,
    reconcileRetryMs: 0,
    updatedAtCoarsenessMs: 5 * 60_000,
  };
  const replicas = new Replicas(config, store);
  // The daemon is infrastructure, not a fourth user. Client sessions below
  // publish their own states through the same awareness/provider.
  replicas.directory().awareness.setLocalState(null);
  await seedSidebarOnce(replicas);

  const localHub = new HocuspocusServer({
    address: "127.0.0.1",
    port: LOCAL_PORT,
    quiet: true,
    stopOnSignals: false,
    async onUpgrade({ request, socket }) {
      const origin = request.headers.origin;
      // Node's internal bridge has no browser Origin. Every browser must come
      // from the one Vite origin that serves its credential document.
      if (origin !== undefined && origin !== BROWSER_ORIGIN) {
        socket.destroy();
        return await Promise.reject();
      }
    },
    async onAuthenticate({ token, documentName }) {
      const envelope = readAuthEnvelope(token);
      if (envelope?.protocolVersion !== SYNC_PROTOCOL_VERSION) {
        throw new Error("protocol-incompatible");
      }
      const claims = await verifyToken(rootKey, envelope.token);
      if (
        claims === null ||
        clampToken(claims, Math.floor(Date.now() / 1000)) !== null ||
        parseRoom(documentName).workspaceId !== WORKSPACE ||
        claims.workspace !== WORKSPACE
      ) {
        throw new Error("unauthorized");
      }
    },
  });
  await localHub.listen();

  const localSocket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${LOCAL_PORT}`,
    delay: 20,
    minDelay: 10,
    maxDelay: 100,
  });
  const bridges = new Map<string, HocuspocusProvider>();
  const attachKnown = (): void => {
    for (const replica of replicas.attachedReplicas()) {
      if (bridges.has(replica.room)) continue;
      const provider = new HocuspocusProvider({
        name: replica.room,
        document: replica.doc,
        awareness: replica.awareness,
        websocketProvider: localSocket,
        token: () => bridgeToken(rootKey),
      });
      provider.attach();
      bridges.set(replica.room, provider);
    }
  };
  attachKnown();
  const bridgeTimer = setInterval(attachKnown, 10);
  bridgeTimer.unref?.();

  const sessions = new Set<{
    server: McpServer;
    transport: SocketTransport;
    presence: SessionPresence;
  }>();
  let sessionCount = 0;
  const ipc = createIpcServer((socket) => {
    const index = sessionCount++;
    const sessionId = `daemon-client-${index}-${randomUUID()}`;
    const color = index % 2 === 0 ? "#db5f45" : "#3088c8";
    const presence = new SessionPresence(sessionId, color);
    const view = sessionReplicas(replicas, presence, sessionId, color);
    presence.touch(replicas.directory());
    const server = new McpServer({ name: "uberblick-daemon-spike", version: "0" });
    server.server.oninitialized = () => {
      const client = server.server.getClientVersion();
      presence.setName(client?.title?.trim() || client?.name?.trim() || "agent");
    };
    registerTools(server, view);
    const transport = new SocketTransport(socket);
    const session = { server, transport, presence };
    sessions.add(session);
    socket.once("close", () => {
      sessions.delete(session);
      presence.close();
      void server.close().catch(() => {});
    });
    void server.connect(transport).catch((error: unknown) => {
      process.stderr.write(`daemon spike: MCP session failed: ${message(error)}\n`);
      socket.destroy();
    });
  });
  ipc.listen(SOCKET_PATH);
  await waitForEvent(ipc, "listening");

  const close = async (): Promise<void> => {
    clearInterval(bridgeTimer);
    for (const session of sessions) {
      session.presence.close();
      await session.server.close().catch(() => {});
      await session.transport.close().catch(() => {});
    }
    sessions.clear();
    const ipcClosed = waitForEvent(ipc, "close");
    ipc.close();
    await ipcClosed.catch(() => {});
    for (const provider of bridges.values()) provider.destroy();
    localSocket.destroy();
    await localHub.destroy().catch(() => {});
    replicas.destroy();
    store.close();
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  };

  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      pid: process.pid,
      databasePath: DATABASE_PATH,
      localHub: `ws://127.0.0.1:${LOCAL_PORT}`,
      socketPath: SOCKET_PATH,
    })}\n`,
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(`daemon spike: ${message(error)}\n`);
  process.exitCode = 1;
});
