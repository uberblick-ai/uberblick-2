import { beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import type { ReactElement } from "react";
import { fireEvent, within } from "@testing-library/react";
import * as Y from "yjs";
import { appendBlock, createAnnotation, getAnnotation, getAnnotationsMap, initDoc } from "@uberblick/schema";
import { act, render } from "./react-render.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import { ThreadsPane } from "../src/ui/comments/ThreadsPane.js";
import { focusThread } from "../src/ui/comments/threads.js";
import type { ThreadFocus } from "../src/ui/comments/threads.js";
import { useThreads } from "../src/ui/hooks.js";

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

function mountComments(count: number) {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "draft-document", title: "Reply drafts" });
  const block = appendBlock(ydoc, { type: "paragraph", text: "First comment. Second comment." });
  const first = createAnnotation(ydoc, block, 0, 5, "First author", "First question");
  const second = count === 2 ? createAnnotation(ydoc, block, 15, 21, "Second author", "Second question") : null;
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(ydoc, update));
  const connection = {
    room: "workspace/draft-document", ydoc, status: { writable: true },
  } as unknown as RoomConnection;
  function LiveComments(): ReactElement {
    const threads = useThreads(connection);
    const [focused, setFocused] = useState<ThreadFocus | null>(null);
    const [hasDrafts, setHasDrafts] = useState(false);
    return <>
      <output aria-label="Reply draft state">{hasDrafts ? "Drafts retained" : "No drafts"}</output>
      <ThreadsPane connection={connection} threads={threads} focused={focused} author="Reader"
        onDraftsChange={setHasDrafts}
        onFocus={(id) => setFocused((current) => id === null ? null : focusThread(current, id))} />
    </>;
  }
  const view = render(<LiveComments />);
  const card = (id: string): HTMLElement => {
    const item = view.container.querySelector<HTMLElement>(`[id="ub-thread-${id}"]`);
    if (item === null) throw new Error(`No card for ${id}`);
    return item;
  };
  return { ...view, ydoc, remote, first, second, card,
    close: () => { view.unmount(); ydoc.destroy(); remote.destroy(); },
  };
}

function select(card: HTMLElement): void {
  act(() => within(card).getByRole<HTMLButtonElement>("button", { name: "Comment" }).click());
}

function field(card: HTMLElement): HTMLTextAreaElement {
  return within(card).getByPlaceholderText<HTMLTextAreaElement>("Reply…");
}

describe("reply draft ownership", () => {
  it("keeps independent drafts with their comments through selection changes and Escape", () => {
    const view = mountComments(2);
    try {
      const first = view.card(view.first.id);
      const second = view.card(view.second!.id);
      select(first);
      fireEvent.input(field(first), { target: { value: "Unsent first reply" } });
      select(second);
      fireEvent.input(field(second), { target: { value: "Unsent second reply" } });
      expect(within(first).getByRole("button", { name: "Comment" }).getAttribute("aria-expanded")).toBe("false");
      expect(within(second).getByRole("button", { name: "Comment" }).getAttribute("aria-expanded")).toBe("true");
      select(first);
      expect(field(first).value).toBe("Unsent first reply");
      expect(field(second).value).toBe("Unsent second reply");
      fireEvent.keyDown(field(first), { key: "Escape" });
      expect(view.container.querySelector("[aria-current=true]")).toBeNull();
      select(second);
      fireEvent.keyDown(within(second).getByRole("button", { name: "Comment" }), { key: "Escape" });
      expect(view.container.querySelector("[aria-current=true]")).toBeNull();
      expect(field(first).value).toBe("Unsent first reply");
      expect(field(second).value).toBe("Unsent second reply");
      expect(getAnnotation(view.ydoc, view.first.id)?.comments).toHaveLength(1);
      expect(getAnnotation(view.ydoc, view.second!.id)?.comments).toHaveLength(1);
      expect(within(view.container).getByLabelText("Reply draft state").textContent).toBe("Drafts retained");
    } finally { view.close(); }
  });

  it("keeps a refused reply readable and keeps its draft signal after the last comment is deleted remotely", async () => {
    const view = mountComments(1);
    try {
      const item = view.card(view.first.id);
      select(item);
      fireEvent.input(field(item), { target: { value: "Recover this exact unsent reply" } });
      const submit = within(item).getByRole<HTMLButtonElement>("button", { name: "Reply" });
      await act(async () => {
        // The remote delete arrives before the coalesced thread observer can
        // remove the form, so the submit handler must re-read the annotation.
        getAnnotationsMap(view.remote).delete(view.first.id);
        submit.click();
      });
      expect(getAnnotation(view.ydoc, view.first.id)).toBeNull();
      expect(within(view.container).queryByRole("group", { name: "Comment" })).toBeNull();
      const comments = within(view.container).getByRole("region", { name: "Comments" });
      expect(within(comments).getByText("This comment no longer exists. Your unsent reply is kept here.")).toBeDefined();
      expect(within(comments).getByText("Recover this exact unsent reply")).toBeDefined();
      expect(within(comments).queryByPlaceholderText("Reply…")).toBeNull();
      expect(within(view.container).getByLabelText("Reply draft state").textContent).toBe("Drafts retained");
    } finally { view.close(); }
  });
});
