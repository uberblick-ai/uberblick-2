#!/usr/bin/env node
// Exercise the committed hub image on disposable Compose volumes without publishing ports.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = process.env.UB_AGENTS_SCRATCH ?? tmpdir();
const sha = process.argv[2];
assert(process.argv.length === 3 && /^[0-9a-f]{40}$/.test(sha ?? ""),
  "usage: node scripts/hub-operator-proof.mjs <full-source-sha>");
const scratch = mkdtempSync(join(scratchRoot, `hub-image-proof-${process.env.UB_AGENTS_RUN ?? "local"}-`));
const log = join(scratch, "proof.log");
const run = (process.env.UB_AGENTS_RUN ?? "local").toLowerCase().replaceAll(/[^a-z0-9]/g, "");
const project = `hub-operator-proof-${run}-${randomUUID().slice(0, 8)}`;
const tag = `uberblick-hub-operator-proof:${sha}-${project.slice(-8)}`;
const emptyVolume = `${project}-empty`;
const deployment = join(scratch, "deployment");
mkdirSync(deployment);
const containers = new Set();
let active;
let interrupted;
let cleaning = false;
const kill = () => { if (active?.pid) { try { process.kill(-active.pid, "SIGTERM"); } catch {} } };
const cancel = signal => { if (!cleaning) { interrupted = signal; kill(); } };
process.on("SIGINT", () => cancel("SIGINT"));
process.on("SIGTERM", () => cancel("SIGTERM"));
const deadline = setTimeout(() => cancel("ten-minute proof deadline"), 600_000);

async function command(program, args, options = {}) {
  if (interrupted && !options.cleanup) throw new Error(interrupted);
  return new Promise((accept, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? root, env: { ...process.env, COMPOSE_PROJECT_NAME: project },
      detached: true, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    active = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let terminate;
    child.stdout.setEncoding("utf8").on("data", data => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
    if (options.input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(options.input); }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      terminate = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2_000);
    }, options.timeout ?? 45_000);
    child.once("error", error => { clearTimeout(timer); clearTimeout(terminate); active = undefined; reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(terminate); active = undefined;
      appendFileSync(log, `${program} ${args.join(" ")}\nexit=${code} signal=${signal}\n${stdout}${stderr}\n`);
      if (timedOut || (code !== 0 && !options.allowFailure)) reject(new Error(`${program} failed (${timedOut ? "deadline" : signal ?? code}): ${stdout}${stderr}`));
      else accept({ code, signal, stdout, stderr });
    });
  });
}

const docker = (args, options) => command("docker", args, options);
const compose = (args, options = {}) => docker(["compose", "--project-name", project, "--file", "docker-compose.yml", ...args], { cwd: deployment, ...options });
const exec = (args, options) => compose(["exec", "-T", "hub", ...args], options);
const offline = (args, options = {}) => {
  const name = `${project}-operator`;
  containers.add(name);
  return compose(["run", "--rm", "--no-deps", "-T", "--name", name, "hub", ...args], options);
};
const live = (source, options) => exec(["node", "-e", source], options);
const stopped = (source, options) => offline(["node", "-e", source], options);
const textState = async () => JSON.parse((await live('const fs=require("node:fs"); const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/data/hub.sqlite",{readOnly:true}); console.log(JSON.stringify({documents:db.prepare("SELECT name,hex(data) AS data FROM documents ORDER BY name").all(), files:fs.readdirSync("/data").sort()}));db.close();')).stdout);
const fileHash = async () => (await offline(["node", "-e", 'const fs=require("node:fs"),crypto=require("node:crypto"); console.log(crypto.createHash("sha256").update(fs.readFileSync("/data/hub.sqlite")).digest("hex"));'])).stdout.trim();
const volumeState = async () => JSON.parse((await stopped('const fs=require("node:fs"),crypto=require("node:crypto");console.log(JSON.stringify(fs.readdirSync("/data").sort().map(name=>{const path="/data/"+name,stat=fs.lstatSync(path);return {name,mode:stat.mode,uid:stat.uid,hash:stat.isFile()?crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex"):null};})));')).stdout);
const databaseState = async (path = "/data/hub.sqlite", runNode = stopped) => JSON.parse((await runNode(`const fs=require("node:fs"),{DatabaseSync}=require("node:sqlite");const path=${JSON.stringify(path)},stat=fs.statSync(path),db=new DatabaseSync(path,{readOnly:true});try{const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();const tables=schema.filter(row=>row.type==="table").map(row=>({name:row.name,rows:db.prepare('SELECT * FROM "'+row.name.replaceAll('"','""')+'"').all().map(value=>JSON.stringify(value,(_key,item)=>item instanceof Uint8Array?{hex:Buffer.from(item).toString("hex")}:item)).sort()}));console.log(JSON.stringify({mode:stat.mode&0o777,uid:stat.uid,integrity:db.prepare("PRAGMA integrity_check").all(),schema,tables,release:schema.some(row=>row.name==="hub_release")?db.prepare("SELECT version FROM hub_release").get().version:null}));}finally{db.close();}`)).stdout);
const startupBackupEvents = async () => {
  const result = await compose(["logs", "--no-color", "--no-log-prefix", "hub"]);
  return `${result.stdout}\n${result.stderr}`.split("\n").flatMap(line => {
    try { const record = JSON.parse(line); return record.event === "hub.database.backup" ? [record] : []; } catch { return []; }
  });
};
const backupFiles = state => state.files.filter(name => name.startsWith("hub-") && name.endsWith(".sqlite"));
const assertDoctor = result => {
  const lines = result.stdout.split("\n").filter(line => /^(ok|warn|FAIL|skip)\s/.test(line));
  assert.equal(lines.length, 5, result.stdout + result.stderr);
  assert.deepEqual(lines.map(line => line.trim().split(/\s+/)[1]), ["hub", "database", "storage", "github", "clock"]);
  assert.equal(result.code, lines.some(line => line.startsWith("FAIL")) ? 1 : 0);
};
async function serving() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await exec(["ub-hub", "status"], { allowFailure: true });
    if (status.code === 0) return status;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("hub did not answer status");
}

try {
  const resolved = (await command("git", ["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`])).stdout.trim();
  assert.equal(resolved, sha, "the supplied commit exists unchanged");
  const context = join(scratch, "source");
  mkdirSync(context);
  const archive = join(scratch, "source.tar");
  await command("git", ["archive", "--format=tar", "--output", archive, sha]);
  await command("tar", ["-xf", archive, "-C", context]);
  const protocol = readFileSync(join(context, "packages/schema/src/protocol.ts"), "utf8")
    .match(/export const SYNC_PROTOCOL_VERSION = ([1-9]\d*);/)?.[1];
  assert.ok(protocol, "the commit declares its sync protocol");
  console.log(`Building actual hub image at commit ${sha}`);
  await docker(["build", "--file", join(context, "Dockerfile.hub-release"),
    "--build-arg", "HUB_RELEASE_VERSION=0.0.1", "--build-arg", `HUB_RELEASE_COMMIT=${sha}`,
    "--build-arg", `HUB_SYNC_PROTOCOL_VERSION=${protocol}`, "--build-arg", "HUB_RELEASE_HUB_IMAGE=ghcr.io/uberblick-ai/hub:0.0.1",
    "--build-arg", "HUB_RELEASE_WEB_IMAGE=ghcr.io/uberblick-ai/hub-web:0.0.1", "--target", "hub", "--tag", tag, context], { timeout: 360_000 });
  const imageId = (await docker(["image", "inspect", tag, "--format", "{{.Id}}"])).stdout.trim();
  console.log(`Built ${imageId}; extracting the image's release and testing PATH.`);
  const extract = `${project}-extract`;
  containers.add(extract);
  await docker(["create", "--name", extract, "--entrypoint", "/bin/true", tag]);
  await docker(["cp", `${extract}:/release/.`, deployment]);
  await docker(["rm", extract]);
  const release = JSON.parse(readFileSync(join(deployment, "release.json"), "utf8"));
  assert.equal(release.sourceCommit, sha);
  assert.equal(release.version, "0.0.1");
  assert.deepEqual(readdirSync(join(deployment, "bin")), ["remote-compose.sh"]);
  writeFileSync(join(deployment, "docker-compose.yml"), `services:\n  hub:\n    image: ${tag}\n    volumes:\n      - hub-data:/data\nvolumes:\n  hub-data:\n`);
  const files = JSON.parse((await docker(["run", "--rm", "--entrypoint", "node", tag, "-e",
    'const fs=require("node:fs"); console.log(JSON.stringify({user:process.getuid(), executable:fs.statSync("/usr/local/bin/ub-hub").mode&0o111, legacyBundle:fs.existsSync("/app/hub-admin-setup.mjs")}));'])).stdout);
  assert.equal(files.user, 1000); assert.ok(files.executable); assert.equal(files.legacyBundle, false);
  for (const args of [[], ["--help"]]) {
    const result = await offline(["ub-hub", ...args]);
    for (const name of ["status", "doctor", "admin-setup", "backup", "restore"]) assert.match(result.stdout, new RegExp(name));
  }
  for (const args of [["unknown"], ["backup", "extra"], ["restore"]]) {
    const result = await offline(["ub-hub", ...args], { allowFailure: true });
    assert.equal(result.code, 2); assert.match(result.stderr, /usage: ub-hub/);
  }
  await compose(["up", "--detach", "hub"]);
  const status = await serving();
  assert.match(status.stdout, /release\s+0\.0\.1/); assert.ok(status.stdout.includes(sha), status.stdout);
  assert.match(status.stdout, new RegExp(`protocol\\s+${protocol}`)); assert.match(status.stdout, /database\s+\/data\/hub\.sqlite/);
  assert.match(status.stdout, /documents\s+1/); assert.match(status.stdout, /claimed\s+no/);
  const doctor = await exec(["ub-hub", "doctor"], { allowFailure: true });
  assertDoctor(doctor); assert.match(doctor.stdout, /^ok\s+hub\s/m); assert.match(doctor.stdout, /^ok\s+database\s/m);
  console.log(`Live status and doctor's five checks: ${doctor.code === 0 ? "passed" : "diagnostic failures recorded in proof log"}.`);
  const receipt = await exec(["ub-hub", "admin-setup", "status", "00000000-0000-4000-8000-000000001174"], { allowFailure: true });
  assert.equal(receipt.code, 1); assert.match(receipt.stdout + receipt.stderr, /unknown/);
  const initial = await textState();
  assert.deepEqual(backupFiles(initial), [], "a fresh database needs no startup backup");
  assert.deepEqual(await startupBackupEvents(), []);
  assert.equal((await databaseState("/data/hub.sqlite", live)).release, "0.0.1");
  const started = (await compose(["ps", "--quiet", "hub"])).stdout.trim();
  const backup = await exec(["ub-hub", "backup"]);
  const path = backup.stdout.match(/backup\s+(\/data\/[^\s]+\.sqlite)/)?.[1];
  assert.ok(path, backup.stdout); assert.match(backup.stdout, /docker compose cp hub:/);
  const check = JSON.parse((await live(`const fs=require("node:fs"),{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(path)},{readOnly:true});console.log(JSON.stringify({mode:fs.statSync(${JSON.stringify(path)}).mode&0o777,uid:fs.statSync(${JSON.stringify(path)}).uid,integrity:db.prepare("PRAGMA integrity_check").get().integrity_check,documents:db.prepare("SELECT name,hex(data) AS data FROM documents ORDER BY name").all()}));db.close();`)).stdout);
  assert.equal(check.mode, 0o600); assert.equal(check.uid, 1000); assert.equal(check.integrity, "ok"); assert.deepEqual(check.documents, initial.documents);
  assert.equal((await compose(["ps", "--quiet", "hub"])).stdout.trim(), started); await serving();
  const beforeReadonly = await textState();
  const mode = Number((await live('const fs=require("node:fs");console.log(fs.statSync("/data").mode&0o777);fs.chmodSync("/data",0o500);')).stdout);
  try {
    const refusal = await exec(["ub-hub", "backup"], { allowFailure: true });
    assert.equal(refusal.code, 1); assert.match(refusal.stderr, /EACCES|permission denied/);
    assert.deepEqual(await textState(), beforeReadonly); await serving();
  } finally { await live(`require("node:fs").chmodSync("/data",${mode});`); }
  console.log("Online backup verified at 0600; write-denied backup published nothing and the hub kept serving.");
  // Operators may still hold a stop-and-copy file from the shell backup earlier releases shipped.
  await compose(["stop", "hub"]);
  await compose(["cp", "hub:/data/hub.sqlite", "legacy.sqlite"]);
  await compose(["start", "hub"]);
  const legacy = readFileSync(join(deployment, "legacy.sqlite"));
  await serving();
  const liveRestore = await offline(["ub-hub", "restore", "-"], { input: legacy, allowFailure: true });
  assert.equal(liveRestore.code, 1); assert.match(liveRestore.stderr, /docker compose stop hub/); assert.match(liveRestore.stderr, /live database was unchanged/);
  assert.deepEqual((await textState()).documents, initial.documents);
  await compose(["stop", "hub"]);
  const stoppedStatus = await offline(["ub-hub", "status"], { allowFailure: true });
  assert.equal(stoppedStatus.code, 1); assert.ok(stoppedStatus.stdout.includes(sha), stoppedStatus.stdout); assert.match(stoppedStatus.stdout, /hub\s+not running/);
  const stoppedDoctor = await offline(["ub-hub", "doctor"], { allowFailure: true }); assertDoctor(stoppedDoctor);
  assert.match(stoppedDoctor.stdout, /^FAIL\s+hub\s/m); assert.match(stoppedDoctor.stdout, /^ok\s+database\s/m);
  const unchanged = await fileHash();
  const corrupt = await offline(["ub-hub", "restore", "-"], { input: Buffer.from("corrupt sqlite candidate"), allowFailure: true });
  assert.equal(corrupt.code, 1); assert.match(corrupt.stderr, /live database was unchanged/); assert.equal(await fileHash(), unchanged);
  await offline(["node", "-e", 'require("node:fs").writeFileSync("/data/hub.sqlite-journal","synthetic journal");']);
  const journal = await offline(["ub-hub", "restore", "-"], { input: legacy, allowFailure: true });
  assert.equal(journal.code, 1); assert.match(journal.stderr, /rollback journal/); assert.match(journal.stderr, /docker compose start hub/); assert.equal(await fileHash(), unchanged);
  await offline(["node", "-e", 'const fs=require("node:fs");if(fs.readFileSync("/data/hub.sqlite-journal","utf8")!=="synthetic journal")throw Error("unexpected journal");fs.unlinkSync("/data/hub.sqlite-journal");']);
  await offline(["ub-hub", "restore", "-"], { input: legacy });
  assert.equal(await fileHash(), createHash("sha256").update(legacy).digest("hex"));
  const pathRestore = await offline(["ub-hub", "restore", path]); assert.match(pathRestore.stdout, /restored/);
  await compose(["start", "hub"]); await serving(); assert.deepEqual((await textState()).documents, initial.documents);
  await docker(["volume", "create", emptyVolume]);
  const emptyName = `${project}-empty-restore`; containers.add(emptyName);
  await docker(["run", "--rm", "--interactive", "--name", emptyName, "--mount", `type=volume,src=${emptyVolume},dst=/data`, tag, "ub-hub", "restore", "-"], { input: legacy });
  const restored = JSON.parse((await docker(["run", "--rm", "--mount", `type=volume,src=${emptyVolume},dst=/data`, tag, "node", "-e",
    'const fs=require("node:fs"),crypto=require("node:crypto"),{DatabaseSync}=require("node:sqlite");const file=fs.statSync("/data/hub.sqlite");const db=new DatabaseSync("/data/hub.sqlite",{readOnly:true});console.log(JSON.stringify({mode:file.mode&0o777,uid:file.uid,integrity:db.prepare("PRAGMA integrity_check").get().integrity_check,hash:crypto.createHash("sha256").update(fs.readFileSync("/data/hub.sqlite")).digest("hex")}));db.close();'])).stdout);
  assert.equal(restored.mode, 0o600); assert.equal(restored.uid, 1000); assert.equal(restored.integrity, "ok"); assert.equal(restored.hash, createHash("sha256").update(legacy).digest("hex"));
  console.log("Restore proved running-hub, corrupt-candidate and journal refusals; volume-path and stdin restore preserve legacy backups, including into an empty volume.");

  await compose(["stop", "hub"]);
  await stopped(`const fs=require("node:fs"),{DatabaseSync}=require("node:sqlite");fs.copyFileSync(${JSON.stringify(path)},"/data/legacy.sqlite");const db=new DatabaseSync("/data/legacy.sqlite");try{db.exec("DROP TABLE hub_release");}finally{db.close();}`);
  await offline(["ub-hub", "restore", "/data/legacy.sqlite"]);
  const beforeLegacy = await databaseState();
  assert.equal(beforeLegacy.release, null);
  await compose(["start", "hub"]); await serving();
  const legacyEvents = await startupBackupEvents();
  assert.equal(legacyEvents.length, 1, "a pre-record database gets one startup backup");
  const legacyCopy = legacyEvents[0];
  assert.equal(legacyCopy.database, "/data/hub.sqlite"); assert.equal(legacyCopy.previousRelease, null); assert.equal(legacyCopy.release, "0.0.1");
  assert.match(legacyCopy.backup, /^\/data\/hub-[^/]+\.sqlite$/);
  assert.deepEqual(await databaseState(legacyCopy.backup, live), { ...beforeLegacy, mode: 0o600 });
  assert.equal((await databaseState("/data/hub.sqlite", live)).release, "0.0.1");
  const copiedFiles = backupFiles(await textState());
  assert.ok(copiedFiles.includes(legacyCopy.backup.slice("/data/".length)));
  assert.equal((await textState()).files.some(name => name.startsWith(".hub-backup-")), false);
  await compose(["stop", "hub"]); await compose(["start", "hub"]); await serving();
  assert.deepEqual(backupFiles(await textState()), copiedFiles, "the same release makes no additional startup copy");
  assert.deepEqual(await startupBackupEvents(), legacyEvents);
  console.log("The real image backed up every legacy table before adding its release, at 0600 with integrity ok; a same-release restart made no copy.");

  await compose(["stop", "hub"]);
  await stopped('const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/hub.sqlite");try{db.prepare("UPDATE hub_release SET version = ?").run("0.0.0");}finally{db.close();}');
  const beforeOlder = await databaseState();
  await compose(["start", "hub"]); await serving();
  const olderEvents = await startupBackupEvents();
  assert.equal(olderEvents.length, 2);
  const olderCopy = olderEvents[1];
  assert.equal(olderCopy.previousRelease, "0.0.0"); assert.equal(olderCopy.release, "0.0.1");
  assert.notEqual(olderCopy.backup, legacyCopy.backup);
  assert.deepEqual(await databaseState(olderCopy.backup, live), { ...beforeOlder, mode: 0o600 });
  assert.equal((await databaseState("/data/hub.sqlite", live)).release, "0.0.1");

  await compose(["stop", "hub"]);
  await stopped('const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/hub.sqlite");try{db.exec("PRAGMA journal_mode = WAL");db.prepare("UPDATE hub_release SET version = ?").run("0.0.2");}finally{db.close();}');
  const beforeNewer = await volumeState();
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = await offline([], { allowFailure: true });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stdout + refused.stderr, /run hub release 0\.0\.2 instead/);
    assert.doesNotMatch(refused.stdout + refused.stderr, /"event":"hub\.(listen|database\.backup)"/);
    assert.deepEqual(await volumeState(), beforeNewer, "repeated downgrade attempts leave every database and file unchanged");
  }
  await offline(["ub-hub", "restore", olderCopy.backup]);
  assert.deepEqual(await databaseState(), { ...beforeOlder, mode: 0o600 }, "in-volume recovery restores the release and all state saved before the update");
  console.log("An older release record gets its own complete copy; two newer-record refusals left the volume byte-for-byte unchanged, and its pre-update copy restored in place.");

  await offline(["ub-hub", "restore", "/data/legacy.sqlite"]);
  const directoryMode = Number((await stopped('const fs=require("node:fs");console.log(fs.statSync("/data").mode&0o777);fs.chmodSync("/data",0o500);')).stdout);
  try {
    const beforeDenied = await volumeState();
    const denied = await offline([], { allowFailure: true });
    assert.notEqual(denied.code, 0);
    assert.match(denied.stdout + denied.stderr, /cannot back up the database before hub release 0\.0\.1/);
    assert.match(denied.stdout + denied.stderr, /EACCES|permission denied/);
    assert.doesNotMatch(denied.stdout + denied.stderr, /"event":"hub\.(listen|database\.backup)"/);
    assert.deepEqual(await volumeState(), beforeDenied, "failed startup publishes no partial backup and changes no database bytes");
  } finally { await stopped(`require("node:fs").chmodSync("/data",${directoryMode});`); }
  await compose(["start", "hub"]); await serving();
  assert.equal((await databaseState("/data/hub.sqlite", live)).release, "0.0.1");
  assert.equal((await textState()).files.some(name => name.startsWith(".hub-backup-")), false);
  console.log("A write-denied startup refused before serving or changing the volume; the same database recovered after restoring volume writes.");
  writeFileSync(join(scratch, "result.json"), `${JSON.stringify({ sha, source: "commit", imageId, doctor: doctor.stdout, stoppedDoctor: stoppedDoctor.stdout, legacyCopy: legacyCopy.backup, olderCopy: olderCopy.backup, releaseGuard: "legacy and older copies, repeat start, repeated downgrade refusal, write-denied refusal and in-volume recovery passed", success: true }, null, 2)}\n`);
  console.log(`PASS ${sha}; evidence ${scratch}`);
} finally {
  clearTimeout(deadline); cleaning = true;
  await compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true, cleanup: true });
  for (const name of containers) await docker(["rm", "--force", name], { allowFailure: true, cleanup: true });
  await docker(["volume", "rm", emptyVolume], { allowFailure: true, cleanup: true });
  console.log("Task-owned containers and volumes cleaned; image retained.");
}
