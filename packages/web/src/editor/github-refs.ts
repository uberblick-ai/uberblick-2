/**
 * GitHub issue and pull-request links, shown the way GitHub shows them: a link
 * to this repo reads `#62`, one to another repo reads `org/repo#62`.
 *
 * Display only. Nothing here touches the Y.Doc: the stored text stays the full
 * URL and so does the `link` mark's href, which is what agents read, what
 * `export_markdown` emits, and what a copy out of the editor carries. The
 * shortening is a ProseMirror decoration — presentation drawn on top of state
 * that is already true, the same shape as typing-theater.ts.
 *
 * Three rules define it, and they are the whole of the file:
 *
 * 1. **Only a bare URL is shortened.** The decoration fires when the link's
 *    text is *exactly* its href — the shape a paste leaves behind. A reader who
 *    wrote their own label ("the fix") keeps it; rewriting chosen words would
 *    be an edit wearing a decoration's clothes.
 * 2. **Only a canonical issue/PR URL is shortened.** `github.com/org/repo/
 *    issues/62` and `.../pull/62`, no query and no fragment. A tree URL, a
 *    comment permalink and every non-GitHub link render as they always did —
 *    "untouched" is the default, and the pure function says so by returning
 *    `null`.
 * 3. **The caret reveals the URL.** While the selection touches the link the
 *    decoration steps aside and the real text is shown. Without that the URL is
 *    `display: none` text a reader could put a caret into but not see — and
 *    they could never edit or remove the link they had just pasted.
 *
 * The same-repo comparison is a plain constant ({@link GITHUB_REPO} in
 * config.ts), which is honest for a single-repo spike and is the seam a hosted
 * uberblick would replace with a per-workspace setting. Nothing is fetched:
 * titles and open/closed state would need the network, and uberblick is
 * offline-first by construction.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { GITHUB_REPO } from "../config.js";

/** The class on the shortened reference. Styled as a link, because it is one. */
export const GITHUB_REF_CLASS = "ub-gh-ref";

/** The class that hides the URL the reference stands in for. */
export const GITHUB_URL_CLASS = "ub-gh-url";

/** The hosts a reference may live on. `www.` because browsers hand it back. */
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * `/<org>/<repo>/(issues|pull)/<number>`, and nothing else. The trailing slash
 * is allowed because a URL bar adds one.
 */
const REF_PATH = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([0-9]+)\/?$/;

/**
 * How `href` reads shortened, or `null` when it is not an issue/PR reference.
 *
 * A query string or fragment disqualifies it: `.../pull/62#issuecomment-1` and
 * `.../pull/62/files` point *into* a pull request rather than at it, and a bare
 * `#62` would say something the link does not.
 */
export function shortGitHubRef(
  href: string,
  sameRepo: string = GITHUB_REPO,
): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.search !== "" || url.hash !== "") return null;
  const match = REF_PATH.exec(url.pathname);
  if (match === null) return null;
  const [, org, repo, number] = match;
  if (org === undefined || repo === undefined || number === undefined) {
    return null;
  }
  const slug = `${org}/${repo}`;
  // GitHub's own slugs are case-insensitive, and a pasted URL need not match
  // the constant's casing.
  return slug.toLowerCase() === sameRepo.toLowerCase()
    ? `#${number}`
    : `${slug}#${number}`;
}

/** The rendered reference: a real anchor, so hover and click reach the URL. */
function refElement(label: string, href: string): HTMLElement {
  const anchor = document.createElement("a");
  anchor.className = `ub-link ${GITHUB_REF_CLASS}`;
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer nofollow";
  // The URL it stands in for, on hover — the one thing the shortening hides.
  anchor.title = href;
  anchor.textContent = label;
  anchor.contentEditable = "false";
  return anchor;
}

function build(state: EditorState): DecorationSet {
  const linkType = state.schema.marks.link;
  if (linkType === undefined) return DecorationSet.empty;
  const { from: selFrom, to: selTo } = state.selection;
  const decorations: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((candidate) => candidate.type === linkType);
    if (mark === undefined) return false;
    const href: unknown = mark.attrs.href;
    // The bare-URL test. A link run split by another mark — half of it
    // commented, say — matches no single text node and simply stays long,
    // which is the harmless outcome.
    if (typeof href !== "string" || node.text !== href) return false;
    const short = shortGitHubRef(href);
    if (short === null) return false;
    const to = pos + node.nodeSize;
    // Inclusive at both ends: arrowing in from outside lands the caret *on* a
    // boundary, and that already counts as inside for revealing.
    if (selFrom <= to && selTo >= pos) return false;
    decorations.push(
      Decoration.inline(pos, to, { class: GITHUB_URL_CLASS }),
      Decoration.widget(pos, () => refElement(short, href), {
        side: -1,
        // No inherited marks: the reference is its own anchor, and nesting it
        // inside the link mark's `<a>` would be invalid HTML.
        marks: [],
        key: `gh:${short}:${href}`,
      }),
    );
    return false;
  });
  return DecorationSet.create(state.doc, decorations);
}

export const githubRefsPluginKey = new PluginKey<DecorationSet>(
  "uberblick/github-refs",
);

export const GitHubRefs = Extension.create({
  name: "uberblickGithubRefs",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: githubRefsPluginKey,
        state: {
          init: (_config, state) => build(state),
          // Rebuilt rather than mapped, and only when something it reads moved:
          // the set depends on the selection as much as on the document, and a
          // mapped decoration would go on hiding a URL the caret has entered.
          // Transactions that are neither — the changed-block redraws and the
          // typing animation's ticks — reuse the set untouched.
          apply: (tr, value, _old, next) =>
            tr.docChanged || tr.selectionSet ? build(next) : value,
        },
        props: {
          decorations: (state) => githubRefsPluginKey.getState(state),
        },
      }),
    ];
  },
});
