import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHub, silentLogger } from "@uberblick/hub";
import { resolveMcpConfig, storeWorkspaceName } from "@uberblick/mcp-server";
import { acquireInitLock } from "@uberblick/mcp-server/init-lock";
import { rememberWorkspaceBindings } from "@uberblick/mcp-server/workspace-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureHub, type HubDecision } from "../src/open-hub.js";
import { cleanUp, fixtureBundle, freePort, holdDefaultHub, hubs } from "./open-fixtures.js";
import { runUb, sandbox, waitUntil } from "./helpers.js";
import { runInProcess } from "./in-process.js";

vi.mock("../src/open-hub.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/open-hub.js")>(),
  ensureHub: vi.fn(),
}));

const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const SECRET = "synthetic-local-signing-secret";

afterEach(cleanUp);

describe("detach while ub open starts", () => {
  it.each([false, true])("refuses before opening a stale primary replica (same hub restored: %s)", async restored => {
    await holdDefaultHub();
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    const hub = await createHub({ port: 0, authSecret: SECRET, log: silentLogger,
      databasePath: join(box.cwd, "remote-hub.sqlite") });
    hubs.push(hub);
    let connections = 0;
    hub.server.httpServer.on("connection", () => { connections += 1; });
    const endpoint = `ws://127.0.0.1:${hub.port}/ws`;
    const binding = { workspaceId: WORKSPACE, hubUrl: endpoint };
    box.env.UB_WORKSPACE_ID = WORKSPACE;
    box.env.UB_HUB_URL = endpoint;
    box.env.UBERBLICK_WEB_DIST = fixtureBundle(box);
    const config = resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE, HUB_URL: endpoint });
    storeWorkspaceName(config, "Detaching during startup");
    const lock = await acquireInitLock(box.env);
    try { rememberWorkspaceBindings([binding], box.env, WORKSPACE); }
    finally { lock.release(); }
    let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    let complete!: (decision: HubDecision) => void;
    const held = new Promise<HubDecision>(resolve => { complete = resolve; });
    vi.mocked(ensureHub).mockImplementationOnce(() => {
      reached();
      return held;
    });
    let done = false;
    const opened = runInProcess(["open", "--no-browser", "--port", String(await freePort())], box)
      .then(result => { done = true; return result; });
    try {
      await Promise.race([entered, opened.then(result => {
        throw new Error(`ub open stopped before its startup gate: ${result.output}`);
      })]);
      const detached = runUb(["workspace", "detach", WORKSPACE], box);
      expect(detached.status, detached.output).toBe(0);
      if (restored) {
        const restoreLock = await acquireInitLock(box.env);
        try { rememberWorkspaceBindings([binding], box.env, WORKSPACE); }
        finally { restoreLock.release(); }
      }
      const before = readFileSync(config.databasePath);
      complete({ started: null, note: "" });
      await waitUntil("open to refuse the detached startup selection", () => done || connections > 0);

      expect(done).toBe(true);
      const result = await opened;
      expect(result.status, result.output).toBe(1);
      expect(result.stderr).toContain("detached while ub open was starting");
      expect(result.stderr).toContain("Restart ub open");
      expect(result.stdout).toBe("");
      expect(connections).toBe(0);
      expect(readFileSync(config.databasePath)).toEqual(before);
      const database = new DatabaseSync(config.databasePath, { readOnly: true });
      try {
        expect(database.prepare("SELECT value FROM meta WHERE key = 'serving-replica-holder'").get()).toBeUndefined();
      } finally { database.close(); }
    } finally {
      complete({ started: null, note: "" });
      if (!done) process.emit("SIGINT");
      await opened;
      await hub.stop();
    }
  });
});
