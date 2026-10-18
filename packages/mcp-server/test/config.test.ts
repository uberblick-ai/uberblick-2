/**
 * Configuration comes from the environment, and one value there is
 * load-bearing three times: `WORKSPACE_ID` names the rooms this server opens,
 * the workspace claim in its hub token, and the SQLite file it hydrates from.
 * There is no default — a guess would silently open somebody else's corpus or
 * start an empty one — and a workspace id is a uuid, making it path-safe.
 */

import { writeHubLogin } from "@uberblick/mcp-server/auth-store";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMcpConfig, } from "../src/config.js";
import { bridgeConfig } from "../src/remote.js";

const WORKSPACE = "9c1f0b4a-6d27-4e83-9b5a-1f2e3d4c5b6a";
const DATA_HOME = "/tmp/uberblick-config-test";

/** A minimal environment: no HUB_AUTH_TOKEN, so the server is local-only. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: DATA_HOME, WORKSPACE_ID: WORKSPACE, ...overrides };
}

describe("resolveMcpConfig", () => {

  it("keeps local workspace ownership distinct from sync credentials", () => {
    expect(resolveMcpConfig(env()).localWorkspace).toBe(true);
    expect(resolveMcpConfig(env({ UB_HUB_URL: "local", HUB_AUTH_TOKEN: "local-serving-secret" })).localWorkspace).toBe(true);
    expect(resolveMcpConfig(env({ HUB_URL: "ws://localhost:1234" })).localWorkspace).toBe(false);
    expect(resolveMcpConfig(env({ UB_HUB_URL: "ws://localhost:1234", HUB_URL: "ws://localhost:1234" })).localWorkspace).toBe(false);
    expect(bridgeConfig(resolveMcpConfig(env()), { hubUrl: "ws://localhost:1234" }).localWorkspace).toBe(false);
  });

  it("selects the stored origin login for a loopback proxy and keeps other local hubs separate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "loopback-device-config-"));
    const authEnv = env({ XDG_CONFIG_HOME: directory, HUB_AUTH_TOKEN: "local-only-secret" });
    const id = "2a51045f-070a-4f56-b3d7-3a9fa4396823";
    try {
      await writeHubLogin("http://localhost:8080", {
        identity: { id, githubAccountId: "12345", githubUsername: "test-person" },
        credential: { record: { id, principalId: id, deviceId: id,
          workspaces: [WORKSPACE], issuedAt: 0, revokedAt: null },
          key: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url") },
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
});
