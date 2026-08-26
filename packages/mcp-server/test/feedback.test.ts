/**
 * The feedback tools: usage recorded by reading, verdicts recorded by rating,
 * and a report a doc-quality review can act on.
 *
 * The fold and compaction rules belong to the schema package and are pinned in
 * `packages/schema/test/feedback.test.ts`. What this suite defends is the tool
 * contract and the plumbing under it: a session is one MCP server process, so
 * "two sessions" here is two servers over one database — the same shape as two
 * agents on one machine; the nudge appears exactly once per unrated document
 * per session; `_feedback` is an ordinary synced doc, logged offline, hydrated
 * on restart and converging across two replicas through the hub; and the report
 * joins nothing, so asking for it opens no document rooms.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getFeedbackEvents, readFeedback, recordUsage } from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import {
  hubUrl,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];

async function server(databasePath?: string): Promise<Rig> {
  const rig = await startServer(
    testConfig(databasePath === undefined ? {} : { databasePath }),
  );
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
});

afterAll(removeTempDirs);

/** One document's row in a report, or null when nobody has reported on it. */
function docRow(report: any, uuid: string): any {
  return report.docs.find((entry: { uuid: string }) => entry.uuid === uuid) ?? null;
}

async function createDoc(rig: Rig, title: string): Promise<string> {
  const created = await rig.ok("create_doc", {
    title,
    blocks: [{ type: "paragraph", text: "a document worth an opinion" }],
  });
  return created.uuid;
}

describe("usage counts sessions, not calls", () => {
  it("counts one document read by two sessions as two sessions used", async () => {
    const databasePath = tempDatabasePath();
    const first = await server(databasePath);
    const uuid = await createDoc(first, "Read twice");
    const second = await server(databasePath);

    await first.ok("get_doc", { uuid });
    await second.ok("get_doc", { uuid });

    // Either session sees both: the events went through the shared update log,
    // which is what every tool call polls before it serves.
    for (const rig of [first, second]) {
      expect(docRow(await rig.ok("feedback_report"), uuid)).toMatchObject({
        title: "Read twice",
        sessionsUsed: 2,
        unrated: 2,
        helpful: 0,
        unhelpful: 0,
        helpfulRatio: null,
      });
    }
  });

  it("counts ten get_docs in one session once", async () => {
    const rig = await server();
    const uuid = await createDoc(rig, "Read ten times");
    for (let index = 0; index < 10; index += 1) {
      await rig.ok("get_doc", { uuid });
    }

    const report = await rig.ok("feedback_report");
    expect(docRow(report, uuid)).toMatchObject({ sessionsUsed: 1, unrated: 1 });
    expect(report.events).toBe(1);
  });

  it("reports nothing for a corpus nobody has read — there is no backfill", async () => {
    const rig = await server();
    await createDoc(rig, "Never opened");
    await createDoc(rig, "Also never opened");

    expect(await rig.ok("feedback_report")).toMatchObject({
      workspace: WORKSPACE,
      docs: [],
      events: 0,
      compactedDocs: 0,
    });
  });
});

describe("the nudge", () => {
  it("appears exactly once per unrated document per session", async () => {
    const rig = await server();
    const uuid = await createDoc(rig, "Nudged once");
    const other = await createDoc(rig, "Nudged once too");

    const first = await rig.ok("get_doc", { uuid });
    expect(first.feedback).toContain("rate_doc");
    // Advisory, and it says so rather than reading as a required step.
    expect(first.feedback).toContain("Optional");
    expect((await rig.ok("get_doc", { uuid })).feedback).toBeUndefined();
    expect((await rig.ok("get_doc", { uuid })).feedback).toBeUndefined();

    // Per document, not per session: a document this session has not met yet
    // still gets its one reminder.
    expect((await rig.ok("get_doc", { uuid: other })).feedback).toContain(
      "rate_doc",
    );
  });

  it("says nothing about a document this session already rated", async () => {
    const rig = await server();
    const uuid = await createDoc(rig, "Rated first");
    await rig.ok("rate_doc", { uuid, verdict: "helpful" });

    expect((await rig.ok("get_doc", { uuid })).feedback).toBeUndefined();
  });

  it("comes back for a second session, which has its own opinion to give", async () => {
    const databasePath = tempDatabasePath();
    const first = await server(databasePath);
    const uuid = await createDoc(first, "Two readers");
    await first.ok("get_doc", { uuid });

    const second = await server(databasePath);
    expect((await second.ok("get_doc", { uuid })).feedback).toContain("rate_doc");
  });
});

describe("rate_doc", () => {
  it("records a verdict as a durable write, and re-rating replaces it", async () => {
    const rig = await server();
    const uuid = await createDoc(rig, "Rated");

    const rated = await rig.ok("rate_doc", {
      uuid,
      verdict: "unhelpful",
      reason: "the tool list is out of date",
    });
    expect(rated).toMatchObject({ uuid, verdict: "unhelpful", applied: true });
    // Local-only in this rig, and it says so rather than claiming the hub has it.
    expect(rated.synced).toBe(false);
    expect(docRow(await rig.ok("feedback_report"), uuid)).toMatchObject({
      sessionsUsed: 1,
      unhelpful: 1,
      helpful: 0,
      unrated: 0,
      helpfulRatio: 0,
    });

    await rig.ok("rate_doc", {
      uuid,
      verdict: "helpful",
      reason: "the contracts section answered it",
    });
    const report = await rig.ok("feedback_report");
    expect(docRow(report, uuid)).toMatchObject({
      sessionsUsed: 1,
      helpful: 1,
      unhelpful: 0,
      unrated: 0,
      helpfulRatio: 1,
    });
    // One verdict per session per document: replaced, never accumulated.
    expect(docRow(report, uuid).reasons).toEqual([
      expect.objectContaining({
        verdict: "helpful",
        reason: "the contracts section answered it",
      }),
    ]);
  });

  it("keeps used-but-unrated as its own bucket", async () => {
    const databasePath = tempDatabasePath();
    const first = await server(databasePath);
    const uuid = await createDoc(first, "Half rated");
    const second = await server(databasePath);

    await first.ok("get_doc", { uuid });
    await second.ok("get_doc", { uuid });
    await first.ok("rate_doc", { uuid, verdict: "helpful" });

    expect(docRow(await second.ok("feedback_report"), uuid)).toMatchObject({
      sessionsUsed: 2,
      helpful: 1,
      unhelpful: 0,
      unrated: 1,
      helpfulRatio: 1,
    });
  });

  it("refuses a uuid the directory has never heard of", async () => {
    const rig = await server();
    const refused = await rig.call("rate_doc", {
      uuid: "6f1f5f2e-0000-4000-8000-000000000000",
      verdict: "helpful",
    });

    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("doc_not_found");
    expect((await rig.ok("feedback_report")).docs).toEqual([]);
  });
});

describe("_feedback is an ordinary synced doc", () => {
  it("logs offline and hydrates on restart", async () => {
    const databasePath = tempDatabasePath();
    const before = await server(databasePath);
    const uuid = await createDoc(before, "Survives a restart");
    await before.ok("rate_doc", {
      uuid,
      verdict: "helpful",
      reason: "worth keeping",
    });
    await before.close();
    rigs.splice(rigs.indexOf(before), 1);

    // Nothing was in memory that mattered: the events came back out of the
    // update log, like every other document's.
    const after = await server(databasePath);
    expect(docRow(await after.ok("feedback_report"), uuid)).toMatchObject({
      sessionsUsed: 1,
      helpful: 1,
      reasons: [expect.objectContaining({ reason: "worth keeping" })],
    });
  });

  it("converges across two replicas rating the same document at once", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const withHub = (databasePath: string) =>
      startServer(
        testConfig({
          databasePath,
          authSecret: TEST_SECRET,
          hubUrl: hubUrl(hub.port),
        }),
      );

    const first = await withHub(tempDatabasePath());
    rigs.push(first);
    const uuid = await createDoc(first, "Two opinions");
    // A second machine, its own database and its own session, which learns the
    // corpus through the hub rather than through a shared log.
    const second = await withHub(tempDatabasePath());
    rigs.push(second);
    await waitUntil("the second replica to see the document", async () =>
      (await second.call("get_doc", { uuid })).isError === false,
    );

    // Neither has seen the other's verdict when it makes its own.
    await Promise.all([
      first.ok("rate_doc", { uuid, verdict: "helpful", reason: "clear" }),
      second.ok("rate_doc", { uuid, verdict: "unhelpful", reason: "stale" }),
    ]);

    for (const rig of [first, second]) {
      await waitUntil(`${rig.config.sessionId} to hold both verdicts`, async () => {
        const row = docRow(await rig.ok("feedback_report"), uuid);
        return row !== null && row.helpful === 1 && row.unhelpful === 1;
      });
      // Both events survive: append-only, so a concurrent rater is merged with
      // rather than overwritten.
      expect(docRow(await rig.ok("feedback_report"), uuid)).toMatchObject({
        sessionsUsed: 2,
        helpful: 1,
        unhelpful: 1,
        unrated: 0,
        helpfulRatio: 0.5,
      });
    }
  });
});

describe("feedback_report", () => {
  it("opens no document rooms, and resolves what it can from the directory", async () => {
    const rig = await server();
    const uuid = await createDoc(rig, "Reported on");
    await rig.ok("get_doc", { uuid });

    // An event about a uuid this replica has no document for — the shape a
    // report gets after an archive, or from another workspace member's read.
    const unknown = "7a1f5f2e-0000-4000-8000-000000000001";
    recordUsage(rig.instance.replicas.feedback().doc, {
      docUuid: unknown,
      session: "another-session",
      agent: "another agent",
    });

    const before = (await rig.ok("sync_status")).rooms.map(
      (room: { room: string }) => room.room,
    );
    const report = await rig.ok("feedback_report");
    const after = (await rig.ok("sync_status")).rooms.map(
      (room: { room: string }) => room.room,
    );

    // The report joined nothing: no room was attached to answer it, least of
    // all one for a uuid nothing can resolve.
    expect(after).toEqual(before);
    expect(after).toContain(`${WORKSPACE}/_feedback`);
    expect(after).not.toContain(`${WORKSPACE}/${unknown}`);
    expect(docRow(report, unknown)).toMatchObject({
      title: null,
      sessionsUsed: 1,
    });
    expect(docRow(report, uuid)).toMatchObject({ title: "Reported on" });
  });

  it("sorts by usage and honours a limit", async () => {
    const databasePath = tempDatabasePath();
    const first = await server(databasePath);
    const popular = await createDoc(first, "Popular");
    const quiet = await createDoc(first, "Quiet");
    const second = await server(databasePath);

    await first.ok("get_doc", { uuid: popular });
    await second.ok("get_doc", { uuid: popular });
    await first.ok("get_doc", { uuid: quiet });

    const report = await first.ok("feedback_report");
    expect(report.docs.map((doc: { title: string }) => doc.title)).toEqual([
      "Popular",
      "Quiet",
    ]);
    expect((await first.ok("feedback_report", { limit: 1 })).docs).toHaveLength(1);
  });

  it("keeps the event list bounded under a burst, without losing the counts", async () => {
    const rig = await server();
    const uuid = await createDoc(rig, "Read by everyone");
    const feedback = rig.instance.replicas.feedback().doc;

    // 600 sessions' worth of reads, past the production compaction limit. They
    // are ordinary local writes on the replica, so they are logged like any
    // other — this is a burst, not a fixture.
    for (let index = 0; index < 600; index += 1) {
      recordUsage(feedback, {
        docUuid: uuid,
        session: `burst-session-${index}`,
        agent: "burst",
      });
    }
    expect(getFeedbackEvents(feedback).length).toBe(600);

    // The next write is what compacts: fold into per-doc totals, then trim.
    await rig.ok("rate_doc", { uuid, verdict: "helpful", reason: "still fine" });

    expect(getFeedbackEvents(feedback).length).toBeLessThanOrEqual(500);
    const report = await rig.ok("feedback_report");
    expect(report.events).toBeLessThanOrEqual(500);
    expect(report.compactedDocs).toBe(1);
    expect(docRow(report, uuid)).toMatchObject({
      sessionsUsed: 601,
      helpful: 1,
      unrated: 600,
    });
    // Compaction is a fold, not a reset: the same numbers survive a restart,
    // because the totals it wrote are in the log too.
    expect(readFeedback(feedback)[0]).toMatchObject({ sessionsUsed: 601 });
  });
});

describe("the tools say what these numbers are", () => {
  it("calls the telemetry self-reported, session-scoped and advisory", async () => {
    const rig = await server();
    const { tools } = await rig.client.listTools();
    const description = (name: string): string =>
      tools.find((tool) => tool.name === name)?.description ?? "";

    for (const name of ["rate_doc", "feedback_report"]) {
      expect(description(name)).toContain(
        "self-reported, session-scoped, advisory",
      );
      expect(description(name)).toContain("not audit data");
      expect(description(name)).toContain("counts SESSIONS, not calls");
    }
    // A read that writes has to say so: get_doc names the room it records into
    // and the dedupe an agent can rely on.
    expect(description("get_doc")).toContain("_feedback");
    expect(description("get_doc")).toContain("once per document per session");
  });
});
