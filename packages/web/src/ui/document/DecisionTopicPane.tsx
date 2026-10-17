import type { ComponentProps, MouseEvent, ReactElement } from "react";
import { decisionCurrentRecord, decisionTopicState, getDirectoryEntry, getMeta, parseRoom, resolveDecisionTopics, setTitle } from "@uberblick/schema";
import type { DecisionTopicResolution, DirectoryEntry } from "@uberblick/schema";
import type { DocLinkContext } from "../../editor/doc-links.js";
import type { RoomConnection } from "../../collab/rooms.js";
import { EditorPane } from "./EditorPane.js";
import { DocumentTitle } from "./DocumentTitle.js";
import { useDocMeta, useRoomStatus } from "../hooks.js";
import { decisionRecordPath, docPath } from "../route.js";
import type { Navigate } from "../route.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import { TOPIC_STATES } from "./decision-state.js";

function navigateLink(event: MouseEvent<HTMLAnchorElement>, navigate: Navigate): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.pathname);
}

/** `chip` marks an archived target with the shared badge pill instead of the inline suffix. */
function DocumentReference({ uuid, label, context, compact = false, chip = compact, className }: {
  uuid: string; label?: string | undefined; context: DocLinkContext | null; compact?: boolean; chip?: boolean; className?: string;
}): ReactElement | null {
  if (context === null) return null;
  const link = context.lookup(uuid);
  const text = label ?? link.title ?? uuid;
  return <a className={className === undefined ? "ub-doclink" : `ub-doclink ${className}`} href={context.href(uuid)}
    data-doc-link-state={link.state} data-archived-chip={chip || undefined}
    onClick={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      context.open(uuid);
    }}>{chip ? <>
      {compact ? <span className="ub-decision-rfc-title">{text}</span> : text}
      {link.state === "archived" && <span className="ub-badge ub-decision-archived">archived</span>}
    </> : text}</a>;
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

function recordDate(record: DirectoryEntry): string | number | undefined {
  return record.status === "open" || record.status === "withdrawn" || record.agentStance
    ? record.createdAt : record.decidedAt;
}

function AnswerPill({ state, timeline = false }: { state: AnswerState; timeline?: boolean }): ReactElement {
  return <span className={`ub-decision-answer-state${timeline ? " ub-decision-record-state" : ""}`} data-state={state}>
    <span className="ub-decisions-mark" aria-hidden="true" /><span className="ub-decision-state-label">{ANSWER_STATES[state]}</span>
  </span>;
}

function RecordedAttribution({ record, state, now }: {
  record: DirectoryEntry; state: AnswerState; now: number;
}): ReactElement | null {
  const opened = record.status === "open" || record.status === "withdrawn";
  const date = recordDate(record);
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

function TopicNotice({ topic, state: selectedState, selectedInForce, docLinks }: {
  topic: DecisionTopicResolution; state: AnswerState; selectedInForce: boolean; docLinks: DocLinkContext | null;
}): ReactElement | null {
  const state = decisionTopicState(topic);
  if (state === "conflict") return <p className="ub-decision-notice" data-state={state}>
    <span><strong>Nothing is in force.</strong> Approved answers conflict. Select an answer in the timeline to read it.</span>
  </p>;
  if (state === "not-yet-decided") {
    const latestOpen = topic.records.findLast((record) => record.status === "open");
    if (selectedState === state && !latestOpen?.discussion) return null;
    return <p className="ub-decision-notice" data-state={state}>{selectedState !== state && <span>Not yet decided.</span>}
      {latestOpen?.discussion && <> <DocumentReference uuid={latestOpen.discussion} label="Open proposal" context={docLinks} className="ub-decision-notice-action" /></>}
    </p>;
  }
  // Other selections carry their own state in the pill and the return banner.
  if (state !== "under-review" || !selectedInForce) return null;
  const single = topic.pending.length === 1 ? topic.pending[0] : undefined;
  return <p className="ub-decision-notice" data-state={state}>
    <span>{selectedState !== state && <><strong>Under review.</strong>{" "}</>}
      {single === undefined ? `${topic.pending.length} pending proposals.` : "The current answer stays in force."}</span>
    {single?.discussion && <> <DocumentReference uuid={single.discussion} label="Open proposal" context={docLinks} className="ub-decision-notice-action" /></>}
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
    <TopicNotice topic={topic} state={state} selectedInForce={topic.inForce?.uuid === record.uuid} docLinks={docLinks} />
    {(state === "superseded" || (topic.inForce !== null && topic.inForce.uuid !== record.uuid)) &&
      <div className="ub-decision-return" role="status">
        {state === "superseded" && <span className="ub-decision-earlier-answer">
          <strong>Earlier answer.</strong> {replacedAt === null ? "It no longer applies." : <>Replaced <time dateTime={replacedAt.dateTime} title={replacedAt.title}>{replacedAt.label}</time>; it no longer applies.</>}
        </span>}
        {topic.inForce !== null && topic.inForce.uuid !== record.uuid && <>{" "}
          <a className="ub-decision-current-answer ub-decision-notice-action" data-primary="true" href={topicPath}
            onClick={(event) => navigateLink(event, navigate)}>Go to the current answer</a>
        </>}
      </div>}
    <div className="ub-decision-answer-header">
      <div className="ub-decision-answer-heading">
        <span className="ub-decision-answer-caption">ANSWER</span>
        <AnswerPill state={state} />
      </div>
      <RecordedAttribution record={record} state={state} now={now} />
    </div>
  </>;
}

function recordEvent(record: DirectoryEntry, inForce: boolean, now: number): string | null {
  if (record.agentStance) return inForce ? null : "Agent stance, never confirmed";
  if (!record.decidedBy?.trim()) return null;
  if (record.status === "decided") return `${record.decidedBy} decided`;
  if (record.status !== "rejected") return null;
  const created = record.createdAt === undefined ? null : formatTimestamp(record.createdAt, now, true);
  return `${record.decidedBy} rejected the proposal${created === null ? "" : ` from ${created.label}`}`;
}

function Timeline({ topic, selected, linkedRecord, segment, navigate, docLinks, directoryConnection }: {
  topic: DecisionTopicResolution; selected: string; linkedRecord: string | null;
  segment: string; navigate: Navigate; docLinks: DocLinkContext | null;
  directoryConnection: RoomConnection | null;
}): ReactElement {
  const now = useTimestampClock();
  const records = topic.records.toReversed();
  const inForceIndex = records.findIndex((record) => record.uuid === topic.inForce?.uuid);
  return <section className="ub-decision-history" aria-label="Decision history">
    <h2>HISTORY</h2>
    <ol className="ub-decision-timeline">
      {records.map((record, index) => {
        const date = recordDate(record);
        const time = date === undefined ? null : formatTimestamp(date, now, true);
        const chosen = record.uuid === selected;
        const state = answerState(topic, record);
        const inForce = topic.inForce?.uuid === record.uuid;
        const event = recordEvent(record, inForce, now);
        const rfcTitle = !record.discussion || directoryConnection === null ? undefined
          : getDirectoryEntry(directoryConnection.ydoc, record.discussion)?.title || undefined;
        return <li key={record.uuid} data-record={record.uuid} data-selected={chosen} data-state={state}
          data-in-force={inForce} data-rail-green={inForceIndex >= 0 && index <= inForceIndex}>
          <a className="ub-decision-record" href={decisionRecordPath(segment, topic.topic, record.uuid)}
            aria-current={chosen ? "true" : undefined}
            onClick={(event) => navigateLink(event, navigate)}>
            <span className="ub-decision-record-date">
              {time !== null && <time dateTime={time.dateTime} title={time.title}>{time.label}</time>}
            </span>
            <span className="ub-decision-rail-dot" aria-hidden="true" />
            <span className="ub-decision-record-line">
              <AnswerPill state={state} timeline />
              {event && <span className="ub-decision-event">{event}</span>}
              {linkedRecord === record.uuid && <span className="ub-decision-linked">Linked record</span>}
              {chosen && <span className="ub-decision-selection">viewing</span>}
            </span>
            {record.answerPreview && <span className="ub-decision-preview">{record.answerPreview}</span>}
            {record.commentCount !== undefined && <span className="ub-decision-record-comments" role="img"
              aria-label={`${record.commentCount} ${record.commentCount === 1 ? "comment" : "comments"}`}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5a10 10 0 0 1 20 0Z" />
              </svg>{record.commentCount}
            </span>}
          </a>
          {record.discussion && docLinks !== null && <span className="ub-decision-record-rfc">
            <DocumentReference uuid={record.discussion} label={rfcTitle} context={docLinks} compact />
          </span>}
        </li>;
      })}
    </ol>
  </section>;
}

function TopicTitle({ topic, current, selected, connection, directoryConnection, archived }: {
  topic: DecisionTopicResolution; current: DirectoryEntry; selected: string;
  connection: RoomConnection | null; directoryConnection: RoomConnection | null; archived: boolean;
}): ReactElement {
  const observedMeta = useDocMeta(connection);
  const meta = observedMeta ?? (connection === null ? null : getMeta(connection.ydoc));
  const { writable } = useRoomStatus(connection);
  const currentRoom = selected === current.uuid && connection !== null &&
    parseRoom(connection.room).uuid === current.uuid && meta?.uuid === current.uuid && meta.kind === "decision";
  return <DocumentTitle
    value={currentRoom ? meta.title : current.title}
    readOnly={!currentRoom || archived || topic.archived || !writable || directoryConnection === null}
    onChange={(value) => {
      if (!currentRoom || archived || connection === null || !connection.status.writable || directoryConnection === null) return;
      const liveMeta = getMeta(connection.ydoc);
      const liveTopic = resolveDecisionTopics(directoryConnection.ydoc).find((entry) => entry.topic === topic.topic);
      if (liveMeta.uuid !== current.uuid || liveMeta.kind !== "decision" || liveTopic === undefined ||
        liveTopic.archived || decisionCurrentRecord(liveTopic)?.uuid !== current.uuid) return;
      setTitle(connection.ydoc, value);
    }}
  />;
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
    header={<TopicTitle topic={topic} current={current} selected={selected} connection={connection}
      directoryConnection={directoryConnection} archived={editorProps.archived} />}
    beforeAnswer={<>
      <AnswerHeader topic={topic} record={record} topicPath={topicPath} navigate={navigate} docLinks={docLinks} />
      {record.status === "rejected" && rejectionReason && <p className="ub-decision-rejection">Rejection reason: {rejectionReason}</p>}
    </>}
    answerClassName={history ? "ub-decision-answer ub-decision-answer-history" : "ub-decision-answer"}
    afterAnswer={<>
      {record.discussion && docLinks !== null && <p className="ub-decision-rfc">
        <span>RFC</span>{" "}
        <DocumentReference uuid={record.discussion} label={discussionTitle} context={docLinks} chip />
      </p>}
      <Timeline topic={topic} selected={selected} linkedRecord={linkedRecord} segment={segment} navigate={navigate} docLinks={docLinks} directoryConnection={directoryConnection} />
    </>}
  />;
}
