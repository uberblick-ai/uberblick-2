/** Member presentation and document presence have independent lifecycles. */
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
import { EditorPane } from "../src/ui/document/EditorPane.js";
import * as hooks from "../src/ui/hooks.js";
import * as composer from "../src/ui/comments/CommentComposer.js";
import { WorkspaceMembersContext } from "../src/ui/workspace-members.js";

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
    const composerRenders = vi.spyOn(composer, "CommentComposer");
    let presence: ReturnType<typeof hooks.usePresence> = [];
    function Shell() {
      presence = hooks.usePresence(connection);
      return <EditorPane connection={connection} segment={WORKSPACE} presence={presence} syncReading={{}}
        author="Reader" archived={false} docLinks={null} actions={{ onRestore: null }}
        onSelectThread={selectThread} />;
    }
    const host = mount(<Shell />);
    expect(within(host).queryByRole("textbox", { name: "Document content" })).not.toBeNull();
    expect(presence[0]?.block).toBe(1);
    const before = composerRenders.mock.calls.length;

    act(() => publish(awareness, peer, { user, cursor: cursorAt(connection, 0, 1) }));
    expect(composerRenders).toHaveBeenCalledTimes(before);
    // This changes the shell's reading and redraws EditorPane, unlike a caret
    // moving inside one block. The memo boundary must still keep the editor out.
    act(() => publish(awareness, peer, { user, cursor: cursorAt(connection, 1) }));
    expect(presence[0]?.block).toBe(2);
    expect(composerRenders).toHaveBeenCalledTimes(before);
    act(() => publish(awareness, peer, {
      user: { ...user, color: "#765432" }, client: "agent", session: "another-session",
      cursor: cursorAt(connection, 1, 1),
    }));
    expect(composerRenders).toHaveBeenCalledTimes(before);
  });

  it("repaints member mentions independently of presence joins, renames and leaves", () => {
    const { connection, awareness } = fixture();
    const peer = awarenessFor();
    const second = awarenessFor();
    publish(awareness, peer, { user: { name: "Peer", color: "#345678" } });
    act(() => { appendBlock(connection.ydoc, { type: "paragraph", text: "Ask @alice and @Peer" }); });
    function Page({ members }: { members: readonly string[] }) {
      return <WorkspaceMembersContext value={members}>
        <EditorPane connection={connection} segment={WORKSPACE} presence={[]}
          author="Reader" archived={false} docLinks={null} actions={{ onRestore: null }}
          onSelectThread={selectThread} />
      </WorkspaceMembersContext>;
    }
    const host = mount(<Page members={["alice"]} />);
    const names = (): string[] => [...host.querySelectorAll(".ub-person-pill")].map((pill) => pill.textContent ?? "");
    expect(names()).toEqual(["@alice"]);
    act(() => publish(awareness, second, { user: { name: "Peer", color: "#765432" } }));
    expect(names()).toEqual(["@alice"]);
    act(() => publish(awareness, peer, { user: { name: "Renamed", color: "#345678" } }));
    expect(names()).toEqual(["@alice"]);
    act(() => publish(awareness, peer, { cursor: cursorAt(connection, 0) }));
    expect(names()).toEqual(["@alice"]);
    act(() => publish(awareness, second, null));
    expect(names()).toEqual(["@alice"]);
    mounted!.rerender(<Page members={["Peer"]} />);
    expect(names()).toEqual(["@Peer"]);
    mounted!.rerender(<Page members={[]} />);
    expect(names()).toEqual([]);
  });
});
