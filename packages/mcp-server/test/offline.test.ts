/**
 * Offline-first, which is the whole promise of this package: with no hub
 * reachable, the server starts and every tool works.
 *
 * The hub is configured here (a secret and a URL) and simply not running, which
 * is the honest version of "the hub is down" — the sync layer is live, retrying,
 * and failing, and no tool call may care.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  removeTempDirs,
  startServer,
  testConfig,
  TEST_SECRET,
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
      "backlinks",
      "create_doc",
      "delete_block",
      "edit_block",
      "export_markdown",
      "get_doc",
      "insert_block",
      "list_docs",
      "search",
      "set_links",
      "set_tags",
      "sync_status",
    ]);

    // The staleness guarantee is local-replica-only, and edit_block says so.
    const edit = tools.find((tool) => tool.name === "edit_block");
    expect(edit?.description).toContain("no cross-replica compare-and-swap");
  });

  it("serves the whole tool set", async () => {
    const rig = await offlineRig();

    const created = await rig.ok("create_doc", {
      title: "Offline notes",
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

    const target = await rig.ok("create_doc", { title: "Link target" });
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

    const created = await rig.ok("create_doc", { title: "Durability" });
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
  });

  it("reports the hub as down, with the unsynced work it is holding", async () => {
    const rig = await offlineRig();
    const created = await rig.ok("create_doc", { title: "Held locally" });

    const status = await rig.ok("sync_status", {});
    expect(status.hub.status).toBe("hub-down");
    expect(status.hub.reason).toContain("127.0.0.1:1");
    expect(status.unsyncedChanges).toBeGreaterThan(0);
    // The doc's own room and the directory room both hold local-only changes.
    expect(status.pendingRooms).toContain(`main/${created.uuid}`);
    expect(status.pendingRooms).toContain("main/_directory");
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
    expect(
      status.rooms.map((room: { room: string }) => room.room),
    ).toEqual(["main/_directory"]);
  });

  it("tells a rejected token apart from an absent hub", async () => {
    // Sync switched off entirely is a third, distinct answer: no secret, no
    // hub, and every tool still works.
    const rig = await startServer(testConfig({ authSecret: null }));
    rigs.push(rig);

    const status = await rig.ok("sync_status", {});
    expect(status.hub.status).toBe("disabled");
    expect(status.hub.url).toBeNull();

    const created = await rig.ok("create_doc", { title: "Local only" });
    expect(created.applied).toBe(true);
    expect(created.synced).toBe(false);
  });
});
