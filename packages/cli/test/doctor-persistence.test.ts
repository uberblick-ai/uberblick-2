/**
 * Doctor's persistence verdict comes from a real replica reading: a database
 * that can open still rejects an append, and a hub that answers still leaves
 * this process quarantined. Missing or unreadable stores must never be created
 * or mistaken for a successful reading.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hub } from "@uberblick/hub";
import { createHub, silentLogger } from "@uberblick/hub";
import { createMcpServer, resolveMcpConfig } from "@uberblick/mcp-server";
import { directoryRoom, upsertDirectoryEntry } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { Check, DoctorReport } from "../src/doctor.js";
import type { StatusReport } from "../src/status.js";
import type { Sandbox } from "./helpers.js";
import { pointAt, removeTempDirs, runUbAsync, sandbox, unboundSandbox } from "./helpers.js";

const WORKSPACE = "c4ee1905-90e4-42df-8a4c-ed6ce9cbe531";
const DOCUMENT = "13b04df6-1c7b-45f1-9ec9-5f22034f71d3";
const SECRET = "doctor-persistence-test-secret";
const REFUSED = "doctor fixture refuses update-log appends";
const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDirs();
});

async function persistence(
  box: Sandbox,
  env: NodeJS.ProcessEnv = {},
): Promise<{ check: Check; report: DoctorReport; status: number | null }> {
  const run = await runUbAsync(["doctor", "--json"], box, {
    PORT: "1",
    HUB_HOST: "127.0.0.1",
    ...env,
  });
  const report = JSON.parse(run.stdout) as DoctorReport;
  const check = report.checks.find((one) => one.name === "persistence");
  if (check === undefined) throw new Error("doctor omitted the persistence check");
  return { check, report, status: run.status };
}

async function emptyStore(box: Sandbox, databasePath: string): Promise<void> {
  // The fixture creates the file explicitly; doctor must not create one itself.
  const instance = createMcpServer(resolveMcpConfig({
    ...box.env,
    WORKSPACE_ID: WORKSPACE,
    UBERBLICK_DB: databasePath,
  }));
  await instance.close();
}

async function waitUntil(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function seededHub(box: Sandbox): Promise<Hub> {
  const hub = await createHub({
    authSecret: SECRET,
    port: 0,
    databasePath: join(box.cwd, "hub.sqlite"),
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  hubs.push(hub);
  // Seed through the existing replica/client flow rather than introducing
  // another token-minting site just for this fixture.
  const seed = createMcpServer({
    ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE }),
    databasePath: join(box.cwd, "seed.sqlite"),
    hubUrl: `ws://127.0.0.1:${hub.port}`,
    authSecret: SECRET,
  });
  try {
    await seed.replicas.settle();
    upsertDirectoryEntry(seed.replicas.directory().doc, {
      uuid: DOCUMENT,
      title: "Remote update",
      tags: [],
    });
    await waitUntil("the remote update to be acknowledged", () =>
      seed.replicas.isRoomQuiet(directoryRoom(WORKSPACE)));
  } finally {
    await seed.close();
  }
  return hub;
}

describe("ub doctor live persistence reading", () => {
  it("reports no workspace without creating config, data or a database", async () => {
    const box = unboundSandbox();
    const { check } = await persistence(box);

    expect(check.status).not.toBe("pass");
    expect(check.reason).toMatch(/no workspace/);
    expect(existsSync(box.configHome)).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("reports an absent database without creating it or its parent directories", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const configPath = join(box.cwd, ".uberblick.json");
    const config = readFileSync(configPath, "utf8");
    const databasePath = join(box.cwd, "absent", "nested", "mirror.sqlite");
    const { check } = await persistence(box, { UBERBLICK_DB: databasePath });

    expect(check.status).not.toBe("pass");
    expect(check.reason).toContain(databasePath);
    expect(check.reason).toMatch(/does not exist/);
    expect(existsSync(join(box.cwd, "absent"))).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(existsSync(box.configHome)).toBe(false);
  });

  it("reports a directory in place of a database without creating store files", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "directory.sqlite");
    mkdirSync(databasePath);
    const { check } = await persistence(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain(databasePath);
    expect(check.reason).toMatch(/not a database file/);
    expect(readdirSync(databasePath)).toEqual([]);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it("reports a corrupt existing store as a failed reading", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "corrupt.sqlite");
    const contents = "this is not a SQLite database";
    writeFileSync(databasePath, contents);
    const { check, status } = await persistence(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain(databasePath);
    expect(check.reason).toMatch(/not a database/);
    expect(check.remedy).toMatch(/valid database/);
    expect(status).toBe(1);
    expect(readFileSync(databasePath, "utf8")).toBe(contents);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("reports an existing store it cannot open", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "unreadable.sqlite");
    await emptyStore(box, databasePath);
    chmodSync(databasePath, 0o000);
    try {
      const { check } = await persistence(box, { UBERBLICK_DB: databasePath });
      expect(check.status).toBe("fail");
      expect(check.reason).toContain(databasePath);
      expect(check.reason).toMatch(/could not take the live reading/);
      expect(check.remedy).toMatch(/restore access/);
      expect(existsSync(box.dataHome)).toBe(false);
    } finally {
      chmodSync(databasePath, 0o600);
    }
  });

  it("passes a completed local-only reading of an existing healthy store", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "healthy.sqlite");
    await emptyStore(box, databasePath);
    const { check, report } = await persistence(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("pass");
    expect(check.remedy).toBeNull();
    expect(report.checks.find((one) => one.name === "hub")?.status).toBe("skipped");
  });

  it("explains the refused append found by status, and never repairs it", async () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      credentials: { signingSecret: SECRET },
    });
    const databasePath = join(box.cwd, "refusing.sqlite");
    await emptyStore(box, databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TRIGGER refuse_updates BEFORE INSERT ON updates " +
      `BEGIN SELECT RAISE(ABORT, '${REFUSED}'); END`,
    );
    database.close();
    const hub = await seededHub(box);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const env = { UBERBLICK_DB: databasePath, UB_TEST_MAX_WAIT_MS: "2000" };

    const status = await runUbAsync(["status", "--json"], box, env);
    const snapshot = JSON.parse(status.stdout) as StatusReport;
    expect(status.status).toBe(0);
    expect(snapshot.persistence?.room).toBe(directoryRoom(WORKSPACE));
    expect(snapshot.persistence?.message).toContain(REFUSED);
    expect(snapshot.hub.status).toBe("quarantined");

    const human = await runUbAsync(["status"], box, env);
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(/1 detected failure.*ub doctor/);
    expect(human.stdout).not.toContain(directoryRoom(WORKSPACE));
    expect(human.stdout).not.toContain(REFUSED);

    const { check, status: exit } = await persistence(box, env);
    expect(check.status).toBe("fail");
    expect(check.reason).toContain(snapshot.persistence?.room);
    expect(check.reason).toContain(REFUSED);
    expect(check.remedy).toMatch(/restart.*MCP server/i);
    expect(check.remedy).toMatch(/re-read/);
    expect(check.remedy).toMatch(/never.*durable/);
    expect(check.remedy).not.toContain("ub status");
    expect(exit).toBe(1);

    // All three diagnostics leave the refused append refused. Only this
    // fixture's explicit repair permits a later fresh reading to pass.
    const repair = new DatabaseSync(databasePath);
    expect(repair.prepare("SELECT COUNT(*) AS count FROM updates").get()?.count).toBe(0);
    expect(repair.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").get()?.name)
      .toBe("refuse_updates");
    repair.exec("DROP TRIGGER refuse_updates");
    repair.close();
    const recovered = await persistence(box, env);
    expect(recovered.check.status).toBe("pass");
  });
});
