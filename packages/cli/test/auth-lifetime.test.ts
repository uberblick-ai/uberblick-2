/**
 * `ub auth login` against an unavailable or misbehaving hub, and the finite
 * lifetime of an attempt. Split from `auth.test.ts`; the fixtures are in
 * `auth-fixtures.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  DEAD_HUB_URL, removeTempDirs, runUbAsync, sandbox, sleep, waitUntil,
} from "./helpers.js";
import {
  GITHUB_TOKEN, SIGNING_SECRET, type Login,
  assertPublicOnly, cleanUp, credentialPath, fixture, privateDeviceRows, rig, serve,
} from "./auth-fixtures.js";

afterEach(cleanUp);
afterAll(removeTempDirs);

describe("CLI sign-in validates availability and has a finite lifetime", () => {
  it("reports unreachable and unconfigured hubs without changing the store", async () => {
    const remote = await rig([], false);
    const box = sandbox({ credentials: { signingSecret: SIGNING_SECRET } });
    const before = readFileSync(credentialPath(box));
    const unconfigured = await runUbAsync(["auth", "login", remote.origin], box);
    expect(unconfigured.status).toBe(1);
    expect(unconfigured.stderr).toMatch(/not configured|not.configured/i);
    const unreachable = await runUbAsync(["auth", "login", DEAD_HUB_URL], box);
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toMatch(/unreachable|cannot reach/i);
    expect(readFileSync(credentialPath(box))).toEqual(before);
  });

  it("reports an empty proxy 502 as unreachable and preserves existing credentials", async () => {
    const proxy = await serve((_request, response) => { response.writeHead(502); response.end(); });
    const box = sandbox({ credentials: { hubLogins: { [proxy.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", proxy.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/unreachable|cannot reach/i);
    expect(run.stderr).not.toMatch(/update.*hub/i);
    expect(readFileSync(credentialPath(box))).toEqual(before);
  });

  it("reports a proxy outage during collection and abandons the existing attempt", async () => {
    const remote = await rig();
    remote.controls.unavailableCollection = true;
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/unreachable|cannot reach/i);
    expect(run.stderr).not.toMatch(/update.*hub/i);
    const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
    expect(cancellation).toBeDefined();
    if (!cancellation) throw new Error("missing cancellation after proxy outage");
    expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
    assertPublicOnly(run, remote);
  });

  it("cancels a timed-out collection before slow GitHub reads can issue a device", async () => {
    const remote = await rig();
    remote.github.lifetime = 30;
    // Both provider reads fit the hub's individual ten-second budgets; their
    // combined wait exceeds the CLI's collection request limit.
    remote.github.tokenHook = () => sleep(6_000);
    let identityRead: Promise<void> | undefined;
    remote.github.identityHook = () => { identityRead = sleep(6_000); return identityRead; };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    try {
      const run = await runUbAsync(["auth", "login", remote.origin], box);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/unreachable|timed out/i);
      const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
      expect(cancellation).toBeDefined();
      if (!cancellation) throw new Error("missing cancellation after collection timeout");
      expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
      expect(remote.github.calls).toContain("https://api.github.com/user");
      expect(identityRead).toBeDefined();
      await identityRead;
      await waitUntil("slow hub collection finished after cancellation", () => remote.collectionStatuses.length === 1, 5_000);
      expect(remote.collectionStatuses).toEqual(["abandoned"]);
      expect(readFileSync(credentialPath(box))).toEqual(before);
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
      assertPublicOnly(run, remote);
    } finally { await identityRead; }
  });

  it("reports a device already issued when failure cleanup finds a collected attempt", async () => {
    const remote = await rig();
    let issuedKey: string | undefined;
    remote.controls.transform = (path, status, result) => {
      if (!path.endsWith("collect") || result.status !== "complete") return { status, result };
      issuedKey = (result.credential as Login["credential"]).key;
      return { status, result: { status: "failed" } };
    };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/failed/i);
    expect(run.stderr).toMatch(/issued.*device.*remain.*hub/i);
    expect(remote.requests.some((request) => request.path === "/auth/github/cancel")).toBe(true);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
    expect(privateDeviceRows(remote.databasePath)[0]?.revoked_at).toBeNull();
    assertPublicOnly(run, remote, issuedKey);
  });

  it("recognizes busy and failed starts by their validated body", async () => {
    const remote = await rig();
    remote.github.failAt = "https://github.com/login/device/code";
    const box = sandbox();
    const failure = await runUbAsync(["auth", "login", remote.origin], box);
    expect(failure.status).toBe(1);
    expect(failure.stderr).toMatch(/failed/i);
    assertPublicOnly(failure, remote);
    remote.github.failAt = undefined;
    remote.github.lifetime = 60;
    await Promise.all(Array.from({ length: 100 }, () => fetch(`http://127.0.0.1:${remote.hub.port}/auth/github/start`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }).then((response) => response.arrayBuffer())));
    const busy = await runUbAsync(["auth", "login", remote.origin], box);
    expect(busy.status).toBe(1);
    expect(busy.stderr).toMatch(/busy/i);
    expect(existsSync(credentialPath(box))).toBe(false);
  });

  it.each(["old-hub", "unsafe-verification-url", "unsafe-code", "invalid-interval"])("refuses %s responses without trusting or printing their contents", async (kind) => {
    const remote = await rig();
    if (kind !== "old-hub") remote.controls.transform = (path, status, result) => {
      if (!path.endsWith("start")) return { status, result };
      if (kind === "unsafe-verification-url") return { status, result: { ...result, verificationUri: `https://attacker.invalid/${GITHUB_TOKEN}` } };
      if (kind === "invalid-interval") return { status, result: { ...result, interval: 0 } };
      return { status, result: { ...result, userCode: GITHUB_TOKEN } };
    };
    const old = kind === "old-hub" ? await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("Welcome to Hocuspocus!");
    }) : undefined;
    const box = sandbox({ credentials: { signingSecret: SIGNING_SECRET } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", old?.origin ?? remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/offer|invalid|malformed|unsupported|response/i);
    expect(run.output).not.toContain(GITHUB_TOKEN);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    if (kind !== "old-hub") {
      const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
      expect(cancellation).toBeDefined();
      if (!cancellation) throw new Error("missing cancellation authority from malformed start");
      expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
      expect(remote.requests.some((request) => request.path === "/auth/github/collect")).toBe(false);
      expect(run.stdout).not.toMatch(/^open {2,}/m);
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
      assertPublicOnly(run, remote);
    } else {
      expect(remote.requests.some((request) => request.path === "/auth/github/cancel")).toBe(false);
    }
  });

  it.each(["username-echoes-key", "username-echoes-collection-secret"])("refuses a complete response with %s and explains the issued device", async (kind) => {
    const remote = await rig();
    let issuedKey: string | undefined;
    remote.controls.transform = (path, status, result) => {
      if (!path.endsWith("collect") || result.status !== "complete") return { status, result };
      const credential = result.credential as Login["credential"];
      const identity = result.identity as Login["identity"];
      issuedKey = credential.key;
      const echoed = kind === "username-echoes-key" ? credential.key
        : remote.requests.at(-1)?.body.collectionSecret;
      return { status, result: { ...result, identity: { ...identity, githubUsername: echoed } } };
    };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/invalid.*credential|invalid.*sign.in|invalid.*response/i);
    expect(run.stderr).toMatch(/issued.*device.*remain.*hub/i);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
    assertPublicOnly(run, remote, issuedKey);
  });

  it.each(["pending", "hung-body"])("ends %s by announced lifetime even with the shorter unrelated test seam", async (kind) => {
    const remote = await rig();
    remote.github.lifetime = 3;
    remote.github.tokenResult = { error: "authorization_pending" };
    remote.controls.holdCollection = kind === "hung-body";
    let announcedLifetime = 0;
    remote.controls.onStart = (result) => { announcedLifetime = result.expiresIn as number; };
    const box = sandbox();
    const startedAt = Date.now();
    const run = await runUbAsync(["auth", "login", remote.origin], box, { UB_TEST_MAX_WAIT_MS: "1" }, 12_000);
    const elapsed = Date.now() - startedAt;
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/expired|timed out|timeout/i);
    expect(announcedLifetime).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(announcedLifetime * 1000 - 100);
    expect(elapsed).toBeLessThan(announcedLifetime * 1000 + 5_000);
    expect(existsSync(credentialPath(box))).toBe(false);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
    assertPublicOnly(run, remote);
  });
});
