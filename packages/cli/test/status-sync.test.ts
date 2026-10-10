/** Live `ub status` sync checks use asynchronous spawns so the hub can answer. */

import { createHub, silentLogger } from "@uberblick/hub";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { pointAt, removeTempDirs, runUbAsync, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

it("reports this run's acknowledgement time after catching up", async () => {
  const secret = "last-sync-live-status-test-secret";
  const box = sandbox({ credentials: { signingSecret: secret } });
  const hub = await createHub({
    authSecret: secret,
    port: 0,
    databasePath: join(box.cwd, "hub.sqlite"),
    log: silentLogger,
  });
  try {
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const before = Date.now();
    const json = await runUbAsync(["status", "--json"], box);
    expect(json.status, json.stderr).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.connection).toEqual({ state: "connected", cause: null, detail: null });
    expect(report.pending).toEqual({ count: 0 });
    expect(report.lastSync).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(report.lastSync)).toBeGreaterThanOrEqual(Math.floor(before / 1_000) * 1_000);
    expect(Date.parse(report.lastSync)).toBeLessThanOrEqual(Date.now());
  } finally {
    await hub.stop();
  }
});
