import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspaceReplicas, resolveMcpConfig } from "@uberblick/mcp-server";
import * as mcp from "@uberblick/mcp-server";
import type { WorkspaceReplicaSet } from "@uberblick/mcp-server";
import {
  applyDocData, DATA_KEY, DATA_LIMITS, initDoc, readDocData,
  setKind, setStatus, tombstoneDirectoryEntry, upsertDirectoryEntry,
} from "@uberblick/schema";
import type { CollectionSchema } from "@uberblick/schema";
import { afterAll, expect, it, vi } from "vitest";
import { DATA_HELP } from "../src/data.js";
import { resolveConfig } from "@uberblick/mcp-server/project-config";
import { removeTempDirs, runUb, sandbox, unboundSandbox } from "./helpers.js";
import type { Sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

const WORKSPACE = "c0697ef3-b98a-405c-8c10-9b9707033a1e";
const UUID = "94c573b9-8c40-40d7-b5d0-f569ca2239cd";
const schema: CollectionSchema = { version: 1, schema: { type: "object", properties: { text: { type: "string" } } } };

afterAll(removeTempDirs);

function replicas(box: Sandbox): WorkspaceReplicaSet {
  const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
  return openWorkspaceReplicas(resolveMcpConfig(resolved.env), { hubFree: true, publishOwnPresence: false });
}

function fixture(): Sandbox {
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
  const instance = replicas(box);
  try {
    const doc = instance.replicas.replica(UUID).doc;
    initDoc(doc, { uuid: UUID, title: "Data fixture" });
    upsertDirectoryEntry(instance.replicas.directory().doc, { uuid: UUID, title: "Data fixture", tags: [] });
  } finally { void instance.close(); }
  return box;
}

function operations(box: Sandbox, value: unknown): string {
  const path = join(box.cwd, "ops.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function state(box: Sandbox) {
  const instance = replicas(box);
  try {
    return { data: readDocData(instance.replicas.replica(UUID).doc), log: instance.store.logSize() };
  } finally { void instance.close(); }
}

it("prints inert help everywhere, and reports usage on stderr without binding or file access", async () => {
  const box = unboundSandbox({ raw: { projectBinding: "{" } });
  for (const args of [[], ["help"], ["get", "--out", "absent", "--help"], ["update", "-h"]]) {
    const run = await runInProcess(["data", ...args], box);
    expect(run).toMatchObject({ status: 0, stdout: DATA_HELP, stderr: "" });
  }
  for (const args of [["get"], ["bogus"], ["bogus", "--", "--help"], ["get", UUID, "--out", "x"], ["update", UUID],
    ["get", UUID, "c", "--ids", "a"], ["update", UUID, "--file", "x", "--out", "y"]]) {
    const run = await runInProcess(["data", ...args], box);
    expect(run.status, run.output).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(DATA_HELP);
  }
});

it("summarizes no data, exports every raw record once in code-point order, and reports file bytes", async () => {
  const box = fixture();
  expect(await runInProcess(["data", "get", UUID], box)).toMatchObject({ status: 0, stdout: "no data\n" });
  const instance = replicas(box);
  const ids = ["😀", "\ue000", ...Array.from({ length: 1100 }, (_, i) => String(i).padStart(4, "0"))];
  try {
    const doc = instance.replicas.replica(UUID).doc;
    applyDocData(doc, instance.replicas.directory().doc, [{ collection: "runs", schema,
      upsert: ids.map(id => ({ id, value: { text: "x".repeat(80) } })) }]);
    doc.getMap(DATA_KEY).set(JSON.stringify(["record", "runs", "invalid"]), { text: 9 });
  } finally { void instance.close(); }
  const before = state(box);
  const summary = await runInProcess(["data", "get", UUID], box);
  expect(summary.stdout).toBe(`runs       1,103 records  invalid\n${before.data?.bytes.toLocaleString("en-US")} bytes\n`);
  const json = await runInProcess(["data", "get", UUID, "runs"], box);
  expect(json.status, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({ schema, records: before.data?.collections[0]?.records });
  const exported = JSON.parse(json.stdout).records;
  expect(exported).toHaveLength(1103);
  expect(exported.at(-2).id).toBe("\ue000");
  expect(exported.at(-1).id).toBe("😀");
  expect(exported.find((r: { id: string }) => r.id === "invalid").value).toEqual({ text: 9 });
  const path = join(box.cwd, "runs.json");
  const file = await runInProcess(["data", "get", UUID, "runs", "--out", path], box);
  expect(readFileSync(path, "utf8")).toBe(json.stdout);
  expect(file.stdout).toBe(`wrote runs: 1,103 records, ${Buffer.byteLength(json.stdout).toLocaleString("en-US")} bytes → ${path}\n`);
  expect(state(box)).toEqual(before);
  expect((await runInProcess(["data", "get", UUID, "absent"], box)).status).toBe(1);
});

it("previews the exact update counts without appending and emits no update for an identical refresh", async () => {
  const box = fixture();
  const path = operations(box, [{ collection: "runs", schema, upsert: [{ id: "a", value: { text: "first" } }] }]);
  const initial = state(box);
  const dry = await runInProcess(["data", "update", UUID, "--file", path, "--dry-run"], box);
  expect(dry).toMatchObject({ status: 0, stdout: "runs       would be 1 record (1 upserted, schema changed)\nnothing written (dry run)\n" });
  expect(state(box)).toEqual(initial);
  const saved = await runInProcess(["data", "update", UUID, "--file", path], box);
  expect(saved).toMatchObject({ status: 0, stdout: "runs       1 record (1 upserted, schema changed)\nsaved locally; not yet synced with hub\n" });
  const before = state(box);
  expect((await runInProcess(["data", "update", UUID, "--file", path], box)).stdout).toBe("no change\n");
  expect(state(box)).toEqual(before);
  operations(box, [{ collection: "runs", deleteRecords: ["a"], upsert: [{ id: "b", value: { text: "next" } }] }]);
  expect((await runInProcess(["data", "update", UUID, "--file", path], box)).stdout)
    .toBe("runs       1 record (1 upserted, 1 deleted)\nsaved locally; not yet synced with hub\n");
  operations(box, [{ collection: "runs", deleteCollection: true }]);
  expect((await runInProcess(["data", "update", UUID, "--file", path], box)).stdout)
    .toBe("runs       0 records (1 deleted, collection deleted)\nsaved locally; not yet synced with hub\n");
});

it("never says nothing was written when acknowledgement or closure fails after the save", async () => {
  for (const failure of ["acknowledgement", "closure", "acknowledgement and closure"]) {
    const box = fixture();
    const path = operations(box, [{ collection: "runs", schema, upsert: [{ id: "a", value: { text: "saved" } }] }]);
    const open = mcp.openWorkspaceReplicas;
    vi.spyOn(mcp, "openWorkspaceReplicas").mockImplementationOnce((...args) => {
      const instance = open(...args);
      if (failure.includes("acknowledgement")) vi.spyOn(instance.replicas.sync, "waitForQuiet").mockRejectedValue(new Error("acknowledgement failed"));
      if (failure.includes("closure")) {
        const close = instance.close;
        instance.close = async () => { await close(); throw new Error("closure failed"); };
      }
      return instance;
    });
    try {
      const run = await runInProcess(["data", "update", UUID, "--file", path], box);
      expect(run.status, run.output).toBe(1);
      expect(run.stderr).not.toContain("nothing written");
      expect(run.stderr).toContain("saved locally; not yet synced with hub");
    } finally { vi.restoreAllMocks(); }
    expect(state(box).data?.collections[0]?.records).toEqual([{ id: "a", value: { text: "saved" } }]);
  }
});

it("refuses malformed files, invalid batches and shared limits atomically in real and dry runs", async () => {
  const box = fixture();
  const valid = { collection: "runs", schema, upsert: [{ id: "a", value: { text: "valid" } }] };
  const badInputs = [
    { operations: [valid] }, [valid, { collection: "other", schema, upsert: [{ id: "bad", value: { text: 5 } }] }],
    [{ ...valid, unknown: true }], [{ ...valid, schema: { ...schema, version: 2 } }],
    [{ ...valid, upsert: [{ id: "big", value: { text: "x".repeat(DATA_LIMITS.record) } }] }],
    [{ ...valid, upsert: Array.from({ length: 17 }, (_, i) => ({ id: String(i), value: { text: "x".repeat(DATA_LIMITS.record - 11) } })) }],
  ];
  const before = state(box);
  for (const input of badInputs) {
    const path = operations(box, input);
    for (const dry of [[], ["--dry-run"]]) {
      const run = await runInProcess(["data", "update", UUID, "--file", path, ...dry], box);
      expect(run.status, run.output).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/^error: /);
      expect(run.stderr).toMatch(/nothing written\n$/);
      expect(state(box)).toEqual(before);
    }
  }
  for (const content of ["{", Buffer.from([0xff])]) {
    const path = join(box.cwd, "bad.json");
    writeFileSync(path, content);
    const run = await runInProcess(["data", "update", UUID, "--file", path], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("UTF-8 JSON array");
  }
  const unreadable = await runInProcess(["data", "update", UUID, "--file", "absent.json"], box);
  expect(unreadable.status).toBe(1);
  expect(unreadable.stderr).toContain("nothing written");
});

it("measures changed canonical values rather than file bytes at the exact 1 MiB boundary", async () => {
  const box = fixture();
  const path = operations(box, [{ collection: "runs", schema }]);
  expect((await runInProcess(["data", "update", UUID, "--file", path], box)).status).toBe(0);
  operations(box, [{ collection: "runs", upsert: Array.from({ length: 16 }, (_, i) => ({
    id: String(i), value: { text: "x".repeat(DATA_LIMITS.record - 11) },
  })) }]);
  expect(readFileSync(path).byteLength).toBeGreaterThan(DATA_LIMITS.operation);
  expect((await runInProcess(["data", "update", UUID, "--file", path], box)).status).toBe(0);
  const before = state(box);
  expect((await runInProcess(["data", "update", UUID, "--file", path], box)).stdout).toBe("no change\n");
  expect(state(box)).toEqual(before);
});

it("keeps archive, every decision state, unknown and unhydrated guards in dry and real writes", async () => {
  for (const guard of ["archived", "open", "decided", "unknown", "unhydrated"]) {
    const box = fixture();
    const instance = replicas(box);
    const missing = "e8f8ddaa-d3be-4bdd-9073-27f6d12ad036";
    const target = guard === "unknown" || guard === "unhydrated" ? missing : UUID;
    try {
      if (guard === "archived") tombstoneDirectoryEntry(instance.replicas.directory().doc, UUID);
      if (guard === "open" || guard === "decided") {
        setKind(instance.replicas.replica(UUID).doc, "decision");
        setStatus(instance.replicas.replica(UUID).doc, guard);
      }
      if (guard === "unhydrated") upsertDirectoryEntry(instance.replicas.directory().doc, { uuid: missing, title: "Not synced", tags: [] });
    } finally { void instance.close(); }
    const path = operations(box, [{ collection: "runs", schema }]);
    const before = state(box);
    for (const dry of [[], ["--dry-run"]]) {
      const run = await runInProcess(["data", "update", target, "--file", path, ...dry], box);
      expect(run.status, guard + run.output).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("nothing written");
      expect(state(box)).toEqual(before);
    }
  }
});

it("uses nearest binding and environment overrides, rejecting foreign links before opening any replica", async () => {
  const box = fixture();
  const child = join(box.cwd, "nested");
  mkdirSync(child);
  expect((await runInProcess(["data", "get", `https://example.invalid/notes-${WORKSPACE}/${UUID.toUpperCase()}`], { ...box, cwd: child })).stdout).toBe("no data\n");
  expect((await runInProcess(["data", "get", `https://example.invalid/${WORKSPACE}/b6a8ebf8-a5b7-4f31-839c-1a1c1e588460/record/${UUID}`], box)).stdout).toBe("no data\n");
  const foreign = "c872c59c-5e43-4556-8b75-cc0f81e9bb64";
  const before = state(box);
  const run = await runInProcess(["data", "get", `https://example.invalid/${foreign}/${UUID}`], box, { UBERBLICK_DB: join(box.cwd, "absent", "foreign.sqlite") });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("another workspace");
  expect(state(box)).toEqual(before);
  const override = await runInProcess(["data", "get", UUID], box, { UB_WORKSPACE_ID: foreign, UB_HUB_URL: "local" });
  expect(override.status).toBe(1);
  expect(override.stderr).toContain("No document");
  expect((await runInProcess(["data", "get", UUID], unboundSandbox())).stderr).toContain("No workspace selected");
});

it("consumes stdin in the real CLI process and leaves stdout free of input records", () => {
  const box = fixture();
  const input = JSON.stringify([{ collection: "runs", schema, upsert: [{ id: "a", value: { text: "producer-only-value" } }] }]);
  const bin = fileURLToPath(new URL("./source-ub.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [bin, "data", "update", UUID, "--file", "-"], {
    cwd: box.cwd, env: box.env, input, encoding: "utf8", timeout: 25_000,
  });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain("1 record (1 upserted, schema changed)");
  expect(run.stdout).not.toContain("producer-only-value");
  expect(state(box).data?.collections[0]?.records).toEqual([{ id: "a", value: { text: "producer-only-value" } }]);
  expect(runUb(["data", "get", UUID, "runs"], box).status).toBe(0);
});
