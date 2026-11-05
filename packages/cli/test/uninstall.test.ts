import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resolveMcpConfig, storeWorkspaceName } from "@uberblick/mcp-server";
import { writeHubLogin } from "@uberblick/mcp-server/auth-store";
import { tryAcquireInitLock } from "@uberblick/mcp-server/init-lock";
import { resolveStorage } from "@uberblick/mcp-server/storage";
import { workspaceRegistryPath } from "@uberblick/mcp-server/workspace-registry";
import { runCli } from "../src/cli.js";
import type { UninstallHost } from "../src/uninstall.js";
import { fixture } from "./auth-fixtures.js";
import { removeTempDirs, sandbox, type Sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

const failedDeletes = vi.hoisted(() => new Set<string>());
const deletionHooks = vi.hoisted(() => ({
  remove: undefined as ((path: string) => void) | undefined,
  rmdir: undefined as ((path: string) => void) | undefined,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: vi.fn((...args: Parameters<typeof fs.rmSync>) => {
      deletionHooks.remove?.(String(args[0]));
      if (failedDeletes.has(String(args[0]))) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES", path: String(args[0]) });
      }
      return fs.rmSync(...args);
    }),
    rmdirSync: vi.fn((...args: Parameters<typeof fs.rmdirSync>) => {
      deletionHooks.rmdir?.(String(args[0]));
      return fs.rmdirSync(...args);
    }),
  };
});

afterAll(removeTempDirs);
afterEach(() => {
  failedDeletes.clear();
  deletionHooks.remove = undefined;
  deletionHooks.rmdir = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const LOCAL = "11111111-1111-4111-8111-111111111111";
const UNKNOWN = "22222222-2222-4222-8222-222222222222";
const PENDING = "33333333-3333-4333-8333-333333333333";
const SYNCED = "44444444-4444-4444-8444-444444444444";
const HUB = "https://hub.example.test";

function host(terminal = false, installPayload = true) {
  return {
    cliDir: "/opt/homebrew/Cellar/uberblick/0.4.10/libexec",
    installPayload,
    isTerminal: terminal,
    capture: vi.fn<UninstallHost["capture"]>().mockReturnValue({ status: 0, stdout: "/opt/homebrew\n", stderr: "" }),
    run: vi.fn<UninstallHost["run"]>().mockResolvedValue(null),
    confirm: vi.fn<UninstallHost["confirm"]>().mockResolvedValue(false),
  } satisfies UninstallHost;
}

function uninstall(box: Sandbox, args: string[], fake = host()) {
  return runInProcess(["uninstall", ...args], box, {}, { uninstallHost: fake });
}

function tree(path: string): unknown[] | null {
  if (!existsSync(path)) return null;
  return readdirSync(path, { recursive: true, encoding: "utf8" }).sort().map(name => {
    const file = join(path, name);
    const stat = statSync(file);
    return [name, stat.isDirectory() ? null : createHash("sha256").update(readFileSync(file)).digest("hex")];
  });
}

function localData(box = sandbox({ userConfig: { displayName: "Synthetic operator" } })) {
  const storage = resolveStorage({ env: box.env });
  storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: LOCAL }), "Private notes");
  const database = new DatabaseSync(join(storage.dataDir, `${LOCAL}.sqlite`));
  try { database.exec("PRAGMA journal_mode = DELETE"); }
  finally { database.close(); }
  writeFileSync(workspaceRegistryPath(box.env), JSON.stringify({ [LOCAL]: null }));
  return { box, storage };
}

describe("ub uninstall", () => {
  it("lists the complete copy-loss inventory and hub logins before confirmation without changing data", async () => {
    const { box, storage } = localData();
    for (const [id, name] of [[UNKNOWN, "Unrecorded notes"], [PENDING, "Pending research"], [SYNCED, "Shared archive"]] as const) {
      storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: id }), name);
    }
    for (const id of [LOCAL, UNKNOWN, PENDING, SYNCED]) {
      const database = new DatabaseSync(join(storage.dataDir, `${id}.sqlite`));
      try {
        if (id !== PENDING) database.exec("DELETE FROM pending_rooms");
        database.exec("PRAGMA journal_mode = DELETE");
      }
      finally { database.close(); }
    }
    writeFileSync(workspaceRegistryPath(box.env), JSON.stringify({ [LOCAL]: null, [PENDING]: `${HUB}/ws`, [SYNCED]: `${HUB}/ws` }));
    const login = fixture([PENDING, SYNCED]);
    await writeHubLogin(HUB, login, box.env);
    const configBefore = tree(storage.configDir);
    const dataBefore = tree(storage.dataDir);
    const fake = host(true);
    vi.stubEnv("XDG_CONFIG_HOME", box.configHome);
    vi.stubEnv("XDG_DATA_HOME", box.dataHome);
    const result = { stdout: "", stderr: "", output: "", status: -1 };
    fake.confirm.mockImplementation(async () => {
      expect(result.stdout).toContain(storage.configDir);
      expect(result.stdout).toContain(storage.dataDir);
      expect(result.stdout).toContain("Private notes");
      expect(result.stdout).toContain("Unrecorded notes");
      expect(result.stdout).toContain("Pending research");
      expect(result.stdout).toContain(HUB);
      return false;
    });
    result.status = await runCli(["uninstall"], {
      out: text => { result.stdout += text; result.output += text; },
      err: text => { result.stderr += text; result.output += text; },
    }, { uninstallHost: fake });

    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(storage.configDir);
    expect(result.stdout).toContain(storage.dataDir);
    expect(result.stdout).toMatch(/4 workspace/);
    expect(result.stdout).toMatch(/1 local-only/);
    expect(result.stdout).toMatch(/1 (?:with )?no hub record/);
    expect(result.stdout).toMatch(/1 .*unacknowledged changes/);
    expect(result.stdout).toContain("Private notes");
    expect(result.stdout).toContain("Unrecorded notes");
    expect(result.stdout).toContain("Pending research");
    expect(result.stdout).toContain(LOCAL);
    expect(result.stdout).toContain(UNKNOWN);
    expect(result.stdout).toContain(PENDING);
    expect(result.stdout).toMatch(/only copy/);
    expect(result.stdout).toContain(HUB);
    expect(result.output).not.toContain(login.credential.key);
    expect(fake.confirm).toHaveBeenCalledTimes(1);
    expect(fake.confirm).toHaveBeenCalledWith(expect.stringMatching(/Uninstall Uberblick/));
    expect(fake.run).not.toHaveBeenCalled();
    expect(tree(storage.configDir)).toEqual(configBefore);
    expect(tree(storage.dataDir)).toEqual(dataBefore);
  });

  it.each([{ args: [] }, { args: ["--delete-data"] }])("requires --yes without a terminal and asks nothing: $args", async ({ args }) => {
    const { box, storage } = localData();
    const before = [tree(storage.configDir), tree(storage.dataDir)];
    const fake = host();

    const result = await uninstall(box, args, fake);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(fake.confirm).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
    expect([tree(storage.configDir), tree(storage.dataDir)]).toEqual(before);
  });

  it("keeps both roots with --yes and says where they remain", async () => {
    const { box, storage } = localData();
    const before = [tree(storage.configDir), tree(storage.dataDir)];
    const fake = host();

    const result = await uninstall(box, ["--yes"], fake);

    expect(result.status, result.output).toBe(0);
    expect(fake.confirm).not.toHaveBeenCalled();
    expect(fake.run).toHaveBeenCalledExactlyOnceWith("brew", ["uninstall", "uberblick-ai/tap/uberblick"]);
    expect(result.stdout).toMatch(/(?:kept local data|local data (?:was )?kept)/i);
    expect(result.stdout).toContain(storage.configDir);
    expect(result.stdout).toContain(storage.dataDir);
    expect([tree(storage.configDir), tree(storage.dataDir)]).toEqual(before);
  });

  it("asks uninstall then delete and keeps data when the second answer is no", async () => {
    const { box, storage } = localData();
    const before = [tree(storage.configDir), tree(storage.dataDir)];
    const fake = host(true);
    fake.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await uninstall(box, [], fake);

    expect(result.status, result.output).toBe(0);
    expect(fake.confirm.mock.calls.map(([question]) => question)).toEqual([
      expect.stringMatching(/Uninstall Uberblick/),
      expect.stringMatching(/delete.*local data/i),
    ]);
    expect(fake.run).toHaveBeenCalledOnce();
    expect([tree(storage.configDir), tree(storage.dataDir)]).toEqual(before);
  });

  it.each([{ args: [] }, { args: ["--yes", "--delete-data"] }, { args: ["--delete-data"] }])("deletes both roots before brew only after explicit agreement: $args", async ({ args }) => {
    const { box, storage } = localData();
    const protectedPaths = [join(box.cwd, "replica.sqlite"), join(box.cwd, "hub.sqlite"), join(box.cwd, ".uberblick.json"), join(box.cwd, ".mcp.json")];
    writeFileSync(protectedPaths[0]!, "external workspace database");
    writeFileSync(protectedPaths[1]!, "external hub database");
    writeFileSync(protectedPaths[3]!, '{"mcpServers":{"uberblick":{}}}');
    box.env.UBERBLICK_DB = protectedPaths[0];
    box.env.HUB_DB_PATH = protectedPaths[1];
    const protectedBefore = protectedPaths.map(path => readFileSync(path));
    for (const name of ["hub.sqlite", "extra-file", `${LOCAL}.sqlite-wal`, `${LOCAL}.sqlite-shm`, `${LOCAL}.sqlite.serving-lock`, `${LOCAL}.sqlite.history-refresher-lock`, `${LOCAL}.sqlite.history-holds/stale.sqlite`]) {
      const path = join(storage.dataDir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }
    for (const name of ["credentials.json", "browser-keys/key.json", "browser-sessions/session.json"]) {
      const path = join(storage.configDir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{}", { mode: 0o600 });
    }
    const fake = host(true);
    fake.confirm.mockResolvedValue(true);
    fake.run.mockImplementation(async () => {
      expect(existsSync(storage.configDir)).toBe(false);
      expect(existsSync(storage.dataDir)).toBe(false);
      return null;
    });

    const result = await uninstall(box, args, fake);

    expect(result.status, result.output).toBe(0);
    expect(fake.confirm).toHaveBeenCalledTimes(args.includes("--yes") ? 0 : args.includes("--delete-data") ? 1 : 2);
    expect(fake.run).toHaveBeenCalledExactlyOnceWith("brew", ["uninstall", "uberblick-ai/tap/uberblick"]);
    expect(existsSync(storage.configDir)).toBe(false);
    expect(existsSync(storage.dataDir)).toBe(false);
    expect(protectedPaths.map(path => readFileSync(path))).toEqual(protectedBefore);
  });

  it("asks only about uninstall when neither root exists and creates neither", async () => {
    const box = sandbox();
    const storage = resolveStorage({ env: box.env });
    const fake = host(true);
    fake.confirm.mockResolvedValue(true);

    const result = await uninstall(box, [], fake);

    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toMatch(/no local data/i);
    expect(fake.confirm).toHaveBeenCalledTimes(1);
    expect(fake.run).toHaveBeenCalledOnce();
    expect(existsSync(storage.configDir)).toBe(false);
    expect(existsSync(storage.dataDir)).toBe(false);
  });

  it.each([false, true])("propagates brew failure and says whether data was deleted: %s", async deleteData => {
    const { box, storage } = localData();
    const fake = host();
    fake.run.mockResolvedValue({ status: 23, message: "`brew uninstall uberblick-ai/tap/uberblick` exited 23" });

    const result = await uninstall(box, ["--yes", ...(deleteData ? ["--delete-data"] : [])], fake);

    expect(result.status).toBe(23);
    expect(result.stderr).toContain("exited 23");
    expect(result.output).toMatch(deleteData ? /(?:deleted local data|local data (?:was |has been )?deleted)/i : /(?:kept local data|local data (?:was |has been )?kept)/i);
    expect(existsSync(storage.configDir)).toBe(!deleteData);
    expect(existsSync(storage.dataDir)).toBe(!deleteData);
  });

  it("leaves the program installed and names the path when removing data fails", async () => {
    const { box, storage } = localData();
    failedDeletes.add(storage.dataDir);
    const fake = host();

    const result = await uninstall(box, ["--yes", "--delete-data"], fake);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(storage.dataDir);
    expect(fake.run).not.toHaveBeenCalled();
    expect(existsSync(storage.dataDir)).toBe(true);
  });

  it("refuses deletion when malformed workspace records prevent a complete copy-loss inventory", async () => {
    const { box, storage } = localData();
    writeFileSync(workspaceRegistryPath(box.env), "{broken");
    const before = [tree(storage.configDir), tree(storage.dataDir)];
    const fake = host(true);

    const result = await uninstall(box, ["--yes", "--delete-data"], fake);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(workspaceRegistryPath(box.env));
    expect(fake.confirm).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
    expect([tree(storage.configDir), tree(storage.dataDir)]).toEqual(before);
  });

  it("holds the init lock during recursive deletion and preserves a writer arriving after release", async () => {
    const { box, storage } = localData();
    const deletingPaths = [storage.dataDir, join(storage.configDir, "config.json"), workspaceRegistryPath(box.env)];
    const observed: string[] = [];
    deletionHooks.remove = path => {
      if (!deletingPaths.includes(path)) return;
      const contender = tryAcquireInitLock(box.env);
      contender?.release();
      expect(contender).toBeNull();
      observed.push(path);
    };
    const newFile = join(storage.configDir, "new-writer.json");
    deletionHooks.rmdir = path => {
      if (path !== storage.configDir) return;
      const nextWriter = tryAcquireInitLock(box.env);
      expect(nextWriter).not.toBeNull();
      try { writeFileSync(newFile, "newly saved configuration"); }
      finally { nextWriter?.release(); }
    };
    const fake = host();

    const result = await uninstall(box, ["--yes", "--delete-data"], fake);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(storage.configDir);
    expect(observed.sort()).toEqual(deletingPaths.sort());
    expect(readFileSync(newFile, "utf8")).toBe("newly saved configuration");
    expect(existsSync(storage.dataDir)).toBe(false);
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each([false, true])("refuses an unsupported copy or checkout without deleting data: checkout %s", async checkout => {
    const { box, storage } = localData(sandbox({ checkout, userConfig: { displayName: "Preserved operator" } }));
    const before = [tree(storage.configDir), tree(storage.dataDir)];
    const fake = host(false, false);
    fake.cliDir = box.cwd;

    const result = await uninstall(box, ["--yes", "--delete-data"], fake);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/only uninstalls Homebrew installations/);
    expect(fake.capture).not.toHaveBeenCalled();
    expect(fake.confirm).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
    expect([tree(storage.configDir), tree(storage.dataDir)]).toEqual(before);
  });

  it.each(["--help", "-h"])("shows %s without inspecting the installation or data", async flag => {
    const box = sandbox({ raw: { userConfig: "{broken", credentials: "{broken" } });
    const storage = resolveStorage({ env: box.env });
    const before = tree(storage.configDir);
    const fake = host(true);
    fake.capture.mockImplementation(() => { throw new Error("help inspected Homebrew"); });

    const result = await uninstall(box, ["--yes", "--delete-data", flag], fake);

    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain("usage: ub uninstall");
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).toContain("--delete-data");
    expect(result.stderr).toBe("");
    expect(fake.capture).not.toHaveBeenCalled();
    expect(fake.confirm).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
    expect(tree(storage.configDir)).toEqual(before);
    expect(existsSync(storage.dataDir)).toBe(false);
  });

  it("lists uninstall in top-level help and rejects operands before doing work", async () => {
    const box = sandbox();
    const fake = host();
    const top = await runInProcess(["--help"], box, {}, { uninstallHost: fake });
    expect(top.status).toBe(0);
    expect(top.stdout).toMatch(/^\s+uninstall\b/m);

    const result = await uninstall(box, ["unexpected"], fake);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: ub uninstall");
    expect(fake.capture).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });
});
