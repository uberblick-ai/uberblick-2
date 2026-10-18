/** Data producers share the existing local log and hub path with live servers. */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHub, silentLogger, type Hub } from "@uberblick/hub";
import { afterEach, describe, expect, it } from "vitest";
import { DEAD_HUB_URL, pointAt, removeTempDirs, runUbAsync, sandbox, type Sandbox } from "./helpers.js";
import { ensureWorkspaceBinding } from "../src/workspace-registry.js";

const WORKSPACE = "c4ee1905-90e4-42df-8a4c-ed6ce9cbe531";
const SECRET = "data-sync-test-secret";
const sessions: Session[] = [];
const hubs: Hub[] = [];
const observationSchema = {
  version: 1,
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

interface Session {
  ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function waitUntil(label: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
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

async function connect(box: Sandbox, env: NodeJS.ProcessEnv = {}): Promise<Session> {
  const childEnv = Object.fromEntries(Object.entries({
    ...box.env,
    WORKSPACE_ID: WORKSPACE,
    HUB_URL: DEAD_HUB_URL,
    ...env,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./main.ts", import.meta.resolve("@uberblick/mcp-server")))],
    cwd: box.cwd,
    env: childEnv,
    stderr: "pipe",
  });
  const client = new Client({ name: "ub-data-tests", version: "0.0.0" });
  let stderr = "";
  let closed = false;
  const deadline = setTimeout(() => {
    const pid = transport.pid;
    if (pid !== null && alive(pid)) process.kill(pid, "SIGKILL");
  }, 40_000);
  const session: Session = {
    async ok(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text?: string }[];
      const payload = JSON.parse(content[0]?.text ?? "null") as Record<string, unknown>;
      if (result.isError === true) {
        throw new Error(`tool ${name} refused: ${JSON.stringify(payload)}\n${stderr}`);
      }
      return payload;
    },
    async close() {
      if (closed) return;
      closed = true;
      const pid = transport.pid;
      try {
        await client.close();
        if (pid !== null) await waitUntil("the MCP fixture process to exit", () => !alive(pid));
      } finally {
        clearTimeout(deadline);
      }
    },
  };
  sessions.push(session);
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return session;
}

function operationsFile(box: Sandbox, name: string, operations: object[]): string {
  const path = join(box.cwd, name);
  writeFileSync(path, JSON.stringify(operations));
  return path;
}

async function document(session: Session): Promise<string> {
  const created = await session.ok("create_doc", {
    title: "CLI data producer fixture",
    description: "Synthetic records for CLI process synchronization.",
  });
  expect(typeof created.uuid).toBe("string");
  return created.uuid as string;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDirs();
});

describe("ub data process synchronization", () => {
  it("writes beside a running MCP server and preserves concurrent writes to different records", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const session = await connect(box);
    const uuid = await document(session);
    await session.ok("update_data", {
      uuid,
      operations: [{ collection: "observations", schema: observationSchema }],
    });
    const first = operationsFile(box, "first.json", [{
      collection: "observations", upsert: [{ id: "row-1", value: { text: "first producer" } }],
    }]);
    const second = operationsFile(box, "second.json", [{
      collection: "observations", upsert: [{ id: "row-2", value: { text: "second producer" } }],
    }]);
    const written = await Promise.all([
      runUbAsync(["data", "update", uuid, "--file", first], box),
      runUbAsync(["data", "update", uuid, "--file", second], box),
    ]);
    for (const run of written) {
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("saved locally; not yet synced with hub");
    }
    const expected = [
      { id: "row-1", value: { text: "first producer" } },
      { id: "row-2", value: { text: "second producer" } },
    ];
    expect(await session.ok("get_data", { uuid, collection: "observations" })).toMatchObject({
      records: expected.map(record => ({ ...record, valid: true })),
      complete: true,
    });
    const exported = await runUbAsync(["data", "get", uuid, "observations"], box);
    expect(exported.status, exported.stderr).toBe(0);
    expect(JSON.parse(exported.stdout)).toEqual({ schema: observationSchema, records: expected });
  });

  it("reports hub acknowledgement and delivers the CLI write to another replica", async () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      credentials: { signingSecret: SECRET },
    });
    const hub = await createHub({
      authSecret: SECRET,
      port: 0,
      databasePath: join(box.cwd, "hub.sqlite"),
      log: silentLogger,
      debounce: 20,
      maxDebounce: 200,
    });
    hubs.push(hub);
    const url = `ws://127.0.0.1:${hub.port}`;
    pointAt(box, url);
    await ensureWorkspaceBinding({ workspaceId: WORKSPACE, hubUrl: url }, box.env);
    const session = await connect(box, { HUB_URL: url, HUB_AUTH_TOKEN: SECRET });
    const uuid = await document(session);
    const path = operationsFile(box, "synced.json", [{
      collection: "observations", schema: observationSchema,
      upsert: [{ id: "synced-row", value: { text: "from the CLI" } }],
    }]);
    const written = await runUbAsync(["data", "update", uuid, "--file", path], box, { UB_TEST_MAX_WAIT_MS: "10000" });
    expect(written.status, written.stderr).toBe(0);
    expect(written.stdout).toContain("saved; synced with hub\n");
    expect(written.stdout).not.toContain("saved locally");

    const remote = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: url } });
    const reader = await connect(remote, { HUB_URL: url, HUB_AUTH_TOKEN: SECRET });
    expect(await reader.ok("get_data", { uuid, collection: "observations" })).toMatchObject({
      records: [{ id: "synced-row", value: { text: "from the CLI" }, valid: true }],
    });
  });

  it("reads cached data and saves locally in a hub workspace with no stored sign-in", async () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      userConfig: { hubAdmissions: { [DEAD_HUB_URL]: "device" } },
    });
    await ensureWorkspaceBinding({ workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL }, box.env);
    const session = await connect(box);
    const uuid = await document(session);
    await session.ok("update_data", {
      uuid,
      operations: [{ collection: "observations", schema: observationSchema,
        upsert: [{ id: "cached", value: { text: "downloaded earlier" } }] }],
    });
    await session.close();
    pointAt(box, DEAD_HUB_URL);
    const read = await runUbAsync(["data", "get", uuid, "observations"], box);
    expect(read.status, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout).records).toEqual([
      { id: "cached", value: { text: "downloaded earlier" } },
    ]);
    const path = operationsFile(box, "offline.json", [{
      collection: "observations", upsert: [{ id: "local", value: { text: "written while signed out" } }],
    }]);
    const written = await runUbAsync(["data", "update", uuid, "--file", path], box);
    expect(written.status, written.stderr).toBe(0);
    expect(written.stdout).toContain("saved locally; not yet synced with hub\n");
    const nextRead = await runUbAsync(["data", "get", uuid, "observations"], box);
    expect(nextRead.status, nextRead.stderr).toBe(0);
    expect(JSON.parse(nextRead.stdout).records).toEqual([
      { id: "cached", value: { text: "downloaded earlier" } },
      { id: "local", value: { text: "written while signed out" } },
    ]);
    expect(read.output + written.output + nextRead.output).not.toMatch(/(?:ub auth login|open.*browser|device code)/i);
    expect(existsSync(join(box.configHome, "uberblick", "credentials.json"))).toBe(false);
  });
});
