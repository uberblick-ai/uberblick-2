import { CLOCK_SKEW_SECONDS } from "@uberblick/schema/token";
import { createHash, randomBytes } from "node:crypto";
import { statfsSync, statSync } from "node:fs";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkDatabaseIntegrity, hasRollbackJournal } from "./operator-database.js";
import { SHARED_GITHUB_CLIENT_ID } from "./team-config.js";

export interface OperatorLiveStatus {
  databasePath: string;
  size: number;
  port: number;
  host?: string;
  integrity: string[];
  storeFailure: string | null;
  githubClientId: string | null;
}

interface Check {
  name: "hub" | "database" | "storage" | "github" | "clock";
  status: "ok" | "warn" | "FAIL" | "skip";
  reason: string;
  fix?: string;
}

export interface OperatorDoctorOptions {
  databasePath: string;
  live?: OperatorLiveStatus;
  githubClientId?: string | null;
  writeLine: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  freeBytes?: (path: string) => number;
  hubUid?: number;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]/g, " ");
}

function failure(name: Check["name"], reason: string, fix: string): Check {
  return { name, status: "FAIL", reason, fix };
}

function loopback(host: string | undefined): string {
  if (host === "::") return "::1";
  if (host === undefined || host === "0.0.0.0") return "127.0.0.1";
  return host;
}

/** An upgrade verifies the listener without authenticating or opening a document. */
function websocketUpgrade(host: string, port: number): Promise<void> {
  return new Promise((resolveUpgrade, reject) => {
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const probe = request({
      host, port, path: "/", method: "GET", headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
      },
    });
    probe.setTimeout(5_000, () => probe.destroy(new Error("WebSocket upgrade timed out")));
    probe.once("error", reject);
    probe.once("response", (response) => {
      response.resume();
      reject(new Error(`WebSocket upgrade returned HTTP ${response.statusCode}`));
      probe.destroy();
    });
    probe.once("upgrade", (response, socket) => {
      socket.destroy();
      if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== expected) {
        reject(new Error("listener returned an invalid WebSocket upgrade"));
      } else {
        resolveUpgrade();
      }
    });
    probe.end();
  });
}

async function hubCheck(options: OperatorDoctorOptions): Promise<Check> {
  const live = options.live;
  if (live === undefined) return failure("hub", "no running hub answers on the private control socket", "run docker compose up -d hub, then inspect docker compose logs hub if it keeps restarting");
  if (resolve(live.databasePath) !== resolve(options.databasePath)) {
    return failure("hub", `the running hub serves ${live.databasePath}, not ${options.databasePath}`, "point HUB_DB_PATH at the database this deployment serves");
  }
  const host = loopback(live.host);
  const address = host.includes(":") ? `[${host}]` : host;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`http://${address}:${live.port}/auth/claim-state`, { signal: AbortSignal.timeout(5_000) });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`HTTP check returned ${response.status}`);
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("unclaimed" in body) || typeof body.unclaimed !== "boolean" || !("canClaim" in body) || typeof body.canClaim !== "boolean") {
      throw new Error("HTTP listener did not return hub claim state");
    }
    await websocketUpgrade(host, live.port);
    return { name: "hub", status: "ok", reason: `${live.databasePath}; HTTP and WebSocket upgrades answer on port ${live.port}` };
  } catch (error) {
    return failure("hub", message(error), "inspect docker compose logs hub and the hub's PORT and HUB_HOST settings");
  }
}

function integrityResults(databasePath: string, live: OperatorLiveStatus | undefined): string[] {
  if (live !== undefined) return live.integrity;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    checkDatabaseIntegrity(database);
    return ["ok"];
  } finally {
    database.close();
  }
}

function databaseCheck(options: OperatorDoctorOptions): Check {
  const path = options.databasePath;
  const repair = "restore a verified backup with ub-hub restore; repair file ownership and set its mode to 0600 if needed";
  try {
    const file = statSync(path);
    if (!file.isFile()) return failure("database", `${path} is not a database file`, repair);
    if (options.live === undefined && hasRollbackJournal(path)) {
      return failure("database", `a SQLite journal or sidecar sits beside ${path}; no recovery or writes were attempted`, "start the hub to let SQLite recover the journal, stop it cleanly, then run ub-hub doctor again");
    }
    const problems: string[] = [];
    const uid = options.hubUid ?? process.getuid?.();
    if (uid !== undefined && file.uid !== uid) problems.push(`owned by uid ${file.uid}, expected hub uid ${uid}`);
    const mode = file.mode & 0o777;
    if (mode !== 0o600) problems.push(`mode ${mode.toString(8).padStart(4, "0")}, expected 0600`);
    const integrity = integrityResults(path, options.live);
    if (integrity.length !== 1 || integrity[0] !== "ok") problems.push(`integrity_check: ${integrity.join("; ") || "no result"}`);
    if (problems.length > 0) return failure("database", `${path}: ${problems.join("; ")}`, repair);
    return { name: "database", status: "ok", reason: `${path}; integrity_check ok, hub ownership and mode 0600` };
  } catch (error) {
    return failure("database", `${path}: ${message(error)}`, repair);
  }
}

function availableBytes(path: string): number {
  const filesystem = statfsSync(path);
  return filesystem.bavail * filesystem.bsize;
}

function storageCheck(options: OperatorDoctorOptions): Check {
  if (options.live?.storeFailure !== null && options.live?.storeFailure !== undefined) {
    return failure("storage", `a document store failed since the hub started: ${message(options.live.storeFailure)}`, "repair the storage failure shown in docker compose logs hub, then restart the hub; do not rely on a backup from this run");
  }
  try {
    const free = (options.freeBytes ?? availableBytes)(dirname(options.databasePath));
    const size = options.live?.size ?? statSync(options.databasePath).size;
    if (free < size) {
      return { name: "storage", status: "warn", reason: `${free} bytes free; database uses ${size} bytes`, fix: "free space in the hub-data volume before taking a backup" };
    }
    return {
      name: "storage", status: "ok",
      reason: `${free} bytes free; ${options.live === undefined ? "no running hub, so store history is unavailable" : "no document store has failed since the hub started"}`,
    };
  } catch (error) {
    return failure("storage", message(error), "restore access to the hub-data volume and inspect docker compose logs hub");
  }
}

async function githubChecks(options: OperatorDoctorOptions): Promise<[Check, Check]> {
  const clientId = options.live === undefined ? options.githubClientId : options.live.githubClientId;
  const app = clientId === SHARED_GITHUB_CLIENT_ID ? `Uberblick Login (${clientId})` : `GitHub App ${clientId ?? "not configured"}`;
  if (clientId === null || clientId === undefined) {
    return [failure("github", "no GitHub sign-in app is configured", "configure the hub's GitHub App client ID before claiming or signing in"), { name: "clock", status: "skip", reason: "no GitHub response to compare" }];
  }
  try {
    const now = options.now ?? Date.now;
    const started = now();
    // The device verification page needs no pending authorization or credentials.
    const response = await (options.fetch ?? globalThis.fetch)("https://github.com/login/device", { signal: AbortSignal.timeout(5_000) });
    const finished = now();
    await response.body?.cancel();
    if (!response.ok) throw new Error(`GitHub device sign-in returned HTTP ${response.status}`);
    const github: Check = { name: "github", status: "ok", reason: `GitHub device sign-in is reachable; ${app}` };
    const date = response.headers.get("date");
    const timestamp = date === null ? Number.NaN : Date.parse(date);
    if (!Number.isFinite(timestamp)) return [github, { name: "clock", status: "skip", reason: "GitHub supplied no usable Date header" }];
    const skew = Math.abs((started + finished) / 2 - timestamp) / 1_000;
    const measured = `${Math.round(skew)}s from GitHub's clock (limit ${CLOCK_SKEW_SECONDS}s)`;
    return [github, skew <= CLOCK_SKEW_SECONDS
      ? { name: "clock", status: "ok", reason: measured }
      : failure("clock", measured, "enable automatic time synchronization on the hub host")];
  } catch (error) {
    return [failure("github", `${app}: ${message(error)}`, "check the hub's outbound HTTPS and DNS access to github.com"), { name: "clock", status: "skip", reason: "no GitHub response to compare" }];
  }
}

/** Read-only diagnostics continue through failed checks and never repair state. */
export async function runOperatorDoctor(options: OperatorDoctorOptions): Promise<0 | 1> {
  const checks = [await hubCheck(options), databaseCheck(options), storageCheck(options), ...await githubChecks(options)];
  for (const check of checks) {
    options.writeLine(`${check.status.padEnd(6)}${check.name.padEnd(12)}${message(check.reason)}`);
    if (check.fix !== undefined) options.writeLine(`      → ${message(check.fix)}`);
  }
  return checks.some((check) => check.status === "FAIL") ? 1 : 0;
}
