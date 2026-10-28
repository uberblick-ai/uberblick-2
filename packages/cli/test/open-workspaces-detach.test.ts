import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHub, silentLogger } from "@uberblick/hub";
import { createMcpEngine, resolveMcpConfig, storeWorkspaceName } from "@uberblick/mcp-server";
import { acquireInitLock } from "@uberblick/mcp-server/init-lock";
import { rememberWorkspaceBindings } from "@uberblick/mcp-server/workspace-registry";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserReplicas, browserWorkspaces } from "../src/open-workspaces.js";
import { sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";
import { cleanUp, holdDefaultHub, hubs } from "./open-fixtures.js";

const FIRST = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const SECOND = "5b2d7e10-4c33-4f92-9e08-71a6d3c85220";
const SECRET = "synthetic-local-signing-secret";

afterEach(cleanUp);

async function recordSecond(env: NodeJS.ProcessEnv, hubUrl: string): Promise<void> {
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: SECOND, hubUrl }], env, SECOND); }
  finally { lock.release(); }
}

describe("lazy browser workspace after detach", () => {
  it("omits a secondary whose detach generation cannot be read while keeping healthy startup", () => {
    const box = sandbox({ projectBinding: { workspaceId: FIRST, hubUrl: null } });
    const config = resolveMcpConfig({ ...box.env, WORKSPACE_ID: FIRST });
    const secondaryConfig = resolveMcpConfig({ ...box.env, WORKSPACE_ID: SECOND });
    storeWorkspaceName(config, "Startup");
    writeFileSync(secondaryConfig.databasePath, "not a sqlite database");
    const warnings: string[] = [];

    const workspaces = browserWorkspaces({ workspaceId: FIRST, hubUrl: null }, config, box.env,
      message => warnings.push(message));

    expect([...workspaces.keys()]).toEqual([FIRST]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`workspace ${SECOND} is unavailable:`);
  });

  it.each([false, true])("never opens the frozen hub selection after detach (same hub restored: %s)", async restored => {
    await holdDefaultHub();
    const box = sandbox({ projectBinding: { workspaceId: FIRST, hubUrl: null },
      credentials: { signingSecret: SECRET } });
    const hub = await createHub({ port: 0, authSecret: SECRET, log: silentLogger,
      databasePath: join(box.cwd, "remote-hub.sqlite") });
    hubs.push(hub);
    let connections = 0;
    hub.server.httpServer.on("connection", () => { connections += 1; });
    const endpoint = `ws://127.0.0.1:${hub.port}/ws`;
    const primaryConfig = { ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: FIRST }), authSecret: null };
    const secondaryConfig = resolveMcpConfig({ ...box.env, WORKSPACE_ID: SECOND, HUB_URL: endpoint });
    storeWorkspaceName(primaryConfig, "Startup");
    storeWorkspaceName(secondaryConfig, "Detached later");
    await recordSecond(box.env, endpoint);
    const startup = await createMcpEngine(primaryConfig, { serving: true });
    let stale: BrowserReplicas | null = null;
    let fresh: BrowserReplicas | null = null;
    try {
      const selection = { workspaceId: FIRST, hubUrl: null };
      const frozen = browserWorkspaces(selection, primaryConfig, box.env, () => {});
      expect(frozen.get(SECOND)?.binding.hubUrl).toBe(endpoint);
      expect(frozen.get(SECOND)?.config.authSecret).toBe(SECRET);
      stale = new BrowserReplicas(frozen, startup, () => {});

      const detached = await runInProcess(["workspace", "detach", SECOND], box);
      expect(detached.status, detached.output).toBe(0);
      if (restored) await recordSecond(box.env, endpoint);
      const before = readFileSync(secondaryConfig.databasePath);
      const connectionCount = connections;

      await expect(stale.prepare(SECOND)).rejects.toMatchObject({ reason: "replica-failed" });

      expect(readFileSync(secondaryConfig.databasePath)).toEqual(before);
      expect(connections).toBe(connectionCount);
      const database = new DatabaseSync(secondaryConfig.databasePath, { readOnly: true });
      try {
        expect(database.prepare("SELECT value FROM meta WHERE key = 'serving-replica-holder'").get()).toBeUndefined();
      } finally { database.close(); }

      // A fresh selection can still start the same real replica and reach the
      // same hub, so the stale refusal is not an unreachable-hub false positive.
      if (!restored) await recordSecond(box.env, endpoint);
      fresh = new BrowserReplicas(browserWorkspaces(selection, primaryConfig, box.env, () => {}), startup, () => {});
      const admitted = await fresh.prepare(SECOND);
      expect(admitted.replicas.sync.state().status).toBe("connected");
      expect(connections).toBeGreaterThan(connectionCount);
    } finally {
      await stale?.close();
      await fresh?.close();
      await startup.close();
      await hub.stop();
    }
  });
});
