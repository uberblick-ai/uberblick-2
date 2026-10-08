/**
 * URL safety at the click boundary. Real activation and pointer selection live
 * in e2e/external-link.spec.ts; jsdom can prove which hrefs reach window.open
 * and which browser defaults the comment delegation must refuse.
 */

import { act, renderSettled } from "./react-render.js";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlocksFragment, initDoc } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { EditorPane } from "../src/ui/EditorPane.js";
import { mountEditor, snapshotFragment } from "./helpers.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const DOC = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const HREF = "https://example.invalid/target";
const REFUSED = [
  "javascript:alert(1)",
  "data:text/html,hello",
  "mailto:someone@example.invalid",
  "ftp://example.invalid/target",
  "//example.invalid/target",
  "/target",
  "#target",
  "",
];

function linkedDoc(): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC, title: "External links" });
  appendBlock(ydoc, {
    type: "paragraph",
    inline: [{ text: "target", marks: { link: HREF } }],
  });
  return ydoc;
}

describe("external link URL safety", () => {
  it("opens only http(s) hrefs through the editor and writes nothing", async () => {
    const ydoc = linkedDoc();
    const { editor, element } = mountEditor(ydoc);
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const updates = vi.fn();
    ydoc.on("update", updates);
    try {
      const anchor = element.querySelector<HTMLAnchorElement>("a.ub-link");
      expect(anchor).not.toBeNull();
      const before = snapshotFragment(ydoc);
      const allowed = ["http://example.invalid/target", HREF];
      for (const href of [...allowed, ...REFUSED]) {
        anchor?.setAttribute("href", href);
        const event = new MouseEvent("click", { button: 0 });
        Object.defineProperty(event, "target", { value: anchor });
        // The seam ProseMirror offers only after a stationary click. The
        // browser test owns how an actual pointer gesture reaches this seam.
        const handled = editor.view.someProp("handleClick", (handler) =>
          handler(editor.view, 1, event),
        );
        expect(Boolean(handled), href).toBe(allowed.includes(href));
      }
      // Restore the test's DOM substitutions before the observer sees them;
      // opening a link is the action whose writes this assertion measures.
      anchor?.setAttribute("href", HREF);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(opened.mock.calls).toEqual(
        allowed.map((href) => [href, "_blank", "noopener,noreferrer"]),
      );
      expect(updates).not.toHaveBeenCalled();
      expect(snapshotFragment(ydoc)).toEqual(before);
    } finally {
      opened.mockRestore();
      editor.destroy();
      ydoc.destroy();
    }
  });

  it("refuses unsafe anchor clicks and Enter before a surrounding thread, in either pane", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      for (const archived of [false, true]) {
        const ydoc = linkedDoc();
        const block = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
        (block.firstChild as Y.XmlText).format(0, 6, {
          comment: { threadId: "t-1" },
        });
        const selected = vi.fn();
        const view = await renderSettled(
          <EditorPane
            connection={connectionFor(ydoc)}
            segment={WORKSPACE}
            presence={[]}
            author="tester"
            archived={archived}
            docLinks={null}
            onRestore={() => {}}
            onSelectThread={selected}
          />,
        );
        const host = view.container;
        try {
          const anchor = host.querySelector<HTMLAnchorElement>("a.ub-link");
          expect(anchor?.closest("[data-comment-thread]")).not.toBeNull();
          for (const href of REFUSED) {
            // Stored links reject these targets already. Inject one in the
            // rendered DOM to exercise the final navigation guard itself.
            anchor?.setAttribute("href", href);
            const click = new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
            });
            const enter = new KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
              cancelable: true,
            });
            act(() => {
              anchor?.dispatchEvent(click);
              anchor?.dispatchEvent(enter);
            });
            expect(click.defaultPrevented, href).toBe(true);
            expect(enter.defaultPrevented, href).toBe(true);
          }
          expect(opened).not.toHaveBeenCalled();
          expect(selected).not.toHaveBeenCalled();
        } finally {
          view.unmount();
          ydoc.destroy();
        }
      }
    } finally {
      opened.mockRestore();
    }
  });
});

function connectionFor(ydoc: Y.Doc): RoomConnection {
  const status: RoomStatus = {
    connected: true,
    synced: true,
    hasReceivedServerState: true,
    writable: true,
    storeRefused: false,
    unsyncedChanges: 0,
    hasAnswered: true,
    protocolMismatch: null,
    authFailed: false,
    tokenMissing: false,
  };
  return {
    room: `${WORKSPACE}/${DOC}`,
    ydoc,
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(status);
      return () => {};
    },
  } as unknown as RoomConnection;
}
