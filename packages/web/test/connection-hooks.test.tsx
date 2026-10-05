/**
 * A room reading belongs to its connection, including the frame before passive
 * effects subscribe to a replacement. Capturing inside render sees that frame;
 * checking only after `act` would hide a previous document's reading.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  appendBlock,
  createAnnotation,
  createGroup,
  getBlocksFragment,
  initDoc,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection } from "../src/collab/rooms.js";
import { AGENT_CLIENT, AWARENESS_FALLBACK_COLOR } from "../src/collab/identity.js";
import { readPresence } from "../src/ui/doc-chrome.js";
import {
  useAgentSessions,
  useDirectory,
  useDocMeta,
  useDocRev,
  useForeignBlocks,
  useLinkConflicts,
  useOutline,
  usePeers,
  usePresence,
  useRawBlocks,
  useSidebar,
  useThreads,
} from "../src/ui/hooks.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";
const OTHER_UUID = "4a9939be-2778-442f-9278-e1517ef88335";

interface Fixture {
  connection: RoomConnection;
  ydoc: Y.Doc;
  awareness: Awareness;
  peer: Awareness;
  peerDoc: Y.Doc;
}

const fixtures: Fixture[] = [];
const remotePeers: Array<{ awareness: Awareness; ydoc: Y.Doc }> = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  for (const peer of remotePeers.splice(0)) {
    peer.awareness.destroy();
    peer.ydoc.destroy();
  }
  for (const fixture of fixtures.splice(0)) {
    fixture.peer.destroy();
    fixture.awareness.destroy();
    fixture.peerDoc.destroy();
    fixture.ydoc.destroy();
  }
});

function fixture(room: string, title?: string): Fixture {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const peerDoc = new Y.Doc();
  const peer = new Awareness(peerDoc);
  const connection = {
    room,
    ydoc,
    provider: { awareness },
    status: { writable: false, synced: false },
    onStatusChange: () => () => {},
  } as unknown as RoomConnection;
  const fix = { connection, ydoc, awareness, peer, peerDoc };
  fixtures.push(fix);
  if (title !== undefined) {
    initDoc(ydoc, { uuid: UUID, title });
    upsertDirectoryEntry(ydoc, { uuid: UUID, title, tags: [] });
    createGroup(ydoc, title);
    appendBlock(ydoc, { type: "heading", level: 1, text: title });
    const paragraph = appendBlock(ydoc, { type: "paragraph", text: "linked text" });
    createAnnotation(ydoc, paragraph, 0, 6, "Test author", title);
    textAt(ydoc, 1).format(0, 6, {
      link: { href: "https://example.test/link" },
      docLink: { docId: OTHER_UUID },
    });
    const foreign = new Y.XmlElement("callout");
    foreign.insert(0, [new Y.XmlText(title)]);
    getBlocksFragment(ydoc).push([foreign]);
    publish(fix, {
      user: { name: title, color: "#888888" },
      client: AGENT_CLIENT,
      session: "agent-14c845a3-3b40-4419-bd91-0865e803bb27",
    });
  }
  return fix;
}

function textAt(ydoc: Y.Doc, index: number): Y.XmlText {
  const block = getBlocksFragment(ydoc).get(index);
  if (!(block instanceof Y.XmlElement) || !(block.firstChild instanceof Y.XmlText)) {
    throw new Error("fixture block has no text");
  }
  return block.firstChild;
}

function publish(fix: Fixture, state: Record<string, unknown>): void {
  fix.peer.setLocalState(state);
  applyAwarenessUpdate(
    fix.awareness,
    encodeAwarenessUpdate(fix.peer, [fix.peerDoc.clientID]),
    "test",
  );
}

function join(fix: Fixture, state: Record<string, unknown>): {
  clientId: number;
  publish: (next: Record<string, unknown>) => void;
} {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  remotePeers.push({ ydoc, awareness });
  const publishState = (next: Record<string, unknown>): void => {
    awareness.setLocalState(next);
    applyAwarenessUpdate(
      fix.awareness,
      encodeAwarenessUpdate(awareness, [ydoc.clientID]),
      "test",
    );
  };
  publishState(state);
  return { clientId: ydoc.clientID, publish: publishState };
}

function useReading(connection: RoomConnection | null) {
  return {
    directory: useDirectory(connection),
    sidebar: useSidebar(connection),
    meta: useDocMeta(connection),
    foreign: useForeignBlocks(connection),
    conflicts: useLinkConflicts(connection).conflicts,
    peers: usePeers(connection),
    agentSessions: useAgentSessions(connection),
    presence: usePresence(connection),
    rev: useDocRev(connection),
    blocks: useRawBlocks(connection),
    outline: useOutline(connection),
    threads: useThreads(connection),
  };
}

const EMPTY = {
  directory: [],
  sidebar: [],
  meta: null,
  foreign: [],
  conflicts: [],
  peers: [],
  agentSessions: 0,
  presence: [],
  rev: null,
  blocks: [],
  outline: [],
  threads: [],
};

describe("connection-scoped readings", () => {
  it("returns empty values in the first frame of every replacement or removal", () => {
    const alpha = fixture(`${WORKSPACE}/alpha`, "Alpha");
    const beta = fixture(`${WORKSPACE}/beta`, "Beta");
    // A new provider can keep the room key while replacing the whole replica.
    const replacement = fixture(`${WORKSPACE}/beta`, "Replacement");
    const seen: Array<ReturnType<typeof useReading>> = [];
    function Probe({ current }: { current: RoomConnection | null }): null {
      seen.push(useReading(current));
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      for (const fix of [alpha, beta, replacement]) {
        const before = seen.length;
        act(() => root.render(<Probe current={fix.connection} />));
        expect(seen[before]).toEqual(EMPTY);
        const populated = seen.at(-1)!;
        // Every reset below has a retained, non-empty reading to defend against.
        expect(populated.directory[0]?.title).toBe(fix === alpha ? "Alpha" : fix === beta ? "Beta" : "Replacement");
        expect(populated.sidebar).toHaveLength(1);
        expect(populated.meta?.title).toBe(populated.directory[0]?.title);
        expect(populated.foreign).toHaveLength(2);
        expect(populated.conflicts).toHaveLength(1);
        expect(populated.peers).toHaveLength(1);
        expect(populated.agentSessions).toBe(1);
        expect(populated.presence).toHaveLength(1);
        expect(populated.rev).toMatch(/^[0-9a-f]{8}$/);
        expect(populated.blocks).toHaveLength(3);
        expect(populated.outline).toHaveLength(1);
        expect(populated.threads).toHaveLength(1);
      }
      const before = seen.length;
      act(() => root.render(<Probe current={null} />));
      for (const snapshot of seen.slice(before)) expect(snapshot).toEqual(EMPTY);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("distinguishes metadata that has not been read from a genuinely empty room", () => {
    const fix = fixture(`${WORKSPACE}/empty`);
    const seen: Array<ReturnType<typeof useDocMeta>> = [];
    function Probe({ current }: { current: RoomConnection | null }): null {
      seen.push(useDocMeta(current));
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(<Probe current={fix.connection} />));
      expect(seen[0]).toBeNull();
      expect(seen.at(-1)?.uuid).toBe("");
      const before = seen.length;
      act(() => root.render(<Probe current={null} />));
      for (const meta of seen.slice(before)) expect(meta).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("updates directory filtering when includeDeleted changes on one connection", () => {
    const fix = fixture(`${WORKSPACE}/directory`);
    upsertDirectoryEntry(fix.ydoc, { uuid: UUID, title: "Live", tags: [] });
    upsertDirectoryEntry(fix.ydoc, { uuid: OTHER_UUID, title: "Archived", tags: [] });
    tombstoneDirectoryEntry(fix.ydoc, OTHER_UUID);
    let entries: ReturnType<typeof useDirectory> = [];
    function Probe({ includeDeleted }: { includeDeleted: boolean }): null {
      entries = useDirectory(fix.connection, includeDeleted);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(<Probe includeDeleted={false} />));
      expect(entries.map(({ uuid }) => uuid)).toEqual([UUID]);
      act(() => root.render(<Probe includeDeleted />));
      expect(entries.map(({ uuid }) => uuid).sort()).toEqual([UUID, OTHER_UUID].sort());
      expect(entries.find(({ uuid }) => uuid === OTHER_UUID)?.deleted).toBe(true);
      act(() => root.render(<Probe includeDeleted={false} />));
      expect(entries.map(({ uuid }) => uuid)).toEqual([UUID]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("refreshes link conflicts before the transaction has notified observers", () => {
    const fix = fixture(`${WORKSPACE}/links`, "Links");
    let links: ReturnType<typeof useLinkConflicts> | undefined;
    function Probe(): null {
      links = useLinkConflicts(fix.connection);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(<Probe />));
      expect(links?.conflicts).toHaveLength(1);
      act(() => {
        fix.ydoc.transact(() => {
          textAt(fix.ydoc, 1).format(0, 6, { link: null });
          // Yjs dispatches observers after the transaction. A repair can still
          // ask for the current scan while that notification has not happened.
          flushSync(() => links?.refresh());
          expect(links?.conflicts).toEqual([]);
        });
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("stores no new presence reading for a caret moving inside the same block", () => {
    const fix = fixture(`${WORKSPACE}/presence`, "Presence");
    const anchorAt = (offset: number): unknown => Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(textAt(fix.ydoc, 0), offset),
    );
    const state = { user: { name: "Peer", color: "#888888" }, client: "web" };
    publish(fix, { ...state, cursor: { anchor: anchorAt(0) } });
    let renders = 0;
    let presence: ReturnType<typeof usePresence> = [];
    function DrawPresence({ current }: { current: ReturnType<typeof usePresence> }): null {
      renders += 1;
      presence = current;
      return null;
    }
    function Probe() {
      return <DrawPresence current={usePresence(fix.connection)} />;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(<Probe />));
      expect(presence[0]?.block).toBe(1);
      const before = renders;
      const previous = presence;
      act(() => publish(fix, { ...state, cursor: { anchor: anchorAt(1) } }));
      expect(presence).toBe(previous);
      expect(renders).toBe(before);
      act(() => publish(fix, { ...state, cursor: { anchor: Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(textAt(fix.ydoc, 1), 0),
      ) } }));
      expect(presence[0]?.block).toBe(2);
      expect(renders).toBeGreaterThan(before);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps each awareness reader's inclusion rule through presence withdrawal", () => {
    const fix = fixture(`${WORKSPACE}/awareness`);
    initDoc(fix.ydoc, { uuid: UUID, title: "Awareness" });
    appendBlock(fix.ydoc, { type: "paragraph", text: "anchor" });
    const anchor = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(textAt(fix.ydoc, 0), 0),
    );
    const session = "agent-b2c87a3f-e677-48e9-bacf-3a9609ac851f";
    fix.awareness.setLocalState({
      user: { name: "Self", color: "#000000" },
      client: AGENT_CLIENT,
      session,
      cursor: { anchor },
    });
    const fallback = join(fix, { user: {} });
    const agent = join(fix, {
      user: { name: "Agent", color: "#123456" },
      client: AGENT_CLIENT,
      session,
      cursor: { anchor },
    });
    const human = join(fix, { user: { name: "Human" }, client: "web" });
    join(fix, { client: AGENT_CLIENT, session });
    const cursorOnly = join(fix, { cursor: { anchor } });
    join(fix, {});
    let peers: ReturnType<typeof usePeers> = [];
    let agents = 0;
    function Probe(): null {
      peers = usePeers(fix.connection);
      agents = useAgentSessions(fix.connection);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(<Probe />));
      expect(peers.map(({ clientId }) => clientId).sort()).toEqual(
        [fallback.clientId, agent.clientId, human.clientId].sort(),
      );
      expect(peers.find(({ clientId }) => clientId === fallback.clientId)).toEqual({
        clientId: fallback.clientId,
        name: `client ${fallback.clientId}`,
      });
      expect(agents).toBe(1);
      const presence = readPresence(fix.ydoc, fix.awareness);
      expect(presence.map(({ clientId }) => clientId).sort()).toEqual(
        [fallback.clientId, agent.clientId, human.clientId, cursorOnly.clientId].sort(),
      );
      expect(presence.find(({ clientId }) => clientId === agent.clientId)).toMatchObject({
        name: "Agent", color: "#123456", kind: "agent", session, block: 1,
      });
      expect(presence.find(({ clientId }) => clientId === human.clientId)).toMatchObject({
        name: "Human", color: AWARENESS_FALLBACK_COLOR, kind: "human", session: null,
      });
      expect(presence.find(({ clientId }) => clientId === cursorOnly.clientId)).toMatchObject({
        name: `client ${cursorOnly.clientId}`,
        color: AWARENESS_FALLBACK_COLOR,
        kind: "human",
        session: null,
        block: 1,
      });

      // Withdrawal keeps the awareness state and caret, but removes the name,
      // marker and agent session. It stops being a mention candidate or agent.
      act(() => agent.publish({ cursor: { anchor } }));
      expect(fix.awareness.getStates().has(agent.clientId)).toBe(true);
      expect(peers.map(({ clientId }) => clientId).sort()).toEqual(
        [fallback.clientId, human.clientId].sort(),
      );
      expect(agents).toBe(0);
      expect(readPresence(fix.ydoc, fix.awareness).find(({ clientId }) => clientId === agent.clientId)).toMatchObject({
        name: `client ${agent.clientId}`,
        color: AWARENESS_FALLBACK_COLOR,
        kind: "human",
        session: null,
        block: 1,
      });
    } finally {
      act(() => root.unmount());
    }
  });
});
