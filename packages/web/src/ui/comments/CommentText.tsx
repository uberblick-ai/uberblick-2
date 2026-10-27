import { Fragment, useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { githubItemUrl } from "@uberblick/schema";
import type { InlineRun } from "@uberblick/schema";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { githubLinkNamesItem, githubPillPresentation } from "../../github-pill.js";
import { personMentionTokens } from "../../mentions.js";
import { isPlainClick } from "../route.js";
import { useWorkspaceMembers } from "../workspace-members.js";
import { commentInline } from "./comment-inline.js";

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

function formatted(run: InlineRun, members: readonly string[], key: number): ReactNode {
  let content: ReactNode = run.marks.inlineCode
    ? <code className="ub-inline-code">{run.text}</code> : personText(run.text, members, key);
  if (run.marks.strike) content = <s>{content}</s>;
  if (run.marks.italic) content = <em>{content}</em>;
  if (run.marks.bold) content = <strong>{content}</strong>;
  return <Fragment key={key}>{content}</Fragment>;
}

export function CommentText({ text, docLinks, mainRepository = null }: {
  text: string;
  docLinks: DocLinkContext | null;
  mainRepository?: string | null;
}): ReactElement {
  const members = useWorkspaceMembers();
  const [, refresh] = useState(0);
  useEffect(() => docLinks?.subscribe(() => refresh((tick) => tick + 1)), [docLinks]);
  const result: ReactNode[] = [];
  const runs = commentInline(text, docLinks !== null);
  for (let index = 0; index < runs.length;) {
    const run = runs[index];
    if (run === undefined) break;
    const { docLink: docId, link: href } = run.marks;
    if (docId === undefined && href === undefined) {
      result.push(formatted(run, members, index));
      index += 1;
      continue;
    }
    const key = index;
    const group: InlineRun[] = [];
    while (runs[index]?.marks.docLink === docId && runs[index]?.marks.link === href) {
      const next = runs[index];
      if (next === undefined) break;
      group.push(next);
      index += 1;
    }
    const content = group.map((part, offset) => formatted(part, members, offset));
    if (href !== undefined) {
      const item = githubItemUrl(href);
      const pill = item !== null && githubLinkNamesItem(group.map((part) => part.text).join(""), href, item)
        ? githubPillPresentation(item, mainRepository) : null;
      result.push(<a key={key} className="ub-link" href={href} target="_blank" rel="noopener noreferrer nofollow"
        aria-label={pill?.label} title={pill?.label} onClick={(event) => event.stopPropagation()}>
        {pill === null ? content : <span className="ub-github-pill">
          <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d={pill.path} />
            {pill.issueDot && <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />}
          </svg>
          {pill.visibleRepo !== null && <span className="ub-github-pill-repo">{pill.visibleRepo}</span>}
          <span className="ub-github-pill-number">{pill.number}</span>
        </span>}
      </a>);
      continue;
    }
    if (docId === undefined || docLinks === null) {
      result.push(<Fragment key={key}>{content}</Fragment>);
      continue;
    }
    const target = docLinks.lookup(docId);
    const deleted = target.state === "deleted";
    result.push(<a key={key} className="ub-doclink" data-doc-id={docId} data-doc-link-state={target.state}
      href={deleted ? undefined : docLinks.href(docId)} aria-disabled={deleted || undefined} tabIndex={deleted ? -1 : undefined}
      title={deleted ? "This document was deleted." : target.state === "archived" ? "This document is archived. The link opens it read-only." : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (docLinks.lookup(docId).state === "deleted") { event.preventDefault(); return; }
        if (!isPlainClick(event)) return;
        event.preventDefault();
        docLinks.open(docId);
      }}>{content}</a>);
  }
  return <>{result}</>;
}
