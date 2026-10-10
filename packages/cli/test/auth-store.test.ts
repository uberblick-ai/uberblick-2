import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  type StoredHubLogin,
  isHubLogin,
  preflightHubLoginStore,
  readHubLogins,
  removeHubLogin,
  writeHubLogin,
} from "../src/auth-store.js";
import { credentialsPath, resolveConfig, userConfigPath } from "../src/config.js";
import { acquireInitLock, initLockPath, tryAcquireInitLock } from "../src/init-lock.js";
import { readWorkspaceHub } from "../src/workspace-registry.js";
import * as safeWrite from "@uberblick/hub/safe-write";
import { PACKAGE_ROOT, SECRET_ON_FILE, removeTempDirs, sandbox, waitUntil, type Sandbox } from "./helpers.js";

afterAll(removeTempDirs);
afterEach(() => vi.restoreAllMocks());

const HUB = "https://hub.example.test";
const OTHER_HUB = "http://localhost:1234";
const WORKSPACE = "aaaaaaaa-1111-4111-8111-111111111111";

function login(): StoredHubLogin {
  return {
    identity: {
      id: "bbbbbbbb-2222-4222-8222-222222222222",
      githubAccountId: "42",
      githubUsername: "managed_user",
    },
    credential: {
      record: {
        id: "cccccccc-3333-4333-8333-333333333333",
        principalId: "bbbbbbbb-2222-4222-8222-222222222222",
        deviceId: "dddddddd-4444-4444-8444-444444444444",
        workspaces: [WORKSPACE],
        issuedAt: 1_790_000_000_000,
        revokedAt: null,
      },
      key: Buffer.alloc(32, 17).toString("base64url"),
    },
  };
}

type Mutation = { command: "write"; origin: string; login: StoredHubLogin }
  | { command: "remove"; origin: string }
  | { command: "remote" };

/**
 * Pause independent writers after their real credential read. Without mutual
 * exclusion both can hold the same snapshot; with it the second must wait for
 * the first's lock before reading. The barriers choose the adverse ordering
 * rather than depending on two short file operations happening to overlap.
 */
async function interleaveWriters(box: Sandbox, first: Mutation, second: Mutation): Promise<void> {
  const scratch = join(box.cwd, `auth-writers-${process.env.UB_AGENTS_RUN ?? "test"}`);
  mkdirSync(scratch);
  const worker = join(scratch, "writer.mjs");
  writeFileSync(worker, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { writeHubLogin, removeHubLogin } from ${JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "src/auth-store.ts")).href)};
import { credentialsPath } from ${JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "src/config.ts")).href)};
import { acquireInitLock, initLockPath } from ${JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "src/init-lock.ts")).href)};
import { setRemote } from ${JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "src/remote.ts")).href)};

const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const barrier = process.argv[3];
const read = fs.readFileSync;
const open = fs.openSync;
let paused = false;
let credentialFd;
fs.readFileSync = (path, ...args) => {
  const contents = read(path, ...args);
  if (!paused && (String(path) === credentialsPath() || path === credentialFd)) {
    paused = true;
    fs.writeFileSync(barrier + ".read", "");
    const deadline = Date.now() + 10_000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(barrier + ".release")) {
      if (Date.now() >= deadline) throw new Error("credential-read barrier timed out");
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  return contents;
};
fs.openSync = (path, ...args) => {
  try {
    const fd = open(path, ...args);
    if (String(path) === credentialsPath()) credentialFd = fd;
    return fd;
  } catch (error) {
    if (String(path) === initLockPath() && error.code === "EEXIST") {
      fs.writeFileSync(barrier + ".waiting", "");
    }
    throw error;
  }
};
syncBuiltinESMExports();
const lifetime = setTimeout(() => process.exit(2), 12_000);
process.once("message", async () => {
  try {
    if (job.command === "write") await writeHubLogin(job.origin, job.login);
    else if (job.command === "remove") await removeHubLogin(job.origin);
    else {
      // The persistence phase used by ub workspace use, under its real lock.
      const lock = await acquireInitLock();
      try { setRemote("wss://new.example.test/ws", { workspace: "5c1f9a72-4d38-4e02-9b6a-7e3f10c85b94" }); }
      finally { lock.release(); }
    }
  } catch (error) {
    process.stderr.write(String(error) + "\\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(lifetime);
    process.disconnect();
  }
});
process.send("ready");
`, "utf8");
  const children: { child: ChildProcess; ready: boolean; done: Promise<{ status: number | null; output: string }>; barrier: string }[] = [];
  for (const [index, job] of [first, second].entries()) {
    const task = join(scratch, `task-${index}.json`);
    writeFileSync(task, JSON.stringify(job), { mode: 0o600 });
    const barrier = join(scratch, `barrier-${index}`);
    const child = spawn(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"), worker, task, barrier,
    ], { cwd: box.cwd, env: box.env, timeout: 15_000, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "";
    const handle = {
      child, barrier, ready: false,
      done: new Promise<{ status: number | null; output: string }>((resolve) => {
        child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
        child.on("error", (error) => { output += String(error); });
        child.on("close", (status) => resolve({ status, output }));
      }),
    };
    child.on("message", () => { handle.ready = true; });
    children.push(handle);
  }
  const [a, b] = children;
  try {
    if (a === undefined || b === undefined) throw new Error("two credential writers are required");
    await waitUntil("both credential writers to boot", () => a.ready && b.ready, 10_000);
    a.child.send("go");
    await waitUntil("first writer's credential read", () => existsSync(`${a.barrier}.read`), 5_000);
    b.child.send("go");
    await waitUntil("second writer's read or lock wait", () =>
      existsSync(`${b.barrier}.read`) || existsSync(`${b.barrier}.waiting`), 1_500);
    if (existsSync(`${b.barrier}.read`)) {
      // An unlocked writer publishes while the first holds the older snapshot.
      writeFileSync(`${b.barrier}.release`, "");
      const finished = await b.done;
      expect(finished.status, finished.output).toBe(0);
    }
    writeFileSync(`${a.barrier}.release`, "");
    const firstResult = await a.done;
    expect(firstResult.status, firstResult.output).toBe(0);
    writeFileSync(`${b.barrier}.release`, "");
    const secondResult = await b.done;
    expect(secondResult.status, secondResult.output).toBe(0);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ done }) => done));
  }
}

describe("hub login store", () => {
  it("preflights an absent store without creating a credential or signing secret", () => {
    const box = sandbox();
    const path = credentialsPath(box.env);
    expect(readHubLogins(box.env).state).toBe("missing");
    expect(preflightHubLoginStore(box.env)).toBe(path);
    expect(readdirSync(dirname(path))).toEqual([]);
    expect(readHubLogins(box.env).state).toBe("missing");
  });

  it("stores at mode 0600 while keeping the binding, signing secret and unknown fields", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "wss://hub.example.test/ws" },
      userConfig: { hubUrl: "wss://hub.example.test/ws", workspace: WORKSPACE },
      credentials: { signingSecret: SECRET_ON_FILE, future: { opaque: true } },
    });
    const binding = readFileSync(userConfigPath(box.env), "utf8");
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    preflightHubLoginStore(box.env);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(await writeHubLogin(HUB, login(), box.env)).toBeNull();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored).toEqual({
      signingSecret: SECRET_ON_FILE,
      future: { opaque: true },
      hubLogins: { [HUB]: login() },
    });
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(userConfigPath(box.env), "utf8")).toBe(binding);
    expect(readHubLogins(box.env)).toEqual({
      path, state: "usable", logins: { [HUB]: login() }, unreadableHubs: [],
    });
    // Issuance and storage do not opt existing commands into credential use.
    expect(JSON.stringify(resolveConfig({ env: box.env, cwd: box.cwd }))).not.toContain(login().credential.key);
  });

  it("replaces and removes only the selected login, keeping malformed and future entries", async () => {
    const other = login();
    other.identity.githubUsername = "other-user";
    const unreadable = { credential: { key: "broken" } };
    const box = sandbox({ credentials: {
      signingSecret: SECRET_ON_FILE,
      hubLogins: {
        [HUB]: login(), [OTHER_HUB]: other,
        "https://broken.example.test": unreadable, future: { version: 2 },
      },
    } });
    const next = login();
    next.credential.record.deviceId = "eeeeeeee-5555-4555-8555-555555555555";
    expect(await writeHubLogin(HUB, next, box.env)).toEqual(login());
    expect(readHubLogins(box.env).logins).toEqual({ [HUB]: next, [OTHER_HUB]: other });
    expect(readHubLogins(box.env).unreadableHubs).toEqual(["https://broken.example.test"]);
    expect(await removeHubLogin(HUB, box.env)).toBe(true);
    expect(await removeHubLogin(HUB, box.env)).toBe(false);
    expect(JSON.parse(readFileSync(credentialsPath(box.env), "utf8"))).toEqual({
      signingSecret: SECRET_ON_FILE,
      hubLogins: { [OTHER_HUB]: other, "https://broken.example.test": unreadable, future: { version: 2 } },
    });
  });

  it("keeps both logins when independent hub writers overlap", async () => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE, future: { opaque: true } } });
    const other = login();
    other.identity.githubUsername = "other-user";
    await interleaveWriters(box,
      { command: "write", origin: HUB, login: login() },
      { command: "write", origin: OTHER_HUB, login: other });
    expect(JSON.parse(readFileSync(credentialsPath(box.env), "utf8"))).toEqual({
      signingSecret: SECRET_ON_FILE, future: { opaque: true },
      hubLogins: { [HUB]: login(), [OTHER_HUB]: other },
    });
  });

  it("returns the login replaced after waiting for the writer lock", async () => {
    const box = sandbox({ credentials: { hubLogins: { [HUB]: login() } } });
    const latest = login();
    latest.credential.record.id = "eeeeeeee-5555-4555-8555-555555555555";
    latest.credential.key = Buffer.alloc(32, 23).toString("base64url");
    const next = login();
    next.credential.record.deviceId = "ffffffff-6666-4666-8666-666666666666";
    const holder = await acquireInitLock(box.env);
    const writing = writeHubLogin(HUB, next, box.env);
    try {
      // Model a renewal finishing its publication while it holds the lock.
      writeFileSync(credentialsPath(box.env), JSON.stringify({ hubLogins: { [HUB]: latest } }), { mode: 0o600 });
    } finally {
      holder.release();
    }
    expect(await writing).toEqual(latest);
    expect(readHubLogins(box.env).logins[HUB]).toEqual(next);
  });

  it("does not restore a login deleted by an independent logout", async () => {
    const box = sandbox({ credentials: {
      signingSecret: SECRET_ON_FILE, future: { opaque: true }, hubLogins: { [HUB]: login() },
    } });
    await interleaveWriters(box,
      { command: "write", origin: OTHER_HUB, login: login() },
      { command: "remove", origin: HUB });
    expect(JSON.parse(readFileSync(credentialsPath(box.env), "utf8"))).toEqual({
      signingSecret: SECRET_ON_FILE, future: { opaque: true }, hubLogins: { [OTHER_HUB]: login() },
    });
  });

  it("keeps the loopback secret and unrelated fields across concurrent remote binding", async () => {
    const box = sandbox({ credentials: {
      signingSecret: SECRET_ON_FILE, future: { opaque: true }, hubLogins: { [OTHER_HUB]: login() },
    } });
    await interleaveWriters(box,
      { command: "write", origin: HUB, login: login() },
      { command: "remote" });
    expect(JSON.parse(readFileSync(credentialsPath(box.env), "utf8"))).toEqual({
      signingSecret: SECRET_ON_FILE, future: { opaque: true },
      hubLogins: { [HUB]: login(), [OTHER_HUB]: login() },
    });
    expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).hubUrl).toBe("wss://new.example.test/ws");
    expect(readdirSync(dirname(credentialsPath(box.env)))).toEqual(["credentials.json", "workspaces.json"]);
    expect(readWorkspaceHub("5c1f9a72-4d38-4e02-9b6a-7e3f10c85b94", box.env)).toBe("wss://new.example.test/ws");
  });

  it("leaves stored bytes and another writer's lock intact when its bounded wait expires", async () => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE, hubLogins: { [HUB]: login() } } });
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    const holder = await acquireInitLock(box.env);
    try {
      await expect(writeHubLogin(OTHER_HUB, login(), box.env)).rejects.toThrow(/ub auth login/);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readFileSync(holder.path, "utf8")).toBe(`${process.pid}\n`);
    } finally {
      holder.release();
    }
    expect(existsSync(initLockPath(box.env))).toBe(false);
  });

  it("does not store a collected login interrupted while waiting for another writer", async () => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE, hubLogins: { [HUB]: login() } } });
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    const holder = await acquireInitLock(box.env);
    const interrupted = new AbortController();
    const writing = writeHubLogin(OTHER_HUB, login(), box.env, interrupted.signal);
    interrupted.abort();
    holder.release();
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(initLockPath(box.env))).toBe(false);
  });

  it("stores only the public identity, credential record and key from collection", async () => {
    const box = sandbox();
    const value = login();
    const extra = {
      ...value,
      collectionSecret: "private-collection-secret",
      identity: { ...value.identity, githubToken: "private-github-token" },
      credential: {
        ...value.credential,
        githubToken: "private-github-token",
        record: { ...value.credential.record, collectionSecret: "private-collection-secret" },
      },
    };
    expect(isHubLogin(extra)).toBe(true);
    await writeHubLogin(HUB, extra, box.env);
    expect(JSON.parse(readFileSync(credentialsPath(box.env), "utf8"))).toEqual({ hubLogins: { [HUB]: value } });
  });

  it("stores names only for issued workspaces and reads them without rewriting the login", async () => {
    const box = sandbox();
    const value = login();
    const name = 'Synthetic 🧭 "workspace" \\';
    value.credential.workspaceNames = {
      [WORKSPACE]: name,
      "eeeeeeee-5555-4555-8555-555555555555": "Not issued",
    };
    await writeHubLogin(HUB, value, box.env);
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    const stored = readHubLogins(box.env).logins[HUB]!;
    expect(stored.credential.workspaceNames).toEqual({ [WORKSPACE]: name });
    expect(stored.credential.record.workspaces).toEqual([WORKSPACE]);
    expect(JSON.parse(before).hubLogins[HUB]).toEqual(stored);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it.each([
    { label: "null", workspaceNames: null }, { label: "array", workspaceNames: [] },
    { label: "string", workspaceNames: "not a map" },
    { label: "non-string", workspaceNames: { [WORKSPACE]: 4 } },
    { label: "empty", workspaceNames: { [WORKSPACE]: "" } },
    { label: "padded", workspaceNames: { [WORKSPACE]: " C1-free but padded " } },
    { label: "C1", workspaceNames: { [WORKSPACE]: "synthetic\u009bname" } },
    { label: "bidi", workspaceNames: { [WORKSPACE]: "synthetic\u202ename" } },
    { label: "credential key", workspaceNames: { [WORKSPACE]: `synthetic ${login().credential.key}` } },
  ])("ignores $label names without losing an older credential", async ({ workspaceNames }) => {
    const original = login();
    const supplied = { ...original, credential: { ...original.credential, workspaceNames } };
    expect(isHubLogin(supplied)).toBe(true);
    const box = sandbox({ credentials: { hubLogins: { [HUB]: supplied } } });
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    expect(readHubLogins(box.env).logins[HUB]).toEqual(original);
    expect(readFileSync(path, "utf8")).toBe(before);
    if (!isHubLogin(supplied)) throw new Error("display names must not invalidate a credential");
    await writeHubLogin(HUB, supplied, box.env);
    expect(JSON.parse(readFileSync(path, "utf8")).hubLogins[HUB]).toEqual(original);
  });

  it.each([0o644, 0o640, 0o606])("refuses mode %o for reads and mutations without repairing it", async (mode) => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE, hubLogins: { [HUB]: login() } }, credentialsMode: mode });
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    const state = readHubLogins(box.env);
    expect(state.state).toBe("refused");
    expect(state.logins).toEqual({});
    expect(state.diagnostic).toContain(`chmod 600 ${path}`);
    expect(state.reason).toBe(`credential store ${path} mode ${mode.toString(8).padStart(4, "0")} lets other users access it`);
    expect(state.fix).toBe(`chmod 600 ${path}`);
    expect(JSON.stringify(state)).not.toContain(login().credential.key);
    expect(() => preflightHubLoginStore(box.env)).toThrow(`chmod 600 ${path}`);
    await expect(writeHubLogin(HUB, login(), box.env)).rejects.toThrow(`chmod 600 ${path}`);
    await expect(removeHubLogin(HUB, box.env)).rejects.toThrow(`chmod 600 ${path}`);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(lstatSync(path).mode & 0o777).toBe(mode);
  });

  it.each([
    { raw: { credentials: "secret-that-must-not-leak" } },
    { credentials: [] },
    { credentials: { hubLogins: [] } },
    { credentials: { hubLogins: null } },
  ])("refuses unreadable stores without revealing or overwriting their contents", async (files) => {
    const box = sandbox(files);
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    const result = readHubLogins(box.env);
    expect(result.state).toBe("unreadable");
    expect(result.logins).toEqual({});
    expect(result.reason).toContain(path);
    expect(result.fix).toBe(`repair ${path}, then run ub auth login`);
    expect(result.reason).not.toBe(result.fix);
    expect(result.reason).not.toContain("`");
    expect(result.fix).not.toContain("`");
    expect(JSON.stringify(result)).not.toContain("secret-that-must-not-leak");
    expect(() => preflightHubLoginStore(box.env)).toThrow(/credential store/);
    await expect(writeHubLogin(HUB, login(), box.env)).rejects.toThrow(/credential store/);
    await expect(removeHubLogin(HUB, box.env)).rejects.toThrow(/credential store/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses symlinks and directories without touching their targets", async () => {
    const box = sandbox();
    const path = credentialsPath(box.env);
    const target = join(box.cwd, "owner-file.json");
    writeFileSync(target, JSON.stringify({ hubLogins: { [HUB]: login() } }), { mode: 0o600 });
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    expect(readHubLogins(box.env)).toMatchObject({
      state: "refused", reason: `credential store ${path} must be a regular file you own`,
      fix: `move ${path} aside, then run ub auth login`,
    });
    expect(() => preflightHubLoginStore(box.env)).toThrow(/regular file you own/);
    await expect(writeHubLogin(HUB, login(), box.env)).rejects.toThrow(/regular file you own/);
    await expect(removeHubLogin(HUB, box.env)).rejects.toThrow(/regular file you own/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ hubLogins: { [HUB]: login() } }));

    const directoryBox = sandbox();
    mkdirSync(credentialsPath(directoryBox.env), { recursive: true });
    expect(readHubLogins(directoryBox.env).state).toBe("refused");
    expect(() => preflightHubLoginStore(directoryBox.env)).toThrow(/regular file you own/);
  });

  it("fails preflight on a non-writable directory before changing stored bytes", () => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE, hubLogins: { [HUB]: login() } } });
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    chmodSync(dirname(path), 0o500);
    try {
      expect(() => preflightHubLoginStore(box.env)).toThrow(/directory is writable/);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(dirname(path))).toEqual(["credentials.json"]);
    } finally {
      chmodSync(dirname(path), 0o700);
    }
  });

  it("keeps the earlier login when publication fails and does not leak the new key", async () => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE, hubLogins: { [HUB]: login() } } });
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    const next = login();
    next.credential.key = Buffer.alloc(32, 23).toString("base64url");
    vi.spyOn(safeWrite, "publishOwnerOnly").mockImplementation(() => { throw new Error(next.credential.key); });
    await expect(writeHubLogin(HUB, next, box.env)).rejects.toThrow(/could not write credential store/);
    try { await writeHubLogin(HUB, next, box.env); } catch (error) {
      expect(String(error)).not.toContain(next.credential.key);
      expect(String(error)).not.toContain(SECRET_ON_FILE);
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    const nextWriter = tryAcquireInitLock(box.env);
    expect(nextWriter).not.toBeNull();
    nextWriter?.release();
  });
});

describe("collected login validation", () => {
  it("accepts empty workspace limits and nullable integer timestamps", () => {
    const value = login();
    value.credential.record.workspaces = [];
    value.credential.record.revokedAt = value.credential.record.issuedAt + 1;
    expect(isHubLogin(value)).toBe(true);
  });

  it("rejects malformed identities, records and noncanonical keys", () => {
    for (const mutate of [
      (value: StoredHubLogin) => { value.identity.id = "bad"; },
      (value: StoredHubLogin) => { value.identity.githubAccountId = "042"; },
      (value: StoredHubLogin) => { value.identity.githubUsername = ""; },
      (value: StoredHubLogin) => { value.credential.record.id = "bad"; },
      (value: StoredHubLogin) => { value.credential.record.principalId = WORKSPACE; },
      (value: StoredHubLogin) => { value.credential.record.deviceId = "bad"; },
      (value: StoredHubLogin) => { value.credential.record.workspaces = [`decorated-${WORKSPACE}`]; },
      (value: StoredHubLogin) => { value.credential.record.issuedAt = Number.NaN; },
      (value: StoredHubLogin) => { value.credential.record.revokedAt = -1; },
      (value: StoredHubLogin) => { value.credential.key += "="; },
      (value: StoredHubLogin) => { value.credential.key = Buffer.alloc(31).toString("base64url"); },
    ]) {
      const value = login();
      mutate(value);
      expect(isHubLogin(value)).toBe(false);
    }
    expect(isHubLogin({ status: "complete" })).toBe(false);
  });
});
