import type { ComponentProps, MouseEvent, ReactElement } from "react";
import { decisionCurrentRecord, decisionTopicState, getDirectoryEntry, getMeta } from "@uberblick/schema";
import type { DecisionTopicResolution, DirectoryEntry } from "@uberblick/schema";
import type { DocLinkContext } from "../../editor/doc-links.js";
import type { RoomConnection } from "../../collab/rooms.js";
import { EditorPane } from "./EditorPane.js";
import { decisionRecordPath, docPath } from "../route.js";
import type { Navigate } from "../route.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import { TOPIC_STATES } from "./decision-state.js";

function navigateLink(event: MouseEvent<HTMLAnchorElement>, navigate: Navigate): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.pathname);
}

function DocumentReference({ uuid, label, context }: {
  uuid: string; label?: string | undefined; context: DocLinkContext | null;
}): ReactElement | null {
  if (context === null) return null;
  const link = context.lookup(uuid);
  return <a className="ub-doclink" href={context.href(uuid)}
    data-doc-link-state={link.state}
    onClick={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      context.open(uuid);
    }}>{label ?? link.title ?? uuid}</a>;
}

function recordState(topic: DecisionTopicResolution, record: DirectoryEntry): string {
  if (topic.conflicts.some((entry) => entry.uuid === record.uuid)) return "Conflicting answer";
  if (topic.superseded.some((entry) => entry.uuid === record.uuid)) return "Superseded";
  if (record.status === "rejected") return "Rejected";
  if (record.status === "withdrawn") return "Withdrawn";
  if (record.status === "open") return "Open proposal";
  if (topic.inForce?.uuid === record.uuid) return record.agentStance ? "Agent stance" : "In force";
  return "Decided";
}

const ANSWER_STATES = {
  ...TOPIC_STATES,
  conflict: "Conflicting answer",
  "open-proposal": "Open proposal",
  superseded: "Superseded",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  decided: "Decided",
};

type AnswerState = keyof typeof ANSWER_STATES;

function answerState(topic: DecisionTopicResolution, record: DirectoryEntry): AnswerState {
  if (topic.conflicts.some((entry) => entry.uuid === record.uuid)) return "conflict";
  if (topic.superseded.some((entry) => entry.uuid === record.uuid)) return "superseded";
  if (record.status === "open") {
    if (topic.inForce !== null) return "under-review";
    return topic.conflicts.length > 0 ? "open-proposal" : "not-yet-decided";
  }
  if (topic.inForce?.uuid === record.uuid) return record.agentStance ? "agent-stance" : "in-force";
  return record.status ?? "decided";
}

function RecordedAttribution({ record, state, now }: {
  record: DirectoryEntry; state: AnswerState; now: number;
}): ReactElement | null {
  const opened = record.status === "open" || record.status === "withdrawn";
  const date = opened || record.agentStance ? record.createdAt : record.decidedAt;
  const time = date === undefined ? null : formatTimestamp(date, now, true);
  const label = opened ? (time === null ? null : "Opened")
    : record.agentStance ? (state === "agent-stance" ? null : "Agent stance")
    : record.decidedBy?.trim() ? record.decidedBy : null;
  if (!label && time === null) return null;
  return <span className="ub-decision-attribution">
    {label}
    {label && time !== null && (opened ? " " : " · ")}
    {time !== null && <time dateTime={time.dateTime} title={time.title}>{time.label}</time>}
  </span>;
}

function TopicNotice({ topic, state: selectedState, docLinks }: {
  topic: DecisionTopicResolution; state: AnswerState; docLinks: DocLinkContext | null;
}): ReactElement | null {
  const state = decisionTopicState(topic);
  if (state === "conflict") return <p className="ub-decision-notice"><strong>Nothing is in force.</strong> Approved answers conflict. Select an answer in the timeline to read it.</p>;
  if (state === "not-yet-decided") {
    const latestOpen = topic.records.findLast((record) => record.status === "open");
    if (selectedState === state && !latestOpen?.discussion) return null;
    return <p className="ub-decision-notice">{selectedState !== state && "Not yet decided."}
      {latestOpen?.discussion && <> <DocumentReference uuid={latestOpen.discussion} label="Open proposal" context={docLinks} /></>}
    </p>;
  }
  if (state !== "under-review") return null;
  const single = topic.pending.length === 1 ? topic.pending[0] : undefined;
  return <p className="ub-decision-notice">{selectedState !== state && <><strong>Under review.</strong>{" "}</>}
    {single === undefined ? `${topic.pending.length} pending proposals.` : "The current answer stays in force."}
    {single?.discussion && <> <DocumentReference uuid={single.discussion} label="Open proposal" context={docLinks} /></>}
  </p>;
}

function replacementRecord(topic: DecisionTopicResolution, selected: string): DirectoryEntry | undefined {
  const byId = new Map(topic.records.map((record) => [record.uuid, record]));
  // Records are oldest first; a missing first replacement date must not fall through to a later answer.
  return topic.records.find((record) => {
    if (record.status !== "decided" || record.uuid === selected) return false;
    const visited = new Set<string>([record.uuid]);
    let next = record.supersedes;
    while (next !== undefined && !visited.has(next)) {
      if (next === selected) return true;
      visited.add(next);
      next = byId.get(next)?.supersedes;
    }
    return false;
  });
}

function AnswerHeader({ topic, record, topicPath, navigate, docLinks }: {
  topic: DecisionTopicResolution; record: DirectoryEntry; topicPath: string;
  navigate: Navigate; docLinks: DocLinkContext | null;
}): ReactElement {
  const now = useTimestampClock();
  const state = answerState(topic, record);
  const replacement = state === "superseded" ? replacementRecord(topic, record.uuid) : undefined;
  const replacedAt = replacement?.decidedAt === undefined ? null : formatTimestamp(replacement.decidedAt, now, true);
  return <>
    <TopicNotice topic={topic} state={state} docLinks={docLinks} />
    <div className="ub-decision-answer-header">
      <div className="ub-decision-answer-heading">
        <span className="ub-decision-answer-caption">ANSWER</span>
        <span className="ub-decision-answer-state" data-state={state}>
          <span className="ub-decisions-mark" aria-hidden="true" />{ANSWER_STATES[state]}
        </span>
      </div>
      <RecordedAttribution record={record} state={state} now={now} />
    </div>
    {state === "superseded" && <p className="ub-decision-earlier-answer">
      Earlier answer. {replacedAt === null ? "It no longer applies." : <>Replaced <time dateTime={replacedAt.dateTime} title={replacedAt.title}>{replacedAt.label}</time>; it no longer applies.</>}
    </p>}
    {topic.inForce !== null && topic.inForce.uuid !== record.uuid && <p className="ub-decision-current-answer">
      <a href={topicPath} onClick={(event) => navigateLink(event, navigate)}>Go to the current answer</a>
    </p>}
  </>;
}

function Timeline({ topic, selected, linkedRecord, segment, navigate, docLinks }: {
  topic: DecisionTopicResolution; selected: string; linkedRecord: string | null;
  segment: string; navigate: Navigate; docLinks: DocLinkContext | null;
}): ReactElement {
  const now = useTimestampClock();
  return <section className="ub-decision-history" aria-label="Decision history">
    <h2>History</h2>
    <ol className="ub-decision-timeline">
      {topic.records.map((record) => {
        const date = record.status === "decided" || record.status === "rejected" ? record.decidedAt : record.createdAt;
        const time = date === undefined ? null : formatTimestamp(date, now, true);
        const chosen = record.uuid === selected;
        return <li key={record.uuid} data-record={record.uuid} data-selected={chosen}>
          <a className="ub-decision-record" href={decisionRecordPath(segment, topic.topic, record.uuid)}
            aria-current={chosen ? "true" : undefined}
            onClick={(event) => navigateLink(event, navigate)}>
            <span className="ub-decision-record-state">{recordState(topic, record)}</span>
            {chosen && <span className="ub-decision-selection"> Selected</span>}
            {linkedRecord === record.uuid && <span className="ub-decision-linked"> Linked record</span>}
            {record.answerPreview && <span className="ub-decision-preview">{record.answerPreview}</span>}
            <span className="ub-decision-record-meta">
              {time !== null && <time dateTime={time.dateTime} title={time.title}>{time.label}</time>}
              {record.commentCount !== undefined && <span>{record.commentCount} {record.commentCount === 1 ? "comment" : "comments"}</span>}
            </span>
          </a>
          {record.discussion && <DocumentReference uuid={record.discussion} label="Open RFC" context={docLinks} />}
        </li>;
      })}
    </ol>
  </section>;
}

/** A topic uses one selected room; its history reads directory caches only. */
export function DecisionTopicPane({ topic, selected, linkedRecord, navigate, explicit, directoryConnection, ...editorProps }:
  ComponentProps<typeof EditorPane> & {
    topic: DecisionTopicResolution | null; selected: string | null; linkedRecord: string | null;
    navigate: Navigate; explicit: boolean;
    directoryConnection: RoomConnection | null;
  }): ReactElement {
  if (topic === null || selected === null) return <EditorPane {...editorProps} />;
  const current = decisionCurrentRecord(topic);
  const record = topic.records.find((entry) => entry.uuid === selected);
  if (current === null || record === undefined) throw new Error("Decision selection must belong to its topic");
  const { segment, docLinks, connection } = editorProps;
  const history = topic.inForce?.uuid !== selected;
  const topicPath = docPath(segment, topic.topic);
  const rejectionReason = connection === null ? undefined : getMeta(connection.ydoc).rejectionReason;
  const discussionTitle = !record.discussion || directoryConnection === null ? undefined
    : getDirectoryEntry(directoryConnection.ydoc, record.discussion)?.title || undefined;
  return <EditorPane {...editorProps}
    decisionView
    copyPath={explicit ? decisionRecordPath(segment, topic.topic, selected) : topicPath}
    header={<h1 className="ub-title">{current.title || "Untitled"}</h1>}
    beforeAnswer={<>
      <AnswerHeader topic={topic} record={record} topicPath={topicPath} navigate={navigate} docLinks={docLinks} />
      {record.status === "rejected" && rejectionReason && <p className="ub-decision-rejection">Rejection reason: {rejectionReason}</p>}
    </>}
    answerClassName={history ? "ub-decision-answer ub-decision-answer-history" : "ub-decision-answer"}
    afterAnswer={<>
      {record.discussion && docLinks !== null && <p className="ub-decision-rfc">
        <span>RFC</span>{" "}
        <DocumentReference uuid={record.discussion} label={discussionTitle} context={docLinks} />
      </p>}
      <Timeline topic={topic} selected={selected} linkedRecord={linkedRecord} segment={segment} navigate={navigate} docLinks={docLinks} />
    </>}
  />;
}
