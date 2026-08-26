/**
 * The feedback doc's semantics: the session is the unit, verdicts replace,
 * abstaining is its own bucket, and compaction bounds the event list without
 * inventing usage that nobody reported.
 *
 * The tool surface over this lives in `packages/mcp-server`; the well-known room
 * name is pinned once, in rooms.test.ts.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  compactFeedback,
  getFeedbackEvents,
  hasSessionVerdict,
  readFeedback,
  recordUsage,
  recordVerdict,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A row by uuid, so a test asserts on one document rather than on an order. */
function row(doc: Y.Doc, uuid: string) {
  return readFeedback(doc).find((entry) => entry.uuid === uuid) ?? null;
}

function use(doc: Y.Doc, uuid: string, session: string): boolean {
  return recordUsage(doc, { docUuid: uuid, session, agent: "test", at: 1 });
}

describe("usage counts sessions, never calls", () => {
  it("counts one document read by two sessions as two sessions used", () => {
    const feedback = new Y.Doc();
    expect(use(feedback, ALPHA, "session-a")).toBe(true);
    expect(use(feedback, ALPHA, "session-b")).toBe(true);

    expect(row(feedback, ALPHA)).toMatchObject({
      sessionsUsed: 2,
      unrated: 2,
      helpful: 0,
      unhelpful: 0,
      helpfulRatio: null,
    });
  });

  it("counts ten reads in one session once, and appends one event", () => {
    const feedback = new Y.Doc();
    const appended = Array.from({ length: 10 }, () =>
      use(feedback, ALPHA, "session-a"),
    );

    // Only the first read is a new fact — which is also what the get_doc nudge
    // keys off, so this is the same assertion as "nudged exactly once".
    expect(appended).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(getFeedbackEvents(feedback).length).toBe(1);
    expect(row(feedback, ALPHA)?.sessionsUsed).toBe(1);
  });
});

describe("verdicts", () => {
  it("records a verdict, and a later one from the same session replaces it", () => {
    const feedback = new Y.Doc();
    use(feedback, ALPHA, "session-a");
    recordVerdict(feedback, {
      docUuid: ALPHA,
      session: "session-a",
      agent: "test",
      verdict: "unhelpful",
      reason: "the tool list is out of date",
      at: 2,
    });
    expect(row(feedback, ALPHA)).toMatchObject({
      sessionsUsed: 1,
      helpful: 0,
      unhelpful: 1,
      unrated: 0,
      helpfulRatio: 0,
    });

    recordVerdict(feedback, {
      docUuid: ALPHA,
      session: "session-a",
      agent: "test",
      verdict: "helpful",
      reason: "the contracts section answered it",
      at: 3,
    });
    expect(row(feedback, ALPHA)).toMatchObject({
      sessionsUsed: 1,
      helpful: 1,
      unhelpful: 0,
      unrated: 0,
      helpfulRatio: 1,
    });
    // Replaced, not accumulated: one session is one opinion, and the superseded
    // reason goes with it.
    expect(getFeedbackEvents(feedback).length).toBe(1);
    expect(row(feedback, ALPHA)?.reasons).toEqual([
      {
        session: "session-a",
        agent: "test",
        verdict: "helpful",
        reason: "the contracts section answered it",
        at: 3,
      },
    ]);
  });

  it("keeps used-but-unrated as its own bucket", () => {
    const feedback = new Y.Doc();
    use(feedback, ALPHA, "session-a");
    use(feedback, ALPHA, "session-b");
    use(feedback, ALPHA, "session-c");
    recordVerdict(feedback, {
      docUuid: ALPHA,
      session: "session-a",
      agent: "test",
      verdict: "helpful",
      at: 2,
    });
    recordVerdict(feedback, {
      docUuid: ALPHA,
      session: "session-b",
      agent: "test",
      verdict: "unhelpful",
      at: 2,
    });

    expect(row(feedback, ALPHA)).toMatchObject({
      sessionsUsed: 3,
      helpful: 1,
      unhelpful: 1,
      // Abstaining is legal and visible: session-c is neither helpful nor
      // unhelpful, and is not folded into either.
      unrated: 1,
      helpfulRatio: 0.5,
    });
    expect(hasSessionVerdict(feedback, ALPHA, "session-a")).toBe(true);
    expect(hasSessionVerdict(feedback, ALPHA, "session-c")).toBe(false);
  });

  it("counts a session that only rated as having used the document", () => {
    const feedback = new Y.Doc();
    recordVerdict(feedback, {
      docUuid: ALPHA,
      session: "session-a",
      agent: "test",
      verdict: "helpful",
      at: 1,
    });
    expect(row(feedback, ALPHA)).toMatchObject({ sessionsUsed: 1, helpful: 1 });
    // And the document is already reported on, so no later read re-reports it.
    expect(use(feedback, ALPHA, "session-a")).toBe(false);
  });
});

describe("the feedback doc is an ordinary synced doc", () => {
  it("keeps both events when two sessions rate concurrently on two replicas", () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    use(first, ALPHA, "session-a");
    syncDocs(first, second);

    // Neither replica sees the other's write before it makes its own.
    recordVerdict(first, {
      docUuid: ALPHA,
      session: "session-a",
      agent: "test",
      verdict: "helpful",
      reason: "saved me a code read",
      at: 2,
    });
    recordVerdict(second, {
      docUuid: ALPHA,
      session: "session-b",
      agent: "test",
      verdict: "unhelpful",
      reason: "stale",
      at: 2,
    });
    syncDocs(first, second);

    for (const replica of [first, second]) {
      expect(row(replica, ALPHA)).toMatchObject({
        sessionsUsed: 2,
        helpful: 1,
        unhelpful: 1,
        unrated: 0,
        helpfulRatio: 0.5,
      });
      expect(row(replica, ALPHA)?.reasons.map((entry) => entry.reason).sort()).toEqual(
        ["saved me a code read", "stale"],
      );
    }
    // Convergent, not merely equal in count.
    expect(readFeedback(first)).toEqual(readFeedback(second));
  });
});

describe("the report", () => {
  it("sorts by sessions used and caps the reasons it carries", () => {
    const feedback = new Y.Doc();
    use(feedback, BETA, "session-a");
    for (let index = 0; index < 4; index += 1) {
      recordVerdict(feedback, {
        docUuid: ALPHA,
        session: `session-${index}`,
        agent: "test",
        verdict: "helpful",
        reason: `reason ${index}`,
        at: index,
      });
    }

    const report = readFeedback(feedback, { reasonLimit: 2 });
    expect(report.map((entry) => entry.uuid)).toEqual([ALPHA, BETA]);
    // Newest first, and only as many as asked for.
    expect(report[0]?.reasons.map((entry) => entry.reason)).toEqual([
      "reason 3",
      "reason 2",
    ]);
    expect(report[1]).toMatchObject({ sessionsUsed: 1, reasons: [] });
  });

  it("reports nothing for a corpus nobody has read", () => {
    expect(readFeedback(new Y.Doc())).toEqual([]);
  });
});

describe("compaction", () => {
  it("bounds the event list under a burst and keeps the counts", () => {
    const feedback = new Y.Doc();
    for (let index = 0; index < 600; index += 1) {
      use(feedback, ALPHA, `session-${index}`);
    }
    expect(getFeedbackEvents(feedback).length).toBe(600);

    const folded = compactFeedback(feedback, { limit: 100, keep: 20 });
    expect(folded).toBe(580);
    expect(getFeedbackEvents(feedback).length).toBe(20);
    // Folded into totals, not thrown away.
    expect(row(feedback, ALPHA)).toMatchObject({
      sessionsUsed: 600,
      unrated: 600,
      helpful: 0,
    });

    // Idempotent below the limit: nothing more to fold, nothing more removed.
    expect(compactFeedback(feedback, { limit: 100, keep: 20 })).toBe(0);
    expect(getFeedbackEvents(feedback).length).toBe(20);
  });

  it("never folds half a session, so a later verdict still replaces", () => {
    const feedback = new Y.Doc();
    use(feedback, ALPHA, "long-lived");
    for (let index = 0; index < 30; index += 1) {
      use(feedback, BETA, `session-${index}`);
    }
    // The long-lived session's newest event sits at the end, so none of its
    // events are foldable — including the old one at index 0.
    use(feedback, BETA, "long-lived");
    compactFeedback(feedback, { limit: 20, keep: 5 });

    recordVerdict(feedback, {
      docUuid: ALPHA,
      session: "long-lived",
      agent: "test",
      verdict: "unhelpful",
      at: 99,
    });
    expect(row(feedback, ALPHA)).toMatchObject({
      sessionsUsed: 1,
      unhelpful: 1,
      unrated: 0,
    });
  });

  it("still bounds a list one live session made on its own", () => {
    const feedback = new Y.Doc();
    // Every event belongs to one session, so the idle-session rule can fold
    // nothing. The backstop has to, or the document grows without limit.
    for (let index = 0; index < 300; index += 1) {
      use(feedback, `doc-${index}`, "one-session");
    }
    const folded = compactFeedback(feedback, { limit: 100, keep: 20 });

    expect(folded).toBe(280);
    expect(getFeedbackEvents(feedback).length).toBe(20);
    expect(readFeedback(feedback).length).toBe(300);
    expect(row(feedback, "doc-0")).toMatchObject({ sessionsUsed: 1 });
  });

  it("does nothing to a list under the limit", () => {
    const feedback = new Y.Doc();
    use(feedback, ALPHA, "session-a");
    expect(compactFeedback(feedback, { limit: 100, keep: 20 })).toBe(0);
    expect(getFeedbackEvents(feedback).length).toBe(1);
  });
});
