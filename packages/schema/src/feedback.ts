/**
 * The feedback document: which documents agents actually used, and whether the
 * documents helped.
 *
 * One Y.Doc per workspace, in the well-known room `<workspaceId>/_feedback`
 * (see `rooms.ts`) — an ordinary synced document, logged, hydrated offline and
 * merged like every other room. It is telemetry, and the vocabulary is chosen
 * to keep that honest: **self-reported, session-scoped, advisory**. Nothing
 * here is audit data, nothing here is identity, and no reader should treat a
 * count as a measurement of anything but what agents said about themselves.
 *
 * Layout — two top-level keys:
 *   - `events` Y.Array<FeedbackEvent>: `{docUuid, session, agent, kind,
 *     reason?, at}`, appended in the order they happened
 *   - `totals` Y.Map: docUuid → `{sessionsUsed, helpful, unhelpful, unrated}`,
 *     the fold of events compaction has already removed
 *
 * ## Why events, and why an array
 *
 * The counts a reader wants — how many agent sessions read this document, how
 * many called it helpful — are folds over per-session facts, so the storage is
 * per-session facts. Appending to a Y.Array is the one shape where two replicas
 * writing at once cannot lose each other: both inserts survive, in some order,
 * and the fold does not care which order that is. A Y.Map of counters would
 * resolve a concurrent set by clientID — a coin flip that silently drops one
 * session's report — and a Y.Map keyed per session would be the same array with
 * extra ceremony.
 *
 * ## The session is the unit
 *
 * A document counts as used **once per agent session**, however many times that
 * session read it: {@link recordUsage} appends nothing when the session already
 * has an event for the document. Ten reads are one signal about one document,
 * and counting the calls would just measure how chatty an agent is.
 *
 * A session's verdict is likewise one fact, not a history: {@link recordVerdict}
 * removes that session's earlier events for the document before appending, so
 * re-rating replaces rather than accumulates. Deleting there is safe where it
 * would not be in general — a session is one process, so nobody else is writing
 * the events being removed, and a concurrent reader on another replica simply
 * sees the delete merge in. The fold takes the last verdict in stored order
 * anyway, so a replica that somehow held two would still converge with every
 * other one: the winner is a position, never a timestamp.
 *
 * `at` is epoch milliseconds from the clock of whichever replica wrote it —
 * display and ordering-by-eye only. It decides nothing.
 *
 * ## Compaction, and what it costs
 *
 * Events accumulate one per (document, session), so the list grows with the
 * corpus times the sessions that ever ran. {@link compactFeedback} folds old
 * events into per-doc `totals` and trims them, the same snapshot-then-trim
 * discipline the update log uses.
 *
 * Two rules, both deliberate:
 *
 *   - **Fold whole sessions, never half of one.** An event is foldable only
 *     when its session's newest event also sits before the cut. Folding half a
 *     session would count it once in `totals` and again from the events it has
 *     left, so a session that used a document and rated it later would inflate
 *     both buckets.
 *   - **A hard backstop.** One long-lived session reading a large corpus is
 *     entirely made of events that are not foldable by the rule above, so when
 *     the idle-session fold cannot bring the list under the limit, everything
 *     before the cut is folded regardless. That trades the exactness above for
 *     a bound, and it is the right trade for advisory telemetry: an unbounded
 *     document is a real cost, a doubled count in a rare race is not.
 *
 * `totals` is written per document as a whole object, and this is the one place
 * concurrency can lose something. Two replicas that fold the *same* events
 * compute the same totals and converge on them, which is the ordinary case —
 * both trim the same items, and Yjs deletes are idempotent. Two replicas that
 * fold *different* slices (one had seen more events than the other) converge on
 * whichever whole-object write Yjs orders last, so the wider slice's extra
 * events can be trimmed without being counted. That direction is deliberate:
 * compaction can undercount, never overcount, and usage telemetry that
 * understates itself is the safe failure.
 *
 * Reasons are not folded. `totals` keeps counts only, so a reason survives
 * exactly as long as the event carrying it — which is what "recent reasons"
 * means in a report.
 */

import type * as Y from "yjs";
import type {
  DocFeedback,
  FeedbackEvent,
  FeedbackKind,
  FeedbackReason,
  FeedbackTotals,
  FeedbackVerdict,
} from "./types.js";

/** The key of the append-only event array inside a feedback doc. */
export const FEEDBACK_EVENTS_KEY = "events";

/** The key of the folded per-document totals inside a feedback doc. */
export const FEEDBACK_TOTALS_KEY = "totals";

/** Events above which {@link compactFeedback} folds. */
export const FEEDBACK_EVENT_LIMIT = 500;

/** Events {@link compactFeedback} leaves in place, newest first. */
export const FEEDBACK_KEEP_EVENTS = 100;

/** Reasons {@link readFeedback} returns per document, newest first. */
const DEFAULT_REASON_LIMIT = 5;

/** The append-only event array inside a feedback doc. */
export function getFeedbackEvents(feedbackDoc: Y.Doc): Y.Array<FeedbackEvent> {
  return feedbackDoc.getArray<FeedbackEvent>(FEEDBACK_EVENTS_KEY);
}

/** The folded per-document totals inside a feedback doc. */
export function getFeedbackTotals(feedbackDoc: Y.Doc): Y.Map<unknown> {
  return feedbackDoc.getMap<unknown>(FEEDBACK_TOTALS_KEY);
}

/** A stored event, or null when the value is not one. */
function readEvent(value: unknown): FeedbackEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<FeedbackEvent>;
  if (typeof candidate.docUuid !== "string" || candidate.docUuid === "") {
    return null;
  }
  if (typeof candidate.session !== "string" || candidate.session === "") {
    return null;
  }
  const kind = candidate.kind;
  if (kind !== "used" && kind !== "helpful" && kind !== "unhelpful") {
    return null;
  }
  return {
    docUuid: candidate.docUuid,
    session: candidate.session,
    agent: typeof candidate.agent === "string" ? candidate.agent : "",
    kind,
    ...(typeof candidate.reason === "string" && candidate.reason !== ""
      ? { reason: candidate.reason }
      : {}),
    at: typeof candidate.at === "number" && Number.isFinite(candidate.at)
      ? candidate.at
      : 0,
  };
}

/** Stored totals, defaulting every missing field to zero. */
function readTotals(value: unknown): FeedbackTotals {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Partial<FeedbackTotals>)
      : {};
  const count = (input: unknown): number =>
    typeof input === "number" && Number.isFinite(input) && input > 0
      ? Math.trunc(input)
      : 0;
  return {
    sessionsUsed: count(candidate.sessionsUsed),
    helpful: count(candidate.helpful),
    unhelpful: count(candidate.unhelpful),
    unrated: count(candidate.unrated),
  };
}

/** Every readable event, in stored order. */
function events(feedbackDoc: Y.Doc): FeedbackEvent[] {
  const out: FeedbackEvent[] = [];
  for (const item of getFeedbackEvents(feedbackDoc).toArray()) {
    const event = readEvent(item);
    if (event !== null) out.push(event);
  }
  return out;
}

/** Whether this session has already reported anything about this document. */
function sessionEvent(
  feedbackDoc: Y.Doc,
  docUuid: string,
  session: string,
  kinds?: readonly FeedbackKind[],
): boolean {
  return events(feedbackDoc).some(
    (event) =>
      event.docUuid === docUuid &&
      event.session === session &&
      (kinds === undefined || kinds.includes(event.kind)),
  );
}

export interface RecordUsageInput {
  docUuid: string;
  /** The reading session's id — one MCP server process. */
  session: string;
  /** The session's self-asserted display name. Never identity. */
  agent: string;
  /** Epoch ms. Display only. */
  at?: number;
}

/**
 * Record that this session used this document, once.
 *
 * @returns whether an event was appended — false when this session has already
 * reported on the document, which is also the answer to "has this session been
 * told about rate_doc yet".
 */
export function recordUsage(
  feedbackDoc: Y.Doc,
  input: RecordUsageInput,
): boolean {
  if (sessionEvent(feedbackDoc, input.docUuid, input.session)) {
    return false;
  }
  getFeedbackEvents(feedbackDoc).push([
    {
      docUuid: input.docUuid,
      session: input.session,
      agent: input.agent,
      kind: "used",
      at: input.at ?? Date.now(),
    },
  ]);
  return true;
}

export interface RecordVerdictInput extends RecordUsageInput {
  verdict: FeedbackVerdict;
  /** Why, in the rater's own words. The rewrite brief, when there is one. */
  reason?: string;
}

/**
 * Record this session's verdict on this document, replacing whatever it said
 * before. A verdict implies usage, so a session that only ever rates a document
 * still counts as having used it.
 */
export function recordVerdict(
  feedbackDoc: Y.Doc,
  input: RecordVerdictInput,
): void {
  const list = getFeedbackEvents(feedbackDoc);
  feedbackDoc.transact(() => {
    // Back to front, so the indexes stay valid as they go.
    const stored = list.toArray();
    for (let index = stored.length - 1; index >= 0; index -= 1) {
      const event = readEvent(stored[index]);
      if (event === null) continue;
      if (event.docUuid !== input.docUuid) continue;
      if (event.session !== input.session) continue;
      list.delete(index, 1);
    }
    list.push([
      {
        docUuid: input.docUuid,
        session: input.session,
        agent: input.agent,
        kind: input.verdict,
        ...(input.reason === undefined || input.reason === ""
          ? {}
          : { reason: input.reason }),
        at: input.at ?? Date.now(),
      },
    ]);
  });
}

/** Whether this session has already rated this document. */
export function hasSessionVerdict(
  feedbackDoc: Y.Doc,
  docUuid: string,
  session: string,
): boolean {
  return sessionEvent(feedbackDoc, docUuid, session, ["helpful", "unhelpful"]);
}

/** Per document: each session that reported, and its verdict if it gave one. */
function foldSessions(
  list: readonly FeedbackEvent[],
): Map<string, Map<string, FeedbackVerdict | null>> {
  const byDoc = new Map<string, Map<string, FeedbackVerdict | null>>();
  for (const event of list) {
    let sessions = byDoc.get(event.docUuid);
    if (sessions === undefined) {
      sessions = new Map<string, FeedbackVerdict | null>();
      byDoc.set(event.docUuid, sessions);
    }
    // A verdict later in stored order replaces an earlier one; `used` never
    // clears a verdict, because rating a document is also using it.
    if (event.kind === "used") {
      if (!sessions.has(event.session)) sessions.set(event.session, null);
    } else {
      sessions.set(event.session, event.kind);
    }
  }
  return byDoc;
}

/** The buckets one document's sessions fall into. */
function tally(sessions: Map<string, FeedbackVerdict | null>): FeedbackTotals {
  let helpful = 0;
  let unhelpful = 0;
  for (const verdict of sessions.values()) {
    if (verdict === "helpful") helpful += 1;
    else if (verdict === "unhelpful") unhelpful += 1;
  }
  return {
    sessionsUsed: sessions.size,
    helpful,
    unhelpful,
    unrated: sessions.size - helpful - unhelpful,
  };
}

export interface ReadFeedbackOptions {
  /** Reasons per document, newest first. Default 5. */
  reasonLimit?: number;
}

/**
 * The whole report: live events folded together with the totals compaction
 * already folded, sorted by sessions used (descending), then by uuid so every
 * replica produces the same order.
 *
 * Documents nothing has ever reported on are absent. There is no backfill and
 * no zero row: telemetry starts when an agent produces some.
 */
export function readFeedback(
  feedbackDoc: Y.Doc,
  options: ReadFeedbackOptions = {},
): DocFeedback[] {
  const reasonLimit = Math.max(0, options.reasonLimit ?? DEFAULT_REASON_LIMIT);
  const live = events(feedbackDoc);
  const byDoc = foldSessions(live);

  const reasons = new Map<string, FeedbackReason[]>();
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const event = live[index];
    if (event === undefined || event.kind === "used") continue;
    if (event.reason === undefined) continue;
    const collected = reasons.get(event.docUuid) ?? [];
    if (collected.length >= reasonLimit) continue;
    collected.push({
      session: event.session,
      agent: event.agent,
      verdict: event.kind,
      reason: event.reason,
      at: event.at,
    });
    reasons.set(event.docUuid, collected);
  }

  const uuids = new Set<string>(byDoc.keys());
  const totals = getFeedbackTotals(feedbackDoc);
  for (const uuid of totals.keys()) uuids.add(uuid);

  const out: DocFeedback[] = [];
  for (const uuid of uuids) {
    const folded = readTotals(totals.get(uuid));
    const fresh = tally(byDoc.get(uuid) ?? new Map());
    const helpful = folded.helpful + fresh.helpful;
    const unhelpful = folded.unhelpful + fresh.unhelpful;
    const rated = helpful + unhelpful;
    out.push({
      uuid,
      sessionsUsed: folded.sessionsUsed + fresh.sessionsUsed,
      helpful,
      unhelpful,
      unrated: folded.unrated + fresh.unrated,
      helpfulRatio: rated === 0 ? null : helpful / rated,
      reasons: reasons.get(uuid) ?? [],
    });
  }
  out.sort((a, b) => {
    if (a.sessionsUsed !== b.sessionsUsed) return b.sessionsUsed - a.sessionsUsed;
    return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
  });
  return out;
}

export interface CompactFeedbackOptions {
  /** Fold only once the list is longer than this. Default 500. */
  limit?: number;
  /** Events left in place, newest first. Default 100. */
  keep?: number;
}

/**
 * Fold old events into per-document totals and trim them.
 *
 * Whole sessions only, with a hard backstop when that cannot bring the list
 * under the limit — see the module header for both rules and for what a
 * concurrent compaction costs.
 *
 * @returns how many events were folded. Zero means the list was short enough,
 * which is the ordinary answer.
 */
export function compactFeedback(
  feedbackDoc: Y.Doc,
  options: CompactFeedbackOptions = {},
): number {
  const limit = Math.max(1, options.limit ?? FEEDBACK_EVENT_LIMIT);
  const keep = Math.max(0, Math.min(options.keep ?? FEEDBACK_KEEP_EVENTS, limit));
  const list = getFeedbackEvents(feedbackDoc);
  const stored = list.toArray().map(readEvent);
  if (stored.length <= limit) return 0;

  const cut = stored.length - keep;
  const lastIndex = new Map<string, number>();
  stored.forEach((event, index) => {
    if (event !== null) lastIndex.set(event.session, index);
  });

  const idle: number[] = [];
  const before: number[] = [];
  stored.forEach((event, index) => {
    if (index >= cut) return;
    before.push(index);
    // A malformed entry is folded as nothing: it counts for no session and
    // nothing can read it, so leaving it in place would only pad the list.
    if (event === null || (lastIndex.get(event.session) ?? index) < cut) {
      idle.push(index);
    }
  });

  const indexes = stored.length - idle.length > limit ? before : idle;
  if (indexes.length === 0) return 0;

  const folded = indexes
    .map((index) => stored[index])
    .filter((event): event is FeedbackEvent => event !== undefined && event !== null);
  const byDoc = foldSessions(folded);

  feedbackDoc.transact(() => {
    const totals = getFeedbackTotals(feedbackDoc);
    for (const [uuid, sessions] of byDoc) {
      const existing = readTotals(totals.get(uuid));
      const added = tally(sessions);
      totals.set(uuid, {
        sessionsUsed: existing.sessionsUsed + added.sessionsUsed,
        helpful: existing.helpful + added.helpful,
        unhelpful: existing.unhelpful + added.unhelpful,
        unrated: existing.unrated + added.unrated,
      } satisfies FeedbackTotals);
    }
    for (let position = indexes.length - 1; position >= 0; position -= 1) {
      const index = indexes[position];
      if (index !== undefined) list.delete(index, 1);
    }
  });
  return folded.length;
}
