import { mainProcess } from "./process-helpers.js";
/** Document data uses the existing room log, snapshots and hub sync path. */

/** Document data uses the existing room log, snapshots and hub sync path. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment, } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT, WORKSPACE, cleanupTestResources, tempDatabasePath, waitUntil } from "./helpers.js";

const processes = new Set<ProcessClient>();

afterEach(async () => {
  const clients = [...processes];
  processes.clear();
  await cleanupTestResources({
    clients: clients.map((client) => () => client.close()),
  });
});

const observationSchema = {
  version: 1 as const,
  schema: {
    type: "object" as const,
    properties: { text: { type: "string" as const } },
    required: ["text"],
    additionalProperties: false as const,
  },
};

interface ProcessClient {
  readonly pid: number;
  ok(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Separate processes must exchange data through the shared log, not memory. */
async function processClient(databasePath: string): Promise<ProcessClient> {
  const transport = new StdioClientTransport({
    ...mainProcess(),
    cwd: PACKAGE_ROOT,
    env: {
      ...getDefaultEnvironment(),
      WORKSPACE_ID: WORKSPACE,
      UBERBLICK_DB: databasePath,
      XDG_DATA_HOME: dirname(databasePath),
      HUB_URL: "ws://127.0.0.1:1",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "uberblick-tests", version: "0.0.0" });
  let pid: number | null = null;
  const started: ProcessClient = {
    get pid() {
      if (pid === null) throw new Error("MCP process has not started");
      return pid;
    },
    async ok(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text?: string }[];
      const payload = JSON.parse(content[0]?.text ?? "null");
      if (result.isError === true) {
        throw new Error(`tool ${name} failed: ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    async close() {
      await client.close();
      if (pid !== null) {
        await waitUntil("the MCP process to exit", () => !alive(pid as number));
      }
      processes.delete(started);
    },
  };
  processes.add(started);
  await client.connect(transport);
  pid = transport.pid;
  return started;
}

describe("document-owned data persistence", () => {

  it("exchanges MCP data between two processes on one database and survives an abrupt restart", async () => {
    const databasePath = tempDatabasePath();
    const writer = await processClient(databasePath);
    const reader = await processClient(databasePath);
    expect(writer.pid).not.toBe(reader.pid);
    // Both processes start before either creates the document, so the reader
    // must discover the directory and document log tails on its next call.
    const created = await writer.ok("create_doc", {
      title: "Shared local document data",
      description: "A synthetic multi-process persistence fixture.",
    });
    const operations = [{
      collection: "observations",
      schema: observationSchema,
      upsert: [{ id: "row-1", value: { text: "from first process" } }],
    }];
    expect(await writer.ok("update_data", { uuid: created.uuid, operations }))
      .toMatchObject({ changed: true, applied: true, synced: false });
    const args = { uuid: created.uuid, collection: "observations" };
    expect(await reader.ok("get_data", args)).toEqual(await writer.ok("get_data", args));

    expect(await reader.ok("update_data", {
      uuid: created.uuid,
      operations: [{
        collection: "observations",
        upsert: [{ id: "row-2", value: { text: "from second process" } }],
      }],
    })).toMatchObject({ changed: true, applied: true, synced: false });
    const expected = await reader.ok("get_data", args);
    expect(await writer.ok("get_data", args)).toEqual(expected);
    expect(expected.records.map((record: { id: string }) => record.id))
      .toEqual(["row-1", "row-2"]);

    // A completed response must be durable even if shutdown never runs.
    process.kill(writer.pid, "SIGKILL");
    await waitUntil("the killed MCP writer to exit", () => !alive(writer.pid));
    await writer.close();
    await reader.close();
    const restarted = await processClient(databasePath);
    expect(await restarted.ok("get_data", args)).toEqual(expected);
    await restarted.close();
  });
});
