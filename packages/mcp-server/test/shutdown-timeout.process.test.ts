/** A real process proves the fallback exit code and stderr-only diagnostic. */

import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { cleanupTestResources, closeChild, trackChild, tempDir, WORKSPACE } from "./shared.js";
import { builtWorker, PACKAGE_ROOT } from "./process-helpers.js";

const children: ChildProcess[] = [];
afterEach(async () => {
  await cleanupTestResources({ clients: children.splice(0).map((child) => () => closeChild(child)) });
});

async function shutdownProcess(stalled: boolean): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [builtWorker("shutdown-timeout"), stalled ? "stalled" : "cleared"], {
    cwd: PACKAGE_ROOT,
    env: { PATH: process.env.PATH ?? "", WORKSPACE_ID: WORKSPACE, XDG_DATA_HOME: tempDir() },
    stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL",
  });
  children.push(trackChild(child));
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

it("exits non-zero with a stderr diagnostic when pending device work stalls close", async () => {
  const result = await shutdownProcess(true);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("shutdown timed out");
}, 15_000);

it("clears the deadline once pending device work finishes and exits cleanly", async () => {
  const result = await shutdownProcess(false);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("shutdown timed out");
}, 15_000);
