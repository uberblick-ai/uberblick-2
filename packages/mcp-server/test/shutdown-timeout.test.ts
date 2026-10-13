/** A real process proves the fallback exit code and stderr-only diagnostic. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hub } from "@uberblick/hub";
import { afterEach, expect, it } from "vitest";
import {
  hubUrl,
  PACKAGE_ROOT,
  removeTempDirs,
  startHub,
  tempDir,
  TEST_SECRET,
  WORKSPACE,
} from "./helpers.js";

const children: ChildProcess[] = [];
const hubs: Hub[] = [];
const releaseLoads: (() => void)[] = [];

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
  for (const release of releaseLoads.splice(0)) release();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDirs();
});

function moduleUrl(name: string): string {
  return JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "src", name)).href);
}

async function shutdownProcess(deviceWork: string, timeoutMs = 50, options: {
  config?: Record<string, unknown>;
  beforeClose?: string;
} = {}): Promise<{
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
        import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
        const instance = createMcpServer({ ...resolveMcpConfig(), ...${JSON.stringify(options.config ?? {})} });
        instance.replicas.sync.waitForDeviceWork = ${deviceWork};
        ${options.beforeClose ?? ""}
        await closeWithDeadline((deadline) => instance.close(deadline), ${timeoutMs});
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

it("uses only the budget left after draining admitted startup work and leaves time for credential publication", async () => {
  const hub = await startHub();
  hubs.push(hub);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  releaseLoads.push(release);
  hub.hocuspocus.configuration.extensions.push({
    onLoadDocument: async () => { await held; },
  });

  const result = await shutdownProcess(
    `async () => {
      if (performance.now() - started > 2_500) throw new Error("No time left for credential publication");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }`,
    5_000,
    {
      config: {
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(hub.port),
        connectTimeoutMs: 30_000,
        syncTimeoutMs: 30_000,
      },
      beforeClose: `
        const waitForQuiet = instance.replicas.sync.waitForQuiet.bind(instance.replicas.sync);
        let enter;
        const entered = new Promise((resolve) => { enter = resolve; });
        let first = true;
        instance.replicas.sync.waitForQuiet = async (options) => {
          if (first) {
            first = false;
            enter();
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            return;
          }
          await waitForQuiet(options);
        };
        const [, transport] = InMemoryTransport.createLinkedPair();
        void instance.connect(transport);
        await entered;
        const started = performance.now();
      `,
    },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("1 changes are still only local");
  expect(result.stderr).not.toContain("shutdown timed out");
  expect(result.stderr).not.toContain("No time left for credential publication");
}, 15_000);
