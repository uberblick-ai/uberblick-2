import { beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import type { ComponentProps, ReactElement } from "react";
import { fireEvent, within } from "@testing-library/react";
import * as Y from "yjs";
import { addComment, appendBlock, createAnnotation, getAnnotation, getAnnotationsMap, initDoc, setAnnotationResolved } from "@uberblick/schema";
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
  const first = createAnnotation(ydoc, block, 0, 5, "First author", "First question", undefined, { kind: "person", account: "reader-one" });
  const second = count === 2 ? createAnnotation(ydoc, block, 15, 21, "Second author", "Second question", undefined, { account: "reader-one", kind: "agent", agent: "codex" }) : null;
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(ydoc, update));
  const connection = {
    room: "workspace/draft-document", ydoc, status: { writable: true },
  } as unknown as RoomConnection;
  function LiveComments({ pane = {} }: { pane?: Partial<ComponentProps<typeof ThreadsPane>> }): ReactElement {
    const threads = useThreads(connection);
    const [focused, setFocused] = useState<ThreadFocus | null>(null);
    const [hasDrafts, setHasDrafts] = useState(false);
    return <>
      <output aria-label="Reply draft state">{hasDrafts ? "Drafts retained" : "No drafts"}</output>
      <ThreadsPane connection={connection} threads={threads} focused={focused} author="Reader"
        account={{ state: "signed-in", handle: "READER-one" }}
        onDraftsChange={setHasDrafts}
        onFocus={(id) => setFocused((current) => id === null ? null : focusThread(current, id))} {...pane} />
    </>;
  }
  const view = render(<LiveComments />);
  const card = (id: string): HTMLElement => {
    const item = view.container.querySelector<HTMLElement>(`[id="ub-thread-${id}"]`);
    if (item === null) throw new Error(`No card for ${id}`);
    return item;
  };
  return { ...view, ydoc, remote, first, second, card,
    reconfigure: (pane: Partial<ComponentProps<typeof ThreadsPane>>) => view.rerender(<LiveComments pane={pane} />),
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

describe("comment edit drafts", () => {
  function start(item: HTMLElement): HTMLTextAreaElement {
    select(item);
    fireEvent.click(within(item).getByRole("button", { name: "Edit" }));
    return within(item).getByPlaceholderText<HTMLTextAreaElement>("Edit comment…");
  }

  it("keeps separate edits through focus and history visibility changes, then saves in place", async () => {
    const view = mountComments(2);
    try {
      const first = view.card(view.first.id);
      const second = view.card(view.second!.id);
      const input = start(first);
      expect(input.value).toBe("First question");
      fireEvent.input(input, { target: { value: "Revised first question" } });
      fireEvent.input(start(second), { target: { value: "Revised agent question" } });
      select(first);
      expect(within(first).getByPlaceholderText<HTMLTextAreaElement>("Edit comment…").value).toBe("Revised first question");
      view.reconfigure({ hidden: true });
      view.reconfigure({ hidden: false });
      expect(within(first).getByPlaceholderText<HTMLTextAreaElement>("Edit comment…").value).toBe("Revised first question");
      await act(async () => addComment(view.ydoc, view.first.id, "Peer", "Later reply"));
      await act(async () => fireEvent.click(within(first).getByRole("button", { name: "Save" })));
      expect(getAnnotation(view.ydoc, view.first.id)?.comments.map((comment) => comment.text)).toEqual(["Revised first question", "Later reply"]);
      expect(getAnnotation(view.ydoc, view.first.id)?.comments[0]?.editedAt).toBeDefined();
      expect(within(first).queryByPlaceholderText("Edit comment…")).toBeNull();
      select(second);
      expect(within(second).getByPlaceholderText<HTMLTextAreaElement>("Edit comment…").value).toBe("Revised agent question");
      expect(within(view.container).getByLabelText("Reply draft state").textContent).toBe("Drafts retained");
    } finally { view.close(); }
  });

  it.each(["field", "Save", "Cancel"])("rejects empty text and Escape from %s cancels only the edit", (target) => {
    const view = mountComments(1);
    try {
      const item = view.card(view.first.id);
      const input = start(item);
      fireEvent.input(input, { target: { value: "   " } });
      expect(within(item).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(getAnnotation(view.ydoc, view.first.id)?.comments[0]?.text).toBe("First question");
      fireEvent.input(input, { target: { value: "Discard this" } });
      fireEvent.keyDown(target === "field" ? input : within(item).getByRole("button", { name: target }), { key: "Escape" });
      expect(within(item).queryByPlaceholderText("Edit comment…")).toBeNull();
      expect(item.querySelector("[aria-current=true]")).not.toBeNull();
      expect(within(item).getByText("First question")).toBeDefined();
      expect(getAnnotation(view.ydoc, view.first.id)?.comments[0]?.editedAt).toBeUndefined();
      expect(within(view.container).getByLabelText("Reply draft state").textContent).toBe("No drafts");
    } finally { view.close(); }
  });

  it("keeps a refused edit after a remote resolution and resumes it after reopening", async () => {
    const view = mountComments(1);
    try {
      const item = view.card(view.first.id);
      fireEvent.input(start(item), { target: { value: "Recover the resolved edit" } });
      const save = within(item).getByRole<HTMLButtonElement>("button", { name: "Save" });
      await act(async () => {
        setAnnotationResolved(view.remote, view.first.id, true);
        save.click();
      });
      fireEvent.click(within(view.container).getByRole("button", { name: "1 resolved" }));
      const resolved = view.card(view.first.id);
      expect(within(resolved).queryByPlaceholderText("Edit comment…")).toBeNull();
      expect(within(resolved).getByText("This comment was resolved while you wrote — reopen it to edit.")).toBeDefined();
      expect(within(resolved).getByText("Recover the resolved edit")).toBeDefined();
      expect(getAnnotation(view.ydoc, view.first.id)?.comments[0]?.text).toBe("First question");
      await act(async () => setAnnotationResolved(view.remote, view.first.id, false));
      expect(within(view.card(view.first.id)).getByPlaceholderText<HTMLTextAreaElement>("Edit comment…").value).toBe("Recover the resolved edit");
    } finally { view.close(); }
  });

  it.each([false, true])("keeps recoverable text when the edited comment is removed (whole conversation: %s)", async (whole) => {
    const view = mountComments(1);
    try {
      await act(async () => addComment(view.ydoc, view.first.id, "Peer", "Surviving reply"));
      const item = view.card(view.first.id);
      fireEvent.input(start(item), { target: { value: "Recover this removed edit" } });
      const save = within(item).getByRole<HTMLButtonElement>("button", { name: "Save" });
      await act(async () => {
        if (whole) getAnnotationsMap(view.remote).delete(view.first.id);
        else {
          const stored = getAnnotationsMap(view.remote).get(view.first.id) as Y.Map<unknown>;
          const rows = stored.get("comments") as Y.Array<unknown>;
          rows.delete(0, 1);
        }
        save.click();
      });
      const comments = within(view.container).getByRole("region", { name: "Comments" });
      expect(within(comments).getByText("Recover this removed edit")).toBeDefined();
      expect(within(comments).getByText(/This comment no longer exists/)).toBeDefined();
      expect(within(comments).queryByPlaceholderText("Edit comment…")).toBeNull();
      if (!whole) expect(getAnnotation(view.ydoc, view.first.id)?.comments.map((comment) => comment.text)).toEqual(["Surviving reply"]);
      expect(within(view.container).getByLabelText("Reply draft state").textContent).toBe("Drafts retained");
    } finally { view.close(); }
  });
});
