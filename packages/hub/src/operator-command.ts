import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAdminSetup } from "./admin-setup-command.js";
import { requestOperator } from "./operator-client.js";
import { restoreDatabase } from "./operator-database.js";
import { runOperatorDoctor, type OperatorLiveStatus } from "./operator-doctor.js";
import { requiredHubDatabasePath, SHARED_GITHUB_CLIENT_ID } from "./team-config.js";

const USAGE = `usage: ub-hub <command>

commands:
  status                              Release, database and claim status
  doctor                              Diagnose this hub without changing it
  admin-setup <workspace-uuid>         Set up the first workspace admin
  admin-setup status <setup-uuid>       Look up a setup result
  hub-admin add <github-login>         Appoint an account that has signed in
  hub-admin add --account-id <id>      Appoint by durable GitHub account ID
  backup                              Verify and save an online database copy
  restore <file|->                     Restore a database while the hub is stopped
`;

function releaseIdentity(path: string): void {
  const release = JSON.parse(readFileSync(path, "utf8"));
  if (typeof release.version !== "string" || typeof release.sourceCommit !== "string" ||
      !Number.isInteger(release.syncProtocolVersion)) throw new Error("invalid image release identity");
  console.log(`release    ${release.version}\ncommit     ${release.sourceCommit}\nprotocol   ${release.syncProtocolVersion}`);
}

async function liveInfo(databasePath: string, doctor = false): Promise<Record<string, unknown>> {
  const result = await requestOperator(databasePath, doctor ? "hub-doctor" : "hub-status");
  if (result.status !== "ok") throw new Error(String(result.error ?? "hub inspection failed"));
  if (!validLiveInfo(result.info, doctor)) {
    throw new Error(String(result.error ?? "invalid hub response"));
  }
  return result.info as Record<string, unknown>;
}

function validLiveInfo(value: unknown, doctor: boolean): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const info = value as Record<string, unknown>;
  const base = typeof info.databasePath === "string" && info.databasePath.length > 0 &&
    typeof info.size === "number" && Number.isSafeInteger(info.size) && info.size >= 0 &&
    typeof info.port === "number" && Number.isInteger(info.port) && info.port > 0 && info.port <= 65535 &&
    (info.host === undefined || typeof info.host === "string") &&
    (info.storeFailure === null || typeof info.storeFailure === "string") &&
    (info.githubClientId === null || typeof info.githubClientId === "string");
  return base && (doctor
    ? Array.isArray(info.integrity) && info.integrity.length > 0 && info.integrity.every(item => typeof item === "string")
    : typeof info.claimed === "boolean" && typeof info.documentCount === "number" &&
      Number.isSafeInteger(info.documentCount) && info.documentCount >= 0);
}

function controlAbsent(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ECONNREFUSED";
}

async function runWithSignals(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, cancel);
  try { await work(abort.signal); }
  finally { for (const signal of signals) process.off(signal, cancel); }
}

async function addHubAdmin(databasePath: string, target: { account: string } | { accountId: string }): Promise<void> {
  let result: Record<string, unknown>;
  try { result = await requestOperator(databasePath, { action: "hub-admin-add", ...target }); }
  catch (error) { throw new Error(`${String(error)}; appointment result unknown; retry the same account to check`); }
  if (result.status === "account-not-found") throw new Error("hub has never recorded this account");
  if (result.status === "sign-in-required") throw new Error("account has no recorded sign-in; sign in to this hub and retry");
  if (result.status === "ambiguous-account") throw new Error("login matches more than one recorded account; use --account-id <GitHub account ID>");
  const identity = result.identity as Record<string, unknown> | undefined;
  if ((result.status !== "complete" && result.status !== "already-admin") || identity === null ||
      typeof identity !== "object" || typeof identity.githubUsername !== "string" || typeof identity.githubAccountId !== "string") {
    throw new Error(String(result.error ?? "appointment result unknown; retry the same account to check"));
  }
  console.log(`${result.status === "already-admin" ? "already hub admin" : "appointed hub admin"}  ${identity.githubUsername} (GitHub account ${identity.githubAccountId})`);
}

async function runHubAdminCommand(args: string[]): Promise<void> {
  let target: { account: string } | { accountId: string } | undefined;
  if (args.length === 3 && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(args[2] ?? "")) {
    target = { account: args[2] ?? "" };
  } else if (args.length === 4 && args[2] === "--account-id" && /^[1-9][0-9]{0,99}$/.test(args[3] ?? "")) {
    target = { accountId: args[3] ?? "" };
  }
  if (args[1] !== "add" || target === undefined) { console.error(USAGE); process.exitCode = 2; return; }
  await addHubAdmin(requiredHubDatabasePath(), target);
}

export async function runOperatorCommand(args: string[], releasePath = "/release/release.json"): Promise<void> {
  const command = args[0];
  if (args.length === 0 || (args.length === 1 && (command === "--help" || command === "-h"))) {
    console.log(USAGE);
    return;
  }
  if (command === "admin-setup") {
    try { await runAdminSetup(args.slice(1)); }
    catch {
      console.error("setup result unknown; check the hub host. This does not establish that nothing changed.");
      process.exitCode = 1;
    }
    return;
  }
  if (command === "hub-admin") { await runHubAdminCommand(args); return; }
  const valid = args.length === 1 && ["status", "doctor", "backup"].includes(command ?? "") ||
    command === "restore" && args.length === 2 && args[1] !== "" && !args[1]?.startsWith("--");
  if (!valid) { console.error(USAGE); process.exitCode = 2; return; }
  if (command === "status") releaseIdentity(releasePath);
  const databasePath = requiredHubDatabasePath();
  if (command === "status") {
    try {
      const info = await liveInfo(databasePath);
      console.log(`hub        running\ndatabase   ${info.databasePath}\nsize       ${info.size} bytes\ndocuments  ${info.documentCount}\nclaimed    ${info.claimed ? "yes" : "no"}`);
    } catch (error) {
      console.log(controlAbsent(error) ? "hub        not running" : "hub        inspection failed");
      console.error(String(error));
      process.exitCode = 1;
    }
  } else if (command === "doctor") {
    let live: OperatorLiveStatus | undefined;
    let controlError: string | undefined;
    try { live = await liveInfo(databasePath, true) as unknown as OperatorLiveStatus; }
    catch (error) { if (!controlAbsent(error)) controlError = String(error); }
    process.exitCode = await runOperatorDoctor({ databasePath, ...(live === undefined ? {} : { live }),
      ...(controlError === undefined ? {} : { controlError }),
      githubClientId: process.env.HUB_GITHUB_CLIENT_ID || SHARED_GITHUB_CLIENT_ID, writeLine: console.log });
  } else if (command === "backup") {
    await runWithSignals(async signal => {
      let result: Record<string, unknown>;
      try { result = await requestOperator(databasePath, "backup", signal); }
      catch (error) {
        throw new Error(`${String(error)}; backup result unknown; check hub-data for a completed verified copy`);
      }
      if (result.status !== "complete" || typeof result.path !== "string") {
        throw new Error(String(result.error ?? "backup failed; no backup was published"));
      }
      console.log(`backup     ${result.path}\ncopy       docker compose cp hub:${result.path} ./hub-backup.sqlite`);
    });
  } else if (command === "restore") {
    const input = args[1] ?? "";
    await runWithSignals(signal => restoreDatabase(databasePath, input === "-" ? process.stdin : input, { signal }));
    console.log(`restored   ${databasePath}`);
  }
}

// Node resolves the main module through symlinks, including macOS's temporary directory.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runOperatorCommand(process.argv.slice(2)).catch(error => {
    console.error(`ub-hub: ${String(error)}`);
    process.exitCode = 1;
  });
}
