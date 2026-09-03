/**
 * The Hocuspocus seams the hub relies on, characterized against the installed
 * 4.6.0.
 *
 * Keeping the dependency is a decision (#394), and its price is this file: the
 * hub's auth boundary and its connection lifecycle depend on behaviour the
 * library's types do not state and its changelog would not call a breaking
 * change. `hocuspocus-pins.test.ts` stops the version moving by accident; these
 * tests are what a *deliberate* bump has to answer, one failure per assumption
 * instead of a symptom in production.
 *
 * Every test drives a real server over a real websocket with a real provider
 * and asserts what was observed — never a mock of it, which would only pin this
 * file's idea of the library. Every barrier a test waits on is an event, never
 * an elapsed duration: a sleep long enough to be reliable today is the flake
 * that fails a merge gate on a loaded machine tomorrow (#359). Where the event
 * a test needs is a frame *arriving* — which fires no hook, because the frame
 * is still queued — it wraps the library's own `handleMessage` entry point as a
 * pass-through counter (`frameBarrier` below); the real handler still handles
 * every frame. Each names the library file and line it pins;
 * those line numbers are from the TypeScript sources shipped inside
 * `@hocuspocus/server@4.6.0` (`node_modules/@hocuspocus/server/src/…`), so a
 * bump is also an invitation to re-read them.
 *
 * The rig is deliberately not the hub: these are properties of the library, and
 * proving them through `createHub` would leave a reader unable to tell which
 * side owns the behaviour.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  type onCloseParameters,
} from "@hocuspocus/provider";
import type { Hocuspocus, ServerConfiguration } from "@hocuspocus/server";
import { Server } from "@hocuspocus/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { TEXT_KEY, waitUntil } from "./helpers.js";

/** What `onAuthenticate` returns here, so a hook can tell the clients apart. */
type Context = { name: string };

const servers: Server<Context>[] = [];
const providers: HocuspocusProvider[] = [];
const websockets: HocuspocusProviderWebsocket[] = [];
const childProcesses: ReturnType<typeof spawn>[] = [];

// Providers before servers: a live provider reconnects on close and would
// otherwise race the server it is being torn down with.
afterEach(async () => {
  for (const provider of providers.splice(0)) {
    provider.destroy();
  }
  for (const websocket of websockets.splice(0)) {
    websocket.destroy();
  }
  for (const server of servers.splice(0)) {
    await server.destroy();
  }
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.kill();
      await exited;
    }
  }
});

async function startServer(hooks: Partial<ServerConfiguration<Context>>) {
  const server = new Server<Context>({
    port: 0,
    address: "127.0.0.1",
    // No banner on stdout, and no signal handlers: a server a test starts must
    // not hijack the runner's SIGINT.
    quiet: true,
    stopOnSignals: false,
    ...hooks,
  });
  servers.push(server);
  const hocuspocus = await server.listen();
  return { port: server.address.port, hocuspocus };
}

function connect(options: {
  port: number;
  room: string;
  token?: string | (() => string);
  /** `null` silences awareness, so the next frame after the sync is the test's. */
  awareness?: null;
  /**
   * The provider's reconnect delay. Its default is a second
   * (`HocuspocusProviderWebsocket.ts:125-133`); a test whose subject is a
   * *closed* connection pushes it out of reach, so nothing it observes can be
   * explained by the client having come back.
   */
  reconnectDelayMs?: number;
  /** A pre-populated document exercises the reconnect SyncStep2 path. */
  document?: Y.Doc;
  /** Share one multiplexed socket across several document providers. */
  websocketProvider?: HocuspocusProviderWebsocket;
}) {
  const doc = options.document ?? new Y.Doc();
  const provider = new HocuspocusProvider({
    ...(options.websocketProvider === undefined
      ? { url: `ws://127.0.0.1:${options.port}` }
      : { websocketProvider: options.websocketProvider }),
    name: options.room,
    token: options.token ?? "test-token",
    document: doc,
    ...(options.awareness === null ? { awareness: null } : {}),
    // The provider hands its whole configuration to the socket it builds
    // (`HocuspocusProvider.ts:294-296`); the public type just does not say so.
    ...(options.reconnectDelayMs === undefined
      ? {}
      : {
          delay: options.reconnectDelayMs,
          minDelay: options.reconnectDelayMs,
        }),
  });
  providers.push(provider);

  const synced = new Promise<void>((resolve) => {
    provider.on("synced", () => {
      resolve();
    });
  });
  const authenticationFailed = new Promise<string>((resolve) => {
    provider.on("authenticationFailed", ({ reason }) => resolve(reason));
  });

  if (options.websocketProvider !== undefined) {
    provider.attach();
  }

  return {
    provider,
    doc,
    text: doc.getText(TEXT_KEY),
    synced,
    authenticationFailed,
  };
}

function sharedWebsocket(port: number) {
  const websocket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}`,
    autoConnect: false,
    delay: 60_000,
    minDelay: 60_000,
  });
  websockets.push(websocket);
  return websocket;
}

/** A deferred a hook can block on, so a test can hold the server mid-flight. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Resolve with the first complete child-process stdout line with this prefix. */
function childLine(child: ReturnType<typeof spawn>, prefix: string) {
  let buffered = "";
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = buffered.split("\n").find((item) => item.startsWith(prefix));
      if (line !== undefined) {
        cleanup();
        resolve(line);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `upgrade probe exited before ${prefix}: code=${String(code)} signal=${String(signal)}`,
        ),
      );
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

/** Run the upgrade hook in a disposable process: the throwing case must exit. */
async function startUpgradeProbe(mode: "throw" | "reject-empty") {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { Server } from "@hocuspocus/server";

        const mode = process.argv[1];
        const server = new Server({
          port: 0,
          address: "127.0.0.1",
          quiet: true,
          stopOnSignals: false,
          onUpgrade: async ({ socket }) => {
            socket.destroy();
            if (mode === "reject-empty") {
              setImmediate(() => process.stdout.write("survived\\n"));
              return Promise.reject();
            }
            throw new Error("throwing onUpgrade escapes the listener");
          },
        });
        await server.listen();
        process.stdout.write("listening:" + server.address.port + "\\n");
        setInterval(() => {}, 60_000);
      `,
      mode,
    ],
    {
      cwd: new URL("../", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  childProcesses.push(child);
  const listening = await childLine(child, "listening:");
  return { child, port: Number(listening.slice("listening:".length)) };
}

/** Trigger the HTTP upgrade path and absorb the expected client-side error. */
function requestUpgrade(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("error", () => {});
}

/** Anything the server hands an incoming websocket frame to. */
type FrameSink = { handleMessage: (data: Uint8Array) => void };

/**
 * Resolve once `count` frames have reached the server on this connection.
 *
 * `handleMessage` is the library's own entry point for an incoming frame —
 * `ClientConnection.ts:573` before a connection is established,
 * `Connection.ts:245` after — and both queue the frame synchronously, so a
 * wrapper that delegates first and counts second reports arrival exactly. That
 * arrival is the only observable a test holding the server mid-flight has: a
 * frame sitting in a queue has fired no hook yet, which is the whole point of
 * the state being held.
 */
function frameBarrier(target: FrameSink, count: number): Promise<void> {
  const handle = target.handleMessage.bind(target);
  let seen = 0;
  return new Promise((resolve) => {
    target.handleMessage = (data: Uint8Array) => {
      handle(data);
      if (++seen === count) resolve();
    };
  });
}

/** The same barrier for the next client to connect, which has no object yet. */
function frameBarrierForNextClient(
  hocuspocus: Hocuspocus<Context>,
  count: number,
): Promise<void> {
  const accept = hocuspocus.handleConnection.bind(hocuspocus);
  return new Promise((resolve) => {
    hocuspocus.handleConnection = (...args: Parameters<typeof accept>) => {
      hocuspocus.handleConnection = accept;
      const client = accept(...args);
      void frameBarrier(client, count).then(resolve);
      return client;
    };
  });
}

describe("ClientConnection.ts:420 — the pre-auth queue drains before `connected`", () => {
  /**
   * A provider sends its token and then its first sync message without waiting
   * to be told it was authenticated (`HocuspocusProvider.ts:537-543`), so those
   * frames sit in `incomingMessageQueue` while `onAuthenticate` runs. They are
   * handed to the `Connection` at `ClientConnection.ts:420-422` — *before* the
   * `connected` hook at `:426`.
   *
   * The hub registers its per-room close logger inside `connected`
   * (`packages/hub/src/server.ts`), so anything that queued frame does — up to
   * and including closing the connection — happens before the hub is watching.
   * If a bump moves the drain after the hook, the hub sees an event ordering it
   * has never seen; if it moves the drain *earlier still*, nothing here breaks,
   * which is the point of asserting the order rather than the mechanism.
   */
  it("hands queued client messages to the connection before the hook runs", async () => {
    const events: string[] = [];
    const room = randomUUID();
    const syncFrameQueued = gate();

    const { port, hocuspocus } = await startServer({
      onConnect: async () => {
        events.push("onConnect");
      },
      onAuthenticate: async () => {
        events.push("onAuthenticate");
        // Hold the handshake open until the client's sync frame has actually
        // reached the server, so the queue this test is about certainly has
        // something in it. Waiting for the frame rather than for a duration is
        // what makes "queued behind the handshake" a fact instead of a bet.
        await syncFrameQueued.opened;
        return { name: "queued" };
      },
      beforeHandleMessage: async () => {
        events.push("message");
      },
      connected: async () => {
        events.push("connected");
      },
    });

    // Frame one is the token, frame two the sync step the provider sends
    // straight after it without waiting to be authenticated.
    void frameBarrierForNextClient(hocuspocus, 2).then(syncFrameQueued.open);

    connect({ port, room });
    await waitUntil("the connected hook to run", () =>
      events.includes("connected"),
    );

    const connectedAt = events.indexOf("connected");
    expect(events.slice(0, 2)).toEqual(["onConnect", "onAuthenticate"]);
    // Everything between the handshake and the hook is drained client traffic,
    // and there is at least one such message: the sync step the provider sent
    // while `onAuthenticate` was still running.
    expect(events.slice(2, connectedAt)).not.toEqual([]);
    expect(new Set(events.slice(2, connectedAt))).toEqual(new Set(["message"]));
  });
});

describe("ClientConnection.ts:510-540 — a refused token sets up no connection", () => {
  /**
   * `onAuthenticate` throwing takes the branch that answers `writePermissionDenied`
   * and closes (`:510-560`); `setUpNewConnection` at `:540` never runs, so the
   * frames the provider queued behind its token — the sync step it sent without
   * waiting to be authenticated — are dropped with the connection rather than
   * handed to a `Connection` afterwards.
   *
   * The hub's protocol refusal rides entirely on that: it is the reason a
   * client the hub has decided not to talk to receives no document state at
   * all. Pinned here with the server *holding* content the refused client does
   * not have, because "the client's document is empty" proves nothing if there
   * was never anything for it to be given.
   */
  it("sends a refused client none of the document it is holding", async () => {
    const room = randomUUID();
    const { port, hocuspocus } = await startServer({
      onAuthenticate: async ({ token }) => {
        if (token === "refused") {
          throw new Error("no");
        }
        return { name: "welcome" };
      },
    });

    // Something to leak: an accepted client writes, and the server has it.
    const holder = connect({ port, room, token: "welcome" });
    await holder.synced;
    holder.text.insert(0, "state the refused client must not receive");
    await waitUntil("the server to hold the text", () =>
      hocuspocus.documents.get(room) !== undefined &&
      hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString() !== "",
    );

    // Refused, on a reconnect delay far out of reach so nothing it observes can
    // be explained by a second attempt.
    const refused = connect({
      port,
      room,
      token: "refused",
      reconnectDelayMs: 60_000,
    });
    let denied = false;
    refused.provider.on("authenticationFailed", () => {
      denied = true;
    });
    await waitUntil("the refusal to reach the client", () => denied);

    expect(hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString()).toBe(
      "state the refused client must not receive",
    );
    expect(refused.text.toString()).toBe("");
    expect(refused.provider.isSynced).toBe(false);
  });
});

describe("ClientConnection pending-document counter", () => {
  it("counts only documents whose authentication has not completed", async () => {
    const heldAuthenticationStarted = gate();
    const releaseHeldAuthentication = gate();
    const failedAfterAuthentication = "failed after authentication";

    const { port } = await startServer({
      maxPendingDocuments: 1,
      onAuthenticate: async ({ documentName }) => {
        if (documentName === "refused-before-authentication") {
          throw { reason: "refused before authentication" };
        }
        if (documentName === "held-during-authentication") {
          heldAuthenticationStarted.open();
          await releaseHeldAuthentication.opened;
        }
      },
      onLoadDocument: async ({ documentName }) => {
        if (documentName === "failed-after-authentication") {
          throw { reason: failedAfterAuthentication };
        }
      },
    });
    const websocket = sharedWebsocket(port);

    const refused = connect({
      port,
      room: "refused-before-authentication",
      awareness: null,
      websocketProvider: websocket,
    });
    await websocket.connect();
    await refused.authenticationFailed;

    const failed = connect({
      port,
      room: "failed-after-authentication",
      awareness: null,
      websocketProvider: websocket,
    });
    expect(await failed.authenticationFailed).toBe(failedAfterAuthentication);

    // Authenticated documents stay on this socket, but no longer consume its
    // one pending slot. Crossing the ceiling cumulatively must stay healthy.
    for (let index = 0; index < 3; index += 1) {
      await connect({
        port,
        room: `authenticated-${index}`,
        awareness: null,
        websocketProvider: websocket,
      }).synced;
    }

    connect({
      port,
      room: "held-during-authentication",
      awareness: null,
      websocketProvider: websocket,
    });
    await heldAuthenticationStarted.opened;

    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    connect({
      port,
      room: "one-past-the-pending-ceiling",
      awareness: null,
      websocketProvider: websocket,
    });

    await waitUntil("the second pending document to terminate its socket", () =>
      warnings.some((line) =>
        line.includes("too many pending unauthenticated documents"),
      ),
    );
    releaseHeldAuthentication.open();
  });
});

describe("MessageReceiver.ts:157 — the token dispatch is fire-and-forget", () => {
  /**
   * An auth message on an established connection reaches
   * `connection.callbacks.onTokenSyncCallback` at `MessageReceiver.ts:160`
   * without an `await`, so the message loop moves on while the `onTokenSync`
   * hook is still running.
   *
   * Release 1's auth refresh hangs off that hook. This test states the
   * consequence in the only terms that matter: a refresh in flight does not
   * pause the connection, so writes arriving during it are applied under the
   * *old* authorization. A bump that adds the `await` would make this time out
   * — which is a behaviour change worth being told about, in either direction.
   */
  it("keeps applying updates while the onTokenSync hook is still running", async () => {
    const room = randomUUID();
    const held = gate();
    let entered = false;
    let released = false;

    const { port, hocuspocus } = await startServer({
      onAuthenticate: async () => ({ name: "refresher" }),
      onTokenSync: async () => {
        entered = true;
        await held.opened;
        released = true;
      },
    });

    // The gate is released in `finally` because the failure this test exists to
    // report — a bump that awaits the dispatch — would otherwise leave the hook
    // blocked forever and hang teardown instead of failing here, by name.
    try {
      const client = connect({ port, room });
      await client.synced;

      client.provider.sendToken();
      await waitUntil("the onTokenSync hook to be entered", () => entered);

      client.text.insert(0, "written mid-refresh");
      await waitUntil(
        "the update to reach the server document",
        () =>
          hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString() ===
          "written mid-refresh",
      );

      expect(
        released,
        "the hook was still running when the update landed",
      ).toBe(false);
    } finally {
      held.open();
    }
  });
});

describe("MessageReceiver.ts:189-280 — beforeSync gates apply and acknowledgement", () => {
  /**
   * `beforeSync` runs after the sync subtype and payload have been decoded, but
   * before either mutating branch. Both branches send their positive sync
   * status only after the apply returns. The hub can therefore hold a write at
   * this hook without the server, a peer, or the sender observing success.
   */
  it("awaits beforeSync before applying or acknowledging messageYjsUpdate", async () => {
    const room = randomUUID();
    const held = gate();
    let armed = false;
    let entered = false;

    const { port, hocuspocus } = await startServer({
      beforeSync: async ({ type }) => {
        if (!armed || type !== messageYjsUpdate) return;
        entered = true;
        await held.opened;
      },
    });
    const sender = connect({ port, room });
    const observer = connect({ port, room });
    await Promise.all([sender.synced, observer.synced]);

    try {
      armed = true;
      sender.text.insert(0, "held update");
      await waitUntil("the update to enter beforeSync", () => entered);

      expect(hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString()).toBe(
        "",
      );
      expect(observer.text.toString()).toBe("");
      expect(sender.provider.hasUnsyncedChanges).toBe(true);

      held.open();
      await waitUntil(
        "the released update to be applied and acknowledged",
        () =>
          observer.text.toString() === "held update" &&
          !sender.provider.hasUnsyncedChanges,
      );
    } finally {
      held.open();
    }
  });

  it("awaits beforeSync before applying or acknowledging a reconnect messageYjsSyncStep2 diff", async () => {
    const room = randomUUID();
    const held = gate();
    let armed = false;
    let entered = false;

    const { port, hocuspocus } = await startServer({
      beforeSync: async ({ type }) => {
        if (!armed || type !== messageYjsSyncStep2) return;
        entered = true;
        await held.opened;
      },
    });
    const observer = connect({ port, room });
    const firstConnection = connect({ port, room, awareness: null });
    await Promise.all([observer.synced, firstConnection.synced]);

    // Detach before editing, then attach a fresh provider to the same Y.Doc:
    // the edit can reach the server only as the reconnect handshake's Step2
    // diff, rather than as an ordinary live messageYjsUpdate.
    firstConnection.provider.destroy();
    firstConnection.text.insert(0, "offline reconnect diff");
    armed = true;
    const reconnect = connect({
      port,
      room,
      awareness: null,
      document: firstConnection.doc,
    });

    try {
      await waitUntil("the reconnect diff to enter beforeSync", () => entered);

      expect(hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString()).toBe(
        "",
      );
      expect(observer.text.toString()).toBe("");
      expect(reconnect.provider.hasUnsyncedChanges).toBe(true);

      held.open();
      await waitUntil(
        "the released reconnect diff to be applied and acknowledged",
        () =>
          observer.text.toString() === "offline reconnect diff" &&
          !reconnect.provider.hasUnsyncedChanges,
      );
    } finally {
      held.open();
    }
  });

  it("closes with the thrown beforeSync reason before applying the update", async () => {
    const room = randomUUID();
    const refusal = "the append was refused verbatim";
    let armed = false;

    const { port, hocuspocus } = await startServer({
      beforeSync: async ({ type }) => {
        if (armed && type === messageYjsUpdate) {
          throw { reason: refusal };
        }
      },
    });
    const sender = connect({
      port,
      room,
      awareness: null,
      reconnectDelayMs: 60_000,
    });
    const observer = connect({ port, room });
    await Promise.all([sender.synced, observer.synced]);

    let closed: { code: number; reason: string } | undefined;
    sender.provider.on("close", ({ event }: onCloseParameters) => {
      closed = { code: event.code, reason: event.reason };
    });
    armed = true;
    sender.text.insert(0, "must not land");
    await waitUntil("the refusal to reach the sender", () => closed !== undefined);

    expect(closed).toEqual({ code: 1000, reason: refusal });
    expect(hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString()).toBe(
      "",
    );
    expect(observer.text.toString()).toBe("");
    expect(sender.provider.hasUnsyncedChanges).toBe(true);
  });
});

describe("y-protocols sync.js:82-89 — update observer errors are not an apply gate", () => {
  it("acknowledges an update whose document observer throws after apply", async () => {
    const room = randomUUID();
    let armed = false;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { port, hocuspocus } = await startServer({
        afterLoadDocument: async ({ document }) => {
          document.on("update", () => {
            if (armed) throw new Error("an observer cannot refuse an update");
          });
        },
      });
      const sender = connect({ port, room });
      await sender.synced;

      armed = true;
      sender.text.insert(0, "already applied");
      await waitUntil(
        "the applied update to be positively acknowledged",
        () =>
          hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString() ===
            "already applied" && !sender.provider.hasUnsyncedChanges,
      );

      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("positively acknowledges an ungated malformed update", async () => {
    const room = randomUUID();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { port, hocuspocus } = await startServer({});
      const sender = connect({ port, room });
      await sender.synced;

      // Drive the provider's public update handler so it owns both the wire
      // framing and the outstanding-change count. This byte is not a valid Yjs
      // update, but the sync reader catches the decoder error and returns.
      sender.provider.documentUpdateHandler(Uint8Array.of(0xff), null);
      expect(sender.provider.hasUnsyncedChanges).toBe(true);
      await waitUntil("the malformed update to be positively acknowledged", () =>
        !sender.provider.hasUnsyncedChanges,
      );

      expect(hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString()).toBe(
        "",
      );
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe("Server.ts:87-105 — onUpgrade refusal distinguishes empty rejection from an error", () => {
  /**
   * The HTTP server's async upgrade listener rethrows a truthy hook error. An
   * uncaught throw from that listener terminates Node, so a refusal cannot use
   * the usual `throw new Error(...)` form.
   */
  it("lets a throwing onUpgrade terminate its process", async () => {
    const { child, port } = await startUpgradeProbe("throw");
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );

    requestUpgrade(port);
    const result = await exited;

    expect(result).toEqual({ code: 1, signal: null });
    expect(stderr).toContain("throwing onUpgrade escapes the listener");
  });

  /** Destroy the socket, then reject with no value so the listener returns. */
  it("keeps the process alive for destroy-then-empty-reject", async () => {
    const { child, port } = await startUpgradeProbe("reject-empty");
    const survived = childLine(child, "survived");

    requestUpgrade(port);
    await survived;

    expect(child.exitCode).toBeNull();
  });
});

describe("Connection.ts:208 — close() clears neither the queue nor the in-flight loop", () => {
  /**
   * `Connection.close()` removes the connection from the document and sends a
   * close frame. It does not touch `messageQueue`, and it cannot interrupt the
   * `processMessages()` loop already awaiting a hook (`Connection.ts:252-302`);
   * the queue is emptied only when a *handler* throws, at `:296`. So both halves
   * survive the close: the message the loop is holding, and every message that
   * queued up behind it — each still applied, and still fanned out to everyone
   * else.
   *
   * Both halves are asserted because they fail independently: a bump could
   * start draining the queue on close while still finishing the message in
   * flight, and a test that sent only one message would call that unchanged.
   *
   * That is the boundary any "close this connection now" story has to be
   * written against: closing is not revoking. A bump that starts discarding the
   * queue would silently drop writes a client believes it sent, so this test is
   * as much a warning as a pin.
   */
  it("applies both the message in flight and the one queued behind it when the connection is closed", async () => {
    const room = randomUUID();
    let armed = false;
    let closed = false;
    const secondUpdateWanted = gate();

    const { port, hocuspocus } = await startServer({
      onAuthenticate: async ({ token }) => ({ name: token }),
      beforeHandleMessage: async ({ context, connection }) => {
        if (!armed || context.name !== "closing") return;
        armed = false;
        // The loop is now holding the first update. Ask the test for a second
        // one and wait for it to land in `messageQueue` behind the first, so
        // the close below happens with one message in flight and one queued.
        const queuedBehind = frameBarrier(connection, 1);
        secondUpdateWanted.open();
        await queuedBehind;
        connection.close({ code: 1000, reason: "characterization" });
        closed = true;
      },
    });

    // Awareness off on the closing client so the frame the hook catches is the
    // update this test sends, not an awareness heartbeat.
    const closing = connect({
      port,
      room,
      token: "closing",
      awareness: null,
      // Nothing the observer sees below can be the closed client reconnecting.
      reconnectDelayMs: 30_000,
    });
    const observer = connect({ port, room, token: "observer" });
    await Promise.all([closing.synced, observer.synced]);

    armed = true;
    closing.text.insert(0, "in flight");
    await secondUpdateWanted.opened;
    closing.text.insert(closing.text.length, ", and queued behind it");

    await waitUntil(
      "the observer to see both writes from the closed connection",
      () => observer.text.toString() === "in flight, and queued behind it",
    );

    expect(closed).toBe(true);
    expect(hocuspocus.documents.get(room)?.getText(TEXT_KEY).toString()).toBe(
      "in flight, and queued behind it",
    );
  });
});

describe("ClientConnection.ts:499-540 — onAuthenticate runs once, refreshes go to onTokenSync", () => {
  /**
   * `onConnect` then `onAuthenticate` (`:499` and `:510`) run on the first auth
   * message for a document, and only then is the connection set up (`:540`).
   * A later auth message finds the connection established (`:449-453`,
   * `:482`) and is routed to `onTokenSync` instead — the wiring at `:386-409`.
   *
   * The hub's whole auth boundary is that shape: `onAuthenticate` is the one
   * place a token is checked before a room opens, and it never runs again on a
   * live connection. A bump that re-ran it per token, or that authenticated
   * lazily, would move the check the hub's `hub.auth.rejected` log stands on.
   */
  it("authenticates once per room and routes a later token to the refresh hook", async () => {
    const room = randomUUID();
    const authenticated: string[] = [];
    const refreshed: string[] = [];
    const order: string[] = [];
    let token = "first-token";

    const { port } = await startServer({
      onConnect: async () => {
        order.push("onConnect");
      },
      onAuthenticate: async ({ token: seen }) => {
        order.push("onAuthenticate");
        authenticated.push(seen);
        return { name: "refresher" };
      },
      connected: async () => {
        order.push("connected");
      },
      onTokenSync: async ({ token: seen }) => {
        refreshed.push(seen);
      },
    });

    const client = connect({ port, room, token: () => token });
    await client.synced;
    await waitUntil("the connected hook to run", () =>
      order.includes("connected"),
    );

    token = "second-token";
    client.provider.sendToken();
    await waitUntil("the refresh to reach onTokenSync", () =>
      refreshed.includes("second-token"),
    );

    expect(order).toEqual(["onConnect", "onAuthenticate", "connected"]);
    expect(authenticated).toEqual(["first-token"]);
    expect(refreshed).toEqual(["second-token"]);
  });
});

describe("MessageReceiver.ts:72-110 — awareness has no readOnly check", () => {
  /**
   * The sync branches ask `connection.readOnly` before applying anything
   * (`:217` and `:259`); the awareness branch does not. A read-only connection
   * therefore cannot write a character but can publish any awareness state it
   * likes, and the server fans it out to every other client.
   *
   * The hub grants `readOnly` from a token's `scope` claim, so this is what a
   * read-only token actually buys — asserted here rather than assumed, because
   * "read-only" reads like a promise about everything the connection can send.
   */
  it("accepts awareness from a read-only connection while refusing its updates", async () => {
    const room = randomUUID();

    const { port, hocuspocus } = await startServer({
      onAuthenticate: async ({ token, connectionConfig }) => {
        connectionConfig.readOnly = token === "read-only";
        return { name: token };
      },
    });

    const reader = connect({ port, room, token: "read-only" });
    await reader.synced;

    // The order of these two lines is the proof, and the reason nothing here
    // waits out a timer to call the document empty. Both frames leave on the
    // same socket, and the server drains one connection's queue strictly in
    // order (`Connection.ts:252-302`): the update goes first, so the awareness
    // state showing up on the server is proof that the update ahead of it has
    // already been handled — and refused.
    reader.text.insert(0, "SMUGGLED");
    reader.provider.setAwarenessField("name", "the read-only client");

    const document = hocuspocus.documents.get(room);
    await waitUntil(
      "the read-only client's awareness to reach the server",
      () =>
        [...(document?.awareness.getStates().values() ?? [])].some(
          (state) => (state as { name?: string }).name === "the read-only client",
        ),
    );

    // The client holds text the server refused, from the same connection whose
    // awareness it just accepted.
    expect(reader.text.toString()).toBe("SMUGGLED");
    expect(document?.getText(TEXT_KEY).toString()).toBe("");
  });
});

describe("MessageReceiver.ts:88-107 — scratch re-encoding drops inbound awareness removals", () => {
  /**
   * The inbound update is decoded into a throwaway Awareness and then encoded
   * again from only the client ids that remain in it. A removal leaves no id to
   * encode, so the document and its peers retain the client's last state. An
   * ordinary update that keeps the client while dropping one field is relayed.
   *
   * This is only the inbound MessageReceiver boundary. When a connection
   * closes, `Document.removeConnection` calls `removeAwarenessStates` on the
   * document itself, and that hub-generated removal is broadcast — the event
   * the web's departed-agent grace observes.
   */
  it("relays a key removal but not the client's awareness removal", async () => {
    const room = randomUUID();
    let tokenRefreshed = false;

    const { port } = await startServer({
      onAuthenticate: async ({ token }) => ({ name: token }),
      onTokenSync: async () => {
        tokenRefreshed = true;
      },
    });

    const sender = connect({ port, room, token: "sender" });
    const observer = connect({ port, room, token: "observer" });
    await Promise.all([sender.synced, observer.synced]);

    const senderAwareness = sender.provider.awareness;
    const observerAwareness = observer.provider.awareness;
    if (!senderAwareness || !observerAwareness) {
      throw new Error("the characterization requires provider awareness");
    }
    const senderId = senderAwareness.clientID;

    senderAwareness.setLocalState({
      name: "sender",
      cursor: { anchor: 4, head: 4 },
    });
    await waitUntil("the observer to see both awareness fields", () =>
      observerAwareness.getStates().get(senderId)?.cursor !== undefined,
    );

    senderAwareness.setLocalState({ name: "sender" });
    await waitUntil("the key removal to reach the observer", () => {
      const state = observerAwareness.getStates().get(senderId);
      return state?.name === "sender" && !("cursor" in state);
    });

    // The token frame leaves after the removal on the same connection. The
    // server drains that queue in order, so entering onTokenSync proves the
    // removal has already passed through MessageReceiver without a timer.
    senderAwareness.setLocalState(null);
    sender.provider.sendToken();
    await waitUntil("the later token frame to reach the server", () =>
      tokenRefreshed,
    );

    expect(observerAwareness.getStates().get(senderId)).toEqual({
      name: "sender",
    });
  });
});
