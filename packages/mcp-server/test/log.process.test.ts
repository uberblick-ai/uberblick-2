import { mainProcess } from "./process-helpers.js";
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment, } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { PACKAGE_ROOT, WORKSPACE, removeTempDirs, startServer, tempDatabasePath, testConfig, waitUntil, } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

describe("the update log", () => {

  it("keeps a write that a SIGKILL interrupted", async () => {
    const databasePath = tempDatabasePath();
    const transport = new StdioClientTransport({
      ...mainProcess(),
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
        description: "A test document.",
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
  });
});
