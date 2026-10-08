/** The status leaf needs a current hub acknowledgement, not a historical one. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHub, silentLogger } from "@uberblick/hub";
import { resolveMcpConfig, storeWorkspaceName } from "@uberblick/mcp-server";
import { afterAll, expect, it } from "vitest";
import { removeTempDirs, runUbAsync, sandbox } from "./helpers.js";

afterAll(removeTempDirs);
const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";

it("reports up to date after a real hub acknowledges the named local changes", async () => {
  const secret = "synthetic-status-hub-secret";
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
  storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE }), "Synced notes");
  const hub = await createHub({
    authSecret: secret, port: 0, databasePath: join(box.cwd, "hub.sqlite"), log: silentLogger,
  });
  try {
    writeFileSync(join(box.cwd, ".uberblick.json"), JSON.stringify({ workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${hub.port}` }));
    const shown = await runUbAsync(["workspace", "status"], box, { HUB_AUTH_TOKEN: secret, UB_TEST_MAX_WAIT_MS: "5000" });
    expect(shown.status, shown.output).toBe(0);
    expect(shown.stdout).toContain("workspace  Synced notes\n");
    expect(shown.stdout).toContain("sync       up to date\n");
    await hub.stop();
    const offline = await runUbAsync(["workspace", "status"], box, { HUB_AUTH_TOKEN: secret });
    expect(offline.status, offline.output).toBe(0);
    expect(offline.stdout).not.toContain("up to date");
    expect(offline.stdout).toMatch(/sync\s+.+/);
  } finally {
    await hub.stop();
  }
});
