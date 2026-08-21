/**
 * What `synced: true` promises, and what it does not.
 *
 * It promises that the hub acknowledged the update: the update is in the hub's
 * memory and will be written within the hub's store debounce. It does not
 * promise that the update is on the hub's disk — and the gap is not theoretical:
 * a hub killed inside that window drops a write this server already reported as
 * `synced: true` with `unsyncedChanges: 0`. The tool descriptions say exactly
 * that; this probe is the behaviour they describe, pinned so the claim cannot
 * quietly widen again.
 *
 * The debounce lives in the hub process' memory, so real processes and a real
 * `SIGKILL` are the only honest reproduction: an in-process "crash" would assert
 * the test's own bookkeeping instead of the hub's.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGE_ROOT,
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

/** `packages/hub`, so the probe runs the hub the way `mise run hub` does. */
const HUB_ROOT = dirname(
  dirname(createRequire(import.meta.url).resolve("@uberblick/hub")),
);

const STORED = "stored before the crash";
const ACKNOWLEDGED = "acknowledged, never stored";

const hubProcesses: ChildProcess[] = [];
const writers: Writer[] = [];
const rigs: Rig[] = [];

interface HubProcess {
  readonly pid: number;
  readonly port: number;
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Start `packages/hub/src/main.ts` as its own process and read back its port. */
async function startHubProcess(databasePath: string): Promise<HubProcess> {
  // `node --import tsx`, never the `tsx` binary: tsx's CLI runs the script in a
  // grandchild, which a SIGKILL to the child would leave alive and syncing.
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join("src", "main.ts")],
    {
      cwd: HUB_ROOT,
      env: {
        ...process.env,
        HUB_AUTH_TOKEN: TEST_SECRET,
        HUB_HOST: "127.0.0.1",
        HUB_DB_PATH: databasePath,
        PORT: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  hubProcesses.push(child);

  const port = await new Promise<number>((resolve, reject) => {
    child.stderr?.setEncoding("utf8");
    let rest = "";
    child.stderr?.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        // Node's own warnings share this stream; only the hub log is JSON.
        const record = parseRecord(line);
        if (record?.event === "hub.listen") {
          resolve(record.port as number);
        }
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`the hub process exited with ${String(code)}`));
    });
  });

  return { pid: child.pid as number, port };
}

interface Writer {
  readonly pid: number;
  // Tool payloads are JSON by contract; the test asserts on their fields.
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

/** An MCP server in its own process, syncing to the hub on `port`. */
async function startWriter(port: number): Promise<Writer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join("src", "main.ts")],
    cwd: PACKAGE_ROOT,
    env: {
      ...getDefaultEnvironment(),
      UBERBLICK_DB: tempDatabasePath(),
      HUB_URL: `ws://127.0.0.1:${port}`,
      HUB_AUTH_TOKEN: TEST_SECRET,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "uberblick-tests", version: "0.0.0" });
  await client.connect(transport);

  const writer: Writer = {
    pid: transport.pid as number,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text?: string }[];
      const payload = JSON.parse(content[0]?.text ?? "null");
      if (result.isError === true) {
        throw new Error(`tool ${name} failed: ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    close: () => client.close(),
  };
  writers.push(writer);
  return writer;
}

/** True once the hub's SQLite file holds a row for `room`. */
function isStored(databasePath: string, room: string): boolean {
  try {
    const database = new Database(databasePath, { readonly: true });
    try {
      return (
        database.prepare('SELECT 1 FROM "documents" WHERE name = ?').get(room) !==
        undefined
      );
    } finally {
      database.close();
    }
  } catch {
    // No file, no table, or a writer mid-transaction: not stored yet.
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const writer of writers.splice(0)) {
    await writer.close().catch(() => {});
  }
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  for (const child of hubProcesses.splice(0)) {
    child.kill("SIGKILL");
  }
  removeTempDirs();
});

describe("synced", () => {
  it("means acknowledged, not stored: a hub killed inside the debounce loses the write", async () => {
    const hubDatabase = tempDatabasePath();
    const running = await startHubProcess(hubDatabase);
    const writer = await startWriter(running.port);

    const created = await writer.call("create_doc", {
      title: "The debounce window",
      blocks: [{ type: "paragraph", text: STORED }],
    });
    const room = `main/${created.uuid}`;

    // The create has to reach the hub's disk before the edit is made: otherwise
    // the crash takes the whole document and says nothing about the window.
    await waitUntil(
      "the hub to store the created document",
      () => isStored(hubDatabase, room) && isStored(hubDatabase, "main/_directory"),
    );

    await writer.call("edit_block", {
      uuid: created.uuid,
      block_id: created.blocks[0].id,
      old_text: STORED,
      new_text: ACKNOWLEDGED,
    });
    await waitUntil("the hub to acknowledge the edit", async () => {
      const status = await writer.call("sync_status");
      return (
        status.unsyncedChanges === 0 &&
        status.rooms.some(
          (entry: { room: string; synced: boolean }) =>
            entry.room === room && entry.synced,
        )
      );
    });

    // The hub dies first, and both die before either can be waited on: a writer
    // that went first would let the hub store the document on the disconnect,
    // and a writer outliving the restart would simply re-send the edit.
    process.kill(running.pid, "SIGKILL");
    process.kill(writer.pid, "SIGKILL");
    await waitUntil(
      "the hub and the writer to be gone",
      () => !alive(running.pid) && !alive(writer.pid),
    );

    const restarted = await startHubProcess(hubDatabase);
    const fresh = await startServer(
      testConfig({
        databasePath: tempDatabasePath(),
        authSecret: TEST_SECRET,
        hubUrl: `ws://127.0.0.1:${restarted.port}`,
      }),
    );
    rigs.push(fresh);

    // An empty store, so everything this replica answers came from the hub.
    let read: { blocks: { text: string }[] } | undefined;
    await waitUntil("the fresh replica to hydrate the document", async () => {
      const result = await fresh.call("get_doc", { uuid: created.uuid });
      read = result.payload;
      return !result.isError;
    });

    // What the hub had stored survives; the acknowledged edit does not. That is
    // the whole of what `synced: true` claims, and the crash window is the gap
    // between the two — named in create_doc, edit_block and sync_status.
    expect(read?.blocks.map((block) => block.text)).toEqual([STORED]);
  }, 45_000);
});
