/**
 * The feedback tools: rate_doc, feedback_report — and the usage get_doc records.
 *
 * Docs are written once and consumed forever, so the corpus rots invisibly
 * unless the agents reading it say something. This module is the whole
 * instrument: which documents agent sessions actually read, what those sessions
 * thought of them, and a report a reviewing pass can act on.
 *
 * `@uberblick/schema`'s feedback module owns the semantics — the session is the
 * unit, events are append-only, compaction folds old events into per-doc totals
 * — and the synced `<workspaceId>/_feedback` room owns the data, hydrated,
 * logged and merged like every other room. What this module adds is the agent
 * surface, and three things about it are deliberate:
 *
 * 1. **get_doc records usage, and says nothing about durability for it.**
 *    Reading a document is what makes it used, so the read is where the event
 *    is written. It is best-effort by construction: a failure to record is
 *    logged and swallowed rather than turned into a failed read, because
 *    telemetry must never cost an agent the document it asked for. An append
 *    the log actually refuses is still the replica set's sticky persistence
 *    failure, so the next tool call reports it — nothing is hidden, it is just
 *    not reported by the tool that was only supposed to read.
 * 2. **The nudge is the first read's answer, not a piece of state.** A session
 *    is told rate_doc exists exactly once per document, and "exactly once" falls
 *    out of the storage rather than out of a set kept on the side: the first
 *    read is precisely the read that appended an event, and every later one —
 *    or any read after this session already rated the document — appends
 *    nothing and says nothing.
 *
 *    The one exception, which is the dedupe's own boundary rather than a second
 *    rule: the events are what remember, so a session that outlives a whole
 *    compaction window can have its event folded away — by the backstop, or as
 *    part of a settled pair it had already rated — and will then report, and be
 *    nudged about, that document a second time. The cost is one extra count per
 *    (document, session) per window the session outlives, so a session spanning
 *    eight of them reads as eight sessions rather than as one. It takes a very
 *    long session, and get_doc's description says so rather than promising an
 *    exactness the storage does not have.
 * 3. **feedback_report opens no document rooms.** It reads `_feedback` for the
 *    numbers and the directory for titles, both already attached, so the number
 *    of rooms it joins is zero whatever the corpus costs — the work itself is
 *    linear in the documents reported on, because the fold walks every event
 *    and the sort walks every row. Constant in connections, not in time. A uuid
 *    the directory has never heard of is reported with a null title rather than
 *    resolved: joining its room to find out would be the one thing this tool
 *    promises not to do.
 *
 * The honesty the tool descriptions owe an agent, stated once here: these
 * numbers are self-reported by agent sessions, scoped to sessions rather than
 * to people or calls, and advisory. They are an instrument for deciding which
 * documents to rewrite, merge or retire — never an audit trail, and never a
 * measurement of anything a session did not volunteer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  compactFeedback,
  getDirectoryEntry,
  getFeedbackEvents,
  getFeedbackTotals,
  readFeedback,
  recordUsage,
  recordVerdict,
} from "@uberblick/schema";
import type { DirectoryEntry, DocFeedback } from "@uberblick/schema";
import { z } from "zod";
import { log } from "./log.js";
import type { Replica, Replicas } from "./replica.js";

/** What the tools need from `tools.ts`, so neither module imports the other. */
export interface FeedbackToolContext {
  /** The directory entry for a uuid, or a `doc_not_found` failure. */
  requireStub(uuid: string): DirectoryEntry;
  /** `{applied, synced, hub}` for a write that just landed. */
  durability(replica: Replica): Record<string, unknown>;
  /** Wrap a handler so every throw becomes a structured tool failure. */
  guarded<Args>(
    handler: (args: Args) => Promise<CallToolResult>,
  ): (args: Args) => Promise<CallToolResult>;
  json(payload: unknown): CallToolResult;
}

/**
 * The one line get_doc adds for a document this session has not rated.
 *
 * Deliberately a sentence, not an error and not a required step: an agent that
 * ignores it has done nothing wrong, and an agent that acts on it costs one
 * call.
 */
export const RATE_DOC_NUDGE =
  "Optional: when you are done with this document, call rate_doc " +
  '{uuid, verdict: "helpful" | "unhelpful", reason} to say whether it earned its tokens. ' +
  "One verdict per document per session, advisory only — abstaining is fine, and nothing here blocks on it.";

/** What every feedback tool says about what these numbers are. */
const FEEDBACK_IS_ADVISORY =
  "Semantics, stated plainly: this is self-reported, session-scoped, advisory telemetry — not audit data. " +
  "A session is one MCP server process, and `agent` is a name a client asserted about itself; neither is an " +
  "identity anyone verified. Usage counts SESSIONS, not calls: a session that reads a document ten times counts " +
  "once, and a session that reads nothing counts not at all. Verdicts are opinions volunteered by whoever read " +
  "the document, and abstaining is legal — `unrated` is its own bucket, never folded into either verdict.";

/**
 * Record that this session used this document, and answer with the nudge when
 * this is the session's first contact with it.
 *
 * Never throws: a document read must not fail because its telemetry could not
 * be written. See the header.
 */
export function recordDocUsage(
  replicas: Replicas,
  uuid: string,
): string | null {
  try {
    const feedback = replicas.feedback();
    const first = recordUsage(feedback.doc, {
      docUuid: uuid,
      session: replicas.config.sessionId,
      agent: replicas.name,
    });
    if (first) {
      compactFeedback(feedback.doc);
    }
    return first ? RATE_DOC_NUDGE : null;
  } catch (error) {
    log.warn("failed to record document usage", error);
    return null;
  }
}

/** One document's row, with the title its directory stub caches. */
function reportRow(
  replicas: Replicas,
  row: DocFeedback,
): Record<string, unknown> {
  const stub = getDirectoryEntry(replicas.directory().doc, row.uuid);
  return {
    uuid: row.uuid,
    title: stub?.title ?? null,
    ...(stub?.deleted === true ? { archived: true } : {}),
    sessionsUsed: row.sessionsUsed,
    helpful: row.helpful,
    unhelpful: row.unhelpful,
    unrated: row.unrated,
    helpfulRatio: row.helpfulRatio,
    reasons: row.reasons,
  };
}

export function registerFeedbackTools(
  server: McpServer,
  replicas: Replicas,
  context: FeedbackToolContext,
): void {
  server.registerTool(
    "rate_doc",
    {
      title: "Rate a document you used",
      description:
        "Say whether a document you read helped you. `reason` is the useful half — one sentence in your own " +
        "words, which is what a rewrite is briefed from, so prefer \"the tool list is out of date\" over " +
        "\"unclear\".\n\n" +
        "One verdict per document per session: rating again replaces what this session said before, rather than " +
        "adding to it — it replaces the earlier event, so this holds for as long as that event is still stored. " +
        "Rating a document also counts as using it, and rating is what lets compaction fold this session's report " +
        "on it; an unrated read is left alone. Should a session rate a document again long after its earlier " +
        "verdict was folded away, there is nothing left to replace and it counts as a second session. The write goes to the workspace's synced " +
        "`_feedback` document, so it is an ordinary durable write — `applied` means this server's update log " +
        "holds it, `synced` means the hub acknowledged it.\n\n" +
        FEEDBACK_IS_ADVISORY,
      inputSchema: {
        uuid: z.uuid().describe("Document UUID."),
        verdict: z
          .enum(["helpful", "unhelpful"])
          .describe("Whether the document helped you do what you came to do."),
        reason: z
          .string()
          .min(1)
          .optional()
          .describe("Why, in one sentence. The rewrite brief when there is one."),
      },
    },
    context.guarded(async ({ uuid, verdict, reason }) => {
      await replicas.settle();
      // Identity is checked against the directory, never by opening the room: a
      // verdict on a uuid nothing can resolve is noise nobody can act on. An
      // archived document is still ratable — saying a retired document confused
      // you is exactly the kind of report this exists to collect.
      context.requireStub(uuid);
      const feedback = replicas.feedback();
      recordVerdict(feedback.doc, {
        docUuid: uuid,
        session: replicas.config.sessionId,
        agent: replicas.name,
        verdict,
        ...(reason === undefined ? {} : { reason }),
      });
      compactFeedback(feedback.doc);
      return context.json({
        uuid,
        verdict,
        ...(reason === undefined ? {} : { reason }),
        session: replicas.config.sessionId,
        ...context.durability(feedback),
      });
    }),
  );

  server.registerTool(
    "feedback_report",
    {
      title: "Which documents get used, and whether they help",
      description:
        "Every document any agent session has reported on, most used first — the input for a doc-quality review " +
        "pass. A low `helpfulRatio` with real reasons is a rewrite brief; high `sessionsUsed` with everything in " +
        "`unrated` is a document nobody has an opinion about; a document nobody read at all is simply absent, " +
        "because telemetry starts when it is produced and nothing was backfilled.\n\n" +
        "Per document: `sessionsUsed`, `helpful`, `unhelpful`, `unrated` (used and not rated), `helpfulRatio` " +
        "(helpful over rated, null when nobody rated it) and the most recent `reasons`. `title` comes from the " +
        "directory stub, never from opening the document — this tool reads two already-open rooms and joins " +
        "nothing, so no number of documents makes it open a room or wait on the network. The work and the payload " +
        "do grow with the corpus, though: every reported document is folded, sorted and returned, so use `limit` " +
        "when you only want the head of the list. A null title means the directory has no entry for that uuid.\n\n" +
        "`events` and `compactedDocs` describe the store rather than the corpus: old events are folded into " +
        "per-document totals once the list grows, so counts survive compaction but the reasons in them do not — " +
        "`reasons` is always recent, never complete.\n\n" +
        "Two ways compaction bends the counts, both bounded and neither hidden. Ordinarily it folds only sessions " +
        "that rated the document, which is exact for a session that has moved on — folding removes the events a " +
        "later verdict would replace and a later read would dedupe against, so a session that comes back to that " +
        "document afterwards counts again. When a burst of unrated reads is all there is to fold, a backstop folds " +
        "those too, which widens the same case to sessions that never rated anything. Either way the overcount is " +
        "one per (document, session) per compaction window the session outlives — a session reading one document " +
        "across eight windows reads as eight sessions — so a very long-lived reader inflates its documents while " +
        "ordinary ones are exact. In the other direction, two replicas compacting different slices at once " +
        "converge on one of the two totals, so a count can sit below the truth. Read these as good numbers to act " +
        "on, not as exact ones.\n\n" +
        FEEDBACK_IS_ADVISORY,
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Return at most this many documents, most used first."),
      },
    },
    context.guarded(async ({ limit }) => {
      await replicas.settle();
      const feedback = replicas.feedback();
      const rows = readFeedback(feedback.doc);
      return context.json({
        workspace: replicas.config.workspaceId,
        docs: (limit === undefined ? rows : rows.slice(0, limit)).map((row) =>
          reportRow(replicas, row),
        ),
        events: getFeedbackEvents(feedback.doc).length,
        compactedDocs: getFeedbackTotals(feedback.doc).size,
        hub: replicas.sync.state(),
      });
    }),
  );
}
