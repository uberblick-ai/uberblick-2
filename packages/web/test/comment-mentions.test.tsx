import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import * as Y from "yjs";
import { appendBlock, createAnnotation, deleteDirectoryEntry, getAnnotation, initDoc, renderMarkdownLink, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import { act, render } from "./react-render.js";
import { createDocLinkContext } from "../src/editor/doc-links.js";
import type { DocLinkContext } from "../src/editor/doc-links.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import { CommentForm } from "../src/ui/comments/CommentForm.js";
import { CommentText } from "../src/ui/comments/CommentText.js";
import { ThreadsPane } from "../src/ui/comments/ThreadsPane.js";
import { threadsFromDoc } from "../src/ui/comments/threads.js";
import { WorkspaceMembersContext } from "../src/ui/workspace-members.js";

const DOC = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const TARGET = "0189abcd-2222-4333-8444-555566667777";
const OTHER = "3f7d1e88-1111-4222-9333-444455556666";

function directory(): { ydoc: Y.Doc; context: DocLinkContext; opened: string[] } {
  const ydoc = new Y.Doc();
  upsertDirectoryEntry(ydoc, { uuid: DOC, title: "Alice in the open document" });
  upsertDirectoryEntry(ydoc, { uuid: TARGET, title: "Alice's notes [draft]" });
  upsertDirectoryEntry(ydoc, { uuid: OTHER, title: "Other document" });
  const opened: string[] = [];
  return { ydoc, opened, context: createDocLinkContext({ directory: ydoc,
    href: (uuid) => `/workspace/${uuid}`, open: (uuid) => opened.push(uuid) }) };
}

async function input(field: HTMLTextAreaElement, value: string, data: string | null = null, inputType = "insertText"): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, value);
    field.setSelectionRange(value.length, value.length);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data, inputType }));
  });
}

async function press(field: HTMLTextAreaElement, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => { field.dispatchEvent(event); });
  return event;
}

function mountForm(context: DocLinkContext | null, members: readonly string[] = ["Zed", "alice", "Bob"]) {
  const submit = vi.fn(() => true);
  const cancel = vi.fn();
  const view = render(<WorkspaceMembersContext value={members}>
    <CommentForm placeholder="Write comment" submitLabel="Comment" docLinks={context} openDocId={DOC} onSubmit={submit} onCancel={cancel} />
  </WorkspaceMembersContext>);
  return { ...view, field: screen.getByPlaceholderText<HTMLTextAreaElement>("Write comment"), submit, cancel };
}

describe("comment and reply mention fields", () => {
  it("offers current members first, then documents, and picks without submitting", async () => {
    const dir = directory();
    const form = mountForm(dir.context);
    await input(form.field, "@", "@");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "@alice", "@Bob", "@Zed", "Alice's notes [draft]", "Other document",
    ]);
    await input(form.field, "@ali", "li");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["@alice", "Alice's notes [draft]"]);
    expect((await press(form.field, "Enter")).defaultPrevented).toBe(true);
    expect(form.field.value).toBe("@alice ");
    expect(form.submit).not.toHaveBeenCalled();
    await input(form.field, "@alice @", "@");
    await input(form.field, "@alice @ali", "ali");
    await press(form.field, "ArrowDown");
    await press(form.field, "Tab");
    expect(form.field.value).toBe(`@alice ${renderMarkdownLink("Alice's notes [draft]", TARGET)} `);
    expect(form.submit).not.toHaveBeenCalled();
    await press(form.field, "Enter");
    expect(form.submit).toHaveBeenCalledWith(`@alice ${renderMarkdownLink("Alice's notes [draft]", TARGET)}`);
  });

  it("Escape keeps the draft, suppresses reopening and never cancels an active list", async () => {
    const form = mountForm(directory().context);
    await input(form.field, "Text @", "@");
    await input(form.field, "Text @ali", "ali");
    await press(form.field, "Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(form.field.value).toBe("Text @ali");
    expect(form.cancel).not.toHaveBeenCalled();
    await input(form.field, "Text @", null, "deleteContentBackward");
    expect(screen.queryByRole("listbox")).toBeNull();
    await input(form.field, "Text @alice", "alice");
    expect(screen.queryByRole("listbox")).toBeNull();
    await press(form.field, "Escape");
    expect(form.cancel).toHaveBeenCalledOnce();
  });

  it("opens only for a typed boundary @ and withholds post/cancel even with no matches", async () => {
    const form = mountForm(null, []);
    await input(form.field, "mail@", "@");
    expect(screen.queryByRole("dialog")).toBeNull();
    await input(form.field, "@alice", null, "insertFromPaste");
    expect(screen.queryByRole("dialog")).toBeNull();
    await input(form.field, "@", null, "deleteContentBackward");
    expect(screen.queryByRole("dialog")).toBeNull();
    await input(form.field, "\n@", "@");
    expect(screen.getByText("No person or document matches.")).toBeDefined();
    await press(form.field, "Enter");
    await press(form.field, "Tab");
    expect(form.submit).not.toHaveBeenCalled();
    await press(form.field, "Escape");
    expect(form.cancel).not.toHaveBeenCalled();
  });

  it("falls back to documents, refreshes an open directory and inserts a clicked title", async () => {
    const dir = directory();
    const form = mountForm(dir.context, []);
    await input(form.field, "@", "@");
    expect(screen.queryByRole("option", { name: "@alice" })).toBeNull();
    await act(async () => { tombstoneDirectoryEntry(dir.ydoc, OTHER); });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await act(async () => { screen.getByRole<HTMLButtonElement>("option", { name: "Alice's notes [draft]" }).click(); });
    expect(form.field.value).toBe(`${renderMarkdownLink("Alice's notes [draft]", TARGET)} `);
  });

  it("passes the same candidates into a reply and stores the picked plain text", async () => {
    const dir = directory();
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: DOC, title: "Comments" });
    const block = appendBlock(ydoc, { type: "paragraph", text: "Prose" });
    const thread = createAnnotation(ydoc, block, 0, 5, "Author", "Question");
    const connection = { room: `workspace/${DOC}`, ydoc, status: { writable: true } } as unknown as RoomConnection;
    render(<WorkspaceMembersContext value={["alice"]}><ThreadsPane connection={connection} focused={null}
      author="Reply author" threads={threadsFromDoc(ydoc)} onFocus={() => {}} docLinks={dir.context} openDocId={DOC} /></WorkspaceMembersContext>);
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>("Reply…");
    await input(field, "@", "@");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["@alice", "Alice's notes [draft]", "Other document"]);
    await press(field, "Tab");
    expect(getAnnotation(ydoc, thread.id)?.comments).toHaveLength(1);
    await press(field, "Enter");
    expect(getAnnotation(ydoc, thread.id)?.comments[1]?.text).toBe("@alice");
  });
});

it("renders current-member pills and reachable document links while other Markdown remains literal", async () => {
  const dir = directory();
  const text = `@alice @unknown **literal** [external](https://example.com) ${renderMarkdownLink("Alice's notes [draft]", TARGET)} [**literal** \`source\`](${OTHER})`;
  const view = render(<WorkspaceMembersContext value={["alice"]}><CommentText text={text} docLinks={dir.context} /></WorkspaceMembersContext>);
  expect(view.container.querySelector(".ub-person-pill")?.textContent).toBe("@alice");
  expect(view.container.textContent).toContain("@unknown **literal** [external](https://example.com)");
  expect(screen.getByRole("link", { name: "**literal** `source`" })).toBeDefined();
  const link = screen.getByRole<HTMLAnchorElement>("link", { name: "Alice's notes [draft]" });
  expect(link.href).toContain(TARGET);
  await act(async () => { link.click(); });
  expect(dir.opened).toEqual([TARGET]);
  await act(async () => { deleteDirectoryEntry(dir.ydoc, TARGET); });
  expect(screen.queryByRole("link", { name: "Alice's notes [draft]" })).toBeNull();
  expect(link.getAttribute("aria-disabled")).toBe("true");
  view.rerender(<WorkspaceMembersContext value={[]}><CommentText text={text} docLinks={dir.context} /></WorkspaceMembersContext>);
  expect(view.container.querySelector(".ub-person-pill")).toBeNull();
});

it("keeps card links independently reachable without selecting their card", () => {
  const dir = directory();
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC, title: "Comments" });
  const block = appendBlock(ydoc, { type: "paragraph", text: "Prose" });
  createAnnotation(ydoc, block, 0, 5, "Author", `@alice ${renderMarkdownLink("Target", TARGET)}`);
  const connection = { room: `workspace/${DOC}`, ydoc, status: { writable: true } } as unknown as RoomConnection;
  const focus = vi.fn();
  const view = render(<WorkspaceMembersContext value={["alice"]}><ThreadsPane connection={connection} focused={null} author="Reader"
    threads={threadsFromDoc(ydoc)} onFocus={focus} docLinks={dir.context} openDocId={DOC} /></WorkspaceMembersContext>);
  const card = within(view.container).getByRole("group", { name: "Comment" });
  const link = within(card).getByRole<HTMLAnchorElement>("link", { name: "Target" });
  expect(link.closest("button")).toBeNull();
  expect(link.tabIndex).toBe(0);
  act(() => { link.click(); });
  expect(dir.opened).toEqual([TARGET]);
  expect(focus).not.toHaveBeenCalled();
  const select = within(card).getByRole<HTMLButtonElement>("button", { name: "Comment" });
  expect(select.tabIndex).toBe(0);
  act(() => { select.click(); });
  expect(focus).toHaveBeenCalledOnce();
});
