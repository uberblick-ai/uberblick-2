// @vitest-environment node
/**
 * The presence name and colour are preferences that *leave the machine*.
 *
 * They are published in awareness, because a preference peers cannot see is
 * not a presence preference. The contract is what a peer ends up holding:
 *
 * - the moment it is chosen, in every room this tab already has open — not on
 *   the next reconnect, and not only in the room that happens to be on screen;
 * - in a room joined afterwards, which is the case a colour applied only to
 *   live rooms would quietly get wrong;
 * - after a reload, where the tab is dealt a fresh random colour and the stored
 *   one has to win.
 *
 * The peer is a real `Awareness` fed a real encoded update, so what is asserted
 * is what the wire carries. The provider is a stand-in — the transport is
 * proved in `reconnect.test.ts`, and dialling a hub that is not running would
 * be the whole of this file's runtime.
 */

import { beforeEach, expect, it, vi } from "vitest";
import { readAuthEnvelope } from "@uberblick/hub/protocol";
import { importRootSecret, verifyToken } from "@uberblick/hub/token";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness: RealAwareness } = await import("y-protocols/awareness");
  class FakeSocket {
    status = "disconnected";
    on(): void {}
    connect(): void {}
    disconnect(): void {}
  }
  /** Everything `openRoom` touches, with a real awareness map behind it. */
  class FakeProvider {
    isSynced = false;
    unsyncedChanges = 0;
    awareness: InstanceType<typeof RealAwareness>;
    token: () => Promise<string>;
    constructor(options: { document: Y.Doc; token: () => Promise<string> }) {
      this.awareness = new RealAwareness(options.document);
      this.token = options.token;
    }
    attach(): void {}
    on(): void {}
    setAwarenessField(field: string, value: unknown): void {
      this.awareness.setLocalStateField(field, value);
    }
    destroy(): void {
      this.awareness.destroy();
    }
  }
  return {
    WebSocketStatus: { Connected: "connected", Disconnected: "disconnected" },
    HocuspocusProviderWebsocket: FakeSocket,
    HocuspocusProvider: FakeProvider,
  };
});

vi.mock("../src/config.js", () => ({
  HUB_CONFIG_PATH: "/uberblick-config.json",
  hubUrl: () => "ws://127.0.0.1:1",
  hubAuthToken: () => "test-secret",
  resolveClientConfig: async () => ({}),
}));

const { acquireRoom } = await import("../src/collab/rooms.js");
const { setSetting } = await import("../src/settings.js");
const { AWARENESS_COLORS } = await import("../src/collab/identity.js");
import type { RoomConnection } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const DEALT = "#0675c9";
const CHOSEN = AWARENESS_COLORS[3]?.hex as string;

/** A fresh in-memory Storage — see settings.test.tsx for why jsdom's is not it. */
function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
}

/** What a remote client holds about this session, decoded from the wire. */
function seenByPeer(connection: RoomConnection): { name: string; color: string } {
  const awareness = connection.provider.awareness as Awareness;
  const peerDoc = new Y.Doc();
  const peer = new Awareness(peerDoc);
  try {
    applyAwarenessUpdate(
      peer,
      encodeAwarenessUpdate(awareness, [awareness.clientID]),
      "test",
    );
    const state = peer.getStates().get(awareness.clientID) as {
      user: { name: string; color: string };
    };
    return state.user;
  } finally {
    peer.destroy();
    peerDoc.destroy();
  }
}

beforeEach(() => {
  installStorage();
});

it("publishes a chosen presence colour to peers, in every room and after a reload", () => {
  const identity = { name: "unhurried otter", color: DEALT };
  const directory = acquireRoom(`${WORKSPACE}/_directory`, identity);
  const doc = acquireRoom(`${WORKSPACE}/one`, identity);

  // Before anybody chooses: the colour the tab was dealt.
  expect(seenByPeer(directory.connection)).toEqual({ name: identity.name, color: DEALT });

  setSetting("presenceColor", CHOSEN);

  // Both rooms, without a reconnect and without re-acquiring anything.
  expect(seenByPeer(directory.connection).color).toBe(CHOSEN);
  expect(seenByPeer(doc.connection).color).toBe(CHOSEN);
  // The name is untouched by a colour change.
  expect(seenByPeer(doc.connection).name).toBe(identity.name);

  // A room joined after the choice publishes it too.
  const later = acquireRoom(`${WORKSPACE}/two`, identity);
  expect(seenByPeer(later.connection).color).toBe(CHOSEN);

  directory.release();
  doc.release();
  later.release();

  // The reload: a new tab dealt a different colour, reading the same storage.
  const reloaded = acquireRoom(`${WORKSPACE}/_directory`, {
    name: "adjacent heron",
    color: "#cb26b4",
  });
  expect(seenByPeer(reloaded.connection).color).toBe(CHOSEN);
  reloaded.release();
});

it("publishes a chosen name live in every room, keeps it after reload, and restores the serving default when cleared", () => {
  const identity = { name: "Git Editor", color: DEALT };
  const directory = acquireRoom(`${WORKSPACE}/_directory`, identity);
  const doc = acquireRoom(`${WORKSPACE}/one`, identity);
  const handles = [directory, doc];
  try {
    expect(seenByPeer(doc.connection)).toEqual(identity);
    setSetting("presenceColor", CHOSEN);
    setSetting("presenceName", "  Chosen Editor  ");
    for (const handle of handles) {
      expect(seenByPeer(handle.connection)).toEqual({ name: "Chosen Editor", color: CHOSEN });
    }
    const later = acquireRoom(`${WORKSPACE}/two`, identity);
    handles.push(later);
    expect(seenByPeer(later.connection)).toEqual({ name: "Chosen Editor", color: CHOSEN });
    setSetting("presenceName", " \t ");
    for (const handle of handles) {
      expect(seenByPeer(handle.connection)).toEqual({ name: identity.name, color: CHOSEN });
    }
    setSetting("presenceName", "Chosen Editor");
  } finally {
    for (const handle of handles) handle.release();
  }

  // A restarted serving process can supply a new default; the browser's
  // preference still wins until the reader clears it.
  const nextDefault = { name: "New Git Editor", color: "#cb26b4" };
  const reloaded = acquireRoom(`${WORKSPACE}/_directory`, nextDefault);
  try {
    expect(seenByPeer(reloaded.connection)).toEqual({ name: "Chosen Editor", color: CHOSEN });
    setSetting("presenceName", " \t\n ");
    expect(seenByPeer(reloaded.connection)).toEqual({ name: nextDefault.name, color: CHOSEN });
  } finally {
    reloaded.release();
  }
});

it("mints each room reconnect token with the current nonblank name", async () => {
  const identity = { name: "Git Editor", color: DEALT };
  const room = acquireRoom(`${WORKSPACE}/_directory`, identity);
  const handles = [room];
  const key = await importRootSecret("test-secret");
  const expectSubject = async (connection: RoomConnection, subject: string): Promise<void> => {
    // This is the same async callback Hocuspocus invokes on every reconnect.
    const { token } = connection.provider as unknown as { token: () => Promise<string> };
    const envelope = readAuthEnvelope(await token());
    expect(envelope).not.toBeNull();
    const claims = await verifyToken(key, envelope?.token ?? "");
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe(subject);
    expect(claims?.workspace).toBe(WORKSPACE);
  };
  try {
    await expectSubject(room.connection, identity.name);
    setSetting("presenceName", "  Chosen Editor  ");
    await expectSubject(room.connection, "Chosen Editor");
    const later = acquireRoom(`${WORKSPACE}/later`, identity);
    handles.push(later);
    await expectSubject(later.connection, "Chosen Editor");
    setSetting("presenceName", " \t\n ");
    for (const handle of handles) await expectSubject(handle.connection, identity.name);
  } finally {
    for (const handle of handles) handle.release();
  }
});

it("reads a workspace name silently and withdraws presence when only that reader remains", () => {
  const identity = { name: "unhurried otter", color: DEALT };
  const room = `${WORKSPACE}/_settings`;
  const silent = acquireRoom(room, identity, { presence: false });
  const awareness = silent.connection.provider.awareness as Awareness;
  const peerDoc = new Y.Doc();
  const peer = new Awareness(peerDoc);
  const readState = (): Record<string, unknown> => {
    applyAwarenessUpdate(peer, encodeAwarenessUpdate(awareness, [awareness.clientID]), "test");
    return (peer.getStates().get(awareness.clientID) ?? {}) as Record<string, unknown>;
  };

  expect(readState()).not.toHaveProperty("user");
  expect(readState()).not.toHaveProperty("client");
  setSetting("presenceColor", CHOSEN);
  expect(readState()).not.toHaveProperty("user");
  expect(readState()).not.toHaveProperty("client");

  const first = acquireRoom(room, identity);
  const second = acquireRoom(room, identity);
  expect(first.connection).toBe(silent.connection);
  expect(readState().user).toEqual({ ...identity, color: CHOSEN });
  expect(readState().client).toBe("web");
  first.release();
  expect(readState()).toHaveProperty("user");
  second.release();
  expect(readState()).not.toHaveProperty("user");
  expect(readState()).not.toHaveProperty("client");
  setSetting("presenceColor", AWARENESS_COLORS[2]?.hex as string);
  expect(readState()).not.toHaveProperty("user");
  expect(readState()).not.toHaveProperty("client");
  silent.release();
  peer.destroy();
  peerDoc.destroy();
});
