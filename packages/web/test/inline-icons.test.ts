import { within } from "@testing-library/dom";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, createAnnotation, exportMarkdown, getBlockInline, getBlocksFragment, initDoc,
} from "@uberblick/schema";
import type { InlineRun } from "@uberblick/schema";
import type { DocLinkContext } from "../src/editor/doc-links.js";
import { mountEditor } from "./helpers.js";

const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HREF = "https://example.com/discuss";
const context: DocLinkContext = {
  href: (id) => `/documents/${id}`,
  lookup: () => ({ state: "resolved", title: "Target" }),
  candidates: () => [],
  subscribe: () => () => {},
  open: () => {},
};

function fixture(inline: string | InlineRun[]) {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "22222222-3333-4444-5555-666666666666", title: "Inline icons" });
  const id = appendBlock(ydoc, typeof inline === "string"
    ? { type: "paragraph", text: inline }
    : { type: "paragraph", inline });
  return { ydoc, id };
}

it.each([true, false])("changes presentation with focus and selection without document writes (editable %s)", async (editable) => {
  const { ydoc, id } = fixture("before :claude: after");
  const inline = getBlockInline(ydoc, id);
  const markdown = exportMarkdown(ydoc);
  const { editor, element } = mountEditor(ydoc);
  try {
    editor.setEditable(editable);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = Y.encodeStateAsUpdate(ydoc);
    let writes = 0;
    ydoc.on("update", () => { writes += 1; });
    const rendered = () => element.querySelectorAll(".ub-inline-icon");
    expect(rendered()).toHaveLength(1);
    editor.view.focus();
    editor.commands.setTextSelection(9);
    expect(rendered()).toHaveLength(editable ? 0 : 1);
    editor.commands.setTextSelection(8);
    expect(rendered()).toHaveLength(1);
    editor.commands.setTextSelection(16);
    expect(rendered()).toHaveLength(1);
    editor.commands.setTextSelection({ from: 7, to: 9 });
    expect(rendered()).toHaveLength(editable ? 0 : 1);
    editor.commands.setTextSelection(9);
    editor.view.dom.blur();
    expect(rendered()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toBe(0);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    expect(getBlockInline(ydoc, id)).toEqual(inline);
    expect(exportMarkdown(ydoc)).toBe(markdown);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("repaints remote source edits without additional document writes", async () => {
  const { ydoc } = fixture(":claude:");
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
  const { editor, element } = mountEditor(ydoc);
  try {
    editor.setEditable(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let localWrites = 0;
    ydoc.on("update", (_update, origin) => { if (origin !== "remote-fixture") localWrites += 1; });
    const source = (getBlocksFragment(remote).get(0) as Y.XmlElement).firstChild as Y.XmlText;
    source.delete(0, source.length);
    source.insert(0, ":github:");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote), "remote-fixture");
    expect(element.querySelector(".ub-inline-icon")?.getAttribute("data-icon")).toBe("github");
    const before = Y.encodeStateAsUpdate(ydoc);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(localWrites).toBe(0);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    source.insert(1, "unknown-");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote), "remote-fixture");
    expect(element.querySelector(".ub-inline-icon")).toBeNull();
    expect(element.textContent).toContain(":unknown-github:");
  } finally { editor.destroy(); ydoc.destroy(); remote.destroy(); }
});

it("keeps a partially commented and formatted shortcode as one highlighted icon", () => {
  const { ydoc, id } = fixture([
    { text: ":cl", marks: { bold: true } },
    { text: "aud", marks: { italic: true } },
    { text: "e:", marks: {} },
  ]);
  const thread = createAnnotation(ydoc, id, 3, 5, "Reader", "Check this mark");
  const before = getBlockInline(ydoc, id);
  const { editor, element } = mountEditor(ydoc);
  try {
    const icon = within(element).getByRole("img", { name: "Claude" });
    expect(element.querySelectorAll(".ub-inline-icon")).toHaveLength(1);
    expect(icon.closest("[data-comment-thread]")?.getAttribute("data-comment-thread")).toBe(thread.id);
    expect(icon.closest("strong")).not.toBeNull();
    for (const source of element.querySelectorAll(".ub-inline-icon-text")) {
      expect(source.getAttribute("aria-hidden")).toBe("true");
    }
    expect(getBlockInline(ydoc, id)).toEqual(before);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("scopes decorative icons to their text block and separately to each link", () => {
  const { ydoc } = fixture([
    { text: "A paragraph :claude: ", marks: {} },
    { text: ":github:", marks: { link: HREF } },
    { text: " and ", marks: {} },
    { text: ":codex: Read the document", marks: { docLink: TARGET } },
  ]);
  appendBlock(ydoc, { type: "paragraph", text: ":claude: :codex:" });
  const { editor, element } = mountEditor(ydoc, { docLinks: context });
  try {
    expect(within(element).getAllByRole("img").map((image) => image.getAttribute("aria-label")))
      .toEqual(["GitHub", "Claude", "Codex"]);
    const firstParagraph = element.querySelector("p")!;
    expect(firstParagraph.querySelector('[data-icon="claude"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(firstParagraph.querySelector('[data-icon="codex"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(within(element).getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe(HREF);
    expect(within(element).getByRole("link", { name: "Read the document" }).getAttribute("href"))
      .toBe(`/documents/${TARGET}`);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("renders a shortcode across link boundaries and carries the overlapping link", () => {
  const { ydoc } = fixture([
    { text: ":cl", marks: {} },
    { text: "aude", marks: { link: HREF } },
    { text: ":", marks: {} },
  ]);
  const { editor, element } = mountEditor(ydoc);
  try {
    const icon = within(element).getByRole("img", { name: "Claude" });
    expect(icon.closest("a")?.getAttribute("href")).toBe(HREF);
    expect(within(element).getAllByRole("link")).toEqual([icon.closest("a")]);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it.each(["external", "document"] as const)("hides source-only %s anchors split by a partial comment", (kind) => {
  const marks = kind === "external" ? { link: HREF } : { docLink: TARGET };
  const { ydoc, id } = fixture([{ text: ":claude:", marks }]);
  const thread = createAnnotation(ydoc, id, 2, 4, "Reader", "Check this link");
  const { editor, element } = mountEditor(ydoc, { docLinks: context });
  try {
    const icon = within(element).getByRole("img", { name: "Claude" });
    expect(icon.closest("[data-comment-thread]")?.getAttribute("data-comment-thread")).toBe(thread.id);
    const links = within(element).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(within(element).getByRole("link", { name: "Claude" }));
    expect(icon.closest("a")).toBe(links[0]);
    for (const anchor of element.querySelectorAll("a")) {
      if (anchor.contains(icon)) continue;
      expect(anchor.getAttribute("aria-hidden")).toBe("true");
      expect(anchor.getAttribute("tabindex")).toBe("-1");
    }
  } finally { editor.destroy(); ydoc.destroy(); }
});

it.each(["external", "document"] as const)("keeps the visible %s link name when a comment covers the icon source", async (kind) => {
  const marks = kind === "external" ? { link: HREF } : { docLink: TARGET };
  const { ydoc, id } = fixture([{ text: ":claude: Discuss with Claude", marks }]);
  createAnnotation(ydoc, id, 2, 6, "Reader", "Check this mark");
  const { editor, element } = mountEditor(ydoc, { docLinks: context });
  try {
    const links = within(element).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(within(element).getByRole("link", { name: "Discuss with Claude" }));
    expect(links[0]?.querySelector(".ub-inline-icon")?.getAttribute("aria-hidden")).toBe("true");
    editor.view.focus();
    editor.commands.setTextSelection(4);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(element.querySelector(".ub-inline-icon")).toBeNull();
    editor.view.dom.blur();
    expect(within(element).getByRole("link", { name: "Discuss with Claude" })).toBe(links[0]);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("leaves unknown names, inline code and every source-block type literal", () => {
  const literal = ":rocket: :Claude: :codex-extra: note:this: 10:30:15";
  const { ydoc } = fixture([
    { text: `${literal} :claude: `, marks: {} },
    { text: ":codex:", marks: { inlineCode: true } },
  ]);
  for (const type of ["code", "terminal", "chart"] as const) {
    appendBlock(ydoc, { type, text: ":claude: :codex: :github:" });
  }
  const { editor, element } = mountEditor(ydoc);
  try {
    expect(element.querySelectorAll(".ub-inline-icon")).toHaveLength(1);
    expect(element.querySelector("p")?.textContent).toContain(literal);
    expect(element.querySelector("p code")?.textContent).toBe(":codex:");
    expect(element.querySelector("p code .ub-inline-icon")).toBeNull();
  } finally { editor.destroy(); ydoc.destroy(); }
});
