import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), `orc-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  directories.push(path);
  return path;
}

function fixture() {
  const live = join(directory(), "hub.sqlite");
  const backup = join(directory(), "backup.sqlite");
  for (const [path, content] of [[live, "live"], [backup, "backup"]] as const) {
    const database = new DatabaseSync(path);
    try {
      database.exec(`CREATE TABLE documents (name TEXT, data BLOB);
        CREATE TABLE hub_principals (id TEXT, github_username TEXT, github_account_id TEXT);
        CREATE TABLE hub_memberships (principal_id TEXT, workspace_id TEXT, role TEXT);
        INSERT INTO hub_principals VALUES ('principal', 'alice', '1234')`);
      database.prepare("INSERT INTO documents VALUES (?, ?)").run(content, new Uint8Array([1]));
      if (path === backup) database.exec("INSERT INTO hub_memberships VALUES ('principal', 'workspace', 'member')");
    } finally { database.close(); }
  }
  return { live, backup };
}

async function command(databasePath: string, args: string[], input?: Buffer) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
    fileURLToPath(new URL("../src/operator-command.ts", import.meta.url)), ...args], {
    cwd: dirname(databasePath), timeout: 5000, killSignal: "SIGKILL",
    env: { ...process.env, HUB_DB_PATH: databasePath }, stdio: ["pipe", "pipe", "pipe"],
  });
  processes.push(child);
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(input);
  const code = await closed;
  return { code, output, errors };
}

it("advertises the restore confirmation flag in command help", async () => {
  const result = await command(join(directory(), "hub.sqlite"), ["--help"]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("restore [--yes] <file|->");
});

it.each([
  { args: ["restore", "--yes"] },
  { args: ["restore", "--yes", "--yes"] },
  { args: ["restore", "--wat", "backup.sqlite"] },
  { args: ["restore", "--yes", "backup.sqlite", "extra"] },
  { args: ["restore", "backup.sqlite", "--yes"] },
])("rejects malformed restore arguments $args with usage exit 2", async ({ args }) => {
  const result = await command(join(directory(), "hub.sqlite"), args);
  expect(result.code).toBe(2);
  expect(result.errors).toContain("usage: ub-hub");
});

it.each(["file", "stdin"])("refuses a %s restore without a terminal or --yes and preserves the live database", async source => {
  const { live, backup } = fixture();
  const original = readFileSync(live);
  const result = await command(live, ["restore", source === "stdin" ? "-" : backup],
    source === "stdin" ? readFileSync(backup) : undefined);
  expect(result.code).toBe(1);
  expect(result.output).toContain("workspace member removal:");
  expect(result.output).toContain('"alice" (GitHub account 1234), workspace workspace');
  expect(result.errors).toContain("rerun ub-hub restore --yes <file|->");
  expect(result.errors).toContain("the live database was unchanged");
  expect(readFileSync(live)).toEqual(original);
  expect(readdirSync(dirname(live))).toEqual(["hub.sqlite"]);
});

it.each(["file", "stdin"])("restores a %s backup with --yes without a terminal", async source => {
  const { live, backup } = fixture();
  const candidate = readFileSync(backup);
  const result = await command(live, ["restore", "--yes", source === "stdin" ? "-" : backup],
    source === "stdin" ? candidate : undefined);
  expect(result.code).toBe(0);
  expect(result.output).toContain("This restore would undo:");
  expect(result.output).toContain("Each account revokes its own lost devices again");
  expect(result.output).toContain(`restored   ${live}`);
  expect(readFileSync(live)).toEqual(candidate);
  expect(readdirSync(dirname(live))).toEqual(["hub.sqlite"]);
});
