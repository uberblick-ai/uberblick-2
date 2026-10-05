/** Remote command admission, recovery and refusal boundaries through real CLI processes. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDeviceSyncHub } from "../../hub/test/device-sync-hub.js";
import { authenticationOrigin } from "@uberblick/hub/remote-url";
import { removeTempDirs, runUbAsync, sandbox, type Sandbox } from "./helpers.js";

const WORKSPACE = "5c1f9a72-4d38-4e02-9b6a-7e3f10c85b94";
const SECRET = "legacy-local-secret-is-never-sent-to-remote";
const hubs: Awaited<ReturnType<typeof startDeviceSyncHub>>[] = [];
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.close(); removeTempDirs(); });

async function rig(access: boolean) {
  const hub = await startDeviceSyncHub({ directory: sandbox().cwd });
  hubs.push(hub);
  // A wildcard endpoint is classified as remote while the fixture's socket
  // remains on loopback. This only strengthens the admission used in the test.
  const endpoint = `ws://0.0.0.0:${hub.port}`;
  if (access) hub.grant(WORKSPACE);
  const login = hub.issue({ workspaces: access ? [WORKSPACE] : [] });
  const box = sandbox({
    projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
    credentials: { signingSecret: SECRET, hubLogins: { [authenticationOrigin(endpoint)]: login } },
  });
  box.env.UB_TEST_MAX_WAIT_MS = "1500";
  return { hub, endpoint, login, box };
}
function file(box: Sandbox, name: string) { return join(box.configHome, "uberblick", name); }
function bind(box: Sandbox, endpoint: string) {
  const path = join(box.cwd, ".uberblick.json");
  writeFileSync(path, JSON.stringify({ workspaceId: WORKSPACE, hubUrl: endpoint }));
}

function assertPrivate(output: string, key: string) {
  expect(output.includes(SECRET), "legacy signing secret stayed private").toBe(false);
  expect(output.includes(key), "device credential key stayed private").toBe(false);
}

describe("remote device commands", () => {
  it("joins and resumes status with a stored login, retaining the loopback secret", async () => {
    const { hub, endpoint, login, box } = await rig(true);
    const before = readFileSync(file(box, "credentials.json"));
    const joined = await runUbAsync(["workspace", "join", `${endpoint}/${WORKSPACE}`], box);
    expect(joined.status, joined.stderr).toBe(0);
    expect(readFileSync(file(box, "credentials.json"))).toEqual(before);
    const status = await runUbAsync(["status", "--json"], box);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ credentialPresent: true, hub: { status: "connected" } });
    const doctor = await runUbAsync(["doctor", "--json"], box);
    const checks = JSON.parse(doctor.stdout).checks;
    expect(checks.find((check: { name: string }) => check.name === "hub").status).toBe("pass");
    expect(hub.authentications.length).toBeGreaterThan(0);
    for (const auth of hub.authentications) expect(auth.claims?.kid).toBe(login.credential.record.id);
    for (const output of [joined.output, status.output, doctor.output]) assertPrivate(output, login.credential.key);
  });

  it("initializes a remote binding only under workspace access, without generating or copying a secret", async () => {
    const { endpoint, box, login } = await rig(true);
    const before = readFileSync(file(box, "credentials.json"));
    const initialized = await runUbAsync(["init", endpoint, "--workspace", WORKSPACE, "--yes", "--no-mcp"], box);
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).hubUrl).toBe(endpoint);
    expect(readFileSync(file(box, "credentials.json"))).toEqual(before);
    assertPrivate(initialized.output, login.credential.key);
  });

  it.each(["revoked", "no-access"] as const)("keeps binding and documents unchanged under %s refusal, with a distinct next action", async (kind) => {
    const { hub, endpoint, box, login } = await rig(kind !== "no-access");
    if (kind === "revoked") hub.revoke(login.credential.record.id);
    const configFile = join(box.cwd, ".uberblick.json");
    const before = readFileSync(configFile);
    for (const args of [["workspace", "join", `${endpoint}/${WORKSPACE}`], ["init", endpoint, "--workspace", WORKSPACE, "--yes"]]) {
      const refused = await runUbAsync(args, box);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain(kind === "no-access" ? "administrator for access" : "ub auth login");
      expect(refused.output).toContain("Nothing was written to the workspace or binding");
      expect(readFileSync(configFile)).toEqual(before);
      expect(existsSync(join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`))).toBe(false);
      assertPrivate(refused.output, login.credential.key);
    }
    bind(box, endpoint);
    for (const command of ["status", "doctor"]) {
      const refused = await runUbAsync([command], box);
      expect(refused.output).toContain(kind === "no-access" ? "administrator for access" : "ub auth login");
      assertPrivate(refused.output, login.credential.key);
    }
  });
});
