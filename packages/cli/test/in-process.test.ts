import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { removeTempDirs, sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

afterAll(removeTempDirs);

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
