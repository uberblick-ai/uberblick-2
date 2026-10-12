import type { ComponentProps, MouseEvent, ReactElement } from "react";
import { decisionCurrentRecord, decisionTopicState, getDirectoryEntry, getMeta } from "@uberblick/schema";
import type { DecisionTopicResolution, DirectoryEntry } from "@uberblick/schema";
import type { DocLinkContext } from "../editor/doc-links.js";
import type { RoomConnection } from "../collab/rooms.js";
import { EditorPane } from "./EditorPane.js";
import { decisionRecordPath, docPath } from "./route.js";
import type { Navigate } from "./route.js";
import { formatTimestamp, useTimestampClock } from "./timestamps.js";

const TOPIC_STATES = {
  conflict: "Conflict",
  "under-review": "Under review",
  "agent-stance": "Agent stance",
  "in-force": "In force",
  "not-yet-decided": "Not yet decided",
};

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

function RecordedAttribution({ record }: { record: DirectoryEntry }): ReactElement | null {
  if (record.agentStance || (record.status !== "decided" && record.status !== "rejected")) return null;
  if (!record.decidedBy && !record.decidedAt) return null;
  return <p className="ub-muted ub-decision-attribution">
    {record.status === "rejected" ? "Rejected" : "Decided"}
    {record.decidedBy && <> by {record.decidedBy}</>}
    {record.decidedAt && <> · {record.decidedAt}</>}
  </p>;
}

function TopicNotice({ topic, docLinks }: {
  topic: DecisionTopicResolution; docLinks: DocLinkContext | null;
}): ReactElement | null {
  const state = decisionTopicState(topic);
  if (state === "conflict") return <p className="ub-decision-notice"><strong>Nothing is in force.</strong> Approved answers conflict. Select an answer in the timeline to read it.</p>;
  if (state === "not-yet-decided") {
    const latestOpen = topic.records.findLast((record) => record.status === "open");
    return <p className="ub-decision-notice">Not yet decided.
      {latestOpen?.discussion && <> <DocumentReference uuid={latestOpen.discussion} label="Open proposal" context={docLinks} /></>}
    </p>;
  }
  if (state !== "under-review") return null;
  const single = topic.pending.length === 1 ? topic.pending[0] : undefined;
  return <p className="ub-decision-notice"><strong>Under review.</strong>{" "}
    {single === undefined ? `${topic.pending.length} pending proposals.` : "The current answer stays in force."}
    {single?.discussion && <> <DocumentReference uuid={single.discussion} label="Open proposal" context={docLinks} /></>}
  </p>;
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
  if (topic === null || selected === null) return <EditorPane {...editorProps} directoryConnection={directoryConnection} />;
  const current = decisionCurrentRecord(topic);
  const record = topic.records.find((entry) => entry.uuid === selected);
  if (current === null || record === undefined) throw new Error("Decision selection must belong to its topic");
  const { segment, docLinks, connection } = editorProps;
  const history = topic.inForce?.uuid !== selected;
  const topicPath = docPath(segment, topic.topic);
  const rejectionReason = connection === null ? undefined : getMeta(connection.ydoc).rejectionReason;
  const relatedTitle = current.governs === undefined || directoryConnection === null ? undefined
    : getDirectoryEntry(directoryConnection.ydoc, current.governs)?.title || undefined;
  return <EditorPane {...editorProps}
    directoryConnection={directoryConnection}
    decisionView
    copyPath={explicit ? decisionRecordPath(segment, topic.topic, selected) : topicPath}
    header={<>
      <h1 className="ub-title">{current.title || "Untitled"}</h1>
      {current.governs && <p className="ub-decision-related">Related page: <DocumentReference uuid={current.governs} label={relatedTitle} context={docLinks} /></p>}
    </>}
    beforeAnswer={<>
      <p className="ub-decision-topic-state">{TOPIC_STATES[decisionTopicState(topic)]}</p>
      <TopicNotice topic={topic} docLinks={docLinks} />
      <div className="ub-decision-answer-label">
        <strong>{history ? `History · ${recordState(topic, record)}` : recordState(topic, record)}</strong>
        {history && record.agentStance && <span>Agent stance</span>}
        {history && topic.inForce !== null && <a href={topicPath} onClick={(event) => navigateLink(event, navigate)}>Go to the current answer</a>}
      </div>
      <RecordedAttribution record={record} />
      {record.status === "rejected" && rejectionReason && <p className="ub-decision-rejection">Rejection reason: {rejectionReason}</p>}
    </>}
    answerClassName={history ? "ub-decision-answer ub-decision-answer-history" : "ub-decision-answer"}
    afterAnswer={<Timeline topic={topic} selected={selected} linkedRecord={linkedRecord} segment={segment} navigate={navigate} docLinks={docLinks} />}
  />;
}
