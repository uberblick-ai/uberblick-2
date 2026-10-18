import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { workspaceRegistryPath } from "../src/workspace-registry.js";
import { cleanUp, credentialPath, fixture, readStore, rig, WORKSPACE } from "./auth-fixtures.js";
import { removeTempDirs, sandbox, type Sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

afterEach(cleanUp);
afterAll(removeTempDirs);

function configuration(box: Sandbox) {
  return [join(box.cwd, ".uberblick.json"), join(box.configHome, "uberblick", "config.json"),
    credentialPath(box), workspaceRegistryPath(box.env)].map(path => existsSync(path) ? readFileSync(path) : null);
}

const commands = [
  ["auth", "login"], ["auth", "status"], ["auth", "logout"], ["auth", "logout", "--all-devices"],
  ["workspace", "use"], ["workspace", "promote"],
];

describe("client hub transport safeguards", () => {
  it.each(commands)("refuses a typed remote cleartext hub for %j before contacting it or writing", async (...command) => {
    const remote = await rig([WORKSPACE]);
    const origin = remote.origin.replace("127.0.0.1", "0.0.0.0");
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      credentials: { hubLogins: { [origin]: fixture() } } });
    const before = configuration(box);
    for (const scheme of ["http", "ws"]) {
      const hub = origin.replace("http:", `${scheme}:`);
      const operand = command[1] === "use" ? `${hub}/${WORKSPACE}` : hub;
      const result = await runInProcess([...command, operand], box, { UB_INSECURE_HUBS: undefined });
      expect(result.status, result.output).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(operand.replace(`${scheme}:`, scheme === "http" ? "https:" : "wss:"));
      expect(configuration(box)).toEqual(before);
      expect(remote.requests).toEqual([]);
      expect(remote.github.calls).toEqual([]);
    }
  });

  it.each(commands)("never echoes a rejected endpoint value for %j", async (...command) => {
    const box = sandbox();
    const before = configuration(box);
    for (const hub of ["http://private-token@remote.invalid", "http://remote.invalid?private-token"]) {
      const result = await runInProcess([...command, command[1] === "use" ? `${hub}/${WORKSPACE}` : hub], box);
      expect(result.status, result.output).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("private-token");
      expect(configuration(box)).toEqual(before);
    }
  });

  it.each(["binding", "environment"])("refuses implicit sign-in and status from the %s without changing the selection", async source => {
    const remote = await rig([WORKSPACE]);
    const endpoint = remote.origin.replace("http://127.0.0.1", "ws://0.0.0.0");
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: source === "binding" ? endpoint : null } });
    const before = configuration(box);
    const env = { UB_INSECURE_HUBS: undefined, ...(source === "environment"
      ? { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: endpoint } : {}) };
    for (const command of ["login", "status"]) {
      const result = await runInProcess(["auth", command], box, env);
      expect(result.status, result.output).toBe(1);
      expect(result.stderr).toContain(endpoint.replace("ws:", "wss:"));
      expect(configuration(box)).toEqual(before);
      expect(remote.requests).toEqual([]);
    }
  });

  it.each([false, true])("preserves implicit logout's unconfirmed revocation behavior with all-devices=%s", async allDevices => {
    const remote = await rig([WORKSPACE]);
    const origin = remote.origin.replace("127.0.0.1", "0.0.0.0");
    const endpoint = `${origin.replace("http:", "ws:")}/ws`;
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint },
      credentials: { hubLogins: { [origin]: fixture() } } });
    const binding = readFileSync(join(box.cwd, ".uberblick.json"));
    const result = await runInProcess(["auth", "logout", ...(allDevices ? ["--all-devices"] : [])], box,
      { UB_INSECURE_HUBS: undefined });
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(origin.replace("http:", "https:"));
    expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(binding);
    expect(readStore(box).hubLogins?.[origin] !== undefined).toBe(allDevices);
    expect(result.output).toContain(allDevices ? "Local login kept" : "not yet revoked");
    expect(remote.requests).toEqual([]);
  });

  it("allows only the exact process-environment host and port entry", async () => {
    const remote = await rig([WORKSPACE]);
    const origin = remote.origin.replace("127.0.0.1", "0.0.0.0");
    const host = new URL(origin).host;
    const box = sandbox();
    const refused = await runInProcess(["auth", "login", origin], box,
      { UB_INSECURE_HUBS: `other.invalid:1234,${host}0` });
    expect(refused.status, refused.output).toBe(2);
    expect(remote.requests).toEqual([]);
    expect(existsSync(credentialPath(box))).toBe(false);
    const allowed = await runInProcess(["auth", "login", origin], box,
      { UB_INSECURE_HUBS: `other.invalid:1234,${host}` });
    expect(allowed.status, allowed.output).toBe(0);
    expect(readStore(box).hubLogins?.[origin]).toBeDefined();
    expect(remote.requests.some(request => request.path === "/auth/github/collect")).toBe(true);
    const count = remote.requests.length;
    const other = await runInProcess(["auth", "status", "http://other.invalid:1235"], box,
      { UB_INSECURE_HUBS: `other.invalid:1234,${host}` });
    expect(other.status, other.output).toBe(2);
    expect(remote.requests).toHaveLength(count);
  });
});
