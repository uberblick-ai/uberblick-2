/** Device retirement uses real hub credentials; an unconfirmed reply is never success. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importCredentialKey, inspectRequestProof } from "@uberblick/hub/token";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { manageRequest } from "../src/access-management.js";
import {
  OTHER_HUB, SIGNING_SECRET, USERNAME, WORKSPACE, assertPublicOnly, cleanUp,
  configPath, credentialPath, fixture, privateDeviceRows, readStore, rig,
  savedLogin, serve,
} from "./auth-fixtures.js";
import { DEAD_HUB_URL, removeTempDirs, runUbAsync, sandbox } from "./helpers.js";

afterEach(cleanUp);
afterAll(removeTempDirs);

function memberships(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return database.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all(); }
  finally { database.close(); }
}

async function signedIn(remote: Awaited<ReturnType<typeof rig>>) {
  const box = sandbox({
    projectBinding: { workspaceId: WORKSPACE, hubUrl: `${remote.origin.replace("http:", "ws:")}/ws` },
    userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
    credentials: { signingSecret: SIGNING_SECRET, hubLogins: { [OTHER_HUB]: fixture() } },
  });
  const login = await runUbAsync(["auth", "login"], box);
  expect(login.status, login.stderr).toBe(0);
  return { box, login: savedLogin(box, remote.origin) };
}

describe("ub auth logout retires devices", () => {
  it("confirms this device's retirement, removes only its login, and preserves memberships, binding and copies", async () => {
    const remote = await rig([WORKSPACE]);
    const { box, login } = await signedIn(remote);
    const store = readStore(box);
    const binding = readFileSync(join(box.cwd, ".uberblick.json"));
    const config = readFileSync(configPath(box));
    const localCopy = join(box.cwd, "workspace-copy.sqlite");
    writeFileSync(localCopy, "local workspace copy");
    const access = memberships(remote.databasePath);
    const run = await runUbAsync(["auth", "logout"], box);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe(`revoked    this computer on ${remote.origin}\nremoved    login for ${remote.origin} on this computer\n`);
    expect(run.stderr).toBe("");
    expect(Object.keys(readStore(box).hubLogins ?? {})).toEqual([OTHER_HUB]);
    expect(readStore(box).hubLogins?.[OTHER_HUB]).toEqual(store.hubLogins?.[OTHER_HUB]);
    expect(readStore(box).signingSecret).toBe(SIGNING_SECRET);
    expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(binding);
    expect(readFileSync(configPath(box))).toEqual(config);
    expect(readFileSync(localCopy, "utf8")).toBe("local workspace copy");
    expect(memberships(remote.databasePath)).toEqual(access);
    expect(privateDeviceRows(remote.databasePath)[0]?.revoked_at).not.toBeNull();
    expect(await manageRequest(remote.origin, { operation: "list-devices" }, login)).toEqual({
      status: 401, body: { status: "sign-in-required" },
    });
    assertPublicOnly(run, remote, login.credential.key);
  });

  it("with no stored login prints that fact and contacts nothing, including when help overrides flags", async () => {
    const remote = await rig();
    const box = sandbox();
    const run = await runUbAsync(["auth", "logout", remote.origin], box);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("No login stored for this hub.\n");
    expect(run.stderr).toBe("");
    const help = await runUbAsync(["auth", "logout", "--all-devices", "--unknown", remote.origin, "--help"], box);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--all-devices");
    expect(help.stderr).toBe("");
    expect(remote.requests).toHaveLength(0);
  });

  it.each([
    [401, { status: "sign-in-required" }],
    [403, { status: "forbidden" }],
    [500, { status: "failed" }],
    [200, { status: "unexpected" }],
    [500, { status: "ok" }],
    [500, { status: "closure-failed", applied: false }],
  ])("removes the login after an unconfirmed %s response and names recovery from another signed-in computer", async (status, result) => {
    const remote = await rig();
    const { box, login } = await signedIn(remote);
    remote.controls.onManagement = () => ({ status, result });
    const run = await runUbAsync(["auth", "logout", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(`removed    login for ${remote.origin} on this computer\n`);
    expect(run.stderr).toMatch(/this computer.*not.*revoked/i);
    expect(run.stderr).toContain(`ub auth logout --all-devices ${remote.origin}`);
    expect(run.stderr).toMatch(/computer.*still signed in/i);
    expect(remote.origin in (readStore(box).hubLogins ?? {})).toBe(false);
    expect(privateDeviceRows(remote.databasePath)[0]?.revoked_at).toBeNull();
    assertPublicOnly(run, remote, login.credential.key);
  });

  it("removes an unreachable hub's login without retaining a pending key", async () => {
    const origin = "http://127.0.0.1:1";
    const other = fixture();
    const box = sandbox({ credentials: { signingSecret: SIGNING_SECRET,
      hubLogins: { [origin]: fixture(), [OTHER_HUB]: other } } });
    const run = await runUbAsync(["auth", "logout", DEAD_HUB_URL], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(`removed    login for ${origin} on this computer\n`);
    expect(run.stderr).toContain(`ub auth logout --all-devices ${origin}`);
    expect(readStore(box)).toEqual({ signingSecret: SIGNING_SECRET, hubLogins: { [OTHER_HUB]: other } });
  });

  it("bounds a hung response body, removes the login and reports an unconfirmed revocation", async () => {
    const remote = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"status":"ok"');
    });
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const run = await runUbAsync(["auth", "logout", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(`removed    login for ${remote.origin} on this computer\n`);
    expect(run.stderr).toMatch(/not.*revoked/i);
    expect(remote.origin in (readStore(box).hubLogins ?? {})).toBe(false);
  });

  it("counts an applied closure failure as revoked and explains the remaining connection warning", async () => {
    const remote = await rig();
    const { box, login } = await signedIn(remote);
    remote.controls.transform = (path, status, result, body) => path === "/auth/manage" && body.operation === "revoke-device"
      ? { status: 500, result: { status: "closure-failed", applied: true } } : { status, result };
    const run = await runUbAsync(["auth", "logout", remote.origin], box);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`revoked    this computer on ${remote.origin}\n`);
    expect(run.stderr).toMatch(/connection|closure/i);
    expect(privateDeviceRows(remote.databasePath)[0]?.revoked_at).not.toBeNull();
    expect((await manageRequest(remote.origin, { operation: "list-devices" }, login)).status).toBe(401);
  });

  it("all-devices revokes only this account, with the current device last and no membership or binding changes", async () => {
    const remote = await rig([WORKSPACE]);
    const older = await signedIn(remote);
    const current = await signedIn(remote);
    remote.github.identity = { id: 5678, login: "another-account" };
    const another = await signedIn(remote);
    const access = memberships(remote.databasePath);
    const binding = readFileSync(join(current.box.cwd, ".uberblick.json"));
    const store = readStore(current.box);
    const run = await runUbAsync(["auth", "logout", "--all-devices"], current.box);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe(`revoked    2 devices of ${USERNAME} on ${remote.origin}, including this computer\nremoved    login for ${remote.origin} on this computer\nsign in again on the computers you still use: ub auth login ${remote.origin}\n`);
    expect(run.stderr).toBe("");
    const actions = remote.requests.filter(request => request.path === "/auth/manage").map(request => request.body);
    expect(actions.map(action => action.operation)).toEqual(["list-devices", "revoke-device", "revoke-device"]);
    expect(actions.slice(1).map(action => action.deviceId)).toEqual([
      older.login.credential.record.deviceId, current.login.credential.record.deviceId,
    ]);
    expect(Object.keys(readStore(current.box).hubLogins ?? {})).toEqual([OTHER_HUB]);
    expect(readStore(current.box).hubLogins?.[OTHER_HUB]).toEqual(store.hubLogins?.[OTHER_HUB]);
    expect(readStore(current.box).signingSecret).toBe(SIGNING_SECRET);
    expect(readFileSync(join(current.box.cwd, ".uberblick.json"))).toEqual(binding);
    expect(memberships(remote.databasePath)).toEqual(access);
    for (const login of [older.login, current.login]) {
      expect((await manageRequest(remote.origin, { operation: "list-devices" }, login)).status).toBe(401);
    }
    expect((await manageRequest(remote.origin, { operation: "list-devices" }, another.login)).status).toBe(200);
    expect(savedLogin(older.box, remote.origin).credential.record.id).toBe(older.login.credential.record.id);
    assertPublicOnly(run, remote, current.login.credential.key);
  });

  it("all-devices quotes an invalid stored username and escapes DEL and every C1 control", async () => {
    const remote = await rig();
    const username = 'synthetic"\\user\n\u001b\u007f' + String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 0x80));
    const escaped = '"synthetic\\"\\\\user\\n\\u001b\\u007f' +
      '\\u0080\\u0081\\u0082\\u0083\\u0084\\u0085\\u0086\\u0087' +
      '\\u0088\\u0089\\u008a\\u008b\\u008c\\u008d\\u008e\\u008f' +
      '\\u0090\\u0091\\u0092\\u0093\\u0094\\u0095\\u0096\\u0097' +
      '\\u0098\\u0099\\u009a\\u009b\\u009c\\u009d\\u009e\\u009f"';
    remote.controls.transform = (path, status, result) => {
      if (path !== "/auth/github/collect" || result.status !== "complete") return { status, result };
      return { status, result: { ...result, identity: { ...(result.identity as Record<string, unknown>), githubUsername: username } } };
    };
    const { box, login } = await signedIn(remote);
    expect(login.identity.githubUsername).toBe(username);
    const run = await runUbAsync(["auth", "logout", "--all-devices", remote.origin], box);
    assertPublicOnly(run, remote, login.credential.key);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe(`revoked    1 devices of ${escaped} on ${remote.origin}, including this computer\n` +
      `removed    login for ${remote.origin} on this computer\n` +
      `sign in again on the computers you still use: ub auth login ${remote.origin}\n`);
    expect(run.stderr).toBe("");
    expect(run.output).not.toMatch(/[\u007f-\u009f]/);
  });

  it("all-devices cannot start without a login and does not contact the hub", async () => {
    const remote = await rig();
    const run = await runUbAsync(["auth", "logout", "--all-devices", remote.origin], sandbox());
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/no.*login|sign.in/i);
    expect(remote.requests).toHaveLength(0);
  });

  it("all-devices keeps a stored login when the hub is unreachable", async () => {
    const origin = "http://127.0.0.1:1";
    const box = sandbox({ credentials: { hubLogins: { [origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "logout", origin, "--all-devices"], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toBe("");
    expect(readFileSync(credentialPath(box)).equals(before), "the stored login was kept byte-for-byte").toBe(true);
  });

  it.each(["refused", "invalid"])("all-devices revokes nothing and preserves its login after a %s listing", async kind => {
    const remote = await rig();
    const { box } = await signedIn(remote);
    const before = readFileSync(credentialPath(box));
    remote.controls.onManagement = () => kind === "refused"
      ? { status: 401, result: { status: "sign-in-required" } }
      : { status: 200, result: { status: "ok", devices: [{ deviceId: "invalid", current: true }] } };
    const run = await runUbAsync(["auth", "logout", "--all-devices", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toBe("");
    expect(readFileSync(credentialPath(box)).equals(before), "the stored login was kept byte-for-byte").toBe(true);
    expect(remote.requests.filter(request => request.path === "/auth/manage")).toHaveLength(1);
    expect(privateDeviceRows(remote.databasePath)[0]?.revoked_at).toBeNull();
  });

  it("all-devices counts only confirmed partial revocations, keeps the login and completes a retry", async () => {
    const remote = await rig();
    await signedIn(remote);
    await signedIn(remote);
    const { box, login } = await signedIn(remote);
    const before = readFileSync(credentialPath(box));
    let revocations = 0;
    remote.controls.onManagement = body => body.operation === "revoke-device" && ++revocations === 2
      ? { status: 401, result: { status: "sign-in-required" } } : undefined;
    const run = await runUbAsync(["auth", "logout", "--all-devices", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`confirmed  1 revocations on ${remote.origin}\n`);
    expect(run.stderr).toContain(`ub auth logout --all-devices ${remote.origin}`);
    expect(run.stderr).toContain(`ub auth login ${remote.origin}`);
    expect(run.stderr).toMatch(/still signed in/i);
    expect(readFileSync(credentialPath(box)).equals(before), "the stored login was kept byte-for-byte").toBe(true);
    expect(privateDeviceRows(remote.databasePath).filter(row => row.revoked_at !== null)).toHaveLength(1);
    expect((await manageRequest(remote.origin, { operation: "list-devices" }, login)).status).toBe(200);
    remote.controls.onManagement = undefined;
    const retry = await runUbAsync(["auth", "logout", "--all-devices", remote.origin], box);
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain(`revoked    2 devices of ${USERNAME}`);
    expect(remote.origin in (readStore(box).hubLogins ?? {})).toBe(false);
    expect(privateDeviceRows(remote.databasePath).every(row => row.revoked_at !== null)).toBe(true);
  });

  it("an unconfirmed final self-revocation may leave a kept login unusable; a fresh login can finish", async () => {
    const remote = await rig();
    await signedIn(remote);
    const { box, login } = await signedIn(remote);
    const before = readFileSync(credentialPath(box));
    remote.controls.transform = (path, status, result, body) => path === "/auth/manage"
      && body.operation === "revoke-device" && body.deviceId === login.credential.record.deviceId
      ? { status: 502, result: { status: "failed" } } : { status, result };
    const run = await runUbAsync(["auth", "logout", "--all-devices", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`confirmed  1 revocations on ${remote.origin}\n`);
    expect(run.stderr).toMatch(/uncertain/i);
    expect(run.stderr).toMatch(/login.*may.*(work|valid)|may.*no longer work/i);
    expect(run.stderr).toContain(`ub auth login ${remote.origin}`);
    expect(run.stderr).toMatch(/still signed in/i);
    expect(readFileSync(credentialPath(box)).equals(before), "the stored login was kept byte-for-byte").toBe(true);
    expect(privateDeviceRows(remote.databasePath).every(row => row.revoked_at !== null)).toBe(true);
    remote.controls.transform = undefined;
    const retry = await runUbAsync(["auth", "logout", "--all-devices", remote.origin], box);
    expect(retry.status).toBe(1);
    expect(retry.stdout).toBe("");
    expect(retry.stderr).toMatch(/sign.in.required|sign in again|refus/i);
    expect(readFileSync(credentialPath(box)).equals(before), "the stored login was kept byte-for-byte").toBe(true);
    expect((await runUbAsync(["auth", "login", remote.origin], box)).status).toBe(0);
    const recovered = await runUbAsync(["auth", "logout", "--all-devices", remote.origin], box);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain(`revoked    1 devices of ${USERNAME}`);
  });

  it("all-devices includes confirmed closure failures in its count and continues to the current device", async () => {
    const remote = await rig();
    const older = await signedIn(remote);
    const { box } = await signedIn(remote);
    remote.controls.transform = (path, status, result, body) => path === "/auth/manage"
      && body.operation === "revoke-device" && body.deviceId === older.login.credential.record.deviceId
      ? { status: 500, result: { status: "closure-failed", applied: true } } : { status, result };
    const run = await runUbAsync(["auth", "logout", "--all-devices", remote.origin], box);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`revoked    2 devices of ${USERNAME}`);
    expect(run.stderr).toMatch(/connection|closure/i);
    expect(remote.origin in (readStore(box).hubLogins ?? {})).toBe(false);
    expect(privateDeviceRows(remote.databasePath).every(row => row.revoked_at !== null)).toBe(true);
  });
});

describe("ub auth login replaces and retires its previous device", () => {
  it.each(["same", "different"])("stores the new login for the %s account before revoking with the old credential; the new credential survives", async account => {
    const remote = await rig([WORKSPACE]);
    const { box, login: old } = await signedIn(remote);
    const binding = readFileSync(join(box.cwd, ".uberblick.json"));
    const access = memberships(remote.databasePath);
    if (account === "different") remote.github.identity = { id: 5678, login: "another-account" };
    let proofVerified = false;
    remote.controls.onManagement = async body => {
      expect(savedLogin(box, remote.origin).credential.record.deviceId).not.toBe(old.credential.record.deviceId);
      expect(body).toMatchObject({ operation: "revoke-device", deviceId: old.credential.record.deviceId });
      const proof = await inspectRequestProof(await importCredentialKey(Buffer.from(old.credential.key, "base64url")),
        String(body.token), { operation: "revoke-device", deviceId: old.credential.record.deviceId });
      proofVerified = "kid" in proof && proof.kid === old.credential.record.id;
      return undefined;
    };
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status, run.stderr).toBe(0);
    expect(proofVerified).toBe(true);
    const next = savedLogin(box, remote.origin);
    remote.controls.onManagement = undefined;
    expect((await manageRequest(remote.origin, { operation: "list-devices" }, old)).status).toBe(401);
    expect((await manageRequest(remote.origin, { operation: "list-devices" }, next)).status).toBe(200);
    expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(binding);
    expect(memberships(remote.databasePath)).toEqual(access);
    assertPublicOnly(run, remote, old.credential.key);
    assertPublicOnly(run, remote, next.credential.key);
  });

  it.each([401, 503])("still succeeds after a %s refusal of previous-device revocation and leaves the new login usable", async status => {
    const remote = await rig();
    const { box, login: old } = await signedIn(remote);
    remote.controls.onManagement = () => ({ status, result: { status: status === 401 ? "sign-in-required" : "failed" } });
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status).toBe(0);
    expect(run.output).toMatch(/previous.*device.*not.*revoked|old.*device.*not.*revoked/i);
    const next = savedLogin(box, remote.origin);
    expect(next.credential.record.deviceId).not.toBe(old.credential.record.deviceId);
    remote.controls.onManagement = undefined;
    expect((await manageRequest(remote.origin, { operation: "list-devices" }, next)).status).toBe(200);
    expect((await manageRequest(remote.origin, { operation: "list-devices" }, old)).status).toBe(200);
    assertPublicOnly(run, remote, next.credential.key);
  });
});
