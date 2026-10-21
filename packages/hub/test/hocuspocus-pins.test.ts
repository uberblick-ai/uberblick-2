/**
 * Hocuspocus is pinned to exactly 4.7.1, and this is the check that keeps it
 * there.
 *
 * The hub's auth and shutdown paths read library internals characterized in
 * `hocuspocus-seams.test.ts`. Keep the exact version pinned: any bump needs
 * review and re-characterization of those seams, including patch releases.
 *
 * Three packages, two places to state the pin:
 *
 * - `@hocuspocus/server` and `@hocuspocus/provider` are named by workspace
 *   manifests, so they are pinned there — and in the lockfile's `specifier:`
 *   for each, which is what `--frozen-lockfile` compares against.
 * - `@hocuspocus/common` is named by no manifest of ours: both of the others
 *   depend on it as `^4.7.1`. A workspace override in `pnpm-workspace.yaml` is
 *   the only place that range can be pinned.
 *
 * The pin assertions read files rather than resolving modules on purpose: what
 * must not drift is what a fresh `pnpm install` on another machine would
 * resolve, and that lives in the manifests, not in this checkout's
 * `node_modules`.
 *
 * The last describe block is the exception, and it has to be: text cannot tell
 * a live patched line from a dead one. A line that names an identifier the
 * bundle it was pasted into does not bind is syntactically fine, passes every
 * assertion above, and throws on the first frame of every document. Execute
 * the installed build to catch that failure.
 */

import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { hocuspocusLogger, stderrLogger } from "../src/log.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** The exact version the auth/shutdown seam probes characterize. */
const PINNED = "4.7.1";
const SERVER_PATCH = `patches/@hocuspocus__server@${PINNED}.patch`;

/** Server, provider and their shared transitive dependency must agree. */
const PINNED_PACKAGES = [
  "@hocuspocus/server",
  "@hocuspocus/provider",
  "@hocuspocus/common",
] as const;

function read(path: string): string {
  return readFileSync(`${REPO}${path}`, "utf8");
}

/** Every workspace manifest, plus the root one. */
function manifests(): string[] {
  const packages = readdirSync(`${REPO}packages`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`);
  return ["package.json", ...packages.sort()];
}

describe("@hocuspocus/* is pinned to an exact version", () => {
  it("pins the server patch to the exact version and both runtime builds", () => {
    const workspace = read("pnpm-workspace.yaml");
    const lock = read("pnpm-lock.yaml");
    const patch = read(SERVER_PATCH);
    const declaration = `@hocuspocus/server@${PINNED}`;

    expect(workspace).toContain(`"${declaration}": ${SERVER_PATCH}`);
    expect(lock).toMatch(
      new RegExp(
        `^  '${declaration}':\\n    hash: [0-9a-f]{64}\\n    path: ${SERVER_PATCH}$`,
        "m",
      ),
    );

    for (const path of [
      "src/ClientConnection.ts",
      "src/Connection.ts",
      "src/Hocuspocus.ts",
      "src/MessageReceiver.ts",
      "src/Server.ts",
      "src/types.ts",
      "dist/index.d.ts",
      "dist/hocuspocus-server.esm.js",
      "dist/hocuspocus-server.cjs",
    ]) {
      expect(patch).toContain(`diff --git a/${path} b/${path}`);
    }

    const added = patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");
    expect(added).toContain("return this.pendingDocumentCount;");
    expect(added).not.toContain("Object.keys(this.hookPayloads)");
  });

  it("names no range in any manifest, override or lockfile entry", () => {
    const ranged: string[] = [];

    for (const path of manifests()) {
      const manifest = JSON.parse(read(path)) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (!name.startsWith("@hocuspocus/")) continue;
          if (specifier !== PINNED) {
            ranged.push(`${path}: "${name}": "${specifier}"`);
          }
        }
      }
    }

    expect(
      ranged,
      `@hocuspocus/* is pinned to exactly ${PINNED}: the ` +
        "hub reads library internals, so a bump is a reviewed act. Pin the " +
        "specifier and re-characterize the seams before changing the version.",
    ).toEqual([]);

    // @hocuspocus/common is a transitive dependency of both server and
    // provider, each asking for a range: the workspace override pins it.
    expect(read("pnpm-workspace.yaml")).toMatch(
      new RegExp(`^\\s*['"]?@hocuspocus/common['"]?:\\s*${PINNED}\\s*$`, "m"),
    );

    const lock = read("pnpm-lock.yaml");

    // Every `specifier:` a workspace importer states for a Hocuspocus package.
    const lines = lock.split("\n");
    const specifiers: string[] = [];
    for (const [index, line] of lines.entries()) {
      const named = /^\s+'(@hocuspocus\/[^']+)':\s*$/.exec(line);
      if (named === null) continue;
      const specifier = /^\s+specifier:\s*(.+)$/.exec(lines[index + 1] ?? "");
      if (specifier === null) continue;
      specifiers.push(`${named[1]}: ${specifier[1]}`);
    }

    // pnpm mirrors `pnpm-workspace.yaml`'s overrides into the lockfile's own
    // top-level `overrides:` block, and that copy is half of what
    // `--frozen-lockfile` compares: a range restored there is a range the
    // next install would honour, so it has to fail here by name too.
    const mirrored = /^overrides:\n((?:[ \t]+\S.*\n)+)/m.exec(lock)?.[1] ?? "";
    expect(
      mirrored,
      "the lockfile mirrors the workspace overrides; @hocuspocus/common must " +
        `read exactly ${PINNED} there as well as in pnpm-workspace.yaml.`,
    ).toMatch(
      new RegExp(`^\\s*['"]?@hocuspocus/common['"]?:\\s*${PINNED}\\s*$`, "m"),
    );

    expect(specifiers.length).toBeGreaterThan(0);
    expect(
      specifiers.filter((entry) => !entry.endsWith(`: ${PINNED}`)),
      "the lockfile is what --frozen-lockfile compares against.",
    ).toEqual([]);

    // And no resolution anywhere in the file — direct or transitive — landed
    // on another version.
    const resolved = new Set(
      [...lock.matchAll(/@hocuspocus\/([a-z-]+)@([^'\s(]+)/g)].map(
        (match) => `${match[1]}@${match[2]}`,
      ),
    );
    expect([...resolved].sort()).toEqual(
      PINNED_PACKAGES.map(
        (name) => `${name.replace("@hocuspocus/", "")}@${PINNED}`,
      ).sort(),
    );
  });
});

/**
 * The runtime build, executed.
 *
 * `@hocuspocus/server` ships the same `ClientConnection` twice — an ESM bundle
 * and a CJS bundle — and the patch edits both by hand, because the package
 * ships no build. Everything in this repository loads the ESM one (every
 * workspace package is `"type": "module"`, and the release bundles are ESM), so
 * only that copy is probed.
 *
 * These probes execute pending-slot admission and cleanup. A document is
 * opened by its Auth message; another first frame is dropped without taking a
 * pending slot (`src/ClientConnection.ts:635-637`). The build is loaded by path
 * and driven through `handleMessage`, the library's own entry point for an
 * incoming frame, so what is asserted is the guard's *effect* in the bytes that
 * ship.
 */
describe("the patched admission rule is live in the ESM build", () => {
  /** Resolved through the `require` condition; the ESM bundle sits beside it. */
  const CJS_BUILD = createRequire(import.meta.url).resolve(
    "@hocuspocus/server",
  );
  const ESM_BUILD = join(dirname(CJS_BUILD), "hocuspocus-server.esm.js");

  /** `lib0` is the bundles' own encoder, so it resolves from beside them. */
  const encoding = createRequire(CJS_BUILD)("lib0/encoding") as {
    createEncoder: () => object;
    writeVarUint: (encoder: object, value: number) => void;
    writeVarString: (encoder: object, value: string) => void;
    toUint8Array: (encoder: object) => Uint8Array;
  };
  const decoding = createRequire(CJS_BUILD)("lib0/decoding") as {
    createDecoder: (data: Uint8Array) => object;
    readVarUint: (decoder: object) => number;
    readVarString: (decoder: object) => string;
  };
  const { AuthMessageType } = createRequire(CJS_BUILD)("@hocuspocus/common") as {
    AuthMessageType: { Authenticated: number; PermissionDenied: number };
  };

  /**
   * What either build exports, as far as a probe needs it. `handleConnection`
   * returns the `ClientConnection`, whose `getPendingDocumentCount()` is the
   * number the ceiling is enforced from — the same handle
   * `hocuspocus-seams.test.ts` reads.
   */
  type ClientConnection = {
    handleMessage: (data: Uint8Array) => void;
    handleQueueingMessage: (
      data: Uint8Array,
      rawKey: string,
      documentName: string,
    ) => Promise<void>;
    handleClose: () => void;
    getPendingDocumentCount: () => number;
    hookPayloads: Record<
      string,
      { connectionConfig: { isAuthenticated: boolean } }
    >;
    documentConnections: Record<
      string,
      { waitForPendingMessages: () => Promise<void> }
    >;
  };
  type ServerBuild = {
    MessageType: { Auth: number; Sync: number; CLOSE: number };
    Hocuspocus: new (configuration: Record<string, unknown>) => {
      documents: Map<string, object>;
      unloadDocument: (document: object) => Promise<void>;
      handleConnection: (
        websocket: unknown,
        request: unknown,
      ) => ClientConnection;
    };
  };

  async function load(): Promise<ServerBuild> {
    return (await import(/* @vite-ignore */ pathToFileURL(ESM_BUILD).href)) as ServerBuild;
  }

  /** A first frame for `room`, of the given top-level message type. */
  function frame(build: ServerBuild, room: string, type: number): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, room);
    encoding.writeVarUint(encoder, type);
    if (type === build.MessageType.Auth) {
      // `writeAuthentication` (@hocuspocus/common): the Token submessage, then
      // the token itself. The provider's optional version string may follow.
      encoding.writeVarUint(encoder, 0);
      encoding.writeVarString(encoder, "probe-token");
    }
    return encoding.toUint8Array(encoder);
  }

  function gate() {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve: () => resolve() };
  }

  function handshakeMessages(build: ServerBuild, frames: Uint8Array[]) {
    return frames.flatMap((data) => {
      const decoder = decoding.createDecoder(data);
      const room = decoding.readVarString(decoder);
      const type = decoding.readVarUint(decoder);
      if (type === build.MessageType.CLOSE) {
        return [{ room, type: "close", value: decoding.readVarString(decoder) }];
      }
      if (type !== build.MessageType.Auth) return [];
      const authType = decoding.readVarUint(decoder);
      if (authType === AuthMessageType.Authenticated) {
        return [{ room, type: "authenticated", value: decoding.readVarString(decoder) }];
      }
      if (authType === AuthMessageType.PermissionDenied) {
        return [{ room, type: "authenticationFailed", value: decoding.readVarString(decoder) }];
      }
      return [];
    });
  }

  /**
   * Deliver one first frame to a fresh connection of `build` and report what
   * the guard did with it: the pending slots it took, and any socket close.
   *
   * `onAuthenticate` is held until cleanup. Everything the guard decides is
   * synchronous — the count is incremented before the frame is handed on, and
   * a refusal closes the socket from the same `try` — so the connection is read
   * while it is still frozen at exactly the state the frame produced, with no
   * document loaded and no second observable to disentangle.
   */
  async function deliverFirstFrame(type: "auth" | "sync") {
    const build = await load();
    const held = gate();
    const client = await probe({ onAuthenticate: () => held.promise });

    try {
      client.connection.handleMessage(
        frame(
          build,
          "patched-build-probe",
          type === "auth" ? build.MessageType.Auth : build.MessageType.Sync,
        ),
      );
      return {
        pending: client.connection.getPendingDocumentCount(),
        closes: client.closes,
      };
    } finally {
      client.connection.handleClose();
      held.resolve();
      await client.dispose();
    }
  }

  async function probe(configuration: Record<string, unknown> = {}) {
    const build = await load();
    const closes: number[] = [];
    const sent: Uint8Array[] = [];
    const websocket = {
      readyState: 1,
      send(data: Uint8Array) {
        sent.push(data);
      },
      close(code: number) {
        closes.push(code);
        this.readyState = 3;
      },
    };
    const server = new build.Hocuspocus({
      quiet: true,
      maxPendingDocuments: 1,
      ...configuration,
    });
    const connection = server.handleConnection(websocket, { url: "/", headers: {} });
    // Observe completion of the real async handler; handleMessage itself is void.
    const tasks: Promise<void>[] = [];
    const original = connection.handleQueueingMessage.bind(connection);
    connection.handleQueueingMessage = (...args) => {
      const task = original(...args);
      tasks.push(task);
      return task;
    };
    return {
      connection,
      closes,
      sent,
      handshakeMessages: () => handshakeMessages(build, sent),
      closeSocket() {
        websocket.readyState = 3;
        connection.handleClose();
      },
      auth(room: string) {
        const before = tasks.length;
        connection.handleMessage(frame(build, room, build.MessageType.Auth));
        return tasks[before] ?? Promise.resolve();
      },
      async message(room: string, type: number) {
        connection.handleMessage(frame(build, room, type));
        await Promise.all(
          Object.values(connection.documentConnections).map((document) =>
            document.waitForPendingMessages(),
          ),
        );
      },
      async dispose() {
        websocket.readyState = 3;
        connection.handleClose();
        await Promise.all(tasks);
        for (const document of server.documents.values()) {
          await server.unloadDocument(document);
        }
      },
    };
  }

  for (const limit of ["pending", "queue"] as const) {
    it(`JSON-escapes unauthenticated ${limit} warnings without changing another instance`, async () => {
      const entered = gate();
      const held = gate();
      const lines: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
        lines.push(String(line));
        return true;
      });
      const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const malicious = 'room\n{"event":"forged"}\r\t"\\';
      const client = await probe({
        logger: hocuspocusLogger(stderrLogger),
        maxUnauthenticatedQueueMessages: 0,
        onAuthenticate: async () => {
          entered.resolve();
          await held.promise;
        },
      });
      const defaultClient = await probe({
        onAuthenticate: () => held.promise,
      });
      try {
        const finished = client.auth(malicious);
        await entered.promise;
        if (limit === "pending") {
          await client.auth(`${malicious}overflow`);
        } else {
          const build = await load();
          client.connection.handleMessage(frame(build, malicious, build.MessageType.Sync));
        }
        expect(client.closes).toEqual([4205]);
        expect(lines).toHaveLength(1);
        expect(lines[0]?.split("\n")).toHaveLength(2);
        expect(JSON.parse(lines[0] ?? "")).toEqual({
          event: "hub.hocuspocus.warning",
          message: expect.stringContaining(malicious),
        });
        expect(consoleWarning).not.toHaveBeenCalled();

        // A separate consumer keeps the library's normal output destination.
        void defaultClient.auth("held-default");
        await defaultClient.auth("default-overflow");
        expect(consoleWarning).toHaveBeenCalledOnce();
        expect(lines).toHaveLength(1);
        held.resolve();
        await finished;
      } finally {
        held.resolve();
        await client.dispose();
        await defaultClient.dispose();
        consoleWarning.mockRestore();
        stderr.mockRestore();
      }
    });
  }

  it("JSON-escapes client text in logged hook errors", async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
      lines.push(String(line));
      return true;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const malicious = 'room\n{"event":"forged"}\r\t"\\';
    const client = await probe({
      logger: hocuspocusLogger(stderrLogger),
      onAuthenticate: ({ documentName }: { documentName: string }) => {
        throw new Error(`Workspace mismatch for ${documentName}`);
      },
    });
    try {
      await client.auth(malicious);
      expect(consoleError).not.toHaveBeenCalled();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.split("\n")).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        event: "hub.hocuspocus.error",
        message: `[onAuthenticate] Workspace mismatch for ${malicious}`,
      });
    } finally {
      await client.dispose();
      consoleError.mockRestore();
      stderr.mockRestore();
    }
  });

  it("keeps receiver and connection errors on the instance logger", async () => {
    const errors: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = 'room\n{"event":"forged"}';
    let refuse = false;
    const client = await probe({
      logger: hocuspocusLogger((record) => errors.push(JSON.stringify(record))),
      beforeHandleMessage: () => {
        if (refuse) throw new Error(`Refused ${room}`);
      },
    });
    try {
      await client.auth(room);
      await client.message(room, 99);
      expect(errors.map((line) => JSON.parse(line).message)).toEqual([
        "Unable to handle message of type 99: no handler defined! Are your provider/server versions aligned?",
      ]);
      refuse = true;
      await client.message(room, 99);
      expect(errors).toHaveLength(3);
      expect(JSON.parse(errors[1] ?? "").message).toContain(room);
      expect(JSON.parse(errors[2] ?? "").message).toContain(room);
      expect(errors.every((line) => !line.includes("\n"))).toBe(true);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      consoleError.mockRestore();
    }
  });

  it("enforces the pending ceiling while authentication is running", async () => {
    const entered = gate();
    const held = gate();
    const client = await probe({
      onAuthenticate: async () => {
        entered.resolve();
        await held.promise;
      },
    });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const finished = client.auth("held");
      await entered.promise;
      expect(client.connection.getPendingDocumentCount()).toBe(1);
      await client.auth("over-ceiling");
      expect(client.closes).toEqual([4205]);
      expect(client.connection.getPendingDocumentCount()).toBe(0);
      held.resolve();
      await finished;
      expect(client.connection.getPendingDocumentCount()).toBe(0);
    } finally {
      held.resolve();
      await client.dispose();
      logged.mockRestore();
    }
  });

  it("releases refused and authenticated slots without scanning other documents", async () => {
    const client = await probe({
      onAuthenticate: ({ documentName }: { documentName: string }) => {
        if (documentName === "refused") throw { reason: "refused" };
      },
      onLoadDocument: ({ documentName }: { documentName: string }) => {
        if (documentName === "load-failed") throw { reason: "load-failed" };
      },
    });
    try {
      await client.auth("refused");
      expect(client.connection.getPendingDocumentCount()).toBe(0);
      await client.auth("load-failed");
      expect(client.connection.getPendingDocumentCount()).toBe(0);
      // These stay authenticated on the same socket, beyond its pending ceiling.
      for (const room of ["accepted-a", "accepted-b", "accepted-c"]) {
        await client.auth(room);
        expect(client.connection.getPendingDocumentCount()).toBe(0);
        expect(
          client.connection.hookPayloads[room]?.connectionConfig.isAuthenticated,
        ).toBe(true);
      }
      const payloads = client.connection.hookPayloads;
      let scans = 0;
      let siblingReads = 0;
      client.connection.hookPayloads = new Proxy(payloads, {
        ownKeys(target) {
          scans += 1;
          return Reflect.ownKeys(target);
        },
        get(target, key, receiver) {
          if (typeof key === "string" && key.startsWith("accepted-")) {
            siblingReads += 1;
          }
          return Reflect.get(target, key, receiver);
        },
      });
      try {
        await client.auth("next");
        expect(client.connection.getPendingDocumentCount()).toBe(0);
        expect({ scans, siblingReads, closes: client.closes }).toEqual({
          scans: 0,
          siblingReads: 0,
          closes: [],
        });
      } finally {
        client.connection.hookPayloads = payloads;
      }
    } finally {
      await client.dispose();
    }
  });

  it("sends a late room refusal after its close and keeps sibling admission live", async () => {
    const room = "late-refused";
    const reason = "access-ended-during-load";
    const client = await probe({
      connected: ({ documentName, connection }: {
        documentName: string;
        connection: { close: (event: { code: number; reason: string }) => void };
      }) => {
        if (documentName !== room) return;
        connection.close({ code: 4403, reason });
        throw { reason };
      },
    });
    try {
      await client.auth(room);
      expect(client.handshakeMessages()).toEqual([
        { room, type: "authenticated", value: "read-write" },
        { room, type: "close", value: reason },
        { room, type: "authenticationFailed", value: reason },
      ]);
      expect(client.connection.getPendingDocumentCount()).toBe(0);
      expect(client.connection.hookPayloads[room]).toBeUndefined();
      expect(client.closes).toEqual([]);

      await client.auth("healthy-sibling");
      expect(client.connection.getPendingDocumentCount()).toBe(0);
      expect(client.connection.hookPayloads["healthy-sibling"]?.connectionConfig.isAuthenticated).toBe(true);
      expect(client.handshakeMessages().at(-1)).toEqual({
        room: "healthy-sibling", type: "authenticated", value: "read-write",
      });
      expect(client.closes).toEqual([]);
    } finally {
      await client.dispose();
    }
  });

  it("sends no late refusal after the socket closes during document loading", async () => {
    const entered = gate();
    const held = gate();
    const client = await probe({
      onLoadDocument: async () => {
        entered.resolve();
        await held.promise;
        throw { reason: "load refused after socket close" };
      },
    });
    try {
      const finished = client.auth("loading");
      await entered.promise;
      expect(client.connection.getPendingDocumentCount()).toBe(0);
      client.closeSocket();
      held.resolve();
      await finished;
      expect(client.connection.getPendingDocumentCount()).toBe(0);
      expect(client.handshakeMessages()).toEqual([
        { room: "loading", type: "authenticated", value: "read-write" },
      ]);
    } finally {
      held.resolve();
      await client.dispose();
    }
  });

  for (const rejects of [false, true]) {
    it(`releases a slot once when the socket closes during ${rejects ? "refused" : "successful"} authentication`, async () => {
      const entered = gate();
      const held = gate();
      const client = await probe({
        onAuthenticate: async () => {
          entered.resolve();
          await held.promise;
          if (rejects) throw { reason: "refused after close" };
        },
      });
      try {
        const finished = client.auth("held");
        await entered.promise;
        expect(client.connection.getPendingDocumentCount()).toBe(1);
        client.closeSocket();
        expect(client.connection.getPendingDocumentCount()).toBe(0);
        held.resolve();
        await finished;
        expect(client.connection.getPendingDocumentCount()).toBe(0);
        expect(client.closes).toEqual([]);
        expect(client.sent).toEqual([]);
      } finally {
        held.resolve();
        await client.dispose();
      }
    });
  }

  it("opens a pending document for an Auth first frame", async () => {
    expect(
      await deliverFirstFrame("auth"),
      "the build must admit a valid Auth frame. A guard that throws " +
        "here — an identifier this bundle does not bind is the way that " +
        "happens — is swallowed into the handler's catch, so every document " +
        "on every socket is refused with 4401 Unauthorized instead.",
    ).toEqual({ pending: 1, closes: [] });
  });

  it("takes no pending slot for a non-Auth first frame", async () => {
    expect(
      await deliverFirstFrame("sync"),
      "the build must drop a first frame that is not an Auth " +
        "message. Opening a pending document for it takes a slot nothing " +
        "can release, because its client has already been refused and sends " +
        "no further token (#944).",
    ).toEqual({ pending: 0, closes: [] });
  });
});
