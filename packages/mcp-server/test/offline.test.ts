/**
 * Offline-first, which is the whole promise of this package: with no hub
 * reachable, the server starts and every tool works.
 *
 * The hub is configured here (a secret and a URL) and simply not running, which
 * is the honest version of "the hub is down" — the sync layer is live, retrying,
 * and failing, and no tool call may care.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "@uberblick/schema";
import {
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  WORKSPACE,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function offlineRig(): Promise<Rig> {
  // A configured hub that is not there: nothing listens on port 1.
  const rig = await startServer(
    testConfig({ authSecret: TEST_SECRET, hubUrl: "ws://127.0.0.1:1" }),
  );
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("with the hub stopped", () => {
  it("exposes exactly the v0 tool set", async () => {
    const rig = await offlineRig();
    const { tools } = await rig.client.listTools();

    // Pinned deliberately. An extra tool is a contract change, and a
    // whole-document write must never appear here.
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "annotate",
      "archive_doc",
      "backlinks",
      "create_doc",
      "delete_block",
      "edit_block",
      "export_markdown",
      "get_doc",
      "get_sidebar",
      "insert_block",
      "link_range",
      "list_docs",
      "pin_doc",
      "restore_doc",
      "search",
      "set_changelog_suggestion",
      "set_description",
      "set_links",
      "set_tags",
      "set_title",
      "sidebar_group",
      "sync_status",
      "unpin_doc",
    ]);

    // The staleness guarantee is local-replica-only, and edit_block says so.
    const edit = tools.find((tool) => tool.name === "edit_block");
    expect(edit?.description).toContain("no cross-replica compare-and-swap");

    // And so is the mark boundary: a splice that touches a mark's edge
    // re-anchors it, which is damage no error reports. An agent only learns
    // that here, so the sentence and its repair are part of the contract.
    expect(edit?.description).toContain("touches a mark's edge re-anchors it");
    expect(edit?.description).toContain("delete_block plus insert_block");

    // insert_block accepts every block type the schema owns, so its
    // description has to name every one of them — the list went stale once
    // already, which is why it is generated from BLOCK_TYPES and pinned here.
    const insert = tools.find((tool) => tool.name === "insert_block");
    for (const type of BLOCK_TYPES) {
      expect(insert?.description).toContain(type);
    }
  });

  it("reads a document without writing to the replica log", async () => {
    const rig = await offlineRig();
    const created = await rig.ok("create_doc", {
      title: "Read only",
      description: "A test document.",
    });
    const logCounts = () =>
      new Map(
        rig.instance.replicas
          .attachedReplicas()
          .map((replica) => [
            replica.room,
            rig.instance.store.updateCount(replica.room),
          ]),
      );
    const before = logCounts();

    const read = await rig.ok("get_doc", { uuid: created.uuid });

    expect(read).not.toHaveProperty("feedback");
    expect(logCounts()).toEqual(before);
  });

  it("serves the whole tool set", async () => {
    const rig = await offlineRig();

    const created = await rig.ok("create_doc", {
      title: "Offline notes",
      description: "A test document.",
      tags: ["spike"],
      blocks: [
        { type: "heading", text: "Offline notes", level: 1 },
        { type: "paragraph", text: "written with no hub in sight" },
        { type: "code", text: "const offline = true;", language: "ts" },
        { type: "mermaid", text: "graph TD; A-->B;" },
      ],
    });
    expect(created.uuid).toBeTruthy();
    expect(created.blocks).toHaveLength(4);

    const target = await rig.ok("create_doc", { title: "Link target", description: "A test document." });
    await rig.ok("set_links", {
      uuid: created.uuid,
      links: [target.uuid],
    });

    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.title).toBe("Offline notes");
    expect(read.links).toEqual([target.uuid]);

    const paragraph = read.blocks[1];
    const edited = await rig.ok("edit_block", {
      uuid: created.uuid,
      block_id: paragraph.id,
      old_text: paragraph.text,
      new_text: "written with no hub in sight, and it worked",
      rev: paragraph.rev,
    });
    expect(edited.block.text).toBe(
      "written with no hub in sight, and it worked",
    );

    const inserted = await rig.ok("insert_block", {
      uuid: created.uuid,
      after_block_id: paragraph.id,
      type: "paragraph",
      text: "appended offline",
    });
    expect(inserted.block.text).toBe("appended offline");

    await rig.ok("delete_block", {
      uuid: created.uuid,
      block_id: inserted.block.id,
    });

    await rig.ok("set_tags", { uuid: created.uuid, tags: ["spike", "offline"] });

    const listed = await rig.ok("list_docs", {});
    expect(listed.docs.map((doc: { uuid: string }) => doc.uuid).sort()).toEqual(
      [created.uuid, target.uuid].sort(),
    );

    const filtered = await rig.ok("list_docs", { tag: "offline" });
    expect(filtered.docs).toHaveLength(1);

    const found = await rig.ok("search", { query: "hub in sight" });
    expect(found.hits.map((hit: { uuid: string }) => hit.uuid)).toContain(
      created.uuid,
    );

    const links = await rig.ok("backlinks", { uuid: target.uuid });
    expect(links.backlinks.map((row: { uuid: string }) => row.uuid)).toEqual([
      created.uuid,
    ]);

    const annotated = await rig.ok("annotate", {
      uuid: created.uuid,
      block_id: paragraph.id,
      start: 0,
      end: 7,
      text: "why offline?",
    });
    expect(annotated.annotation.range).toEqual({
      start: 0,
      end: 7,
      collapsed: false,
    });
    const commented = await rig.ok("annotate", {
      uuid: created.uuid,
      thread_id: annotated.annotation.id,
      text: "because the log is the replica",
    });
    expect(commented.annotation.comments).toHaveLength(2);

    const exported = await rig.ok("export_markdown", { uuid: created.uuid });
    expect(exported.markdown).toContain("# Offline notes");
    expect(exported.markdown).toContain("```ts\nconst offline = true;\n```");
    expect(exported.markdown).toContain("```mermaid\ngraph TD; A-->B;\n```");
  });

  it("reports every mutating tool as applied but not synced", async () => {
    const rig = await offlineRig();

    const created = await rig.ok("create_doc", { title: "Durability", description: "A test document." });
    expect(created.applied).toBe(true);
    expect(created.synced).toBe(false);

    const block = await rig.ok("insert_block", {
      uuid: created.uuid,
      type: "paragraph",
      text: "one",
    });
    expect(block.applied).toBe(true);
    expect(block.synced).toBe(false);

    for (const call of [
      rig.ok("set_tags", { uuid: created.uuid, tags: ["x"] }),
      rig.ok("set_links", { uuid: created.uuid, links: [] }),
    ]) {
      const payload = await call;
      expect(payload.applied).toBe(true);
      expect(payload.synced).toBe(false);
    }

    // These two write the directory rather than the document, so they report
    // durability for a different room — offline is still offline.
    const archived = await rig.ok("archive_doc", { uuid: created.uuid });
    expect(archived.applied).toBe(true);
    expect(archived.synced).toBe(false);

    const restored = await rig.ok("restore_doc", { uuid: created.uuid });
    expect(restored.applied).toBe(true);
    expect(restored.synced).toBe(false);
  });

  // `hub.status` is what an agent reads to know whether its work has left the
  // machine, so the values have to be distinguishable. Two of the three are
  // reachable with no hub: "hub-down" (configured, unreachable) and "disabled"
  // (never configured). The third, "auth-failed", needs a hub that rejects a
  // token and is pinned in sync.test.ts.
  it("reports the hub as down, with the unsynced work it is holding", async () => {
    const rig = await offlineRig();
    const created = await rig.ok("create_doc", { title: "Held locally", description: "A test document." });

    const status = await rig.ok("sync_status", {});
    expect(status.hub.status).toBe("hub-down");
    expect(status.hub.reason).toContain("127.0.0.1:1");
    expect(status.unsyncedChanges).toBeGreaterThan(0);
    // The doc's own room and the directory room both hold local-only changes,
    // each with the log sequence it is waiting on.
    const pending = status.pendingRooms as { room: string; seq: number }[];
    expect(pending.map((entry) => entry.room)).toEqual(
      expect.arrayContaining([`${WORKSPACE}/${created.uuid}`, `${WORKSPACE}/_directory`]),
    );
    for (const entry of pending) {
      expect(entry.seq).toBeGreaterThan(0);
    }
    expect(status.unsyncedChanges).toBe(pending.length);

    // Sync switched off entirely is a distinct answer, not the same as a hub
    // that is merely unreachable — and every tool still works either way.
    const disabled = await startServer(testConfig({ authSecret: null }));
    rigs.push(disabled);
    const off = await disabled.ok("sync_status", {});
    expect(off.hub.status).toBe("disabled");
    expect(off.hub.url).toBeNull();
    const local = await disabled.ok("create_doc", { title: "Local only", description: "A test document." });
    expect(local.applied).toBe(true);
    expect(local.synced).toBe(false);
  });

  it("keeps reporting unsynced work in local-only mode, across a restart", async () => {
    // The count comes from the durable pending set, not a provider's in-memory
    // counter: with sync disabled there is no provider at all, and an offline
    // restart starts every counter at zero — but the work is still unsynced.
    const databasePath = tempDatabasePath();
    const first = await startServer(testConfig({ databasePath }));
    rigs.push(first);
    const created = await first.ok("create_doc", { title: "Never left home", description: "A test document." });

    const before = await first.ok("sync_status", {});
    expect(before.hub.status).toBe("disabled");
    expect(before.inFlightUpdates).toBe(0);
    expect(before.unsyncedChanges).toBeGreaterThan(0);

    await first.close();
    rigs.length = 0;

    const restarted = await startServer(testConfig({ databasePath }));
    rigs.push(restarted);
    const after = await restarted.ok("sync_status", {});
    expect(after.unsyncedChanges).toBeGreaterThan(0);
    expect(
      (after.pendingRooms as { room: string }[]).map((entry) => entry.room),
    ).toContain(`${WORKSPACE}/${created.uuid}`);
  });

  it("does not open a room for a document nobody has heard of", async () => {
    const rig = await offlineRig();
    const missing = await rig.call("get_doc", {
      uuid: "6f1f5f2e-0000-4000-8000-000000000000",
    });

    expect(missing.isError).toBe(true);
    expect(missing.payload.error).toBe("doc_not_found");
    // A typo must not create an empty document on the hub.
    const status = await rig.ok("sync_status", {});
    // The well-known rooms and nothing else: discovery and curation are synced
    // docs, attached from boot.
    expect(
      status.rooms.map((room: { room: string }) => room.room),
    ).toEqual([
      `${WORKSPACE}/_directory`,
      `${WORKSPACE}/_sidebar`,
    ]);
  });

});
