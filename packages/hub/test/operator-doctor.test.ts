import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { CLOCK_SKEW_SECONDS } from "@uberblick/schema/token";
import { runOperatorDoctor, type OperatorDoctorOptions, type OperatorLiveStatus } from "../src/operator-doctor.js";
import type { TeamHub } from "../src/team.js";
import { SHARED_GITHUB_CLIENT_ID } from "../src/team-config.js";
import { removeTempDatabases, startHub, tempDatabasePath } from "./helpers.js";

const NOW = Date.parse("2026-10-14T02:00:00Z");
const hubs: TeamHub[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
  removeTempDatabases();
});

function githubFetch(options: { date?: number | null; fail?: boolean } = {}): typeof fetch {
  return async (input, init) => {
    if (String(input).startsWith("http://")) return globalThis.fetch(input, init);
    expect(String(input)).toBe("https://github.com/login/device");
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    if (options.fail === true) throw new Error("outbound HTTPS failed");
    const date = options.date === undefined ? NOW : options.date;
    return new Response("device verification page", { headers: date === null ? {} : { date: new Date(date).toUTCString() } });
  };
}

async function doctor(databasePath: string, options: Partial<OperatorDoctorOptions> = {}) {
  const lines: string[] = [];
  const code = await runOperatorDoctor({
    databasePath, githubClientId: SHARED_GITHUB_CLIENT_ID, now: () => NOW,
    fetch: githubFetch(), writeLine: (line) => lines.push(line), ...options,
  });
  return { code, lines, output: lines.join("\n") };
}

async function liveHub(): Promise<OperatorLiveStatus> {
  const hub = await startHub();
  hubs.push(hub);
  return {
    databasePath: hub.databasePath, size: statSync(hub.databasePath).size, port: hub.port,
    integrity: ["ok"], storeFailure: null, githubClientId: SHARED_GITHUB_CLIENT_ID,
  };
}

function offlineDatabase(): string {
  const databasePath = tempDatabasePath();
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE documents (name TEXT PRIMARY KEY, data BLOB NOT NULL)");
  database.close();
  chmodSync(databasePath, 0o600);
  return databasePath;
}

it("checks a real hub's HTTP and WebSocket listener without changing the database", async () => {
  const live = await liveHub();
  const before = readFileSync(live.databasePath);
  const report = await doctor(live.databasePath, { live });

  expect(report.code).toBe(0);
  expect(report.lines.map((line) => line.trim().split(/\s+/).slice(0, 2))).toEqual([
    ["ok", "hub"], ["ok", "database"], ["ok", "storage"], ["ok", "github"], ["ok", "clock"],
  ]);
  expect(report.output).toContain("HTTP and WebSocket upgrades answer");
  expect(report.output).toContain(`Uberblick Login (${SHARED_GITHUB_CLIENT_ID})`);
  expect(readFileSync(live.databasePath)).toEqual(before);
});

it("inspects a stopped hub's database read-only and continues after the hub failure", async () => {
  const databasePath = offlineDatabase();
  const before = readFileSync(databasePath);
  const siblings = readdirSync(dirname(databasePath));
  const report = await doctor(databasePath);

  expect(report.code).toBe(1);
  expect(report.output).toMatch(/FAIL\s+hub\s+no running hub/);
  expect(report.output).toMatch(/ok\s+database\s+.*integrity_check ok/);
  expect(report.output).toMatch(/ok\s+clock/);
  expect(report.lines).toHaveLength(6);
  expect(readFileSync(databasePath)).toEqual(before);
  expect(readdirSync(dirname(databasePath))).toEqual(siblings);
});

it("refuses offline journal recovery and leaves both files untouched", async () => {
  const databasePath = offlineDatabase();
  writeFileSync(`${databasePath}-journal`, "an unrecovered journal");
  const before = readFileSync(databasePath);
  const report = await doctor(databasePath);

  expect(report.code).toBe(1);
  expect(report.output).toMatch(/FAIL\s+database\s+.*journal/);
  expect(report.output).toContain("start the hub to let SQLite recover");
  expect(readFileSync(databasePath)).toEqual(before);
  expect(readFileSync(`${databasePath}-journal`, "utf8")).toBe("an unrecovered journal");
});

it("fails database ownership, permissions and corrupt databases without stopping other checks", async () => {
  const databasePath = offlineDatabase();
  chmodSync(databasePath, 0o644);
  const wrongOwner = await doctor(databasePath, { hubUid: statSync(databasePath).uid + 1 });
  expect(wrongOwner.output).toMatch(/FAIL\s+database/);
  expect(wrongOwner.output).toContain("expected hub uid");
  expect(wrongOwner.output).toContain("mode 0644, expected 0600");
  expect(statSync(databasePath).mode & 0o777).toBe(0o644);

  writeFileSync(databasePath, "not a SQLite database");
  chmodSync(databasePath, 0o600);
  const corrupt = await doctor(databasePath);
  expect(corrupt.output).toMatch(/FAIL\s+database/);
  expect(corrupt.output).toMatch(/ok\s+github/);
  expect(readFileSync(databasePath, "utf8")).toBe("not a SQLite database");
});

it("reports low free space as a warning and remembers a running hub's failed store", async () => {
  const live = await liveHub();
  const lowSpace = await doctor(live.databasePath, { live, freeBytes: () => 0 });
  expect(lowSpace.code).toBe(0);
  expect(lowSpace.output).toMatch(/warn\s+storage\s+0 bytes free/);
  expect(lowSpace.output).toContain("→ free space in the hub-data volume");

  const failedStore = await doctor(live.databasePath, { live: { ...live, storeFailure: "disk full" } });
  expect(failedStore.code).toBe(1);
  expect(failedStore.output).toMatch(/FAIL\s+storage\s+.*disk full/);
  expect(failedStore.output).toContain("restart the hub");
});

it("fails a listener that answers HTTP but refuses WebSocket upgrades", async () => {
  const databasePath = offlineDatabase();
  const server = createServer((_request, response) => response.end(JSON.stringify({ unclaimed: true, canClaim: true })));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test HTTP listener has no port");
  const report = await doctor(databasePath, { live: {
    databasePath, size: statSync(databasePath).size, port: address.port,
    integrity: ["ok"], storeFailure: null, githubClientId: SHARED_GITHUB_CLIENT_ID,
  } });

  expect(report.code).toBe(1);
  expect(report.output).toMatch(/FAIL\s+hub\s+WebSocket upgrade returned HTTP 200/);
  expect(report.output).toMatch(/ok\s+database/);
});

it("bounds clock skew in both directions and skips it when GitHub supplies no reading", async () => {
  const live = await liveHub();
  for (const direction of [-1, 1]) {
    const excessive = await doctor(live.databasePath, { live, fetch: githubFetch({ date: NOW + direction * (CLOCK_SKEW_SECONDS + 1) * 1_000 }) });
    expect(excessive.code).toBe(1);
    expect(excessive.output).toMatch(/FAIL\s+clock\s+61s/);
    expect(excessive.output).toContain("automatic time synchronization");
  }
  const boundary = await doctor(live.databasePath, { live, fetch: githubFetch({ date: NOW - CLOCK_SKEW_SECONDS * 1_000 }) });
  expect(boundary.code).toBe(0);
  expect(boundary.output).toMatch(/ok\s+clock/);
  const missing = await doctor(live.databasePath, { live, fetch: githubFetch({ date: null }) });
  expect(missing.code).toBe(0);
  expect(missing.output).toMatch(/skip\s+clock/);
  const failed = await doctor(live.databasePath, { live, fetch: githubFetch({ fail: true }) });
  expect(failed.code).toBe(1);
  expect(failed.output).toMatch(/FAIL\s+github\s+.*outbound HTTPS failed/);
  expect(failed.output).toMatch(/skip\s+clock/);
});
