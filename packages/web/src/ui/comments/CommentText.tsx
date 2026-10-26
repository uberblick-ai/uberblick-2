import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { canonicalDocumentUuid, parseMarkdownLinkPrefix } from "@uberblick/schema";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { personMentionTokens } from "../../mentions.js";
import { isPlainClick } from "../route.js";
import { useWorkspaceMembers } from "../workspace-members.js";

function personText(text: string, members: readonly string[], offset: number): ReactNode[] {
  const result: ReactNode[] = [];
  let from = 0;
  for (const token of personMentionTokens(text, members)) {
    result.push(text.slice(from, token.from));
    result.push(<span className="ub-person-pill" data-person-mention={token.username} key={offset + token.from}>{token.text}</span>);
    from = token.to;
  }
  result.push(text.slice(from));
  return result;
}

/** Only the existing UUID-link grammar is interpreted; other Markdown stays text. */
export function CommentText({ text, docLinks }: { text: string; docLinks: DocLinkContext | null }): ReactElement {
  const members = useWorkspaceMembers();
  const [, refresh] = useState(0);
  useEffect(() => docLinks?.subscribe(() => refresh((tick) => tick + 1)), [docLinks]);
  const result: ReactNode[] = [];
  let from = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") { index += 1; continue; }
    if (text[index] !== "[") continue;
    const link = parseMarkdownLinkPrefix(text.slice(index));
    const docId = canonicalDocumentUuid(link?.href);
    if (link === null || docId === null || docLinks === null) continue;
    result.push(...personText(text.slice(from, index), members, from));
    const target = docLinks.lookup(docId);
    const deleted = target.state === "deleted";
    // Undo the inline writer's label escapes without interpreting formatting.
    const label = link.label.replace(/\\(.)/g, (escaped, character: string) => "\\`*[]~_".includes(character) ? character : escaped);
    result.push(<a key={`doc:${index}`} className="ub-doclink" data-doc-id={docId} data-doc-link-state={target.state}
      href={deleted ? undefined : docLinks.href(docId)} aria-disabled={deleted || undefined} tabIndex={deleted ? -1 : undefined}
      title={deleted ? "This document was deleted." : target.state === "archived" ? "This document is archived. The link opens it read-only." : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (docLinks.lookup(docId).state === "deleted") { event.preventDefault(); return; }
        if (!isPlainClick(event)) return;
        event.preventDefault();
        docLinks.open(docId);
      }}>{personText(label, members, index)}</a>);
    index += link.next - 1;
    from = index + 1;
  }
  result.push(...personText(text.slice(from), members, from));
  return <>{result}</>;
}
