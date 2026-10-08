/** The editor reads mention names, while its parent reads caret locations. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import { act, render, type RenderResult } from "./react-render.js";
import type { ReactElement } from "react";
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { appendBlock, getBlocksFragment, initDoc } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { EditorPane } from "../src/ui/EditorPane.js";
import * as hooks from "../src/ui/hooks.js";
import * as composer from "../src/ui/CommentComposer.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const LIVE: RoomStatus = {
  connected: true,
  synced: true,
  hasReceivedServerState: true,
  hasAnswered: true,
  writable: true,
  storeRefused: false,
  unsyncedChanges: 0,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};
const selectThread = (): void => {};

const docs: Y.Doc[] = [];
const awarenesses: Awareness[] = [];
let mounted: RenderResult | null = null;

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

afterEach(() => {
  mounted = null;
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
  for (const ydoc of docs.splice(0)) ydoc.destroy();
  vi.restoreAllMocks();
});

function awarenessFor(ydoc: Y.Doc = new Y.Doc()): Awareness {
  docs.push(ydoc);
  const awareness = new Awareness(ydoc);
  awarenesses.push(awareness);
  return awareness;
}

function fixture(): { connection: RoomConnection; awareness: Awareness } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: UUID, title: "Editor presence" });
  appendBlock(ydoc, { type: "paragraph", text: "First block" });
  appendBlock(ydoc, { type: "paragraph", text: "Second block" });
  const awareness = awarenessFor(ydoc);
  awareness.setLocalState({ user: { name: "Reader", color: "#123456" } });
  const connection = {
    room: `${WORKSPACE}/${UUID}`,
    ydoc,
    provider: { awareness },
    status: LIVE,
    onStatusChange: (listener: (status: RoomStatus) => void) => {
      listener(LIVE);
      return () => {};
    },
  } as unknown as RoomConnection;
  return { connection, awareness };
}

function publish(
  target: Awareness,
  peer: Awareness,
  state: Record<string, unknown> | null,
): void {
  peer.setLocalState(state);
  applyAwarenessUpdate(target, encodeAwarenessUpdate(peer, [peer.clientID]), "test");
}

function cursorAt(connection: RoomConnection, block: number, offset = 0) {
  const node = getBlocksFragment(connection.ydoc).get(block);
  if (!(node instanceof Y.XmlElement) || !(node.firstChild instanceof Y.XmlText)) {
    throw new Error("fixture block has no text");
  }
  const position = Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(node.firstChild, offset),
  );
  return { anchor: position, head: position };
}

function mount(element: ReactElement): HTMLElement {
  mounted = render(element);
  return mounted.container;
}

describe("the bound editor's awareness reading", () => {
  it("does not render BoundEditor for unchanged names, including parent caret updates", () => {
    const { connection, awareness } = fixture();
    const peer = awarenessFor();
    const user = { name: "Peer", color: "#345678" };
    publish(awareness, peer, { user, cursor: cursorAt(connection, 0) });
    // usePeers is called once per BoundEditor render. This spy preserves the
    // real hook, binding and parent subscription, without a production seam.
    const editorRenders = vi.spyOn(hooks, "usePeers");
    const composerRenders = vi.spyOn(composer, "CommentComposer");
    let presence: ReturnType<typeof hooks.usePresence> = [];
    function Shell() {
      presence = hooks.usePresence(connection);
      return <EditorPane connection={connection} segment={WORKSPACE} presence={presence}
        author="Reader" archived={false} docLinks={null} onRestore={null}
        onSelectThread={selectThread} />;
    }
    const host = mount(<Shell />);
    expect(within(host).queryByRole("textbox", { name: "Document content" })).not.toBeNull();
    expect(presence[0]?.block).toBe(1);
    expect(composerRenders.mock.lastCall?.[0].mentions).toEqual(["Peer"]);
    const before = editorRenders.mock.calls.length;
    const originalNames = composerRenders.mock.lastCall?.[0].mentions;

    act(() => publish(awareness, peer, { user, cursor: cursorAt(connection, 0, 1) }));
    expect(editorRenders).toHaveBeenCalledTimes(before);
    // This changes the shell's reading and redraws EditorPane, unlike a caret
    // moving inside one block. The memo boundary must still keep the editor out.
    act(() => publish(awareness, peer, { user, cursor: cursorAt(connection, 1) }));
    expect(presence[0]?.block).toBe(2);
    expect(editorRenders).toHaveBeenCalledTimes(before);
    act(() => publish(awareness, peer, {
      user: { ...user, color: "#765432" }, client: "agent", session: "another-session",
      cursor: cursorAt(connection, 1, 1),
    }));
    expect(editorRenders).toHaveBeenCalledTimes(before);
    expect(composerRenders.mock.lastCall?.[0].mentions).toBe(originalNames);
  });

  it("keeps the composer's mention candidates live through joins, renames and leaves", () => {
    const { connection, awareness } = fixture();
    const peer = awarenessFor();
    const second = awarenessFor();
    publish(awareness, peer, { user: { name: "Peer", color: "#345678" } });
    const composerRenders = vi.spyOn(composer, "CommentComposer");
    mount(<EditorPane connection={connection} segment={WORKSPACE} presence={[]}
      author="Reader" archived={false} docLinks={null} onRestore={null}
      onSelectThread={selectThread} />);
    const names = (): string[] | undefined => composerRenders.mock.lastCall?.[0].mentions;
    expect(names()).toEqual(["Peer"]);
    act(() => publish(awareness, second, { user: { name: "Peer", color: "#765432" } }));
    expect(names()).toEqual(["Peer", "Peer"]);
    act(() => publish(awareness, peer, { user: { name: "Renamed", color: "#345678" } }));
    expect(names()).toEqual(["Renamed", "Peer"]);
    // Withdrawing the user while retaining a caret is also a departure from
    // the mention roster (the MCP's ordinary presence-withdrawal shape).
    act(() => publish(awareness, peer, { cursor: cursorAt(connection, 0) }));
    expect(names()).toEqual(["Peer"]);
    act(() => publish(awareness, second, null));
    expect(names()).toEqual([]);
  });

  it("never returns peers from a replaced connection, even at the same room", () => {
    const first = fixture();
    const replacement = fixture();
    const peer = awarenessFor();
    const nextPeer = awarenessFor();
    publish(first.awareness, peer, { user: { name: "Before", color: "#345678" } });
    publish(replacement.awareness, nextPeer, { user: { name: "After", color: "#765432" } });
    const seen: string[][] = [];
    function Probe({ connection }: { connection: RoomConnection | null }): null {
      seen.push(hooks.usePeers(connection).map(({ name }) => name));
      return null;
    }
    mount(<Probe connection={first.connection} />);
    expect(seen.at(-1)).toEqual(["Before"]);
    const before = seen.length;
    mounted!.rerender(<Probe connection={replacement.connection} />);
    expect(seen[before]).toEqual([]);
    expect(seen.at(-1)).toEqual(["After"]);
    const settled = seen.length;
    act(() => publish(first.awareness, peer, { user: { name: "Old source", color: "#345678" } }));
    expect(seen).toHaveLength(settled);
    mounted!.rerender(<Probe connection={null} />);
    expect(seen.at(-1)).toEqual([]);
  });
});
