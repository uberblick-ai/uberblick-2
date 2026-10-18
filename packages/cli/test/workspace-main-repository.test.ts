import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpServer, defaultWorkspaceDatabasePath, resolveMcpConfig } from "@uberblick/mcp-server";
import { getWorkspaceMainRepository, setWorkspaceMainRepository } from "@uberblick/schema";
import { writeHubLogin } from "@uberblick/mcp-server/auth-store";
import { afterEach, expect, it } from "vitest";
import { writeHubAdmission } from "../src/config.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { cleanUp, rig, seedLogin } from "./auth-fixtures.js";
import { removeTempDirs, unboundSandbox, type Sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

afterEach(async () => { await cleanUp(); removeTempDirs(); });

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";

function selected(box: Sandbox): string {
  return JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).workspaceId;
}

function gitOrigin(box: Sandbox, origin: string, bare = false): void {
  execFileSync("git", ["init", "--quiet", ...(bare ? ["--bare"] : [])], { cwd: box.cwd, env: box.env });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: box.cwd, env: box.env });
}

async function repository(box: Sandbox, value?: string): Promise<string | null> {
  const local = createMcpServer({
    ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: selected(box) }), authSecret: null,
  });
  try {
    const settings = local.replicas.settings().doc;
    if (value !== undefined) setWorkspaceMainRepository(settings, value);
    return getWorkspaceMainRepository(settings);
  } finally { await local.close(); }
}

it.each([
  "https://github.com/Acme/notes.git",
  "git@github.com:Acme/notes.git",
  "ssh://git@github.com/Acme/notes.git",
])("fills create from the checkout's origin %s", async origin => {
  const box = unboundSandbox();
  gitOrigin(box, origin);
  const result = await runInProcess(["workspace", "create", "Project notes"], box);
  expect(result.status, result.output).toBe(0);
  expect(await repository(box)).toBe("Acme/notes");
  expect(result.stdout).toBe(`Created Project notes (${selected(box)}), local-only.\nSelected in ${join(box.cwd, ".uberblick.json")}.\nRun \`ub open\` to open it.\n`);
  expect(result.stderr).toBe("");
  expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")))
    .toEqual({ workspaceId: selected(box), hubUrl: null });
});

it("fills id use, preserves an existing value and keeps JSON and binding unchanged", async () => {
  const box = unboundSandbox();
  expect((await runInProcess(["workspace", "create", "Local notes"], box)).status).toBe(0);
  expect(await repository(box)).toBeNull();
  const id = selected(box);
  const before = readFileSync(join(box.cwd, ".uberblick.json"));
  gitOrigin(box, "https://github.com/acme/notes.git");
  const filled = await runInProcess(["workspace", "use", id, "--json"], box);
  expect(filled.status, filled.output).toBe(0);
  expect(JSON.parse(filled.stdout)).toEqual({
    binding: { workspaceId: id, hubUrl: null }, previous: { workspaceId: id, hubUrl: null },
  });
  expect(filled.stderr).toBe("");
  expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(before);
  expect(await repository(box)).toBe("acme/notes");
  await repository(box, "other/selected");
  const kept = await runInProcess(["workspace", "use", id, "--json"], box);
  expect(kept).toEqual(filled);
  expect(await repository(box)).toBe("other/selected");
});

it.each(["admin", "member", "signed-out", "hub-down"] as const)(
  "fills hub id use only after confirming admin authority: %s", async authority => {
    const remote = await rig([], true, false, true);
    const box = remote.box;
    const identity = remote.hub.principals!.identify("1234", remote.github.identity.login);
    remote.hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: identity.id,
      role: authority === "admin" ? "admin" : "member" });
    await seedLogin(remote);
    if (authority === "signed-out") {
      writeFileSync(join(box.configHome, "uberblick", "credentials.json"), "{}");
    }
    if (authority === "hub-down") remote.controls.onManagement = () => ({ status: 503, result: { status: "failed" } });
    rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: remote.origin }], box.env);
    const local = createMcpServer({ ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE }), authSecret: null });
    await local.close();
    gitOrigin(box, "https://github.com/acme/notes.git");
    const result = await runInProcess(["workspace", "use", WORKSPACE, "--json"], box);
    expect(result.status, result.output).toBe(0);
    expect(result.stderr).toBe("");
    expect(await repository(box)).toBe(authority === "admin" ? "acme/notes" : null);
    expect(remote.requests.filter(request => request.path.includes("renew"))).toEqual([]);
    expect(remote.requests.filter(request => request.path === "/auth/manage").map(request => request.body.operation))
      .toEqual(authority === "signed-out" ? [] : ["own-role"]);
  },
);

it.each(["admin", "member"] as const)("fills fetched hub settings only for a confirmed %s", async role => {
  const remote = await rig([], true, false, true);
  const box = remote.box;
  const identity = remote.hub.principals!.identify("1234", remote.github.identity.login);
  remote.hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: identity.id, role });
  const login = await seedLogin(remote);
  const endpoint = `http://127.0.0.1:${remote.hub.port}`;
  await writeHubLogin(endpoint, login, box.env);
  writeHubAdmission(endpoint, true, box.env);
  gitOrigin(box, "https://github.com/acme/notes.git");
  const result = await runInProcess(["workspace", "use", `${endpoint}/notes-${WORKSPACE}`, "--json"], box);
  expect(result.status, result.output).toBe(0);
  expect(await repository(box)).toBe(role === "admin" ? "acme/notes" : null);
});

it.each([
  "https://gitlab.com/acme/notes.git",
  "git@github.enterprise.test:acme/notes.git",
  "acme/notes",
  "http://github.com/acme/notes.git",
])("leaves create and id use unset for unsupported origin %s", async origin => {
  const box = unboundSandbox();
  gitOrigin(box, origin);
  const created = await runInProcess(["workspace", "create", "Local notes"], box);
  expect(created.status, created.output).toBe(0);
  const used = await runInProcess(["workspace", "use", selected(box), "--json"], box);
  expect(used.status, used.output).toBe(0);
  expect(await repository(box)).toBeNull();
  expect(created.stderr + used.stderr).toBe("");
});

it.each(["no-checkout", "no-origin", "bare", "missing-git", "failed-lookup"] as const)(
  "leaves create and id use unset without changing their result: %s", async kind => {
    const box = unboundSandbox();
    let env: NodeJS.ProcessEnv = {};
    if (kind === "no-checkout") {
      const globalConfig = join(box.cwd, "global.gitconfig");
      writeFileSync(globalConfig, '[remote "origin"]\nurl = https://github.com/acme/notes.git\n');
      env = { GIT_CONFIG_GLOBAL: globalConfig };
    } else if (kind !== "missing-git") {
      gitOrigin(box, "https://github.com/acme/notes.git", kind === "bare");
      if (kind === "no-origin") execFileSync("git", ["remote", "remove", "origin"], { cwd: box.cwd, env: box.env });
      if (kind === "failed-lookup") writeFileSync(join(box.cwd, ".git", "config"), "not a git config document\n");
    } else { env = { PATH: "" }; }
    const created = await runInProcess(["workspace", "create", "Local notes"], box, env);
    expect(created.status, created.output).toBe(0);
    const id = selected(box);
    const used = await runInProcess(["workspace", "use", id, "--json"], box, env);
    expect(used.status, used.output).toBe(0);
    expect(JSON.parse(used.stdout)).toEqual({
      binding: { workspaceId: id, hubUrl: null }, previous: { workspaceId: id, hubUrl: null },
    });
    expect(created.stderr + used.stderr).toBe("");
    expect(await repository(box)).toBeNull();
  },
);

it("kills a stalled origin lookup even when it ignores SIGTERM, and still creates and uses", async () => {
  const box = unboundSandbox();
  const bin = join(box.cwd, "bin");
  const pidFile = join(box.cwd, "git.pid");
  mkdirSync(bin);
  const git = join(bin, "git");
  writeFileSync(git, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === 'rev-parse') { console.log('true'); } else {\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1_000);\n}\n`);
  chmodSync(git, 0o755);
  try {
    const created = await runInProcess(["workspace", "create", "Local notes"], box, { PATH: bin });
    expect(created.status, created.output).toBe(0);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    const used = await runInProcess(["workspace", "use", selected(box), "--json"], box, { PATH: bin });
    expect(used.status, used.output).toBe(0);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    expect(created.stderr + used.stderr).toBe("");
    expect(await repository(box)).toBeNull();
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already exited */ }
    }
  }
});

it.each(["absent", "unreadable"] as const)("id use does not create or repair an %s replica", async kind => {
  const box = unboundSandbox();
  gitOrigin(box, "https://github.com/acme/notes.git");
  rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: null }], box.env);
  const path = defaultWorkspaceDatabasePath(WORKSPACE, box.env);
  if (kind === "unreadable") {
    mkdirSync(join(box.dataHome, "uberblick"), { recursive: true });
    writeFileSync(path, "not a database\n");
  }
  const before = kind === "unreadable" ? readFileSync(path) : null;
  const result = await runInProcess(["workspace", "use", WORKSPACE, "--json"], box);
  expect(result.status, result.output).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ binding: { workspaceId: WORKSPACE, hubUrl: null }, previous: null });
  if (before === null) expect(existsSync(path)).toBe(false);
  else expect(readFileSync(path)).toEqual(before);
});

it("help and bare workspace commands never fill or write settings", async () => {
  const box = unboundSandbox();
  expect((await runInProcess(["workspace", "create", "Local notes"], box)).status).toBe(0);
  const id = selected(box);
  gitOrigin(box, "https://github.com/acme/notes.git");
  const path = defaultWorkspaceDatabasePath(id, box.env);
  const before = readFileSync(path);
  for (const argv of [["workspace"], ["workspace", "create", "--help"], ["workspace", "use", id, "--help"]]) {
    const result = await runInProcess(argv, box);
    expect(result.status, result.output).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(path)).toEqual(before);
  }
  expect(await repository(box)).toBeNull();
});
