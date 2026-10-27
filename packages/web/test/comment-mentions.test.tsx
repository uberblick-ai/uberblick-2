import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import * as Y from "yjs";
import { appendBlock, createAnnotation, deleteDirectoryEntry, getAnnotation, initDoc, renderMarkdownLink, setWorkspaceMainRepository, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
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

it("renders current-member pills, formatting and external links while keeping document labels literal", async () => {
  const dir = directory();
  const text = `@alice @unknown **literal** [external](https://example.com) ${renderMarkdownLink("Alice's notes [draft]", TARGET)} [**literal** \`source\`](${OTHER})`;
  const view = render(<WorkspaceMembersContext value={["alice"]}><CommentText text={text} docLinks={dir.context} /></WorkspaceMembersContext>);
  expect(view.container.querySelector(".ub-person-pill")?.textContent).toBe("@alice");
  expect(view.container.textContent).toContain("@unknown literal external");
  expect(view.container.querySelector("strong")?.textContent).toBe("literal");
  expect(screen.getByRole<HTMLAnchorElement>("link", { name: "external" }).href).toBe("https://example.com/");
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

describe("comment inline Markdown", () => {
  it("renders emphasis, strike, inline code and external links", () => {
    const view = render(<CommentText text="**must**, *maybe*, ~~before~~, `ub update`, [spec](https://example.com/spec), https://example.com/a" docLinks={null} />);
    expect(view.container.querySelector("strong")?.textContent).toBe("must");
    expect(view.container.querySelector("em")?.textContent).toBe("maybe");
    expect(view.container.querySelector("s")?.textContent).toBe("before");
    expect(view.container.querySelector("code.ub-inline-code")?.textContent).toBe("ub update");
    const markdown = screen.getByRole<HTMLAnchorElement>("link", { name: "spec" });
    const bare = screen.getByRole<HTMLAnchorElement>("link", { name: "https://example.com/a" });
    expect(markdown.getAttribute("href")).toBe("https://example.com/spec");
    expect(bare.getAttribute("href")).toBe("https://example.com/a");
    for (const link of [markdown, bare]) {
      expect(link.target).toBe("_blank");
      expect(link.relList.contains("noopener")).toBe(true);
      expect(link.relList.contains("noreferrer")).toBe(true);
      expect(link.tabIndex).toBe(0);
    }
  });

  it.each([
    ["https://github.com/uberblick-ai/uberblick-2/issues/2170", "Issue uberblick-ai/uberblick-2#2170"],
    ["[#2170](https://github.com/uberblick-ai/uberblick-2/issues/2170)", "Issue uberblick-ai/uberblick-2#2170"],
    ["[uberblick-2#2170](https://github.com/uberblick-ai/uberblick-2/issues/2170)", "Issue uberblick-ai/uberblick-2#2170"],
    ["[UBERBLICK-AI/uberblick-2#02170](https://github.com/uberblick-ai/uberblick-2/issues/2170)", "Issue uberblick-ai/uberblick-2#2170"],
    ["[https://github.com/uberblick-ai/uberblick-2/issues/2170](https://github.com/uberblick-ai/uberblick-2/issues/2170)", "Issue uberblick-ai/uberblick-2#2170"],
    ["https://github.com/acme/crm-prototype/pull/69", "Pull request acme/crm-prototype#69"],
  ])("renders a document-style pill for %s", (text, label) => {
    render(<CommentText text={text} docLinks={null} mainRepository="uberblick-ai/uberblick-2" />);
    const anchor = screen.getByRole<HTMLAnchorElement>("link", { name: label });
    expect(anchor.title).toBe(label);
    const pill = anchor.querySelector(".ub-github-pill");
    expect(pill).not.toBeNull();
    expect(pill?.querySelector(".ub-github-pill-number")?.textContent).toBe(label.includes("#2170") ? "#2170" : "#69");
    expect(pill?.querySelector(".ub-github-pill-repo")?.textContent ?? null).toBe(label.startsWith("Issue") ? null : "crm-prototype");
    expect(pill?.querySelectorAll("svg")).toHaveLength(1);
    expect(pill?.querySelector("circle") !== null).toBe(label.startsWith("Issue"));
  });

  it.each(["the blocker", "#2171", "other-repo#2170", "someone/uberblick-2#2170"])("keeps nonmatching GitHub link label %s ordinary", (label) => {
    const href = "https://github.com/uberblick-ai/uberblick-2/issues/2170";
    const view = render(<CommentText text={`[${label}](${href})`} docLinks={null} />);
    expect(screen.getByRole<HTMLAnchorElement>("link", { name: label }).getAttribute("href")).toBe(href);
    expect(view.container.querySelector(".ub-github-pill")).toBeNull();
  });

  it.each(["crm-prototype#69", "acme/crm-prototype#69"])("folds matching %s and its parenthesised GitHub address into one pill", (reference) => {
    const view = render(<CommentText text={`See ${reference} (https://github.com/acme/crm-prototype/issues/69).`} docLinks={null} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    const anchor = screen.getByRole("link", { name: "Issue acme/crm-prototype#69" });
    expect(anchor.textContent).toBe("crm-prototype#69");
    expect(view.container.textContent).toBe("See crm-prototype#69.");
  });

  it("keeps a different reference and a parenthesised URL separate, and leaves URL-free shorthand literal", () => {
    const view = render(<CommentText text="See crm-prototype#68 (https://github.com/acme/crm-prototype/issues/69). #69 crm-prototype#69" docLinks={null} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(view.container.textContent).toBe("See crm-prototype#68 (crm-prototype#69). #69 crm-prototype#69");
  });

  it.each([".", ",", "!", "?", ";", ":", ")"])("keeps trailing %s outside a bare URL", (punctuation) => {
    const view = render(<CommentText text={`https://example.com/a${punctuation}`} docLinks={null} />);
    const anchor = screen.getByRole<HTMLAnchorElement>("link", { name: "https://example.com/a" });
    expect(anchor.getAttribute("href")).toBe("https://example.com/a");
    expect(anchor.nextSibling?.textContent).toBe(punctuation);
    expect(view.container.textContent).toBe(`https://example.com/a${punctuation}`);
  });

  it("keeps balanced URL parentheses while leaving an unmatched closing parenthesis outside", () => {
    render(<CommentText text="(https://example.com/a_(b))." docLinks={null} />);
    const anchor = screen.getByRole<HTMLAnchorElement>("link", { name: "https://example.com/a_(b)" });
    expect(anchor.getAttribute("href")).toBe("https://example.com/a_(b)");
    expect(anchor.previousSibling?.textContent).toBe("(");
    expect(anchor.nextSibling?.textContent).toBe(").");
  });

  it("keeps bracketed citations outside the URL and preserves URL punctuation within its path", () => {
    const view = render(<CommentText text="[https://example.com/a] https://example.com/a*b*c https://[::1]/a" docLinks={null} />);
    const anchor = screen.getByRole<HTMLAnchorElement>("link", { name: "https://example.com/a", exact: true });
    expect(anchor.getAttribute("href")).toBe("https://example.com/a");
    expect(anchor.previousSibling?.textContent).toBe("[");
    expect(anchor.nextSibling?.textContent).toBe("] ");
    expect(screen.getByRole<HTMLAnchorElement>("link", { name: "https://example.com/a*b*c" }).getAttribute("href")).toBe("https://example.com/a*b*c");
    expect(screen.getByRole<HTMLAnchorElement>("link", { name: "https://[::1]/a" }).getAttribute("href")).toBe("https://[::1]/a");
    expect(view.container.querySelector("em")).toBeNull();
  });

  it.each([
    "[x](javascript:alert(1))", "[https://example.com/a](javascript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)", "[x](mailto:person@example.com)",
    "[x](/relative)",
  ])("keeps unsupported link %s literal without autolinking its label", (text) => {
    const view = render(<CommentText text={text} docLinks={null} />);
    expect(view.container.textContent).toBe(text);
    expect(screen.queryByRole("link")).toBeNull();
    expect(view.container.querySelector("script")).toBeNull();
  });

  it("keeps block markers, HTML and line breaks as authored text", () => {
    const text = "# Heading\n- List item\n1. Numbered item\n> Quote\n<img src=x onerror=alert(1)>\n\nLast line";
    const view = render(<CommentText text={text} docLinks={null} />);
    expect(view.container.textContent).toBe(text);
    expect(view.container.querySelector("h1, ul, ol, li, blockquote, img, br")).toBeNull();
  });

  it("honours inline escapes and keeps URLs, document links and mentions literal inside code", () => {
    const dir = directory();
    const code = `https://example.com @alice ${renderMarkdownLink("Target", TARGET)}`;
    const view = render(<WorkspaceMembersContext value={["alice"]}><CommentText text={`\\*maybe\\* \\*\\*must\\*\\* \\~\\~kept\\~\\~ \`${code}\``} docLinks={dir.context} /></WorkspaceMembersContext>);
    expect(view.container.textContent).toBe(`*maybe* **must** ~~kept~~ ${code}`);
    expect(view.container.querySelector("code")?.textContent).toBe(code);
    expect(view.container.querySelector("strong, em, s, .ub-person-pill")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("preserves line breaks within formatting and keeps multiline code literal", () => {
    const code = "https://example.com\n@alice";
    const view = render(<WorkspaceMembersContext value={["alice"]}><CommentText
      text={`**bold\ncontinued** \`${code}\`\ncrm-prototype#69\n(https://github.com/acme/crm-prototype/issues/69)`}
      docLinks={null} /></WorkspaceMembersContext>);
    expect(view.container.querySelector("strong")?.textContent).toBe("bold\ncontinued");
    expect(view.container.querySelector("code")?.textContent).toBe(code);
    expect(view.container.querySelector(".ub-person-pill")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(view.container.textContent).toContain("crm-prototype#69\n(crm-prototype#69)");
  });

  it("retains mentions and live document availability inside bold and italic text", async () => {
    const dir = directory();
    const view = render(<WorkspaceMembersContext value={["alice"]}><CommentText
      text={`**@alice ${renderMarkdownLink("Bold document", TARGET)}** and *@alice ${renderMarkdownLink("Italic document", OTHER)}*`}
      docLinks={dir.context} /></WorkspaceMembersContext>);
    expect(view.container.querySelectorAll("strong .ub-person-pill, em .ub-person-pill")).toHaveLength(2);
    const bold = screen.getByRole<HTMLAnchorElement>("link", { name: "Bold document" });
    const italic = screen.getByRole<HTMLAnchorElement>("link", { name: "Italic document" });
    expect(bold.querySelector("strong")?.textContent).toBe("Bold document");
    expect(italic.querySelector("em")?.textContent).toBe("Italic document");
    await act(async () => { tombstoneDirectoryEntry(dir.ydoc, TARGET); });
    expect(bold.getAttribute("data-doc-link-state")).toBe("archived");
    expect(bold.title).toContain("archived");
    await act(async () => { bold.click(); });
    expect(dir.opened).toEqual([TARGET]);
    expect(bold.target).toBe("");
    await act(async () => { deleteDirectoryEntry(dir.ydoc, TARGET); });
    expect(bold.getAttribute("data-doc-link-state")).toBe("deleted");
    expect(bold.getAttribute("aria-disabled")).toBe("true");
    expect(bold.hasAttribute("href")).toBe(false);
    expect(bold.tabIndex).toBe(-1);
    await act(async () => { bold.click(); });
    expect(dir.opened).toEqual([TARGET]);
  });
});

it.each([false, true])("repaints comment repository labels from catalog settings without changing stored text (narrow %s)", async (narrow) => {
  const ydoc = new Y.Doc();
  const catalog = new Y.Doc();
  const peer = new Y.Doc();
  initDoc(ydoc, { uuid: DOC, title: "Comments" });
  const block = appendBlock(ydoc, { type: "paragraph", text: "Prose" });
  const text = "**must** https://github.com/acme/crm-prototype/issues/69";
  const thread = createAnnotation(ydoc, block, 0, 5, "Author", text);
  const connection = { room: `workspace/${DOC}`, ydoc, status: { writable: true } } as unknown as RoomConnection;
  const catalogConnection = { room: "workspace/_settings", ydoc: catalog } as unknown as RoomConnection;
  const view = render(<ThreadsPane connection={connection} catalogConnection={catalogConnection} focused={null} author="Reader"
    threads={threadsFromDoc(ydoc)} onFocus={() => {}} narrow={narrow} open readOnly />);
  const card = screen.getByRole("group", { name: "Comment" });
  const anchor = within(card).getByRole("link", { name: "Issue acme/crm-prototype#69" });
  expect(card.querySelector("strong")?.textContent).toBe("must");
  expect(anchor.querySelector(".ub-github-pill-repo")?.textContent).toBe("crm-prototype");
  await act(async () => { setWorkspaceMainRepository(catalog, "ACME/crm-prototype"); });
  expect(anchor.querySelector(".ub-github-pill-repo")).toBeNull();
  expect(anchor.getAttribute("aria-label")).toBe("Issue acme/crm-prototype#69");
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(catalog));
  setWorkspaceMainRepository(peer, "other/repository");
  await act(async () => { Y.applyUpdate(catalog, Y.encodeStateAsUpdate(peer)); });
  expect(anchor.querySelector(".ub-github-pill-repo")?.textContent).toBe("crm-prototype");
  expect(getAnnotation(ydoc, thread.id)?.comments[0]?.text).toBe(text);
  view.unmount();
  ydoc.destroy(); catalog.destroy(); peer.destroy();
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
