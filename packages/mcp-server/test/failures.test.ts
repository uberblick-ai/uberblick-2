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
import { upsertDirectoryEntry } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  FAILURE_CODES,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
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
async function seeded(rig: Rig): Promise<{ uuid: string; blockId: string }> {
  const created = await rig.ok("create_doc", {
    title: "Contract",
    description: "A document the failure contract is exercised against.",
    blocks: [{ type: "paragraph", text: "one" }],
  });
  return { uuid: created.uuid, blockId: created.blocks[0].id };
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
  persistence_failed: { recoveryClass: "manual", detail: ["room"] },
  stale_block: {
    recoveryClass: "reread",
    detail: ["blockId", "currentText", "currentRev", "retry"],
  },
  block_not_found: { recoveryClass: "reread", detail: ["blockId"] },
  annotation_range: {
    recoveryClass: "reread",
    detail: ["reason", "blockId", "conflictingThreadId"],
  },
  thread_not_found: { recoveryClass: "reread", detail: ["uuid", "threadId"] },
  doc_not_found: {
    recoveryClass: "reread",
    detail: ["uuid", "inDirectory", "hub"],
  },
  doc_not_hydrated: {
    recoveryClass: "retry",
    detail: ["uuid", "inDirectory", "hub"],
  },
  doc_archived: { recoveryClass: "manual", detail: ["uuid", "archived"] },
  group_not_found: { recoveryClass: "reread", detail: ["group"] },
  invalid_arguments: { recoveryClass: "manual", detail: ["uuid"] },
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
      // And every tool says so where an agent reads it: the floor in every
      // description, the mutation half only where there is a write to report.
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
    // Individually valid arguments that do not add up to a call: a new thread
    // needs a block and a range, so this never reaches the schema layer's net.
    record(
      (await rig.call("annotate", { uuid: doc.uuid, text: "orphan" })).payload,
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
    const archived = await seeded(rig);
    await rig.ok("archive_doc", { uuid: archived.uuid });
    record(
      (await rig.call("set_title", { uuid: archived.uuid, title: "Nope" }))
        .payload,
    );

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

    const result = await rig.client.callTool({
      name: "edit_block",
      arguments: { uuid: "not-a-uuid", block_id: "b", old_text: "", new_text: "" },
    });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";

    expect(result.isError).toBe(true);
    expect(text).not.toBe("");
    expect(() => JSON.parse(text)).toThrow();
    expect(FAILURE_CODES.some((code) => text.includes(code))).toBe(false);
    // Nothing reached the corpus: the call never got past the boundary.
    expect((await rig.ok("list_docs")).docs).toEqual([]);
  });
});
