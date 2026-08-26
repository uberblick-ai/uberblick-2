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
 *   - **Only settled pairs fold, whole.** A (document, session) pair is
 *     foldable when it has a *verdict* and its newest event sits before the
 *     cut. Rating is the last thing a session says about a document — a
 *     verdict replaces the pair's earlier events — so a folded pair has nothing
 *     left to come, and the fold is exact. (Exact to the same boundary
 *     everything here has: a session that comes back to *re-rate* a document a
 *     whole compaction window later is counted twice for it, like one that
 *     re-reads one whose event the backstop folded. It takes a session that
 *     outlives the window.) An unrated `used` event stays live
 *     however old it is, because folding it would count the session once in
 *     `totals` and again the moment it rated the document: one session, two
 *     sessionsUsed. Cheap to leave alone, wrong to fold.
 *   - **A hard backstop.** A corpus read by sessions that never rate anything
 *     is entirely made of events the rule above will not fold, so when the
 *     settled fold cannot bring the list under the limit, everything before the
 *     cut is folded regardless. **This is the path that overcounts in ordinary use**: a
 *     session whose `used` event was folded that way and which then rates the
 *     document is counted twice for it — `sessionsUsed` and one bucket too high
 *     by exactly one per (document, session) it happens to. It is the right
 *     trade for advisory telemetry, an unbounded document being a real cost and
 *     a rare doubled count not, but it is a real inaccuracy and both this
 *     module and `feedback_report` say so rather than implying exactness.
 *
 * `totals` is written per document as a whole object, and this is the other
 * place concurrency shows. Two replicas that fold the *same* events compute the
 * same totals and converge on them, which is the ordinary case — both trim the
 * same items, and Yjs deletes are idempotent. Two replicas that fold *different*
 * slices (one had seen more events than the other) converge on whichever
 * whole-object write Yjs orders last, so the wider slice's extra events can be
 * trimmed without being counted. That direction is bounded and one-way: the
 * result is never higher than the truth, and never lower than the narrower
 * fold's own count plus whatever events are still live.
 *
 * Reasons are not folded. `totals` keeps counts only, so a reason survives
 * exactly as long as the event carrying it — which is what "recent reasons"
 * means in a report.
 */

import type * as Y from "yjs";
import type {
  DocFeedback,
  FeedbackEvent,
  FeedbackReason,
  FeedbackTotals,
  FeedbackVerdict,
} from "./types.js";

/** The key of the append-only event array inside a feedback doc. */
const FEEDBACK_EVENTS_KEY = "events";

/** The key of the folded per-document totals inside a feedback doc. */
const FEEDBACK_TOTALS_KEY = "totals";

/** Events above which {@link compactFeedback} folds. */
const FEEDBACK_EVENT_LIMIT = 500;

/** Events {@link compactFeedback} leaves in place, newest first. */
const FEEDBACK_KEEP_EVENTS = 100;

/** Reasons {@link readFeedback} returns per document, newest first. */
const REASON_LIMIT = 5;

/** The append-only event array inside a feedback doc. */
export function getFeedbackEvents(feedbackDoc: Y.Doc): Y.Array<FeedbackEvent> {
  return feedbackDoc.getArray<FeedbackEvent>(FEEDBACK_EVENTS_KEY);
}

/** The folded per-document totals inside a feedback doc. */
export function getFeedbackTotals(feedbackDoc: Y.Doc): Y.Map<unknown> {
  return feedbackDoc.getMap<unknown>(FEEDBACK_TOTALS_KEY);
}

/**
 * A stored event, or null when the value is not an object.
 *
 * Shape-checked, never repaired: every event in here was written by this
 * module, and a reader that silently rewrote a field would hide the one case
 * worth seeing.
 */
function readEvent(value: unknown): FeedbackEvent | null {
  if (typeof value !== "object" || value === null) return null;
  return value as FeedbackEvent;
}

/** Stored totals, with a missing field read as zero. */
function readTotals(value: unknown): FeedbackTotals {
  const stored =
    typeof value === "object" && value !== null
      ? (value as Partial<FeedbackTotals>)
      : {};
  return {
    sessionsUsed: stored.sessionsUsed ?? 0,
    helpful: stored.helpful ?? 0,
    unhelpful: stored.unhelpful ?? 0,
    unrated: stored.unrated ?? 0,
  };
}

/** The key one (document, session) pair folds under. */
function pairKey(event: FeedbackEvent): string {
  return `${event.docUuid}\u0000${event.session}`;
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
): boolean {
  return events(feedbackDoc).some(
    (event) => event.docUuid === docUuid && event.session === session,
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
 * The dedupe is the stored events, so it is exactly as durable as they are: a
 * session whose `used` event the compaction backstop folded away reports the
 * document again, and is counted twice for it. That is the same bounded
 * inaccuracy the backstop already carries — see the module header — and it takes
 * a session long-lived enough to outlive a whole compaction window.
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

/**
 * The whole report: live events folded together with the totals compaction
 * already folded, sorted by sessions used (descending), then by uuid so every
 * replica produces the same order.
 *
 * Documents nothing has ever reported on are absent. There is no backfill and
 * no zero row: telemetry starts when an agent produces some.
 */
export function readFeedback(feedbackDoc: Y.Doc): DocFeedback[] {
  const live = events(feedbackDoc);
  const byDoc = foldSessions(live);

  const reasons = new Map<string, FeedbackReason[]>();
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const event = live[index];
    if (event === undefined || event.kind === "used") continue;
    if (event.reason === undefined) continue;
    const collected = reasons.get(event.docUuid) ?? [];
    if (collected.length >= REASON_LIMIT) continue;
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
 * Settled (document, session) pairs only — rated, and done writing — with a
 * hard backstop that folds anything before the cut when that cannot bound the
 * list. See the module header for both rules, for the overcount the backstop
 * can cause, and for what a concurrent compaction costs.
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
  // Per (document, session): where its newest event sits, and whether it has
  // said the last thing it is going to say about that document.
  const newest = new Map<string, number>();
  const rated = new Set<string>();
  stored.forEach((event, index) => {
    if (event === null) return;
    const key = pairKey(event);
    newest.set(key, index);
    if (event.kind !== "used") rated.add(key);
  });

  const settled: number[] = [];
  const before: number[] = [];
  stored.forEach((event, index) => {
    if (index >= cut) return;
    before.push(index);
    // A malformed entry folds as nothing: it counts for no session and nothing
    // can read it, so leaving it in place would only pad the list.
    if (event === null) {
      settled.push(index);
      return;
    }
    const key = pairKey(event);
    if (rated.has(key) && (newest.get(key) ?? index) < cut) settled.push(index);
  });

  const indexes = stored.length - settled.length > limit ? before : settled;
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
