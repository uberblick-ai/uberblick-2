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
import { applyDocData, createTagCatalogEntry, DATA_LIMITS, DataError, setTags, upsertDirectoryEntry } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  FAILURE_CODES,
  INTERNAL_ERROR_MESSAGE,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  hydrationRecovery,
  toFailure,
} from "../src/failures.js";
import { MirrorStore } from "../src/store.js";
import type { SearchHit } from "../src/store.js";
import {
  FailingStore,
  WORKSPACE,
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const stores: MirrorStore[] = [];

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
  data_invalid_input: { recoveryClass: "manual", detail: ["collection", "recordId"] },
  data_collection_not_found: { recoveryClass: "reread", detail: ["uuid", "collection"] },
  data_schema_invalid: { recoveryClass: "manual", detail: ["collection", "path"] },
  data_record_invalid: { recoveryClass: "manual", detail: ["collection", "recordId", "path"] },
  data_limit_exceeded: {
    recoveryClass: "manual",
    detail: ["collection", "recordId", "limit", "value", "attempted"],
  },
  invalid_table: { recoveryClass: "manual", detail: [] },
  table_mapping_required: { recoveryClass: "manual", detail: [] },
  invalid_table_mapping: { recoveryClass: "manual", detail: [] },
  annotation_cell: { recoveryClass: "manual", detail: ["blockId", "reason"] },
  invalid_github_reference: { recoveryClass: "manual", detail: ["github_ref"] },
  persistence_failed: { recoveryClass: "manual", detail: ["room"] },
  stale_block: {
    recoveryClass: "reread",
    detail: ["blockId", "currentText", "currentRev", "retry"],
  },
  old_text_mismatch: {
    recoveryClass: "manual",
    detail: ["blockId", "currentText", "currentRev", "retry"],
  },
  block_not_found: { recoveryClass: "reread", detail: ["blockId"] },
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
  governs_not_requirement: {
    recoveryClass: "reread",
    detail: ["governs", "kind"],
  },
  invalid_tag_assignment: {
    recoveryClass: "manual",
    detail: ["unknown", "retired"],
  },
  supersedes_not_decision: {
    recoveryClass: "reread",
    detail: ["supersedes", "kind"],
  },
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
  it("classifies every registered tool as writing or read-only", async () => {
    // The one fact a failure payload cannot work out for itself: the same
    // `doc_not_found` is a read's dead end and a write that never happened. A
    // tool added later is classified here or this fails.
    const rig = await localRig();
    const registered = (await rig.client.listTools()).tools;

    expect(registered.length).toBeGreaterThan(0);
    for (const { name, description } of registered) {
      expect(
        MUTATING_TOOLS.has(name) || READ_ONLY_TOOLS.has(name),
        `${name} is neither in MUTATING_TOOLS nor READ_ONLY_TOOLS`,
      ).toBe(true);
      expect(MUTATING_TOOLS.has(name) && READ_ONLY_TOOLS.has(name)).toBe(false);
      // And every tool names the shape it answers with — the machine contract,
      // the mutation fields only where there is a write to report. The prose
      // that explains them is carried once, in the server's instructions.
      expect(description, `${name} has no description`).toBeDefined();
      expect(description).toContain("recoveryClass");
      expect(description?.includes("`partial`")).toBe(MUTATING_TOOLS.has(name));
    }
    expect([...MUTATING_TOOLS, ...READ_ONLY_TOOLS].sort()).toEqual(
      registered.map((tool) => tool.name).sort(),
    );
  });

  it("gives every failure code a message, its domain detail and a recovery class", async () => {
    const rig = await localRig();
    const doc = await seeded(rig);
    const failures = new Map<string, any>();
    const record = (payload: any): void => {
      failures.set(payload.error, payload);
    };

    record((await rig.call("get_doc", { uuid: randomUUID() })).payload);
    record((await rig.call("get_data", { uuid: doc.uuid, collection: "missing" })).payload);
    record((await rig.call("find_decisions", { github_ref: "#1" })).payload);
    record((await rig.call("insert_block", {
      uuid: doc.uuid, type: "table", text: "not a GFM table",
    })).payload);
    const table = await rig.ok("insert_block", {
      uuid: doc.uuid, after_block_id: doc.blockId, type: "table", text: "| Header |\n| --- |\n| Cell |",
    });
    record((await rig.call("edit_block", {
      uuid: doc.uuid, block_id: table.block.id, old_text: table.block.text,
      new_text: "| Header | Added |\n| --- | --- |\n| Cell | New |",
    })).payload);
    record((await rig.call("edit_block", {
      uuid: doc.uuid, block_id: table.block.id, old_text: table.block.text, new_text: table.block.text,
      table_mapping: { rows: [0, 2], columns: [0] },
    })).payload);
    record((await rig.call("annotate", {
      uuid: doc.uuid, block_id: table.block.id, start: 0, end: 3, text: "Missing cell coordinates",
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
    const requirement = await rig.ok("create_doc", {
      title: "Fixed kind",
      description: "A requirement with a schema-owned lifecycle.",
      kind: "requirement",
    });
    record(
      (
        await rig.call("set_status", {
          uuid: requirement.uuid,
          status: "open",
        })
      ).payload,
    );
    const firstDecision = await rig.ok("create_doc", {
      title: "First decision",
      description: "The topic's first stance.",
      kind: "decision",
      status: "decided",
    });
    const successorDecision = await rig.ok("create_doc", {
      title: "Successor proposal",
      description: "A proposal that needs a person's answer.",
      kind: "decision",
      supersedes: firstDecision.uuid,
    });
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
    record((await rig.call("set_title", { uuid: firstDecision.uuid, title: "Frozen" })).payload);
    record(
      (
        await rig.call("create_doc", {
          title: "Wrong governing kind",
          description: "A decision cannot govern an ordinary document.",
          kind: "decision",
          governs: doc.uuid,
        })
      ).payload,
    );
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
    const archived = await seeded(rig);
    await rig.ok("archive_doc", { uuid: archived.uuid });
    record(
      (await rig.call("set_title", { uuid: archived.uuid, title: "Nope" }))
        .payload,
    );
    record(
      (
        await rig.call("set_tags", {
          uuid: doc.uuid,
          tags: ["not-in-catalog"],
        })
      ).payload,
    );

    // No data tool is introduced in this slice. Exercise the shared operation
    // errors through the same adapter a later dedicated tool will use.
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
        const failure = toFailure("edit_block", error);
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
    record((await rig.call("set_title", { uuid: doc.uuid, title: "Unbriefed" })).payload);

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
        await failing.rig.call("set_title", {
          uuid: victim.uuid,
          title: "Refused",
        })
      ).payload,
    );

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

  it("says a failed write changed nothing, and invents nothing for a read", async () => {
    const rig = await localRig();

    const write = await rig.call("set_title", {
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
    const refusedWrite = await failing.rig.call("set_title", {
      uuid: doc.uuid,
      title: "Refused",
    });
    expect(refusedWrite.payload.error).toBe("persistence_failed");
    expect(refusedWrite.payload.applied).toBe(false);
    expect(refusedWrite.payload.partial).toBe(false);

    const blockedRead = await failing.rig.call("get_doc", { uuid: doc.uuid });
    expect(blockedRead.payload.error).toBe("persistence_failed");
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
      // And a field nobody declared, which used to be dropped in silence.
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
