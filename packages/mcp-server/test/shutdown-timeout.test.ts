/** A real process proves the fallback exit code and stderr-only diagnostic. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  PACKAGE_ROOT,
  removeTempDirs,
  tempDir,
  WORKSPACE,
} from "./helpers.js";

const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exited = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      child.kill("SIGKILL");
      await exited;
    }),
  );
  removeTempDirs();
});

function moduleUrl(name: string): string {
  return JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "src", name)).href);
}

async function shutdownProcess(deviceWork: string, timeoutMs = 50): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import { resolveMcpConfig } from ${moduleUrl("config.ts")};
        import { createMcpServer } from ${moduleUrl("server.ts")};
        import { closeWithDeadline } from ${moduleUrl("shutdown.ts")};
        const instance = createMcpServer(resolveMcpConfig());
        instance.replicas.sync.waitForDeviceWork = ${deviceWork};
        await closeWithDeadline(() => instance.close(), ${timeoutMs});
      `,
    ],
    {
      cwd: PACKAGE_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        WORKSPACE_ID: WORKSPACE,
        XDG_DATA_HOME: tempDir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

it("exits non-zero with a stderr diagnostic when pending device work stalls close", async () => {
  const result = await shutdownProcess("() => new Promise(() => {})");
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("shutdown timed out");
}, 15_000);

it("clears the deadline once pending device work finishes and exits cleanly", async () => {
  const result = await shutdownProcess(
    "() => new Promise((resolve) => setTimeout(resolve, 10))",
    500,
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("shutdown timed out");
}, 15_000);
