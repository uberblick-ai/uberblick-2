import { decisionCurrentRecord, decisionTopicState } from "@uberblick/schema";
import type { DecisionTopicResolution, DirectoryEntry } from "@uberblick/schema";
import type { ReactElement } from "react";
import { TOPIC_STATES, TOPIC_STATE_ORDER } from "./decision-state.js";
import { docPath } from "./route.js";
import type { Navigate } from "./route.js";
import { formatShortTimestamp, useTimestampClock } from "./timestamps.js";

export function decisionsSummary(topics: readonly DecisionTopicResolution[]): string {
  const count = topics.length;
  const summary = `${count} ${count === 1 ? "decision" : "decisions"}`;
  if (count > 0 && topics.every((topic) => decisionTopicState(topic) === "in-force")) return `${summary} in force`;
  return summary + TOPIC_STATE_ORDER.filter((state) => state !== "in-force").flatMap((state) => {
    const matching = topics.filter((topic) => decisionTopicState(topic) === state).length;
    return matching === 0 ? [] : [` · ${matching} ${TOPIC_STATES[state].toLowerCase()}`];
  }).join("");
}

export function focusDecisions(id: string): void {
  const block = document.getElementById(id);
  block?.scrollIntoView({ block: "start" });
  block?.focus({ preventScroll: true });
}

export function DecisionsLink({ topics, id }: {
  topics: readonly DecisionTopicResolution[]; id: string;
}): ReactElement | null {
  if (topics.length === 0) return null;
  return <a className="ub-decisions-link" href={`#${id}`} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    focusDecisions(id);
  }}>{decisionsSummary(topics)} <span aria-hidden="true">↓</span></a>;
}

function Attribution({ record, now }: { record: DirectoryEntry; now: number }): ReactElement {
  const time = record.decidedAt === undefined ? null : formatShortTimestamp(record.decidedAt, now);
  if (!record.decidedBy && time === null) return <span className="ub-decisions-state-label">In force</span>;
  return <>
    {record.decidedBy}
    {record.decidedBy && time !== null && " · "}
    {time !== null && <time dateTime={time.dateTime} title={time.title}>{time.label}</time>}
  </>;
}

export function DecisionsBlock({ topics, segment, navigate, id }: {
  topics: readonly DecisionTopicResolution[]; segment: string; navigate: Navigate; id: string;
}): ReactElement | null {
  const now = useTimestampClock();
  if (topics.length === 0) return null;
  const ordered = [...topics].sort((left, right) => {
    const byState = TOPIC_STATE_ORDER.indexOf(decisionTopicState(left)) - TOPIC_STATE_ORDER.indexOf(decisionTopicState(right));
    return byState || (decisionCurrentRecord(left)?.title || "Untitled").localeCompare(decisionCurrentRecord(right)?.title || "Untitled");
  });
  return <section className="ub-decisions-block" id={id} aria-label="Decisions" tabIndex={-1}>
    <header className="ub-decisions-heading">
      <h2>Decisions</h2>
      <span className="ub-decisions-summary">{decisionsSummary(ordered)}</span>
    </header>
    <ul className="ub-decisions-list">
      {ordered.map((topic) => {
        const state = decisionTopicState(topic);
        const current = decisionCurrentRecord(topic);
        const question = current?.title || "Untitled";
        const preview = state === "conflict" ? "Nothing is in force."
          : state === "not-yet-decided" ? null : topic.inForce?.answerPreview;
        return <li key={topic.topic}>
          <a className="ub-decisions-row" href={docPath(segment, topic.topic)}
            aria-label={`${TOPIC_STATES[state]}: ${question}`}
            data-state={state}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate(event.currentTarget.pathname);
            }}>
            <span className="ub-decisions-row-line">
              <span className="ub-decisions-mark" aria-hidden="true" />
              <span className="ub-decisions-question">{question}</span>
              <span className="ub-decisions-row-meta">
                {state === "in-force" && current !== null ? <Attribution record={current} now={now} />
                  : <span className="ub-decisions-state-label">{TOPIC_STATES[state]}</span>}
              </span>
            </span>
            {preview != null && <span className="ub-decisions-row-preview">{preview}</span>}
          </a>
        </li>;
      })}
    </ul>
  </section>;
}
