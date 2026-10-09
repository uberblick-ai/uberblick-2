/**
 * Configuration comes from the environment, and one value there is
 * load-bearing three times: `WORKSPACE_ID` names the rooms this server opens,
 * the workspace claim in its hub token, and the SQLite file it hydrates from.
 * There is no default — a guess would silently open somebody else's corpus or
 * start an empty one — and a workspace id is a uuid, so the path-segment
 * question the old string workspaces raised is answered by construction.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidWorkspaceIdError } from "@uberblick/schema";
import {
  DEFAULT_HUB_URL,
  defaultDatabasePath,
  resolveMcpConfig,
} from "../src/config.js";
import { PACKAGE_ROOT, mainTsProcess } from "./helpers.js";
import { bridgeConfig } from "../src/remote.js";
import { writeHubLogin } from "@uberblick/hub/auth-store";

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
  it.each(["wss://hub.example/ws", "ws://0.0.0.0:1234", "ws://[::]:1234", "ws://127.attacker.example:1234"])("requires stored login and suppresses the secret for %s", hubUrl => {
    const config = resolveMcpConfig(env({ HUB_URL: hubUrl, HUB_AUTH_TOKEN: "local-only-secret" }));
    expect(config.authSecret).toBeNull();
    expect(config.deviceLogin).toBeDefined();
  });

  it.each(["ws://localhost:1234", "ws://127.42.0.9:1234", "ws://[::1]:1234"])("keeps loopback secret admission for %s", hubUrl => {
    const config = resolveMcpConfig(env({ HUB_URL: hubUrl, HUB_AUTH_TOKEN: "local-only-secret" }));
    expect(config.authSecret).toBe("local-only-secret");
    expect(config.deviceLogin).toBeUndefined();
  });

  it("selects the stored origin login for a loopback proxy and keeps other local hubs separate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "loopback-device-config-"));
    const authEnv = env({ XDG_CONFIG_HOME: directory, HUB_AUTH_TOKEN: "local-only-secret" });
    const id = "2a51045f-070a-4f56-b3d7-3a9fa4396823";
    try {
      await writeHubLogin("http://localhost:8080", {
        identity: { id, githubAccountId: "12345", githubUsername: "test-person" },
        credential: { record: { id, principalId: id, deviceId: id,
          workspaces: [WORKSPACE], issuedAt: 0, revokedAt: null }, key: Buffer.alloc(32).toString("base64url") },
      }, authEnv);
      const proxy = resolveMcpConfig({ ...authEnv, HUB_URL: "ws://localhost:8080/arbitrary-proxy-path" });
      expect(proxy.deviceLogin).toBeDefined();
      expect(proxy.authSecret).toBeNull();
      const local = bridgeConfig(proxy, { hubUrl: "ws://localhost:1234", authSecret: "local-only-secret" });
      expect(local.deviceLogin).toBeUndefined();
      expect(local.authSecret).toBe("local-only-secret");
      const sameOrigin = bridgeConfig(local, { hubUrl: "ws://localhost:8080/another-path", authSecret: "never-send-this" });
      expect(sameOrigin.deviceLogin).toBeDefined();
      expect(sameOrigin.authSecret).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("retains device admission without a login and drops it when a bridge targets another local hub", () => {
    const proxy = resolveMcpConfig(env({ HUB_URL: "ws://localhost:8080/ws", HUB_ADMISSION: "device", HUB_AUTH_TOKEN: "never-send-this" }));
    expect(proxy.authSecret).toBeNull();
    expect(proxy.deviceLogin).toBeDefined();
    expect(bridgeConfig(proxy, { hubUrl: "ws://localhost:1234" }).deviceLogin).toBeUndefined();
  });

  it("reclassifies bridge endpoint overrides without moving a login between hubs", () => {
    const local = resolveMcpConfig(env({ HUB_AUTH_TOKEN: "local-only-secret" }));
    const remote = bridgeConfig(local, { hubUrl: "wss://hub.example/ws", authSecret: "never-send-this" });
    expect(remote.authSecret).toBeNull();
    expect(remote.deviceLogin).toBeDefined();
    expect(bridgeConfig(remote, { hubUrl: "ws://127.0.0.1:1234" }).deviceLogin).toBeUndefined();
  });
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

  it("puts both spellings of one workspace in one replica file", () => {
    // The layout is `@uberblick/hub/storage`'s to decide and its suite's to
    // prove; what matters here is that both spellings of one workspace land on
    // one file — two replicas of one corpus would converge with neither.
    const dataHome = mkdtempSync(join(tmpdir(), "uberblick-data-home-"));
    const expected = join(dataHome, "uberblick", `${WORKSPACE}.sqlite`);
    expect(defaultDatabasePath(WORKSPACE, { XDG_DATA_HOME: dataHome })).toBe(
      expected,
    );
    expect(
      defaultDatabasePath(`uberblick-${WORKSPACE}`, { XDG_DATA_HOME: dataHome }),
    ).toBe(expected);
    // Resolution reads; it never creates. Nothing to clean up but the shell.
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("lets UBERBLICK_DB name the file outright", () => {
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
    expect(() => resolveMcpConfig(withoutWorkspace)).toThrow(/ub workspace create/);
  });
});

describe("the server process", () => {
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
