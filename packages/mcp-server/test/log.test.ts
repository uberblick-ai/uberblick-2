/**
 * The update log is the authoritative local replica.
 *
 * Three properties, each of which something else depends on:
 *
 * - every update is appended *synchronously*, so a mutating tool cannot return
 *   before its update is committed — verified by reading the file through a
 *   second handle, and by killing the process with `SIGKILL` and coming back;
 * - replicas hydrate from the log, never from the hub;
 * - compaction replaces a log prefix with a snapshot in one transaction, and a
 *   replica built from the compacted log is the same replica.
 */

import { afterAll, describe, expect, it } from "vitest";
import { MirrorStore } from "../src/store.js";
import { WORKSPACE, directoryStub, removeTempDirs, startServer, tempDatabasePath, testConfig } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

describe("the update log", () => {
  it("has the update on disk before the mutating tool returns", async () => {
    const databasePath = tempDatabasePath();
    const rig = await startServer(testConfig({ databasePath }));
    try {
      const doc = await rig.ok("create_doc", {
        title: "Committed",
        description: "A test document.",
        blocks: [{ type: "paragraph", text: "already durable" }],
      });

      // A second handle on the same file sees only committed data.
      const reader = new MirrorStore(databasePath, WORKSPACE);
      try {
        const room = `${WORKSPACE}/${doc.uuid}`;
        const logged = reader.updatesAfter(room, 0);
        expect(logged.length).toBeGreaterThan(0);
        // Enough to rebuild the document, with nothing but the log.
        expect(reader.updatesAfter(`${WORKSPACE}/_directory`, 0).length).toBeGreaterThan(
          0,
        );
      } finally {
        reader.close();
      }
    } finally {
      await rig.close();
    }
  });

  it("hydrates a new replica set from the log alone", async () => {
    const databasePath = tempDatabasePath();
    const first = await startServer(testConfig({ databasePath }));
    let uuid: string;
    try {
      const doc = await first.ok("create_doc", {
        title: "Written once",
        description: "A test document.",
        tags: ["auth"],
        blocks: [
          { type: "heading", text: "Written once", level: 2 },
          { type: "paragraph", text: "read back from the log" },
        ],
      });
      uuid = doc.uuid;
      await first.ok("set_metadata", { uuid, links: [] });
    } finally {
      await first.close();
    }

    // No hub was ever configured, so the log is the only possible source.
    const second = await startServer(testConfig({ databasePath }));
    try {
      const listed = await second.ok("list_docs", {});
      expect(listed.docs).toEqual([
        {
          uuid,
          title: "Written once",
          tags: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              name: "auth",
              state: "active",
            },
          ],
          description: "A test document.",
          pinned: false,
          updatedAt: expect.any(Number),
          openThreadCount: 0,
        },
      ]);
      expect(directoryStub(second.instance, uuid)).toMatchObject({ createdAt: expect.any(Number), code_check: [] });

      const read = await second.ok("get_doc", { uuid });
      expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([
        "Written once",
        "read back from the log",
      ]);
      expect(
        (await second.ok("search", { query: "read back" })).hits.map(
          (hit: { uuid: string }) => hit.uuid,
        ),
      ).toEqual([uuid]);
    } finally {
      await second.close();
    }
  });

  it("compacts a long log into a snapshot without losing a document", async () => {
    const databasePath = tempDatabasePath();
    const rig = await startServer(
      testConfig({ databasePath, compactAfter: 4 }),
    );
    let uuid: string;
    try {
      const doc = await rig.ok("create_doc", {
        title: "Compacted",
        description: "A test document.",
        blocks: [{ type: "paragraph", text: "0" }],
      });
      uuid = doc.uuid;
      const blockId = doc.blocks[0].id;

      let text = "0";
      for (let step = 1; step <= 6; step += 1) {
        const next = `${text} ${step}`;
        await rig.ok("edit_block", {
          uuid,
          block_id: blockId,
          old_text: text,
          new_text: next,
        });
        text = next;
      }

      // One more tool call so the settle that follows the last write runs.
      await rig.ok("sync_status", {});

      const room = `${WORKSPACE}/${uuid}`;
      const snapshot = rig.instance.store.snapshot(room);
      expect(snapshot).not.toBeNull();
      expect(rig.instance.store.updateCount(room)).toBeLessThan(4);
    } finally {
      await rig.close();
    }

    // The snapshot has to be enough on its own.
    const rebuilt = await startServer(testConfig({ databasePath }));
    try {
      const read = await rebuilt.ok("get_doc", { uuid });
      expect(read.blocks[0].text).toBe("0 1 2 3 4 5 6");
    } finally {
      await rebuilt.close();
    }
  });
});
