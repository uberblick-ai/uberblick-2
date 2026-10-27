import { Extension } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { COMMENT_MARK, getWorkspaceMainRepository, githubItemUrl } from "@uberblick/schema";
import type { GitHubItem } from "@uberblick/schema";
import type * as Y from "yjs";
import { githubLinkNamesItem, githubPillPresentation } from "../github-pill.js";
import { inlineIconAnchorLabel } from "../inline-icons.js";

interface LinkRange {
  from: number;
  to: number;
  text: string;
  link: Mark;
  comments: Mark[];
}

function linkRanges(doc: ProseMirrorNode): LinkRange[] {
  const ranges: LinkRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let current: LinkRange | undefined;
    node.forEach((child, offset) => {
      const link = child.isText
        ? child.marks.find((mark) => mark.type.name === "link")
        : undefined;
      if (link === undefined) {
        current = undefined;
        return;
      }
      const from = pos + 1 + offset;
      if (current === undefined || !current.link.eq(link)) {
        current = { from, to: from, text: "", link, comments: [] };
        ranges.push(current);
      }
      current.to = from + child.nodeSize;
      current.text += child.text;
      // A comment on any part of the stored reference stays visible on its pill.
      for (const mark of child.marks) {
        if (
          mark.type.name === COMMENT_MARK &&
          !current.comments.some((comment) => comment.eq(mark))
        ) current.comments.push(mark);
      }
    });
    return false;
  });
  return ranges;
}

function pill(item: GitHubItem, mainRepository: string | null): HTMLElement {
  const presentation = githubPillPresentation(item, mainRepository);
  const dom = document.createElement("span");
  dom.className = "ub-github-pill";
  // The mark view gives the native anchor this label, including through comments.
  dom.setAttribute("aria-hidden", "true");
  dom.title = presentation.label;
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.5");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", presentation.path);
  icon.append(path);
  if (presentation.issueDot) {
    // GitHub's issue mark is a ring around a solid dot, not an exclamation mark.
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", "8");
    dot.setAttribute("cy", "8");
    dot.setAttribute("r", "1.5");
    dot.setAttribute("fill", "currentColor");
    dot.setAttribute("stroke", "none");
    icon.append(dot);
  }
  const repo = document.createElement("span");
  repo.className = "ub-github-pill-repo";
  repo.textContent = presentation.visibleRepo;
  repo.setAttribute("aria-hidden", "true");
  const number = document.createElement("span");
  number.className = "ub-github-pill-number";
  number.textContent = presentation.number;
  number.setAttribute("aria-hidden", "true");
  dom.append(icon);
  if (presentation.visibleRepo !== null) dom.append(repo);
  dom.append(number);
  return dom;
}

function decorations(state: EditorState, focused: boolean, mainRepository: string | null): DecorationSet {
  const result: Decoration[] = [];
  const selection = state.selection;
  for (const range of linkRanges(state.doc)) {
    const href: unknown = range.link.attrs.href;
    if (typeof href !== "string") continue;
    const item = githubItemUrl(href);
    if (item === null || !githubLinkNamesItem(range.text, href, item)) continue;
    const editing = selection.empty
      ? range.from < selection.from && selection.from < range.to
      : selection.from < range.to && range.from < selection.to;
    if (focused && editing) continue;
    result.push(
      Decoration.inline(range.from, range.to, {
        class: "ub-github-link-text",
        "aria-hidden": "true",
      }),
      Decoration.widget(range.to, () => pill(item, mainRepository), {
        // Explicit marks keep activation and comment presentation on their usual paths.
        marks: [range.link, ...range.comments],
        side: -1,
        key: JSON.stringify([range.to, href, range.text, mainRepository, range.comments.map((mark) => mark.attrs)]),
      }),
    );
  }
  return DecorationSet.create(state.doc, result);
}

const githubLinksKey = new PluginKey<DecorationSet>("uberblickGithubLinks");

/** Presentation only: clipboard serialization and Yjs see the original link. */
export const GitHubLinks = Extension.create<{ settings: Y.Doc | null }>({
  name: "uberblickGithubLinks",
  addOptions() { return { settings: null }; },
  // The lone-URL shortcut runs before the table's plain-text paste normalization.
  priority: 1200,
  addProseMirrorPlugins() {
    const editor = this.editor;
    const settings = this.options.settings;
    const readMainRepository = (): string | null => settings === null ? null : getWorkspaceMainRepository(settings);
    const anchors = new Set<HTMLAnchorElement>();
    const repaint = (): void => {
      for (const anchor of anchors) {
        const label = anchor.querySelector(".ub-github-pill")?.getAttribute("title");
        if (label) {
          anchor.setAttribute("aria-label", label);
          anchor.title = label;
          anchor.removeAttribute("tabindex");
          anchor.removeAttribute("aria-hidden");
        } else {
          const iconLabel = inlineIconAnchorLabel(anchor);
          if (iconLabel) anchor.setAttribute("aria-label", iconLabel);
          else anchor.removeAttribute("aria-label");
          anchor.removeAttribute("title");
          // Partial formatting can split the source into additional anchors.
          const hidden = anchor.querySelector(".ub-github-link-text") !== null || iconLabel === "";
          if (hidden) {
            anchor.tabIndex = -1;
            anchor.setAttribute("aria-hidden", "true");
          } else {
            anchor.removeAttribute("tabindex");
            anchor.removeAttribute("aria-hidden");
          }
        }
      }
    };
    return [new Plugin({
      key: githubLinksKey,
      state: {
        init: (_config, state) => decorations(state, editor.isFocused, readMainRepository()),
        apply: (tr, previous, _oldState, state) =>
          tr.docChanged || tr.selectionSet || tr.getMeta("focus") || tr.getMeta("blur") || tr.getMeta(githubLinksKey)
            ? decorations(state, editor.isFocused, readMainRepository()) : previous,
      },
      props: {
        markViews: {
          link: (mark) => {
            const dom = document.createElement("a");
            dom.className = "ub-link";
            if (typeof mark.attrs.href === "string") dom.setAttribute("href", mark.attrs.href);
            dom.target = "_blank";
            dom.rel = "noopener noreferrer nofollow";
            anchors.add(dom);
            return {
              dom,
              // The accessible label is derived from decorations, never stored.
              ignoreMutation: (mutation) => mutation.type === "attributes",
              destroy: () => { anchors.delete(dom); },
            };
          },
        },
        decorations: (state) => githubLinksKey.getState(state),
        handlePaste: (view, event) => {
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (
            !view.editable || event.clipboardData?.getData("text/html") ||
            /\s/.test(text) || view.state.selection.$from.parent.type.spec.code
          ) return false;
          const item = githubItemUrl(text);
          const link = view.state.schema.marks.link;
          if (item === null || link === undefined) return false;
          const { $from, $to } = view.state.selection;
          if (!$from.parent.type.allowsMarkType(link) || !$to.parent.type.allowsMarkType(link)) return false;
          view.dispatch(view.state.tr.replaceSelectionWith(
            view.state.schema.text(
              `${item.owner}/${item.repo}#${item.numberText}`,
              link.create({ href: text }).addToSet(view.state.storedMarks ?? $from.marks()),
            ),
            false,
          ).scrollIntoView());
          return true;
        },
      },
      view: (view) => {
        let mainRepository = readMainRepository();
        const settingsChanged = (): void => {
          const next = readMainRepository();
          if (next === mainRepository) return;
          mainRepository = next;
          view.dispatch(view.state.tr.setMeta(githubLinksKey, true).setMeta("addToHistory", false));
        };
        settings?.on("update", settingsChanged);
        repaint();
        return { update: repaint, destroy: () => settings?.off("update", settingsChanged) };
      },
    })];
  },
});
