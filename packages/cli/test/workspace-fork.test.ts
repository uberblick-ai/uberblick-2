import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createMcpServer, defaultWorkspaceDatabasePath, resolveMcpConfig } from "@uberblick/mcp-server";
import { appendBlock, listDirectory, tombstoneDirectoryEntry } from "@uberblick/schema";
import { afterAll, expect, it } from "vitest";
import { initLockPath } from "../src/init-lock.js";
import { parseJoinTarget } from "../src/remote.js";
import { readWorkspaceHub, workspaceRegistryPath } from "../src/workspace-registry.js";
import { removeTempDirs, runUb, unboundSandbox, type Sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

afterAll(removeTempDirs);

function selected(box: Sandbox): { workspaceId: string; hubUrl: string | null } {
  return JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"));
}

async function localSource() {
  const box = unboundSandbox();
  const created = await runInProcess(["workspace", "create", "Source notes"], box);
  expect(created.status, created.output).toBe(0);
  const binding = selected(box);
  const config = { ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: binding.workspaceId }), authSecret: null };
  return { box, binding, config };
}

function stored(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      meta: db.prepare("SELECT * FROM meta ORDER BY key").all(),
      updates: db.prepare("SELECT * FROM updates ORDER BY seq").all(),
      snapshots: db.prepare("SELECT * FROM snapshots ORDER BY room").all(),
      pending: db.prepare("SELECT * FROM pending_rooms ORDER BY room").all(),
    };
  } finally { db.close(); }
}

it("forks without network or credential reads while a source MCP session retains its pending writes", async () => {
  const { box, binding, config } = await localSource();
  const source = createMcpServer(config);
  try {
    await source.replicas.settle();
    const docId = listDirectory(source.replicas.directory().doc)[0]!.uuid;
    appendBlock(source.replicas.replica(docId).doc, { type: "paragraph", text: "Unacknowledged local edit" });
    const before = stored(config.databasePath);
    expect(before.pending.length).toBeGreaterThan(0);
    const credentials = join(box.configHome, "uberblick", "credentials.json");
    const credentialBytes = readFileSync(credentials);
    const preload = join(box.cwd, "offline-fork.mjs");
    writeFileSync(preload, `
import fs from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
net.Socket.prototype.connect = () => { throw new Error("fork attempted network"); };
globalThis.fetch = () => { throw new Error("fork attempted fetch"); };
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
  if (String(path).endsWith("credentials.json")) throw new Error("fork read credentials");
  return read(path, ...args);
};
syncBuiltinESMExports();
`);
    const nested = join(box.cwd, "nested");
    mkdirSync(nested);
    const result = runUb(["workspace", "fork"], { ...box, cwd: nested }, {
      NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
    });
    expect(result.status, result.output).toBe(0);
    const fork = selected(box);
    expect(fork.workspaceId).not.toBe(binding.workspaceId);
    expect(fork.hubUrl).toBeNull();
    expect(readWorkspaceHub(fork.workspaceId, box.env)).toBeNull();
    expect(result.stdout).toContain(`forked     Source notes (${fork.workspaceId}, local)`);
    expect(result.stdout).toContain(`wrote      ${join(box.cwd, ".uberblick.json")}`);
    expect(result.stdout).toContain(`previous   Source notes (${binding.workspaceId}, local)`);
    expect(result.stdout).toContain(`switch back with: ub workspace use ${binding.workspaceId}`);
    expect(stored(config.databasePath)).toEqual(before);
    expect(readFileSync(credentials)).toEqual(credentialBytes);
    const status = await runInProcess(["status", "--json"], box);
    expect(status.status, status.output).toBe(0);
    expect(status.stdout).toContain(fork.workspaceId);
    expect(JSON.parse(status.stdout).hub).toBeNull();
    const switched = await runInProcess(["workspace", "use", binding.workspaceId], box);
    expect(switched.status, switched.output).toBe(0);
    expect(selected(box)).toEqual(binding);
    appendBlock(source.replicas.replica(docId).doc, { type: "paragraph", text: "Source remains writable" });
    expect(stored(config.databasePath).updates.length).toBeGreaterThan(before.updates.length);
  } finally { await source.close(); }
});

it.each(["wss://source.example.test/ws", "ws://127.0.0.1:1", "wss://source.example.test/proxy/"])("names every missing document and preserves recovery endpoint %s before creating a database", async (hub) => {
  const { box, binding, config } = await localSource();
  const source = createMcpServer(config);
  let entries: { uuid: string; title: string }[];
  try {
    await source.replicas.settle();
    entries = listDirectory(source.replicas.directory().doc);
    tombstoneDirectoryEntry(source.replicas.directory().doc, entries[0]!.uuid);
  } finally { await source.close(); }
  const db = new DatabaseSync(config.databasePath);
  try {
    for (const entry of entries) {
      db.prepare("DELETE FROM updates WHERE room = ?").run(`${binding.workspaceId}/${entry.uuid}`);
      db.prepare("DELETE FROM snapshots WHERE room = ?").run(`${binding.workspaceId}/${entry.uuid}`);
    }
  } finally { db.close(); }
  writeFileSync(join(box.cwd, ".uberblick.json"), JSON.stringify({ ...binding, hubUrl: hub }));
  writeFileSync(workspaceRegistryPath(box.env), JSON.stringify({ [binding.workspaceId]: hub }));
  const beforeBinding = readFileSync(join(box.cwd, ".uberblick.json"));
  const beforeRegistry = readFileSync(workspaceRegistryPath(box.env));
  const files = readdirSync(join(box.dataHome, "uberblick")).filter(name => name.endsWith(".sqlite"));
  const result = await runInProcess(["workspace", "fork"], box);
  expect(result.status, result.output).toBe(1);
  expect(result.stdout).toBe("");
  for (const entry of entries) expect(result.stderr).toContain(`${entry.title} (${entry.uuid})`);
  const recovery = result.stderr.split("\n").find(line => line.includes("ub workspace use "))!;
  const target = recovery.split("ub workspace use ")[1]!;
  expect(parseJoinTarget(target)).toEqual({ endpoint: hub, workspace: binding.workspaceId });
  expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(beforeBinding);
  expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(beforeRegistry);
  expect(readdirSync(join(box.dataHome, "uberblick")).filter(name => name.endsWith(".sqlite"))).toEqual(files);
});

it.each(["failure", "interruption"])("keeps the binding and source after copy %s and retries into a fresh workspace", async (kind) => {
  const { box, config } = await localSource();
  const beforeBinding = readFileSync(join(box.cwd, ".uberblick.json"));
  const beforeRegistry = readFileSync(workspaceRegistryPath(box.env));
  const before = stored(config.databasePath);
  const preload = join(box.cwd, "stop-fork.mjs");
  writeFileSync(preload, `
import sqlite from "node:sqlite";
const prepare = sqlite.DatabaseSync.prototype.prepare;
sqlite.DatabaseSync.prototype.prepare = function(sql, ...args) {
  if (sql.includes("INSERT INTO updates")) {
    ${kind === "failure" ? 'throw new Error("copy write refused");' : 'process.kill(process.pid, "SIGKILL");'}
  }
  return prepare.call(this, sql, ...args);
};
`);
  const failed = runUb(["workspace", "fork"], box, { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` });
  expect(failed.status).not.toBe(0);
  expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(beforeBinding);
  expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(beforeRegistry);
  expect(stored(config.databasePath)).toEqual(before);
  const partials = readdirSync(join(box.dataHome, "uberblick")).filter(name => name.endsWith(".sqlite"));
  expect(partials).toHaveLength(2);
  if (kind === "interruption") rmSync(initLockPath(box.env));
  const retry = await runInProcess(["workspace", "fork"], box);
  expect(retry.status, retry.output).toBe(0);
  expect(partials).not.toContain(`${selected(box).workspaceId}.sqlite`);
  expect(stored(config.databasePath)).toEqual(before);
});

it("restores records when publishing the completed fork's binding fails", async () => {
  const { box, config } = await localSource();
  const beforeBinding = readFileSync(join(box.cwd, ".uberblick.json"));
  const beforeRegistry = readFileSync(workspaceRegistryPath(box.env));
  const preload = join(box.cwd, "refuse-binding.mjs");
  writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (String(destination).endsWith(".uberblick.json")) throw new Error("binding write refused");
  return rename(source, destination);
};
syncBuiltinESMExports();
`);
  const result = runUb(["workspace", "fork"], box, { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` });
  expect(result.status, result.output).toBe(1);
  expect(result.stderr).toContain("binding write refused");
  expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(beforeBinding);
  expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(beforeRegistry);
  expect(defaultWorkspaceDatabasePath(selected(box).workspaceId, box.env)).toBe(config.databasePath);
});

it("leaves an unrecorded source unrecorded and warns when environment selection still overrides the new binding", async () => {
  const { box, binding } = await localSource();
  rmSync(workspaceRegistryPath(box.env));
  const result = await runInProcess(["workspace", "fork"], box, {
    UB_WORKSPACE_ID: binding.workspaceId, UB_HUB_URL: "local",
  });
  expect(result.status, result.output).toBe(0);
  expect(readWorkspaceHub(binding.workspaceId, box.env)).toBeUndefined();
  expect(readWorkspaceHub(selected(box).workspaceId, box.env)).toBeNull();
  expect(result.stderr).toContain("environment binding still takes precedence");
  expect(result.stdout).toContain(`switch back with: ub workspace use ${binding.workspaceId}`);
  const switched = await runInProcess(["workspace", "use", binding.workspaceId], box);
  expect(switched.status, switched.output).toBe(0);
  expect(selected(box)).toEqual(binding);
});

it.each([["source-id"], ["New name"], ["--json"]])("rejects operands and unsupported flags before reading a binding: %j", async (...argv) => {
  const box = unboundSandbox();
  const result = await runInProcess(["workspace", "fork", ...argv], box);
  expect(result.status, result.output).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("usage: ub workspace fork");
});
