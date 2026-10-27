import { canonicalDocumentUuid, githubItemUrl, isExternalHref, parseInline, parseMarkdownLinkPrefix, renderMarkdownLink } from "@uberblick/schema";
import type { InlineRun } from "@uberblick/schema";
import { githubLinkNamesItem } from "../../github-pill.js";

function bareUrl(source: string): string | null {
  let url = /^https?:\/\/[^\s<>"'`]+/i.exec(source)?.[0];
  if (url === undefined) return null;
  const brackets: string[] = [];
  const opening: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < url.length; index += 1) {
    const character = url[index] ?? "";
    if (/[([{]/.test(character)) brackets.push(character);
    if (opening[character] !== undefined) {
      if (brackets.pop() !== opening[character]) { url = url.slice(0, index); break; }
    }
  }
  url = url.replace(/[.,!?;:*~]+$/, "");
  return isExternalHref(url) ? url : null;
}

/** Add display-only URLs before the shared inline reader handles formatting. */
function withCommentLinks(source: string, documentLinks: boolean): string {
  let result = "";
  for (let index = 0; index < source.length;) {
    const tail = source.slice(index);
    if (tail.startsWith("\\")) {
      result += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    // Preserve code spans wholesale so their links and mentions stay literal.
    const fence = /^`+/.exec(tail)?.[0];
    if (fence !== undefined) {
      const close = [...tail.slice(fence.length).matchAll(/`+/g)].find((run) => run[0].length === fence.length);
      if (close !== undefined && close.index > 0) {
        const end = fence.length + close.index + fence.length;
        result += tail.slice(0, end);
        index += end;
        continue;
      }
      result += fence;
      index += fence.length;
      continue;
    }
    const link = tail.startsWith("[") ? parseMarkdownLinkPrefix(tail) : null;
    if (link !== null) {
      const original = tail.slice(0, link.next);
      const docId = canonicalDocumentUuid(link.href);
      // Document labels keep the existing literal-label display contract.
      const label = link.label.replace(/\\(.)/g, (escaped, character: string) => "\\`*[]~_".includes(character) ? character : escaped);
      result += docId !== null && documentLinks ? renderMarkdownLink(label, docId)
        : isExternalHref(link.href) ? original : original.replace(/[\\`*_[\]~]/g, "\\$&");
      index += link.next;
      continue;
    }
    // A literal opener must not capture a link inserted later in this pass.
    if (tail.startsWith("[")) {
      result += "\\[";
      index += 1;
      continue;
    }
    let url = index === 0 || !/[\p{L}\p{N}]/u.test(source[index - 1] ?? "") ? bareUrl(tail) : null;
    if (url !== null) {
      // An underscore hugging a URL can close surrounding italic Markdown.
      if (source[index - 1] === "_") url = url.replace(/_+$/, "");
      const item = githubItemUrl(url);
      const reference = /(?:^|\s)((?:[^/\s#()]+\/)?[^/\s#()]+#[0-9]+)[ \t]+\($/.exec(result);
      if (item !== null && reference?.[1] !== undefined && tail[url.length] === ")"
        && githubLinkNamesItem(reference[1], url, item)) {
        result = result.slice(0, result.length - reference[0].trimStart().length) + renderMarkdownLink(reference[1], url);
        index += url.length + 1;
      } else {
        result += renderMarkdownLink(url, url);
        index += url.length;
      }
      continue;
    }
    result += source[index];
    index += 1;
  }
  return result;
}

export function commentInline(text: string, documentLinks = true): InlineRun[] {
  return parseInline(withCommentLinks(text, documentLinks));
}
