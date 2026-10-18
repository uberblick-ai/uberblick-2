/** Recent-device readings are account scoped, bounded and read-only. */
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { removeHubLogin, writeHubLogin } from "@uberblick/mcp-server/auth-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recentDevicesNotice, requestRecentDevices } from "../src/recent-devices.js";
import { credentialPath, fixture, WORKSPACE } from "./auth-fixtures.js";
import { removeTempDirs, sandbox } from "./helpers.js";

const ORIGIN = "https://recent-hub.example";
const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const DAY = 86_400_000;
const NAMED = "11111111-1111-4111-8111-111111111111";
const UNNAMED = "22222222-2222-4222-8222-222222222222";
const OLD = "33333333-3333-4333-8333-333333333333";
const FUTURE = "44444444-4444-4444-8444-444444444444";

function rig() {
  // Device management remains available without workspace membership.
  const login = fixture([]);
  const box = sandbox({ credentials: { hubLogins: { [ORIGIN]: login } } });
  const binding = { hubUrl: `${ORIGIN}/proxy/ws`, workspaceId: WORKSPACE, env: box.env };
  const own = { deviceId: login.credential.record.deviceId, signedInAt: NOW, deviceName: "This computer", current: true };
  const read = (signal = new AbortController().signal) => requestRecentDevices(binding, signal);
  return { box, login, binding, own, read };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { vi.restoreAllMocks(); removeTempDirs(); });

describe("recent devices", () => {
  it("projects every other device in the seven-day window without consuming or writing the reading", async () => {
    const { box, login, own, read } = rig();
    const path = credentialPath(box);
    const before = readFileSync(path);
    const modified = statSync(path).mtimeMs;
    const files = readdirSync(dirname(path));
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ status: "ok", devices: [
      own,
      { deviceId: NAMED, signedInAt: NOW - DAY, deviceName: "This computer", current: false, credential: login.credential },
      { deviceId: UNNAMED, signedInAt: NOW - 7 * DAY, current: false },
      { deviceId: OLD, signedInAt: NOW - 7 * DAY - 1, deviceName: "Old computer", current: false },
      { deviceId: FUTURE, signedInAt: NOW + 1, deviceName: "Future computer", current: false },
    ], privateField: login.credential.key }));
    const expected = [
      { id: NAMED, name: "This computer", signedInAt: "2026-10-17T12:00:00.000Z" },
      { id: UNNAMED, signedInAt: "2026-10-11T12:00:00.000Z" },
    ];
    expect(await read()).toEqual(expected);
    expect(await read()).toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe(`${ORIGIN}/auth/manage`);
      expect(JSON.parse(String(init?.body))).toMatchObject({ operation: "list-devices" });
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("workspaceId");
    }
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mtimeMs).toBe(modified);
    expect(readdirSync(dirname(path))).toEqual(files);
  });

  it("uses validated display names and never projects private upstream fields", async () => {
    const { login, own, read } = rig();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok", devices: [
      own,
      { deviceId: NAMED, signedInAt: NOW, deviceName: `computer ${login.credential.key}`, current: false },
      { deviceId: UNNAMED, signedInAt: NOW, deviceName: "name\n\u001b[31m", current: false, key: login.credential.key },
    ] }));
    const answer = await read();
    expect(answer).toEqual([
      { id: NAMED, signedInAt: "2026-10-18T12:00:00.000Z" },
      { id: UNNAMED, signedInAt: "2026-10-18T12:00:00.000Z" },
    ]);
    expect(JSON.stringify(answer)).not.toContain(login.credential.key);
  });

  it("distinguishes a successful empty reading from an unavailable reading", async () => {
    const { own, read } = rig();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ status: "ok", devices: [own] }));
    expect(await read()).toEqual([]);
    fetch.mockResolvedValueOnce(Response.json({ status: "forbidden", message: "private diagnostic" }, { status: 403 }));
    expect(await read()).toBeNull();
    fetch.mockResolvedValueOnce(new Response("older hub", { status: 404 }));
    expect(await read()).toBeNull();
    fetch.mockRejectedValueOnce(new Error("private transport diagnostic"));
    expect(await read()).toBeNull();
  });

  it.each(["wrong current", "no current", "duplicate", "invalid time"])(
    "withholds a malformed list with %s rather than guessing device identity",
    async defect => {
      const { own, read } = rig();
      const other = { deviceId: NAMED, signedInAt: NOW, current: false };
      const devices = defect === "wrong current" ? [{ ...own, current: false }, { ...other, current: true }]
        : defect === "no current" ? [other]
        : defect === "duplicate" ? [own, other, other]
        : [own, { ...other, signedInAt: "yesterday" }];
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok", devices }));
      expect(await read()).toBeNull();
    },
  );

  it("does not contact a hub for local, missing, unreadable or refused logins", async () => {
    const { box, binding, read } = rig();
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await requestRecentDevices({ ...binding, hubUrl: null }, new AbortController().signal)).toBeNull();
    await removeHubLogin(ORIGIN, box.env);
    expect(await read()).toBeNull();
    const path = credentialPath(box);
    writeFileSync(path, "{");
    expect(await read()).toBeNull();
    writeFileSync(path, JSON.stringify({ hubLogins: { [ORIGIN]: fixture() } }));
    chmodSync(path, 0o644);
    expect(await read()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["removed", "replaced"])("withholds a login %s while the list is being read", async change => {
    const { box, own, read } = rig();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (change === "removed") await removeHubLogin(ORIGIN, box.env);
      else await writeHubLogin(ORIGIN, fixture(), box.env);
      return Response.json({ status: "ok", devices: [own, { deviceId: NAMED, signedInAt: NOW, current: false }] });
    });
    expect(await read()).toBeNull();
  });

  it.each(["headers", "body"])("honors caller cancellation while waiting for response %s", async phase => {
    const { read } = rig();
    const abort = new AbortController();
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) throw new Error("missing request deadline");
      if (phase === "headers") {
        reached();
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => { reject(signal.reason); }, { once: true });
        });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => { controller.error(signal.reason); }, { once: true });
        },
        pull() { reached(); },
      }, { highWaterMark: 0 }));
    });
    const result = read(abort.signal);
    await waiting;
    abort.abort();
    await expect(result).resolves.toBeNull();
  });

  it("does no request after the caller deadline has already elapsed", async () => {
    const { read } = rig();
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await read(AbortSignal.abort())).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders names beside id prefixes, relative sign-in times and both revoke routes", () => {
    expect(recentDevicesNotice([
      { id: NAMED, name: "This computer", signedInAt: "2026-10-18T11:00:00.000Z" },
      { id: UNNAMED, signedInAt: "2026-10-18T12:00:00.000Z" },
    ], ORIGIN)).toBe(
      "new device  This computer (11111111), signed in 1 hour ago\n" +
      "              → revoke in Settings → User → Devices\n" +
      `              → or ub auth logout --all-devices ${ORIGIN}\n` +
      "new device  Unnamed device (22222222), signed in just now\n" +
      "              → revoke in Settings → User → Devices\n" +
      `              → or ub auth logout --all-devices ${ORIGIN}\n`,
    );
    expect(recentDevicesNotice([], ORIGIN)).toBe("");
    expect(recentDevicesNotice(null, ORIGIN)).toBe("");
  });
});
