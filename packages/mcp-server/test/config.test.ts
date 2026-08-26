/**
 * Configuration comes from the environment, and one value there is
 * load-bearing three times: `WORKSPACE_ID` names the rooms this server opens,
 * the workspace claim in its hub token, and the SQLite file it hydrates from.
 * There is no default — a guess would silently open somebody else's corpus or
 * start an empty one — and a workspace id is a uuid, so the path-segment
 * question the old string workspaces raised is answered by construction.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidWorkspaceIdError } from "@uberblick/schema";
import {
  DEFAULT_HUB_URL,
  defaultDatabasePath,
  resolveMcpConfig,
} from "../src/config.js";
import { PACKAGE_ROOT, mainTsProcess } from "./helpers.js";

const WORKSPACE = "9c1f0b4a-6d27-4e83-9b5a-1f2e3d4c5b6a";
const DATA_HOME = "/tmp/uberblick-config-test";

/** A minimal environment: no HUB_AUTH_TOKEN, so the server is local-only. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: DATA_HOME, WORKSPACE_ID: WORKSPACE, ...overrides };
}

/** Run `src/main.ts` to completion and collect what it said and returned. */
function runServer(
  overrides: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  const { command, args } = mainTsProcess();
  const child = spawn(command, args, {
    cwd: PACKAGE_ROOT,
    env: { PATH: process.env.PATH ?? "", ...overrides },
    stdio: ["ignore", "ignore", "pipe"],
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

describe("resolveMcpConfig", () => {
  it("keys the rooms and the database by the workspace uuid", () => {
    const config = resolveMcpConfig(env());
    expect(config.workspaceId).toBe(WORKSPACE);
    expect(config.hubUrl).toBe(DEFAULT_HUB_URL);
    expect(config.authSecret).toBeNull();
    expect(config.databasePath).toBe(
      join(DATA_HOME, "uberblick", `${WORKSPACE}.sqlite`),
    );
  });

  it("resolves a decorated and a bare spelling to one workspace", () => {
    // The slug is display only. Two spellings that hydrated two databases
    // would be two local replicas of one corpus, converging with neither.
    const decorated = resolveMcpConfig(
      env({ WORKSPACE_ID: `uberblick-${WORKSPACE}` }),
    );
    const bare = resolveMcpConfig(env());
    expect(decorated.workspaceId).toBe(bare.workspaceId);
    expect(decorated.databasePath).toBe(bare.databasePath);
  });

  it("puts the replica in the Mac layout's workspace directory on a Mac", () => {
    // The layout is `@uberblick/hub/storage`'s to decide and its suite's to
    // prove; what matters here is that both spellings of one workspace land on
    // one file whichever layout is in force — two replicas of one corpus would
    // converge with neither. `platform` is a parameter so this holds on the
    // machine running the tests.
    const macHome = "/tmp/uberblick-config-test-home";
    const expected = join(
      macHome,
      "Library",
      "Application Support",
      "Uberblick",
      "data",
      "workspaces",
      `${WORKSPACE}.sqlite`,
    );
    expect(defaultDatabasePath(WORKSPACE, { HOME: macHome }, "darwin")).toBe(
      expected,
    );
    expect(
      defaultDatabasePath(`uberblick-${WORKSPACE}`, { HOME: macHome }, "darwin"),
    ).toBe(expected);
  });

  it("lets UBERBLICK_DB name the file outright, on either layout", () => {
    const named = "/tmp/uberblick-config-test/named.sqlite";
    expect(resolveMcpConfig(env({ UBERBLICK_DB: named })).databasePath).toBe(named);
  });

  it("refuses a value that is not a workspace id", () => {
    for (const workspaceId of [
      "main",
      "a/b",
      "..",
      "../outside",
      "..\\outside",
      ".",
      `uberblick-${WORKSPACE.toUpperCase()}`,
    ]) {
      expect(() => resolveMcpConfig(env({ WORKSPACE_ID: workspaceId }))).toThrow(
        InvalidWorkspaceIdError,
      );
    }
  });

  it("refuses to start with no workspace at all", () => {
    // Blank and unset are the same thing, and neither has a default.
    for (const value of ["", "   "]) {
      expect(() => resolveMcpConfig(env({ WORKSPACE_ID: value }))).toThrow(
        /WORKSPACE_ID/,
      );
    }
    const { WORKSPACE_ID: _omitted, ...withoutWorkspace } = env();
    expect(() => resolveMcpConfig(withoutWorkspace)).toThrow(/ub init/);
  });
});

describe("the server process", () => {
  it("exits non-zero and names `ub init` when WORKSPACE_ID is unset", async () => {
    // The whole interface is the environment an MCP client hands the process,
    // so "it refuses" has to be true of the process, not only of the function.
    // stdout is the JSON-RPC transport: the complaint goes to stderr.
    const run = await runServer({});

    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/WORKSPACE_ID/);
    expect(run.stderr).toMatch(/ub init/);
  }, 30_000);
});
