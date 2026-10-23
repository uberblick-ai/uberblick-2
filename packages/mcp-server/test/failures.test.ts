/**
 * The failure contract, over every code this server can answer with.
 *
 * What is defended here is what a generic caller may rely on without knowing
 * which tool it called: a stable `error` code and a human `message` on every
 * handler failure, the domain detail each code already carried, an honest
 * statement of what happened to the write when the tool writes, and a recovery
 * class that never labels a hopeless retry safe.
 *
 * The list of codes comes from the code itself (`FAILURE_CODES`), so a code
 * added without a recovery class fails this suite rather than reaching an agent
 * unexplained. The MCP SDK's own schema rejection is here too, as the boundary
 * class it is: it never reaches a handler and never changes anything.
 */

import { randomUUID } from "node:crypto";
import { applyDocData, createTagCatalogEntry, DATA_LIMITS, DataError, InvalidDocumentLifecycleError, setTags, setTldrOptOut, upsertDirectoryEntry } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  FAILURE_CODES,
  INTERNAL_ERROR_MESSAGE,
  PERSISTENCE_ERROR_MESSAGE,
  hydrationRecovery,
  toFailure,
} from "../src/failures.js";
import { RevisionClientError } from "../src/revision-client.js";
import { ServerShuttingDownError } from "../src/server-work.js";
import { MirrorStore, WorkspaceRemovedError } from "../src/store.js";
import type { SearchHit } from "../src/store.js";
import {
  FailingStore,
  WORKSPACE,
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
  toolNamed,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const stores: MirrorStore[] = [];
const REVISION_FAILURES = [
  ["local-only", "revisions_local_only", "manual", "team hub"],
  ["unreachable", "revisions_unreachable", "retry", "once the hub is reachable"],
  ["sign-in-required", "revisions_sign_in_required", "manual", "ub auth login"],
  ["forbidden", "revisions_forbidden", "manual", "grant read access"],
  ["deleted", "doc_deleted", "manual", "permanently deleted"],
  ["revision-not-found", "revision_not_found", "reread", "list_revisions"],
  ["unsupported", "revisions_unsupported", "manual", "update the hub"],
] as const;

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

/** A server whose store is the given one — the seam every fault comes through. */
async function rigWith<S extends MirrorStore>(
  make: (databasePath: string) => S,
): Promise<{ rig: Rig; store: S }> {
  const databasePath = tempDatabasePath();
  const store = make(databasePath);
  stores.push(store);
  const rig = await startServer(testConfig({ databasePath }), store);
  rigs.push(rig);
  return { rig, store };
}

/** A store whose search throws — the seam for an unmapped handler crash. */
class ExplodingSearchStore extends MirrorStore {
  override search(): SearchHit[] {
    throw new Error("the search index exploded");
  }
}

/** A document with one paragraph, the starting point for the block failures. */
async function seeded(
  rig: Rig,
): Promise<{ uuid: string; blockId: string; rev: string }> {
  const created = await rig.ok("create_doc", {
    title: "Contract",
    description: "A document the failure contract is exercised against.",
    blocks: [{ type: "paragraph", text: "one" }],
  });
  return {
    uuid: created.uuid,
    blockId: created.blocks[0].id,
    rev: created.blocks[0].rev,
  };
}

/** A uuid the directory carries but whose room has never reached this replica. */
function stubOnly(rig: Rig): string {
  const uuid = randomUUID();
  upsertDirectoryEntry(rig.instance.replicas.directory().doc, {
    uuid,
    title: "Known, not held",
  });
  return uuid;
}

/** What each code promises beyond `error` and `message`. */
const EXPECTED: Record<
  string,
  { recoveryClass: string | null; detail: string[] }
> = {
  server_shutting_down: { recoveryClass: "manual", detail: [] },
  data_invalid_input: { recoveryClass: "manual", detail: ["collection", "recordId"] },
  data_collection_not_found: { recoveryClass: "reread", detail: ["uuid", "collection"] },
  data_schema_invalid: { recoveryClass: "manual", detail: ["collection", "path"] },
  data_record_invalid: { recoveryClass: "manual", detail: ["collection", "recordId", "path"] },
  data_limit_exceeded: {
    recoveryClass: "manual",
    detail: ["collection", "recordId", "limit", "value", "attempted"],
  },
  invalid_table: { recoveryClass: "manual", detail: [] },
  invalid_card: { recoveryClass: "manual", detail: [] },
  annotation_card: { recoveryClass: "manual", detail: ["blockId"] },
  invalid_figma: { recoveryClass: "manual", detail: [] },
  annotation_figma: { recoveryClass: "manual", detail: ["blockId"] },
  table_mapping_required: { recoveryClass: "manual", detail: [] },
  invalid_table_mapping: { recoveryClass: "manual", detail: [] },
  invalid_list_attributes: { recoveryClass: "manual", detail: [] },
  annotation_cell: { recoveryClass: "manual", detail: ["blockId", "reason"] },
  invalid_github_reference: { recoveryClass: "manual", detail: ["github_ref"] },
  unknown_help_topic: { recoveryClass: "manual", detail: ["topics"] },
  persistence_failed: { recoveryClass: "manual", detail: ["room"] },
  workspace_removed: { recoveryClass: "manual", detail: [] },
  stale_block: {
    recoveryClass: "reread",
    detail: ["blockId", "currentText", "currentRev", "retry"],
  },
  old_text_mismatch: {
    recoveryClass: "manual",
    detail: ["blockId", "currentText", "currentRev", "retry"],
  },
  block_not_found: { recoveryClass: "reread", detail: ["blockId"] },
  duplicate_block_id: { recoveryClass: "manual", detail: ["blockId"] },
  move_target_in_selection: { recoveryClass: "manual", detail: ["blockId"] },
  open_thread_anchored: { recoveryClass: "manual", detail: ["blockId", "threads"] },
  annotation_range: {
    recoveryClass: "reread",
    detail: ["reason", "blockId", "conflictingThreadId"],
  },
  thread_not_found: { recoveryClass: "reread", detail: ["uuid", "threadId"] },
  inline_link_range: { recoveryClass: "reread", detail: ["reason"] },
  // Never `retry`: the directory arrives over the hub, not by calling again.
  doclink_target_not_known_locally: {
    recoveryClass: "reread",
    detail: ["docId", "inDirectory", "hub"],
  },
  doc_not_found: {
    recoveryClass: "reread",
    detail: ["uuid", "inDirectory", "hub"],
  },
  // `manual` because these servers run with no hub configured: a room that
  // arrives over a connection cannot arrive over none. The class per hub state
  // is its own table below.
  doc_not_hydrated: {
    recoveryClass: "manual",
    detail: ["uuid", "inDirectory", "hub"],
  },
  doc_archived: { recoveryClass: "manual", detail: ["uuid", "archived"] },
  doc_deleted: { recoveryClass: "manual", detail: ["uuid"] },
  revisions_local_only: { recoveryClass: "manual", detail: [] },
  revisions_unreachable: { recoveryClass: "retry", detail: [] },
  revisions_sign_in_required: { recoveryClass: "manual", detail: [] },
  revisions_forbidden: { recoveryClass: "manual", detail: [] },
  revisions_unsupported: { recoveryClass: "manual", detail: [] },
  revision_not_found: { recoveryClass: "reread", detail: [] },
  revision_stale_state: { recoveryClass: "reread", detail: [] },
  revision_invalid_name: { recoveryClass: "manual", detail: [] },
  revision_already_named: { recoveryClass: "manual", detail: ["existingName"] },
  revision_not_namer: { recoveryClass: "manual", detail: [] },
  revision_naming_outcome_unknown: { recoveryClass: "reread", detail: ["reason"] },
  doc_not_archived: { recoveryClass: "manual", detail: ["uuid"] },
  decision_delete_unsupported: { recoveryClass: "manual", detail: ["uuid"] },
  guidance_required: { recoveryClass: "reread", detail: ["unread"] },
  group_not_found: { recoveryClass: "reread", detail: ["group"] },
  invalid_document_lifecycle: {
    recoveryClass: "manual",
    detail: ["kind", "status"],
  },
  decision_answer_required: {
    recoveryClass: "manual",
    detail: ["kind", "status"],
  },
  decision_reason_required: {
    recoveryClass: "manual",
    detail: ["uuid", "kind", "status"],
  },
  decision_transition_invalid: {
    recoveryClass: "manual",
    detail: ["kind", "status"],
  },
  decision_read_only: {
    recoveryClass: "manual",
    detail: ["uuid", "kind", "status"],
  },
  related_not_regular_document: {
    recoveryClass: "reread",
    detail: ["related", "kind"],
  },
  discussion_not_regular_document: {
    recoveryClass: "reread",
    detail: ["discussion", "kind"],
  },
  discussion_not_writable: {
    recoveryClass: "manual",
    detail: ["uuid", "kind", "status", "field"],
  },
  decision_answer_empty: { recoveryClass: "manual", detail: ["kind", "status"] },
  decision_tldr_unsupported: { recoveryClass: "manual", detail: ["kind", "status"] },
  invalid_code_check: { recoveryClass: "manual", detail: ["uuid", "field"] },
  decision_code_check_unsupported: { recoveryClass: "manual", detail: ["uuid", "kind", "status", "field"] },
  tldr_opted_out: { recoveryClass: "manual", detail: ["uuid", "field"] },
  decision_data_unsupported: { recoveryClass: "manual", detail: ["uuid", "kind", "status"] },
  decision_block_unsupported: { recoveryClass: "manual", detail: ["kind", "status"] },
  decision_answer_too_long: { recoveryClass: "manual", detail: ["kind", "status"] },
  invalid_tag_assignment: {
    recoveryClass: "manual",
    detail: ["unknown"],
  },
  supersedes_not_decision: {
    recoveryClass: "reread",
    detail: ["supersedes", "kind"],
  },
  decision_title_mismatch: { recoveryClass: "reread", detail: ["field", "supersedes", "title"] },
  // The unclassified fallback: a handler that threw something nobody mapped
  // cannot say what happened to a write, so it promises the floor and no more.
  internal_error: { recoveryClass: null, detail: [] },
};

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  for (const opened of stores.splice(0)) {
    opened.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("the failure contract", () => {
  it("documents the complete failure shape and recovery classes in shared help", async () => {
    const rig = await localRig();
    const { text } = await rig.ok("get_help", { topic: "tool-contracts" });
    for (const field of ["error", "message", "recoveryClass", "recovery", "applied", "partial", "synced"]) {
      expect(text, field).toContain(`\`${field}\``);
    }
    for (const recoveryClass of ["retry", "reread", "manual"]) {
      expect(text, recoveryClass).toContain(`\`${recoveryClass}\``);
    }
    expect(text).toContain("internal_error");
    expect(text).toContain("isError: true");
    expect(text).toContain("structuredContent");
  });

  it("gives every failure code a message, its domain detail and a recovery class", async () => {
    const rig = await localRig();
    const doc = await seeded(rig);
    const failures = new Map<string, any>();
    const record = (payload: any): void => {
      failures.set(payload.error, payload);
    };

    record((await rig.call("move_block", {
      uuid: doc.uuid, block_ids: [doc.blockId, doc.blockId],
    })).payload);
    record((await rig.call("move_block", {
      uuid: doc.uuid, block_ids: [doc.blockId], after_block_id: doc.blockId,
    })).payload);

    record((await rig.call("edit_block", {
      uuid: doc.uuid, block_id: doc.blockId, old_text: "one", new_text: "two", list: "ordered",
    })).payload);

    record((await rig.call("get_doc", { uuid: randomUUID() })).payload);
    record((await rig.call("get_data", { uuid: doc.uuid, collection: "missing" })).payload);
    record((await rig.call("find_decisions", { github_ref: "#1" })).payload);
    record((await rig.call("get_help", { topic: "no-such-help-topic" })).payload);
    record((await rig.call("insert_block", {
      uuid: doc.uuid,
      blocks: [{ type: "table", text: "not a GFM table" }],
    })).payload);
    record((await rig.call("insert_block", {
      uuid: doc.uuid,
      blocks: [{ type: "card", text: "label: Missing title" }],
    })).payload);
    const card = await rig.ok("insert_block", {
      uuid: doc.uuid, after_block_id: doc.blockId,
      blocks: [{ type: "card", text: "title: Card\n\nBody" }],
    });
    record((await rig.call("annotate", {
      uuid: doc.uuid, block_id: card.blocks[0].id, start: 0, end: 3, text: "Open this in the web editor",
    })).payload);
    record((await rig.call("insert_block", {
      uuid: doc.uuid,
      blocks: [{ type: "figma", text: "url: https://example.com/design/key\n\nCaption" }],
    })).payload);
    const figma = await rig.ok("insert_block", {
      uuid: doc.uuid, after_block_id: doc.blockId,
      blocks: [{ type: "figma", text: "url: https://www.figma.com/design/key\n\nCaption" }],
    });
    record((await rig.call("annotate", {
      uuid: doc.uuid, block_id: figma.blocks[0].id, start: 0, end: 3, text: "New Figma caption thread",
    })).payload);
    const table = await rig.ok("insert_block", {
      uuid: doc.uuid, after_block_id: doc.blockId,
      blocks: [{ type: "table", text: "| Header |\n| --- |\n| Cell |" }],
    });
    record((await rig.call("edit_block", {
      uuid: doc.uuid, block_id: table.blocks[0].id, old_text: table.blocks[0].text,
      new_text: "| Header | Added |\n| --- | --- |\n| Cell | New |",
    })).payload);
    record((await rig.call("edit_block", {
      uuid: doc.uuid, block_id: table.blocks[0].id, old_text: table.blocks[0].text, new_text: table.blocks[0].text,
      table_mapping: { rows: [0, 2], columns: [0] },
    })).payload);
    record((await rig.call("annotate", {
      uuid: doc.uuid, block_id: table.blocks[0].id, start: 0, end: 3, text: "Missing cell coordinates",
    })).payload);
    record(
      (await rig.call("get_doc", { uuid: stubOnly(rig) })).payload,
    );
    record(
      (
        await rig.call("edit_block", {
          uuid: doc.uuid,
          block_id: doc.blockId,
          old_text: "not what is there",
          new_text: "two",
        })
      ).payload,
    );
    record(
      (
        await rig.call("edit_block", {
          uuid: doc.uuid,
          block_id: doc.blockId,
          old_text: "still not what is there",
          new_text: "two",
          rev: doc.rev,
        })
      ).payload,
    );
    record(
      (
        await rig.call("edit_block", {
          uuid: doc.uuid,
          block_id: "no-such-block",
          old_text: "one",
          new_text: "two",
        })
      ).payload,
    );
    await rig.ok("annotate", {
      uuid: doc.uuid,
      block_id: doc.blockId,
      start: 0,
      end: 3,
      text: "the first thread",
    });
    record((await rig.call("delete_block", {
      uuid: doc.uuid, block_id: doc.blockId,
    })).payload);
    record(
      (
        await rig.call("annotate", {
          uuid: doc.uuid,
          block_id: doc.blockId,
          start: 0,
          end: 3,
          text: "a second thread over the same range",
        })
      ).payload,
    );
    record(
      (
        await rig.call("annotate", {
          uuid: doc.uuid,
          thread_id: "no-such-thread",
          text: "a comment",
        })
      ).payload,
    );
    // A range that clamps to nothing, and a reference to a uuid this replica's
    // directory has never carried — the two ways an inline link is refused.
    const linkable = (await rig.ok("get_doc", { uuid: doc.uuid })).blocks[0];
    record(
      (
        await rig.call("link_range", {
          uuid: doc.uuid,
          block_id: doc.blockId,
          start: 0,
          end: 0,
          doc_id: doc.uuid,
          rev: linkable.rev,
        })
      ).payload,
    );
    record(
      (
        await rig.call("link_range", {
          uuid: doc.uuid,
          block_id: doc.blockId,
          start: 0,
          end: 3,
          doc_id: randomUUID(),
          rev: linkable.rev,
        })
      ).payload,
    );
    record(
      (
        await rig.call("sidebar_group", {
          action: "rename",
          group: "no-such-group",
          name: "Renamed",
        })
      ).payload,
    );
    const regular = await rig.ok("create_doc", {
      title: "Regular page",
      description: "A page without a specialized lifecycle.",
    });
    const firstDecision = await rig.ok("create_doc", {
      title: "First decision",
      description: "The topic's first stance.",
      kind: "decision",
      status: "decided",
      blocks: [{ type: "paragraph", text: "Use the existing log." }],
    });
    const successorDecision = await rig.ok("create_doc", {
      description: "A proposal that needs a person's answer.",
      kind: "decision",
      supersedes: firstDecision.uuid,
    });
    record((await rig.call("create_doc", {
      title: "A different question", description: "A successor cannot rename the topic.", kind: "decision", supersedes: firstDecision.uuid,
    })).payload);
    record(
      (
        await rig.call("set_status", {
          uuid: successorDecision.uuid,
          status: "decided",
        })
      ).payload,
    );
    record((await rig.call("set_status", {
      uuid: successorDecision.uuid,
      status: "rejected",
      answer: { who: "A member", when: "2026-10-04T12:00:00Z", where: "A team discussion." },
    })).payload);
    record((await rig.call("set_status", { uuid: firstDecision.uuid, status: "open" })).payload);
    record((await rig.call("set_metadata", { uuid: firstDecision.uuid, tldr: null })).payload);
    record((await rig.call("set_metadata", { uuid: regular.uuid, discussion: null })).payload);
    record((await rig.call("set_metadata", { uuid: regular.uuid, code_check: {} })).payload);
    record((await rig.call("set_metadata", {
      uuid: firstDecision.uuid,
      code_check: { repository: "uberblick-ai/uberblick-2", commit: "a".repeat(40), result: "matches", rev: (await rig.ok("get_doc", { uuid: firstDecision.uuid })).rev },
    })).payload);
    record((await rig.call("create_doc", {
      title: "Wrong discussion kind",
      description: "Discussion belongs on a regular document.",
      kind: "decision",
      discussion: firstDecision.uuid,
    })).payload);
    record(
      (
        await rig.call("create_doc", {
          title: "Wrong related kind",
          description: "A decision cannot own another decision record.",
          kind: "decision",
          related: firstDecision.uuid,
        })
      ).payload,
    );
    for (const fields of [
      { status: "decided" },
      { tldr: "No decision TL;DR." },
      { blocks: [{ type: "heading", text: "No heading" }] },
      { blocks: Array.from({ length: 4 }, () => ({ type: "paragraph", text: "An answer." })) },
    ]) record((await rig.call("create_doc", { title: "Invalid answer", description: "Answer validation refuses before writing.", kind: "decision", ...fields })).payload);
    record((await rig.call("update_data", { uuid: successorDecision.uuid, operations: [] })).payload);
    record(
      (
        await rig.call("create_doc", {
          title: "Wrong superseded kind",
          description: "A decision cannot supersede an ordinary document.",
          kind: "decision",
          supersedes: doc.uuid,
        })
      ).payload,
    );
    const marked = await seeded(rig);
    setTldrOptOut(rig.instance.replicas.replica(marked.uuid).doc, true);
    const beforeMarked = await rig.ok("get_doc", { uuid: marked.uuid });
    const beforeMarkedLog = rig.instance.store.logSize();
    const optedOut = await rig.call("set_metadata", {
      uuid: marked.uuid, title: "Must stay unchanged", tldr: "Refused summary.",
    });
    expect(optedOut).toMatchObject({ isError: true, payload: {
      error: "tldr_opted_out", field: "tldr", applied: false, partial: false, synced: false,
    } });
    expect(optedOut.payload.recovery).toContain("tldr_opt_in: true");
    expect(rig.instance.store.logSize()).toBe(beforeMarkedLog);
    expect(await rig.ok("get_doc", { uuid: marked.uuid })).toEqual(beforeMarked);
    record(optedOut.payload);

    const archived = await seeded(rig);
    record((await rig.call("delete_doc", { uuid: archived.uuid })).payload);
    await rig.ok("archive_doc", { uuid: archived.uuid });
    record(
      (await rig.call("set_metadata", { uuid: archived.uuid, title: "Nope" }))
        .payload,
    );
    await rig.ok("delete_doc", { uuid: archived.uuid });
    record((await rig.call("get_doc", { uuid: archived.uuid })).payload);
    const undeletableDecision = await rig.ok("create_doc", {
      title: "Which deletion operations are available?", description: "A decision cannot be deleted yet.", kind: "decision",
    });
    record((await rig.call("delete_doc", { uuid: undeletableDecision.uuid })).payload);
    record(
      (
        await rig.call("set_metadata", {
          uuid: doc.uuid,
          tags: ["not-in-catalog"],
        })
      ).payload,
    );

    // Exercise shared data-operation errors through the tool failure adapter.
    const dataDoc = rig.instance.replicas.replica(doc.uuid).doc;
    const directory = rig.instance.replicas.directory().doc;
    const dataSchema = {
      version: 1 as const,
      schema: {
        type: "object" as const,
        properties: { count: { type: "number" as const }, text: { type: "string" as const } },
        required: ["count"],
        additionalProperties: false as const,
      },
    };
    const unsupportedSchema = {
      version: 1 as const,
      schema: { type: "object" as const, uniqueItems: true },
    };
    const dataRefusals = [
      () => applyDocData(dataDoc, directory, [{
        collection: "observations", schema: dataSchema,
        upsert: [{ id: "row-1", value: { count: 1 } }, { id: "row-1", value: { count: 2 } }],
      }]),
      () => applyDocData(dataDoc, directory, [{ collection: "observations", schema: unsupportedSchema }]),
      () => applyDocData(dataDoc, directory, [{
        collection: "observations", schema: dataSchema,
        upsert: [{ id: "row-1", value: { count: "invalid number" } }],
      }]),
      () => applyDocData(dataDoc, directory, [{
        collection: "observations", schema: dataSchema,
        upsert: [{ id: "row-1", value: { count: 1, text: "x".repeat(DATA_LIMITS.record) } }],
      }]),
    ];
    for (const refuse of dataRefusals) {
      let rejected = false;
      try {
        refuse();
      } catch (error) {
        if (!(error instanceof DataError)) throw error;
        rejected = true;
        const failure = toFailure(toolNamed("edit_block"), error);
        const payload = failure.payload;
        expect(failure.isError).toBe(true);
        expect(payload).toMatchObject({
          error: error.code, message: error.message, ...error.details,
          recoveryClass: "manual", applied: false, partial: false, synced: false,
        });
        record(payload);
      }
      expect(rejected, "the shared data operation must refuse this input").toBe(true);
    }

    const guidanceTag = createTagCatalogEntry(rig.instance.replicas.settings().doc, "guidance");
    setTags(rig.instance.replicas.replica(doc.uuid).doc, [guidanceTag.id]);
    record((await rig.call("set_metadata", { uuid: doc.uuid, title: "Unbriefed" })).payload);

    // A handler that threw something nobody mapped, and a refused log write:
    // both need their own server, so they get one.
    const exploding = await rigWith(
      (path) => new ExplodingSearchStore(path, WORKSPACE),
    );
    record((await exploding.rig.call("search", { query: "anything" })).payload);

    const failing = await rigWith((path) => new FailingStore(path, WORKSPACE));
    const victim = await seeded(failing.rig);
    failing.store.failing = true;
    record(
      (
        await failing.rig.call("set_metadata", {
          uuid: victim.uuid,
          title: "Refused",
        })
      ).payload,
    );

    // Admission refusals use the same failure floor as every other tool error.
    record(toFailure(toolNamed("set_metadata"), new ServerShuttingDownError()).payload);
    record(toFailure(toolNamed("create_doc"), new WorkspaceRemovedError()).payload);

    // Valid MCP inputs cannot cross decision kinds; retain the defensive
    // mapper for shared-model lifecycle errors from an internal caller.
    record(toFailure(toolNamed("set_status"), new InvalidDocumentLifecycleError("decision", "planned")).payload);

    for (const [clientCode] of REVISION_FAILURES) {
      if (clientCode !== "deleted") {
        record(toFailure(toolNamed("get_data"), new RevisionClientError(clientCode)).payload);
      }
    }
    for (const clientCode of ["stale-state", "invalid-name", "already-named", "not-namer", "naming-outcome-unknown"] as const) {
      record(toFailure(toolNamed("name_revision"), new RevisionClientError(clientCode,
        clientCode === "already-named" ? { existingName: { text: "Reviewed", namer: null, namedAt: 1, canManage: false } }
          : clientCode === "naming-outcome-unknown" ? { applied: null, reason: "unsupported" } : {})).payload);
    }

    // Every code the code itself knows about was triggered above.
    expect([...failures.keys()].sort()).toEqual([...FAILURE_CODES].sort());

    for (const [code, payload] of failures) {
      const expected = EXPECTED[code];
      if (expected === undefined) {
        throw new Error(`no expectation recorded for ${code}`);
      }
      expect(payload.error).toBe(code);
      expect(typeof payload.message).toBe("string");
      expect(payload.message.length).toBeGreaterThan(0);
      for (const field of expected.detail) {
        expect(payload[field], `${code} lost its ${field}`).toBeDefined();
      }
      if (expected.recoveryClass === null) {
        expect(payload.recoveryClass).toBeUndefined();
        expect(payload.recovery).toBeUndefined();
      } else {
        expect(payload.recoveryClass).toBe(expected.recoveryClass);
        expect(typeof payload.recovery).toBe("string");
        expect(payload.recovery.length).toBeGreaterThan(0);
      }
    }

    // A retry that cannot work is never labelled one. The fail-stop stands
    // until the process restarts, so `retry` there would be advice that loops.
    expect(failures.get("persistence_failed").recoveryClass).toBe("manual");
    // And the re-read the caller needs is in the answer already.
    const stale = failures.get("stale_block");
    expect(stale.currentText).toBe("one");
    expect(stale.currentRev).toBeTruthy();
    const mismatch = failures.get("old_text_mismatch");
    expect(mismatch.currentText).toBe("one");
    expect(mismatch.currentRev).toBe(doc.rev);

    // An unmapped crash says one fixed thing. The exception's own text can hold
    // a path, a query or a secret, so it goes to the log and not to the caller.
    const crash = failures.get("internal_error");
    expect(crash.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(crash.message).not.toContain("exploded");
  });

  it.each(REVISION_FAILURES)("maps revision client %s to %s with actionable read recovery", (clientCode, code, recoveryClass, recovery) => {
    const error = new RevisionClientError(clientCode);
    expect(toFailure(toolNamed("get_data"), error)).toEqual({
      isError: true,
      payload: {
        error: code,
        message: error.message,
        recoveryClass,
        recovery: expect.stringContaining(recovery),
      },
    });
  });

  it("says a failed write changed nothing, and invents nothing for a read", async () => {
    const rig = await localRig();

    const write = await rig.call("set_metadata", {
      uuid: randomUUID(),
      title: "Nowhere",
    });
    expect(write.payload.error).toBe("doc_not_found");
    expect(write.payload.applied).toBe(false);
    expect(write.payload.partial).toBe(false);
    expect(write.payload.synced).toBe(false);

    // The same code from a tool that only reads. Claiming `applied: false`
    // here would be reporting on a write nobody attempted.
    const read = await rig.call("get_doc", { uuid: randomUUID() });
    expect(read.payload.error).toBe("doc_not_found");
    expect(read.payload.applied).toBeUndefined();
    expect(read.payload.partial).toBeUndefined();
    expect(read.payload.synced).toBeUndefined();

    // Including the failure a read gets for somebody else's refused write: the
    // fail-stop blocks reads too, and a read still has no write to report on.
    const failing = await rigWith((path) => new FailingStore(path, WORKSPACE));
    const doc = await seeded(failing.rig);
    failing.store.failing = true;
    const refusedWrite = await failing.rig.call("set_metadata", {
      uuid: doc.uuid,
      title: "Refused",
    });
    expect(refusedWrite.payload.error).toBe("persistence_failed");
    expect(refusedWrite.payload.message).toBe(PERSISTENCE_ERROR_MESSAGE);
    expect(JSON.stringify(refusedWrite.payload)).not.toContain("simulated disk failure");
    expect(refusedWrite.payload.applied).toBe(false);
    expect(refusedWrite.payload.partial).toBe(false);

    const blockedRead = await failing.rig.call("get_doc", { uuid: doc.uuid });
    expect(blockedRead.payload.error).toBe("persistence_failed");
    expect(blockedRead.payload.message).toBe(PERSISTENCE_ERROR_MESSAGE);
    expect(JSON.stringify(blockedRead.payload)).not.toContain("simulated disk failure");
    expect(blockedRead.payload.room).toBeTruthy();
    expect(blockedRead.payload.recoveryClass).toBe("manual");
    expect(blockedRead.payload.applied).toBeUndefined();
    expect(blockedRead.payload.partial).toBeUndefined();
    expect(blockedRead.payload.synced).toBeUndefined();
  });

  it("refuses values that name no single GitHub issue or pull request without claiming a write", async () => {
    const rig = await localRig();
    const size = rig.instance.store.logSize();
    for (const github_ref of [
      "",
      "#1",
      "https://example.com/owner/repo/issues/1",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo/issues",
      "https://github.com/owner/repo/pull/",
      "https://github.com/owner/repo/commit/1",
      "https://github.com/owner/repo/discussions/1",
    ]) {
      const refused = await rig.call("find_decisions", { github_ref });
      expect(refused).toMatchObject({
        isError: true,
        payload: {
          error: "invalid_github_reference",
          github_ref,
          recoveryClass: "manual",
          recovery: expect.stringContaining("Correct github_ref"),
        },
      });
      expect(refused.payload).not.toHaveProperty("applied");
      expect(refused.payload).not.toHaveProperty("partial");
      expect(refused.payload).not.toHaveProperty("synced");
    }
    expect(rig.instance.store.logSize()).toBe(size);
  });

  it("makes doc_not_hydrated retryable only while a hub could still deliver the room", () => {
    // The room arrives over a connection or not at all, so the class is a
    // statement about the hub. `retry` where waiting works; `manual`, naming
    // what a human must change, where the stub would otherwise dangle forever.
    const expected: Record<string, string> = {
      connected: "retry",
      connecting: "retry",
      "hub-down": "retry",
      disabled: "manual",
      "auth-failed": "manual",
      // A version skew is the clearest case of all: the hub refuses the
      // connection before the token, so waiting is advice that loops forever.
      "update-required": "manual",
      quarantined: "manual",
    };
    for (const [status, recoveryClass] of Object.entries(expected)) {
      const advice = hydrationRecovery(status);
      expect(advice.recoveryClass, status).toBe(recoveryClass);
      expect(advice.recovery.length).toBeGreaterThan(0);
    }
    // The two a caller cannot wait out say what to do instead.
    expect(hydrationRecovery("disabled").recovery).toContain("dangling");
    expect(hydrationRecovery("auth-failed").recovery).toContain("human");
    expect(hydrationRecovery("update-required").recovery).toContain("updated");
  });

  it("names the durable half of a partial write, and promises no rollback", async () => {
    // create_doc writes three independently persisted rooms. Failing the last
    // one is how a caller learns to read `partial` — the semantics themselves
    // belong to create_doc's own suite; what is checked here is that the
    // contract's fields describe them.
    const { rig, store } = await rigWith(
      (path) => new FailingStore(path, WORKSPACE),
    );
    const group = (
      await rig.ok("pin_doc", { uuid: (await seeded(rig)).uuid, group: "Docs" })
    ).group.id;

    store.failRoom = (room) => room === `${WORKSPACE}/_sidebar`;
    store.failing = true;
    const refused = await rig.call("create_doc", {
      title: "Half there",
      description: "A document whose sidebar placement was refused.",
      sidebar: { group: { id: group } },
    });

    expect(refused.payload.error).toBe("persistence_failed");
    expect(refused.payload.applied).toBe(false);
    expect(refused.payload.partial).toBe(true);
    expect(refused.payload.rolledBack).toBe(false);
    expect(
      refused.payload.completed.map((room: { purpose: string }) => room.purpose),
    ).toEqual(["document", "directory"]);
    // Manual, not retry: the fail-stop means the finishing call comes after a
    // restart, and repeating create_doc would make a second document.
    expect(refused.payload.recoveryClass).toBe("manual");
    expect(refused.payload.recovery).toContain("pin_doc");
  });

  it("rejects malformed arguments at the MCP boundary, before any handler runs", async () => {
    // A distinct class on purpose: the SDK validates against the tool's input
    // schema and answers with its own plain-text error. It is not JSON, carries
    // no `error` code of ours, and nothing durable can have changed — the
    // handler never ran.
    const rig = await localRig();
    const doc = await seeded(rig);

    const malformed = [
      // A field whose value is the wrong shape.
      { uuid: "not-a-uuid", block_id: "b", old_text: "", new_text: "" },
      // An undeclared field must be refused rather than silently dropped.
      {
        uuid: doc.uuid,
        block_id: doc.blockId,
        old_text: "one",
        new_text: "two",
        force: true,
      },
    ];
    for (const args of malformed) {
      const result = await rig.client.callTool({ name: "edit_block", arguments: args });
      const text = (result.content as { text?: string }[])[0]?.text ?? "";

      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text).not.toBe("");
      expect(() => JSON.parse(text)).toThrow();
      expect(FAILURE_CODES.some((code) => text.includes(code))).toBe(false);
    }

    // Arguments each valid on their own that do not add up to a call land in
    // the same class, because the shapes are in the input schema rather than in
    // a handler: `annotate` has no code of its own left to answer with.
    const incomplete = await rig.call("annotate", { uuid: doc.uuid, text: "orphan" });
    expect(incomplete.isError).toBe(true);
    expect(incomplete.payload.error).toBe("schema_validation");

    // Nothing reached the document: no call got past the boundary.
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).blocks[0].text).toBe("one");
  });
});
