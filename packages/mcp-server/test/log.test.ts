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

import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, describe, expect, it } from "vitest";
import { MirrorStore } from "../src/store.js";
import {
  mainTsProcess,
  PACKAGE_ROOT,
  WORKSPACE,
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
  waitUntil,
} from "./helpers.js";

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
        blocks: [{ type: "paragraph", text: "already durable" }],
      });

      // A second handle on the same file sees only committed data.
      const reader = new MirrorStore(databasePath);
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
        tags: ["kept"],
        blocks: [
          { type: "heading", text: "Written once", level: 2 },
          { type: "paragraph", text: "read back from the log" },
        ],
      });
      uuid = doc.uuid;
      await first.ok("set_links", { uuid, links: [] });
    } finally {
      await first.close();
    }

    // No hub was ever configured, so the log is the only possible source.
    const second = await startServer(testConfig({ databasePath }));
    try {
      const listed = await second.ok("list_docs", {});
      expect(listed.docs).toEqual([
        { uuid, title: "Written once", tags: ["kept"], pinned: false },
      ]);

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

  it("keeps a write that a SIGKILL interrupted", async () => {
    const databasePath = tempDatabasePath();
    const transport = new StdioClientTransport({
      ...mainTsProcess(),
      cwd: PACKAGE_ROOT,
      // No HUB_AUTH_TOKEN: the child runs local-only, which is the point.
      env: {
        ...getDefaultEnvironment(),
        WORKSPACE_ID: WORKSPACE,
        UBERBLICK_DB: databasePath,
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "uberblick-tests", version: "0.0.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "create_doc",
      arguments: {
        title: "Survives a kill",
        blocks: [{ type: "paragraph", text: "written just before the kill" }],
      },
    });
    const content = result.content as { text: string }[];
    const created = JSON.parse(content[0]?.text ?? "{}") as {
      uuid: string;
      applied: boolean;
    };
    expect(created.applied).toBe(true);

    const pid = transport.pid;
    expect(pid).not.toBeNull();
    process.kill(pid as number, "SIGKILL");
    await waitUntil("the child process to be gone", () => {
      try {
        process.kill(pid as number, 0);
        return false;
      } catch {
        return true;
      }
    });

    // A brand-new server on the same database, with no hub in the picture.
    const rig = await startServer(testConfig({ databasePath }));
    try {
      const read = await rig.ok("get_doc", { uuid: created.uuid });
      expect(read.title).toBe("Survives a kill");
      expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([
        "written just before the kill",
      ]);
      const listed = await rig.ok("list_docs", {});
      expect(listed.docs.map((doc: { uuid: string }) => doc.uuid)).toEqual([
        created.uuid,
      ]);
    } finally {
      await rig.close();
    }
  }, 30_000);

  it("compacts a long log into a snapshot without losing a document", async () => {
    const databasePath = tempDatabasePath();
    const rig = await startServer(
      testConfig({ databasePath, compactAfter: 4 }),
    );
    let uuid: string;
    try {
      const doc = await rig.ok("create_doc", {
        title: "Compacted",
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
