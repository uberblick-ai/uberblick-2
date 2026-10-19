/**
 * Configuration comes from the environment, and one value there is
 * load-bearing three times: `WORKSPACE_ID` names the rooms this server opens,
 * the workspace claim in its hub token, and the SQLite file it hydrates from.
 * There is no default — a guess would silently open somebody else's corpus or
 * start an empty one — and a workspace id is a uuid, making it path-safe.
 */

import { InvalidWorkspaceIdError } from "@uberblick/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HUB_URL, defaultWorkspaceDatabasePath, resolveAgentSession, resolveMcpConfig } from "../src/config.js";
import { bridgeConfig } from "../src/remote.js";

const WORKSPACE = "9c1f0b4a-6d27-4e83-9b5a-1f2e3d4c5b6a";
const DATA_HOME = "/tmp/uberblick-config-test";

/** A minimal environment: no HUB_AUTH_TOKEN, so the server is local-only. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: DATA_HOME, WORKSPACE_ID: WORKSPACE, ...overrides };
}

describe("resolveMcpConfig", () => {
  it("keeps non-serve callers independent of UB_AGENT_SESSION", () => {
    for (const value of ["same-session", "invalid/session"]) {
      const first = resolveMcpConfig(env({ UB_AGENT_SESSION: value }));
      const second = resolveMcpConfig(env({ UB_AGENT_SESSION: value }));
      expect(first.sessionId).toMatch(/^agent-[0-9a-f-]{36}$/);
      expect(first.sessionId).not.toBe(second.sessionId);
    }
  });

  it("keeps the same caller-chosen identity and colour across reconnects", () => {
    const session = "Caller.Run_1570-1";
    const first = resolveMcpConfig(env(), resolveAgentSession(session));
    const second = resolveMcpConfig(env(), resolveAgentSession(session));
    expect(first.sessionId).toBe(session);
    expect(second.sessionId).toBe(session);
    expect(second.color).toBe(first.color);
  });

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

  it("retains device admission without a login and drops it when a bridge targets another local hub", () => {
    const proxy = resolveMcpConfig(env({ HUB_URL: "ws://localhost:8080/ws", HUB_ADMISSION: "device", HUB_AUTH_TOKEN: "never-send-this" }));
    expect(proxy.authSecret).toBeNull();
    expect(proxy.deviceLogin).toBeDefined();
    expect(bridgeConfig(proxy, { hubUrl: "ws://localhost:1234" }).deviceLogin).toBeUndefined();
  });

  it.each(["WS://LOCALHOST:8080/ws", "ws://localhost:8080/a/../ws"])(
    "retains device admission and login options for an equivalent bridge target: %s", hubUrl => {
      const original = resolveMcpConfig(env({ HUB_URL: "ws://localhost:8080/ws", HUB_ADMISSION: "device", HUB_AUTH_TOKEN: "never-send-this" }));
      const bridged = bridgeConfig(original, { hubUrl, authSecret: "never-send-this-either" });
      expect(bridged.hubUrl).toBe(hubUrl);
      expect(bridged.authEnv?.HUB_ADMISSION).toBe("device");
      expect(bridged.deviceLogin).toBe(original.deviceLogin);
      expect(bridged.authSecret).toBeNull();
      expect(original.authEnv?.HUB_ADMISSION).toBe("device");

      const fixture = { ...original, authEnv: env(), deviceLogin: { env: env() } };
      expect(bridgeConfig(fixture, { hubUrl }).deviceLogin).toBe(fixture.deviceLogin);
    },
  );

  it.each(["ws://localhost:8080/ws/", "ws://localhost:8080/WS", "ws://localhost:8080/w%73",
    "ws://127.0.0.1:8080/ws", "ws://[::1]:8080/ws"])(
    "does not carry device admission or login options to a distinct bridge target: %s", hubUrl => {
      const original = resolveMcpConfig(env({ HUB_URL: "ws://localhost:8080/ws", HUB_ADMISSION: "device" }));
      const bridged = bridgeConfig(original, { hubUrl });
      expect(bridged.authEnv?.HUB_ADMISSION).toBeUndefined();
      expect(bridged.deviceLogin).toBeUndefined();
      expect(original.authEnv?.HUB_ADMISSION).toBe("device");
    },
  );

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
    expect(DEFAULT_HUB_URL).toBe("ws://localhost:1234");
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
    // The layout is `@uberblick/mcp-server/storage`'s to decide and its suite's to
    // prove; what matters here is that both spellings of one workspace land on
    // one file — two replicas of one corpus would converge with neither.
    const dataHome = mkdtempSync(join(tmpdir(), "uberblick-data-home-"));
    const expected = join(dataHome, "uberblick", `${WORKSPACE}.sqlite`);
    expect(defaultWorkspaceDatabasePath(WORKSPACE, { XDG_DATA_HOME: dataHome })).toBe(
      expected,
    );
    expect(
      defaultWorkspaceDatabasePath(`uberblick-${WORKSPACE}`, { XDG_DATA_HOME: dataHome }),
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

describe("serve's agent session input", () => {
  it.each(["x", "A".repeat(64), "Caller.Run_1570-1"])("accepts %s exactly", (session) => {
    expect(resolveAgentSession(session)).toBe(session);
  });

  it.each([undefined, "", " \t\n"])("uses a fresh process identity for blank %s", (session) => {
    expect(resolveAgentSession(session)).toBeUndefined();
    const first = resolveMcpConfig(env(), resolveAgentSession(session));
    const second = resolveMcpConfig(env(), resolveAgentSession(session));
    expect(first.sessionId).toMatch(/^agent-[0-9a-f-]{36}$/);
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it.each(["a".repeat(65), "a/b", "two words", " padded", "padded ", "é", "a\nb", "a\n"])("refuses nonblank %s instead of replacing it", (session) => {
    expect(() => resolveAgentSession(session)).toThrow(/UB_AGENT_SESSION/);
  });
});
