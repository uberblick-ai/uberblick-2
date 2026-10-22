import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { DEAD_HUB_URL, PACKAGE_ROOT, SHIPPED_UB, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";
const SECONDARY = "c3f57be0-748d-4fb3-a3c1-7a26bea6a537";

interface Fixture {
  primary: string;
  linked: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  databases: string[];
}

function launcher(root: string): string {
  return join(root, "packages", "cli", "bin", "ub.mjs");
}

/** The real source shim runs before either fixture's schema-bearing entry. */
function writeCheckout(root: string, source: "primary" | "branch"): void {
  mkdirSync(join(root, "packages", "cli", "bin"), { recursive: true });
  mkdirSync(join(root, "packages", "cli", "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "uberblick", private: true }));
  writeFileSync(join(root, "mise.toml"), "[env]\n");
  writeFileSync(join(root, "packages", "cli", "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, "packages", "cli", "tsconfig.json"), '{"compilerOptions":{}}\n');
  copyFileSync(SHIPPED_UB, launcher(root));
  symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(root, "packages", "cli", "node_modules"), "dir");
  writeFileSync(join(root, "packages", "cli", "src", "main.ts"), `
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
for (const path of JSON.parse(process.env.UB_LAUNCHER_TEST_DATABASES ?? "[]")) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE ${source}_schema_marker (value TEXT)");
  database.close();
}
process.stdout.write(JSON.stringify({
  source: ${JSON.stringify(source)},
  cwd: process.cwd(),
  args: process.argv.slice(2),
  configHome: process.env.XDG_CONFIG_HOME,
  session: process.env.UB_AGENT_SESSION,
}) + "\\n");
`);
}

function fixture(separateGitDir = false): Fixture {
  const box = sandbox();
  const primary = box.cwd;
  const linked = join(dirname(primary), "linked worktree");
  const git = (args: string[], input?: string): string => execFileSync("git", args, {
    cwd: primary,
    env: {
      ...box.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  }).trim();
  if (separateGitDir) mkdirSync(join(dirname(primary), "metadata"));
  git(["init", "--quiet", ...(separateGitDir
    ? ["--separate-git-dir", join(dirname(primary), "metadata", ".git")]
    : [])]);
  const tree = git(["hash-object", "-t", "tree", "--stdin", "-w"], "");
  const commit = git(["commit-tree", tree, "-m", "fixture"]);
  git(["worktree", "add", "--quiet", "--detach", linked, commit]);
  writeCheckout(primary, "primary");
  writeCheckout(linked, "branch");
  const cwd = join(linked, "nested project");
  mkdirSync(cwd);
  const databases = [WORKSPACE, SECONDARY].map(id => join(box.dataHome, "uberblick", `${id}.sqlite`));
  return {
    primary, linked, cwd, databases,
    env: {
      ...box.env,
      UB_AGENT_SESSION: "worktree-test",
      UB_LAUNCHER_TEST_DATABASES: JSON.stringify(databases),
    },
  };
}

function run(f: Fixture, root: string, args: string[], cwd = f.cwd) {
  return spawnSync(process.execPath, [launcher(root), ...args], {
    cwd, env: f.env, encoding: "utf8", timeout: 25_000,
  });
}

function schema(path: string): string[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
      .map(row => row.name as string).sort();
  } finally { database.close(); }
}

async function connect(f: Fixture, root: string, cwd: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(f.env)) {
    if (value !== undefined) env[key] = value;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher(root), "mcp", "serve"],
    cwd, env, stderr: "pipe",
  });
  const client = new Client({ name: "worktree-launcher-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    transport.stderr?.on("data", () => {});
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}

function toolValue(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  const content = result.content as { text: string }[];
  return JSON.parse(content[0]!.text);
}

describe("linked-worktree source launcher", () => {
  it.each([["mcp", "serve"], ["open"], ["status", "--json"]])(
    "uses primary code for %j before opening any replica, preserving the project and session",
    (...args: string[]) => {
      const f = fixture();
      const result = run(f, f.linked, args);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        source: "primary", cwd: f.cwd, args,
        configHome: f.env.XDG_CONFIG_HOME, session: "worktree-test",
      });
      for (const path of f.databases) expect(schema(path)).toEqual(["primary_schema_marker"]);
    },
  );

  it("uses the running launcher's checkout rather than the caller's linked worktree", () => {
    const f = fixture();
    const result = run(f, f.primary, ["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).source).toBe("primary");
    for (const path of f.databases) expect(schema(path)).toEqual(["primary_schema_marker"]);
  });

  it("allows only an explicit opt-in in that linked checkout to run branch code", () => {
    const f = fixture();
    writeFileSync(join(f.linked, ".uberblick-use-shared-replicas"), "");
    const result = run(f, f.linked, ["open"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).source).toBe("branch");
    for (const path of f.databases) expect(schema(path)).toEqual(["branch_schema_marker"]);
  });

  it("keeps the opt-in local to its own checkout", () => {
    const f = fixture();
    writeFileSync(join(f.primary, ".uberblick-use-shared-replicas"), "");
    const result = run(f, f.linked, ["mcp", "serve"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).source).toBe("primary");
  });

  it("uses the selected checkout's imports despite caller tsconfig aliases", () => {
    const f = fixture();
    const dependency = join(f.primary, "node_modules", "schema-owner");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "package.json"), '{"type":"module","main":"index.js"}\n');
    writeFileSync(join(dependency, "index.js"), 'export const owner = "primary";\n');
    const branchModule = join(f.linked, "schema-owner.ts");
    writeFileSync(branchModule, 'export const owner = "branch";\n');
    writeFileSync(join(f.primary, "packages", "cli", "src", "main.ts"),
      'import { owner } from "schema-owner"; process.stdout.write(JSON.stringify({ owner }) + "\\n");\n');
    const hostileConfig = join(f.cwd, "tsconfig.json");
    writeFileSync(hostileConfig, JSON.stringify({ compilerOptions: { paths: {
      "schema-owner": [branchModule],
    } } }));
    f.env.TSX_TSCONFIG_PATH = hostileConfig;
    const result = run(f, f.linked, ["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ owner: "primary" });
  });

  it("runs a primary checkout with a separate Git directory itself", () => {
    const f = fixture(true);
    const result = run(f, f.primary, ["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).source).toBe("primary");
    for (const path of f.databases) expect(schema(path)).toEqual(["primary_schema_marker"]);
  });

  it("refuses when Git cannot locate the primary checkout behind a separate Git directory", () => {
    const f = fixture(true);
    // Git lists the metadata directory's parent as primary rather than this checkout.
    const result = run(f, f.linked, ["status"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ub: cannot safely select primary checkout");
    for (const path of f.databases) expect(existsSync(path)).toBe(false);
  });

  it("retains unacknowledged corpus writes after the linked worktree is removed", async () => {
    const f = fixture();
    delete f.env.UB_LAUNCHER_TEST_DATABASES;
    writeFileSync(join(f.primary, "packages", "cli", "src", "main.ts"),
      `await import(${JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "src", "main.ts")).href)});\n`);
    const binding = JSON.stringify({ workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL });
    writeFileSync(join(f.cwd, ".uberblick.json"), binding);
    writeFileSync(join(f.primary, ".uberblick.json"), binding);
    const config = join(f.env.XDG_CONFIG_HOME!, "uberblick");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "credentials.json"), '{"signingSecret":"worktree-test-secret"}', { mode: 0o600 });
    writeFileSync(join(config, "workspaces.json"), JSON.stringify({ [WORKSPACE]: DEAD_HUB_URL }));
    const branchModule = join(f.linked, "branch-schema.ts");
    writeFileSync(branchModule, 'throw new Error("Branch schema module must not load");\n');
    const hostileConfig = join(f.cwd, "tsconfig.json");
    writeFileSync(hostileConfig, JSON.stringify({ compilerOptions: { paths: {
      "@uberblick/schema": [branchModule],
      "@uberblick/schema/*": [branchModule],
      "@uberblick/mcp-server": [branchModule],
      "@uberblick/mcp-server/*": [branchModule],
    } } }));
    f.env.TSX_TSCONFIG_PATH = hostileConfig;

    const session = await connect(f, f.linked, f.cwd);
    try {
      const created = toolValue(await session.callTool({ name: "create_doc", arguments: {
        title: "Pending worktree document", description: "Retained after the checkout is removed.",
      } }));
      expect(created.applied).toBe(true);
      expect(created.synced).toBe(false);
      const status = toolValue(await session.callTool({ name: "sync_status", arguments: {} }));
      expect(status.database).toBe(f.databases[0]);
      expect(status.hub.url).toBe(DEAD_HUB_URL);
    } finally { await session.close(); }

    execFileSync("git", ["-C", f.primary, "worktree", "remove", "--force", f.linked], { env: f.env });
    expect(existsSync(f.linked)).toBe(false);
    const status = run(f, f.primary, ["status", "--json"], f.primary);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).pending.count).toBeGreaterThan(0);

    const reopened = await connect(f, f.primary, f.primary);
    try {
      const listing = toolValue(await reopened.callTool({ name: "list_docs", arguments: {} }));
      expect(listing.docs.map((doc: { title: string }) => doc.title)).toContain("Pending worktree document");
    } finally { await reopened.close(); }
  });

  it("refuses a missing primary launcher without falling back to branch code", () => {
    const f = fixture();
    rmSync(launcher(f.primary));
    const result = run(f, f.linked, ["status"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ub: cannot safely select primary checkout");
    expect(result.stderr).toContain("restore/setup the primary checkout");
    for (const path of f.databases) expect(existsSync(path)).toBe(false);
  });

  it("refuses a non-file opt-in without loading either schema-bearing entry", () => {
    const f = fixture();
    mkdirSync(join(f.linked, ".uberblick-use-shared-replicas"));
    const result = run(f, f.linked, ["open"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    for (const path of f.databases) expect(existsSync(path)).toBe(false);
  });
});
