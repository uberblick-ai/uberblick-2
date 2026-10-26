import { expect, it } from "vitest";
import { within } from "@testing-library/dom";
import * as Y from "yjs";
import { appendBlock, createAnnotation, exportMarkdown, getBlockInline, initDoc } from "@uberblick/schema";
import type { InlineRun } from "@uberblick/schema";
import { setEditorMembers } from "../src/editor/person-mentions.js";
import { mountEditor } from "./helpers.js";

function fixture(inline: string | InlineRun[]) {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "22222222-3333-4444-5555-666666666666", title: "People" });
  const id = appendBlock(ydoc, typeof inline === "string"
    ? { type: "paragraph", text: inline }
    : { type: "paragraph", inline });
  return { ydoc, id };
}

it("renders current member text without changing content, export or history when membership changes", async () => {
  const { ydoc, id } = fixture("Thanks @alice and @unknown");
  const { editor, element } = mountEditor(ydoc);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const inline = getBlockInline(ydoc, id);
    const markdown = exportMarkdown(ydoc);
    let writes = 0;
    ydoc.on("update", () => { writes += 1; });
    expect(element.querySelector(".ub-person-pill")).toBeNull();
    setEditorMembers(editor, ["alice"]);
    expect(element.querySelector(".ub-person-pill")?.textContent).toBe("@alice");
    expect(element.querySelectorAll(".ub-person-pill")).toHaveLength(1);
    expect(exportMarkdown(ydoc)).toBe(markdown);
    expect(markdown).toContain("Thanks @alice and @unknown");
    expect(getBlockInline(ydoc, id)).toEqual(inline);
    setEditorMembers(editor, []);
    expect(element.querySelector(".ub-person-pill")).toBeNull();
    expect(getBlockInline(ydoc, id)).toEqual(inline);
    expect(writes).toBe(0);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it.each([true, false])("reveals stored text only while editing inside a mention (editable %s)", (editable) => {
  const { ydoc } = fixture("before @alice after");
  const { editor, element } = mountEditor(ydoc);
  try {
    editor.setEditable(editable);
    setEditorMembers(editor, ["alice"]);
    editor.view.focus();
    editor.commands.setTextSelection(10);
    expect(element.querySelectorAll(".ub-person-pill")).toHaveLength(editable ? 0 : 1);
    editor.commands.setTextSelection(8);
    expect(element.querySelectorAll(".ub-person-pill")).toHaveLength(1);
    editor.commands.setTextSelection(14);
    expect(element.querySelectorAll(".ub-person-pill")).toHaveLength(1);
    editor.commands.setTextSelection(10);
    editor.view.dom.blur();
    expect(element.querySelectorAll(".ub-person-pill")).toHaveLength(1);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("keeps comments and formatting on mentions split over text runs, while leaving code literal", () => {
  const { ydoc, id } = fixture([
    { text: "@al", marks: { bold: true } },
    { text: "ice ", marks: {} },
    { text: "@alice", marks: { inlineCode: true } },
  ]);
  const thread = createAnnotation(ydoc, id, 2, 4, "Reader", "Check this mention");
  appendBlock(ydoc, { type: "code", text: "@alice" });
  const before = getBlockInline(ydoc, id);
  const { editor, element } = mountEditor(ydoc);
  try {
    setEditorMembers(editor, ["alice"]);
    expect(element.querySelectorAll(".ub-person-pill")).toHaveLength(1);
    const pill = element.querySelector(".ub-person-pill");
    expect(pill?.closest("strong")).not.toBeNull();
    expect(pill?.closest("[data-comment-thread]")?.getAttribute("data-comment-thread")).toBe(thread.id);
    expect(element.querySelector("code .ub-person-pill")).toBeNull();
    expect(getBlockInline(ydoc, id)).toEqual(before);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("keeps one reachable authored link when a comment splits its person mention", () => {
  const { ydoc, id } = fixture([{ text: "@alice", marks: { link: "https://example.com/people" } }]);
  createAnnotation(ydoc, id, 2, 4, "Reader", "Check the person");
  const { editor, element } = mountEditor(ydoc);
  try {
    setEditorMembers(editor, ["alice"]);
    const links = within(element).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(within(element).getByRole("link", { name: "@alice" }));
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/people");
    expect(links[0]?.querySelector(".ub-person-pill")).not.toBeNull();
    for (const link of element.querySelectorAll("a")) {
      if (link === links[0]) continue;
      expect(link.getAttribute("aria-hidden")).toBe("true");
      expect(link.getAttribute("tabindex")).toBe("-1");
    }
  } finally { editor.destroy(); ydoc.destroy(); }
});
