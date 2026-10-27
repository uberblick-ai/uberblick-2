import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { AnnotationComment } from "@uberblick/schema";
import { AWARENESS_FALLBACK_COLOR } from "../../collab/identity.js";
import { InlineIconText } from "../InlineIconText.js";
import { initialOf } from "../status/PeerAvatar.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../shadcn/tooltip.js";
import { commentTimestamp } from "./threads.js";

function CommentAvatar({ author, account, opening }: {
  author: string;
  account?: string | undefined;
  opening: boolean;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const initials = author.trim().split(/\s+/);
  const first = initials[0] ?? "";
  const last = initials.length > 1 ? initials.at(-1) : undefined;
  return <span
    className={`ub-comment-avatar inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ub-type-caption font-medium ${opening ? "size-7" : "size-5"}`}
    aria-hidden="true"
    style={{ backgroundColor: AWARENESS_FALLBACK_COLOR, color: "#ffffff" }}
  >
    {account !== undefined && account !== "" && !failed && online
      ? <img
        src={`https://avatars.githubusercontent.com/${encodeURIComponent(account)}?s=64`}
        alt=""
        className="size-full object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
      : `${initialOf(first)}${last === undefined ? "" : initialOf(last)}`}
  </span>;
}

function AgentMark({ agent }: { agent: "claude" | "codex" }): ReactElement {
  const label = agent === "claude" ? "via Claude" : "via Codex";
  return <TooltipProvider><Tooltip>
    <TooltipTrigger asChild>
      <span className="ub-comment-agent inline-flex shrink-0 items-center" role="img" aria-label={label} style={{ color: `var(--agent-${agent})` }}>
        <span aria-hidden="true"><InlineIconText text={`:${agent}:`} /></span>
      </span>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip></TooltipProvider>;
}

export function CommentByline({ comment, now, updatedAt }: {
  comment: AnnotationComment;
  now: number;
  updatedAt?: string | undefined;
}): ReactElement {
  const opening = updatedAt !== undefined;
  const { label, dateTime, title } = commentTimestamp(updatedAt ?? comment.createdAt, now);
  const time = <time className="ub-type-caption text-(--muted-foreground)" dateTime={dateTime} title={title}>{opening ? "Updated " : ""}{label}</time>;
  return <span className={`ub-thread-byline flex items-center gap-2 ub-type-ui text-(--muted-foreground) ${opening ? "ub-comment-opening" : "ub-comment-reply"}`}>
    <CommentAvatar key={comment.account ?? ""} author={comment.author} account={comment.account} opening={opening} />
    <span className={`min-w-0 ${opening ? "flex flex-col" : "flex flex-wrap items-center gap-x-2"}`}>
      <span className="inline-flex min-w-0 items-center gap-1">
        <span className="ub-thread-author break-words font-medium">{comment.author}</span>
        {(comment.agent === "claude" || comment.agent === "codex") && <AgentMark agent={comment.agent} />}
      </span>
      {time}
    </span>
  </span>;
}
