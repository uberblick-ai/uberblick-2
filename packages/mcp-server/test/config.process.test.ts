/**
 * Configuration comes from the environment, and one value there is
 * load-bearing three times: `WORKSPACE_ID` names the rooms this server opens,
 * the workspace claim in its hub token, and the SQLite file it hydrates from.
 * There is no default — a guess would silently open somebody else's corpus or
 * start an empty one — and a workspace id is a uuid, making it path-safe.
 */

import { mainProcess } from "./process-helpers.js";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "./helpers.js";

const WORKSPACE = "9c1f0b4a-6d27-4e83-9b5a-1f2e3d4c5b6a";
const DATA_HOME = "/tmp/uberblick-config-test";

/** A minimal environment: no HUB_AUTH_TOKEN, so the server is local-only. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: DATA_HOME, WORKSPACE_ID: WORKSPACE, ...overrides };
}

/** Run `src/main.ts` to completion and collect what it said and returned. */
function runServer(
  overrides: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  const { command, args } = mainProcess();
  const child = spawn(command, args, {
    cwd: PACKAGE_ROOT,
    env: { PATH: process.env.PATH ?? "", ...overrides },
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 10_000,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

describe("the server process", () => {
  it("refuses an invalid agent session before serving", async () => {
    const run = await runServer(env({ UB_AGENT_SESSION: "invalid/session" }));
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/UB_AGENT_SESSION/);
    expect(run.stderr).not.toContain("serving");
  });

  it("exits non-zero and names `ub workspace create` when WORKSPACE_ID is unset", async () => {
    // The whole interface is the environment an MCP client hands the process,
    // so "it refuses" has to be true of the process, not only of the function.
    // stdout is the JSON-RPC transport: the complaint goes to stderr.
    const run = await runServer({});

    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/WORKSPACE_ID/);
    expect(run.stderr).toMatch(/ub workspace create/);
  });
});
