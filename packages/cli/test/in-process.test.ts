import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { removeTempDirs, sandbox } from "./helpers.js";
import { cleanUp, rig } from "./auth-fixtures.js";
import { runInProcess } from "./in-process.js";

afterAll(removeTempDirs);
afterEach(cleanUp);

function environmentFingerprint(): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(process.env).sort())).digest("hex");
}

it("runs successive workspace commands with isolated files, environment and output", async () => {
  const first = sandbox({ projectBinding: { workspaceId: "11111111-1111-4111-8111-111111111111", hubUrl: null } });
  const second = sandbox({ projectBinding: { workspaceId: "22222222-2222-4222-8222-222222222222", hubUrl: null } });
  const cwd = process.cwd();
  const environment = environmentFingerprint();
  for (const box of [first, second]) {
    const run = await runInProcess(["workspace", "status"], box);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(box === first ? "11111111" : "22222222");
    expect(run.stdout).not.toContain(box === first ? "22222222" : "11111111");
    expect(run.stderr).toBe("");
    expect(process.cwd()).toBe(cwd);
    expect(environmentFingerprint()).toBe(environment);
  }
});

it("restores process configuration when a command throws", async () => {
  const box = sandbox();
  const database = join(box.cwd, "broken.sqlite");
  writeFileSync(database, "not a SQLite database");
  const cwd = process.cwd();
  const environment = environmentFingerprint();
  await expect(runInProcess(["status"], box, { UBERBLICK_DB: database })).rejects.toThrow();
  expect(process.cwd()).toBe(cwd);
  expect(environmentFingerprint()).toBe(environment);
  expect((await runInProcess(["--help"], box)).status).toBe(0);
});

it("refuses overlapping invocations instead of sharing process configuration", async () => {
  const first = runInProcess(["--help"], sandbox());
  await expect(runInProcess(["--help"], sandbox())).rejects.toThrow("Concurrent CLI invocations");
  expect((await first).status).toBe(0);
});

it("refuses startup options instead of silently ignoring a preload", async () => {
  const box = sandbox();
  const cwd = process.cwd();
  const environment = environmentFingerprint();
  await expect(runInProcess(["--help"], box, { NODE_OPTIONS: "--import=missing-fixture" }))
    .rejects.toThrow("Node startup options require the subprocess helper");
  expect(process.cwd()).toBe(cwd);
  expect(environmentFingerprint()).toBe(environment);
  expect((await runInProcess(["--help"], box)).status).toBe(0);
});

it("keeps login noninteractive even when the test runner owns a terminal", async () => {
  const remote = await rig();
  const box = sandbox();
  const record = join(box.cwd, "opened-browser");
  const opener = join(box.cwd, "record-browser");
  writeFileSync(opener, `#!/bin/sh\nprintf opened > '${record}'\n`, { mode: 0o700 });
  const streams = [process.stdin, process.stdout];
  const properties = streams.map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  try {
    for (const stream of streams) Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    const run = await runInProcess(["auth", "login", remote.origin], box, {
      BROWSER: opener, SSH_CONNECTION: undefined, SSH_CLIENT: undefined, SSH_TTY: undefined,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("signed in");
    expect(existsSync(record)).toBe(false);
    for (const stream of streams) expect(stream.isTTY).toBe(true);
  } finally {
    streams.forEach((stream, index) => {
      const property = properties[index];
      if (property === undefined) Reflect.deleteProperty(stream, "isTTY");
      else Object.defineProperty(stream, "isTTY", property);
    });
    rmSync(record, { force: true });
  }
});
