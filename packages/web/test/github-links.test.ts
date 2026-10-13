import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, createAnnotation, exportMarkdown, getBlockInline,
  getBlocksFragment, importMarkdown, initDoc,
  setWorkspaceMainRepository, WORKSPACE_SETTINGS_KEY,
} from "@uberblick/schema";
import { mountEditor } from "./helpers.js";

const HREF = "http://github.com/Owner/Repo/pull/0012/files#diff-abc";

it.each([true, false])("repaints local and remote main-repository changes without document writes (editable %s)", async (editable) => {
  const { ydoc } = fixture("Owner/Repo#12");
  const settings = new Y.Doc();
  const peer = new Y.Doc();
  const { editor, element } = mountEditor(ydoc, { workspaceSettings: settings });
  try {
    editor.setEditable(editable);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = Y.encodeStateAsUpdate(ydoc);
    const markdown = exportMarkdown(ydoc);
    let writes = 0;
    ydoc.on("update", () => { writes += 1; });
    const repo = (): string | undefined => element.querySelector(".ub-github-pill-repo")?.textContent ?? undefined;
    const expectFullReference = (): void => {
      const anchor = element.querySelector("a.ub-link");
      expect(anchor?.getAttribute("aria-label")).toBe("Pull request Owner/Repo#0012");
      expect(anchor?.getAttribute("title")).toBe("Pull request Owner/Repo#0012");
      expect(anchor?.querySelector(".ub-github-pill-number")?.textContent).toBe("#0012");
      expect(anchor?.querySelectorAll("svg")).toHaveLength(1);
    };
    expect(repo()).toBe("Repo");
    setWorkspaceMainRepository(settings, "OWNER/repo");
    expect(repo()).toBeUndefined();
    expectFullReference();
    setWorkspaceMainRepository(settings, "Other/Repo");
    expect(repo()).toBe("Repo");
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(settings));
    setWorkspaceMainRepository(peer, "owner/REPO");
    Y.applyUpdate(settings, Y.encodeStateAsUpdate(peer));
    expect(repo()).toBeUndefined();
    expectFullReference();
    setWorkspaceMainRepository(peer, "");
    Y.applyUpdate(settings, Y.encodeStateAsUpdate(peer));
    expect(repo()).toBe("Repo");
    settings.getMap(WORKSPACE_SETTINGS_KEY).set("mainRepository", { invalid: "Owner/Repo" });
    expect(repo()).toBe("Repo");
    expectFullReference();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toBe(0);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    expect(exportMarkdown(ydoc)).toBe(markdown);
    editor.destroy();
    expect(() => setWorkspaceMainRepository(settings, "Owner/Repo")).not.toThrow();
  } finally {
    if (!editor.isDestroyed) editor.destroy();
    ydoc.destroy(); settings.destroy(); peer.destroy();
  }
});

function fixture(text: string, href = HREF) {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "22222222-3333-4444-5555-666666666666", title: "Pills" });
  const blockId = appendBlock(ydoc, {
    type: "paragraph", inline: [
      { text: "before ", marks: {} },
      { text, marks: { link: href } },
      { text: " after", marks: {} },
    ],
  });
  return { ydoc, blockId };
}

it.each(["#12", "repo#12", "OWNER/REPO#0012", HREF])(
  "renders matching reference %s without writing presentation to the document", async (text) => {
    const { ydoc, blockId } = fixture(text);
    const before = getBlockInline(ydoc, blockId);
    const markdown = exportMarkdown(ydoc);
    const { editor, element } = mountEditor(ydoc);
    try {
      const anchor = element.querySelector("a.ub-link");
      expect(anchor?.getAttribute("aria-label")).toBe("Pull request Owner/Repo#0012");
      expect(anchor?.querySelector(".ub-github-pill-repo")?.textContent).toBe("Repo");
      expect(anchor?.querySelector(".ub-github-pill-number")?.textContent).toBe("#0012");
      editor.view.focus();
      editor.commands.setTextSelection(9);
      expect(element.querySelector(".ub-github-pill")).toBeNull();
      expect(anchor?.hasAttribute("aria-label")).toBe(false);
      editor.commands.setTextSelection(8);
      expect(element.querySelector(".ub-github-pill")).not.toBeNull();
      editor.commands.setTextSelection(8 + text.length);
      expect(element.querySelector(".ub-github-pill")).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getBlockInline(ydoc, blockId)).toEqual(before);
      expect(exportMarkdown(ydoc)).toBe(markdown);
      const imported = importMarkdown(markdown);
      expect(imported.blocks[0]?.text).toBe(`before ${text} after`);
      expect(imported.blocks[0]?.inline).toEqual(before);
    } finally { editor.destroy(); ydoc.destroy(); }
  },
);

it.each([
  ["the blocker", HREF], ["#13", HREF], ["Elsewhere#12", HREF],
  ["Other/Repo#12", HREF], ["#12", "https://github.com/Owner/Repo"],
  ["#12", "https://github.com/Owner/Repo/commit/12"],
  ["#12", "https://github.com/Owner/Repo/discussions/12"],
  ["#12", "https://github.example/Owner/Repo/issues/12"],
])("leaves %s linked to %s ordinary", (text, href) => {
  const { ydoc } = fixture(text, href);
  const { editor, element } = mountEditor(ydoc);
  try {
    expect(element.querySelector(".ub-github-pill")).toBeNull();
    expect(element.querySelector("a.ub-link")?.textContent).toBe(text);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("keeps partial comment highlights on the pill and repaints remote text and address edits", async () => {
  const { ydoc, blockId } = fixture("Owner/Repo#12");
  const thread = createAnnotation(ydoc, blockId, 10, 14, "tester", "Check the evidence");
  const before = getBlockInline(ydoc, blockId);
  const { editor, element } = mountEditor(ydoc);
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
  try {
    editor.setEditable(false);
    expect(element.querySelector(".ub-github-pill")?.closest("[data-comment-thread]")?.getAttribute("data-comment-thread")).toBe(thread.id);
    expect(element.querySelector(".ub-github-pill")?.closest("a.ub-link")?.getAttribute("aria-label")).toBe("Pull request Owner/Repo#0012");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getBlockInline(ydoc, blockId)).toEqual(before);

    const text = (getBlocksFragment(remote).get(0) as Y.XmlElement).firstChild as Y.XmlText;
    text.format(7, 13, { link: { href: "https://github.com/owner/repo/issues/12" } });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote));
    expect(element.querySelector(".ub-github-pill")?.closest("a.ub-link")?.getAttribute("aria-label"), element.innerHTML).toBe("Issue owner/repo#12");
    text.insert(20, "3", { link: { href: "https://github.com/owner/repo/issues/12" } });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote));
    expect(element.querySelector(".ub-github-pill")).toBeNull();
    text.delete(20, 1);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote));
    expect(element.querySelector(".ub-github-pill")).not.toBeNull();
  } finally { editor.destroy(); ydoc.destroy(); remote.destroy(); }
});
