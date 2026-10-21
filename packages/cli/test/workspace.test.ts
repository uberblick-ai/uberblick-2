/** Project selection never borrows a workspace's hub from another binding. */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { writeHubLogin, removeHubLogin } from "@uberblick/mcp-server/auth-store";
import { resolveMcpConfig, storeWorkspaceName } from "@uberblick/mcp-server";
import { acquireServingReplicaRole } from "../../mcp-server/src/serving-role.js";
import { startServer, testConfig } from "../../mcp-server/test/helpers.js";
import { resolveConfig } from "@uberblick/mcp-server/project-config";
import { readWorkspaceHub, workspaceRegistryPath } from "@uberblick/mcp-server/workspace-registry";
import { acquireInitLock } from "@uberblick/mcp-server/init-lock";
import { removeTempDirs, runUb, runUbAsync, sandbox, unboundSandbox, type Sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";
import { fixture } from "./auth-fixtures.js";

afterAll(removeTempDirs);
const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";
const OTHER = "4d8e0000-1111-4222-8333-444455556666";
const UNRELATED = "b7c3d914-5a20-4e6f-8d13-9f04a2c68e75";
const HUB = "wss://hub.example.test/ws";

function bind(box: Sandbox, workspaceId = WORKSPACE, hubUrl: string | null = HUB): void {
  writeFileSync(join(box.cwd, ".uberblick.json"), JSON.stringify({ workspaceId, hubUrl }));
}
function binding(box: Sandbox): { workspaceId: string; hubUrl: string | null } {
  return JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"));
}
function record(box: Sandbox, id: string, hub: string | null): void {
  const path = workspaceRegistryPath(box.env);
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...current, [id]: hub }));
}
function withDatabase(box: Sandbox, uuid: string): void {
  const dir = join(box.dataHome, "uberblick");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.sqlite`), "", "utf8");
}

it("workspace use remembers device admission after logout and never clears another hub's mode", async () => {
  const endpoint = "ws://localhost:8080/ws";
  const otherEndpoint = "ws://localhost:8081/ws";
  const box = sandbox({ credentials: { signingSecret: "synthetic-local-secret" } });
  await writeHubLogin("http://localhost:8080", {
    identity: { id: WORKSPACE, githubAccountId: "12345", githubUsername: "synthetic-person" },
    credential: { record: { id: WORKSPACE, principalId: WORKSPACE, deviceId: OTHER,
      workspaces: [WORKSPACE], issuedAt: 0, revokedAt: null }, key: fixture().credential.key },
  }, box.env);
  record(box, WORKSPACE, endpoint);
  record(box, OTHER, otherEndpoint);
  const selected = await runInProcess(["workspace", "use", WORKSPACE], box);
  expect(selected.status, selected.output).toBe(0);
  await removeHubLogin("http://localhost:8080", box.env);
  const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
  expect(resolved.env.HUB_ADMISSION).toBe("device");
  expect(resolved.env.HUB_AUTH_TOKEN).toBeUndefined();
  const next = await runInProcess(["workspace", "use", OTHER], box);
  expect(next.status, next.output).toBe(0);
  expect(resolveConfig({ env: box.env, cwd: box.cwd }).env.HUB_ADMISSION).toBeUndefined();
  const previous = resolveConfig({ env: { ...box.env, UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: endpoint }, cwd: box.cwd });
  expect(previous.env.HUB_ADMISSION).toBe("device");
  expect(previous.env.HUB_AUTH_TOKEN).toBeUndefined();
});

describe("ub workspace list", () => {
  it.each([{}, { workspace: WORKSPACE, hubUrl: HUB }])("prints one neutral selection note with machine settings %j", async (userConfig) => {
    const box = unboundSandbox({ userConfig });
    withDatabase(box, WORKSPACE);
    withDatabase(box, UNRELATED);
    const entries = [WORKSPACE, UNRELATED].map(uuid => ({
      uuid, name: null, active: false,
      databasePath: join(box.dataHome, "uberblick", `${uuid}.sqlite`), hub: "local",
    }));
    for (const json of [false, true]) {
      const run = runUb(["workspace", "list", ...(json ? ["--json"] : [])], box);
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toBe(json ? `${JSON.stringify(entries, null, 2)}\n`
        : `  ${WORKSPACE} |  | local\n  ${UNRELATED} |  | local\n`);
      expect(run.stderr).toBe("No workspace selected (no .uberblick.json found).\n");
    }
  });

  it.each(["invalid machine config", "exposed credentials"])("retains %s warnings beside the selection note", async (kind) => {
    const box = unboundSandbox(kind === "invalid machine config"
      ? { raw: { userConfig: "{invalid" } }
      : { userConfig: { workspace: WORKSPACE, hubUrl: HUB }, credentials: { signingSecret: "synthetic-secret" }, credentialsMode: 0o644 });
    for (const args of [[], ["--json"]]) {
      const run = await runInProcess(["workspace", "list", ...args], box);
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toBe(args.length === 0
        ? "no workspaces on this machine — run `ub workspace create <name>` to create one\n" : "[]\n");
      expect(run.stderr).toContain("No workspace selected (no .uberblick.json found).\n");
      expect(run.stderr).toContain(kind === "invalid machine config"
        ? `ub: warning: ignoring ${join(box.configHome, "uberblick", "config.json")}: invalid JSON\n`
        : `ub: warning: refusing ${join(box.configHome, "uberblick", "credentials.json")}: mode 0644`);
      expect(run.stderr).not.toContain("Legacy machine");
      expect(run.stderr).not.toContain("synthetic-secret");
    }
  });

  it.each([
    [{ UB_WORKSPACE_ID: "invalid", UB_HUB_URL: "local" }, /environment binding: workspaceId must be a workspace id/],
    [{ UB_HUB_URL: HUB }, /UB_HUB_URL requires a non-empty UB_WORKSPACE_ID/],
    [{ UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "" }, /UB_HUB_URL must not be empty/],
    [{ UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "file:///invalid" }, /that is not a websocket endpoint/],
    [{ WORKSPACE_ID: WORKSPACE }, /Legacy WORKSPACE_ID \/ HUB_URL selection is no longer supported/],
    [{ HUB_URL: HUB }, /Legacy WORKSPACE_ID \/ HUB_URL selection is no longer supported/],
  ])("keeps invalid selection %j as an error", async (env, diagnostic) => {
    const box = unboundSandbox({ userConfig: { workspace: WORKSPACE, hubUrl: HUB } });
    for (const args of [[], ["--json"]]) {
      const run = await runInProcess(["workspace", "list", ...args], box, env);
      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/^ub workspace list: /);
      expect(run.stderr).toMatch(diagnostic);
      expect(run.stderr).not.toContain("No workspace selected");
      expect(run.stderr).not.toContain("ub: warning:");
    }
  });

  it.each(["invalid JSON", "directory"])("refuses an owned binding containing %s without a selection note", async (kind) => {
    const box = unboundSandbox();
    const path = join(box.cwd, ".uberblick.json");
    if (kind === "directory") mkdirSync(path);
    else writeFileSync(path, "{invalid");
    for (const args of [[], ["--json"]]) {
      const run = await runInProcess(["workspace", "list", ...args], box);
      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(`ub workspace list: Cannot read ${path}: expected a regular file containing valid JSON\n`);
    }
  });

  it("unions database IDs with the explicitly selected workspace", async () => {
    const box = sandbox();
    bind(box);
    withDatabase(box, UNRELATED);
    const text = await runInProcess(["workspace", "list"], box);
    expect(text.status, text.output).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toBe(`* ${WORKSPACE} |  | https://hub.example.test\n  ${UNRELATED} |  | local\n`);
    const run = await runInProcess(["workspace", "list", "--json"], box);
    expect(run.status, run.output).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual([
      { uuid: WORKSPACE, name: null, active: true, databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`), hub: HUB },
      { uuid: UNRELATED, name: null, active: false, databasePath: join(box.dataHome, "uberblick", `${UNRELATED}.sqlite`), hub: "local" },
    ]);
    expect(existsSync(join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`))).toBe(false);
  });

  it("shows local names beside full IDs and preserves JSON parity and selection", async () => {
    const box = sandbox({ userConfig: { displayName: "Synthetic operator" } });
    bind(box);
    const named = [[WORKSPACE, "Project notes"], [OTHER, "Research notes"]] as const;
    for (const [uuid, name] of named) {
      storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: uuid }), name);
    }
    withDatabase(box, UNRELATED);
    record(box, WORKSPACE, HUB);
    record(box, OTHER, null);
    // A record alone does not add a workspace to this command's inventory.
    record(box, "00000000-1111-4222-8333-444455556666", HUB);
    const configPath = join(box.configHome, "uberblick", "config.json");
    const bindingBefore = readFileSync(join(box.cwd, ".uberblick.json"));
    const configBefore = readFileSync(configPath);
    const recordsBefore = readFileSync(workspaceRegistryPath(box.env));
    const databaseIds = [...named.map(([uuid]) => uuid), UNRELATED];
    const databaseBefore = databaseIds.map((uuid) =>
      readFileSync(join(box.dataHome, "uberblick", `${uuid}.sqlite`)));

    // Any network attempt fails in the real CLI process, including a websocket.
    const preload = join(box.cwd, "no-network.mjs");
    writeFileSync(preload, `
import { Socket } from "node:net";
Socket.prototype.connect = () => { throw new Error("list must stay local"); };
globalThis.fetch = () => { throw new Error("list must stay local"); };
`);
    const env = { NODE_OPTIONS: `--import=${preload}` };
    const text = runUb(["workspace", "list"], box, env);
    expect(text.status, text.output).toBe(0);
    expect(text.stdout).toBe(
      `  ${OTHER} | Research notes | local\n* ${WORKSPACE} | Project notes  | https://hub.example.test\n  ${UNRELATED} |                | local\n`,
    );
    const json = runUb(["workspace", "list", "--json"], box, env);
    expect(json.status, json.output).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([
      { uuid: OTHER, name: "Research notes", active: false, databasePath: join(box.dataHome, "uberblick", `${OTHER}.sqlite`), hub: "local" },
      { uuid: WORKSPACE, name: "Project notes", active: true, databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`), hub: HUB },
      { uuid: UNRELATED, name: null, active: false, databasePath: join(box.dataHome, "uberblick", `${UNRELATED}.sqlite`), hub: "local" },
    ]);
    expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(bindingBefore);
    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(recordsBefore);
    expect(databaseIds.map((uuid) => readFileSync(join(box.dataHome, "uberblick", `${uuid}.sqlite`))))
      .toEqual(databaseBefore);
  });

  it.each([
    ["wss://Hub.Example.test:443/ws", "https://hub.example.test"],
    ["ws://localhost:8080/proxy//ws", "http://localhost:8080/proxy//ws"],
    [null, "local"],
  ] as const)("shows the active workspace's recorded %s hub independently of selection", async (hub, display) => {
    const box = sandbox();
    bind(box, `notes-${WORKSPACE}`);
    record(box, WORKSPACE, hub);
    const before = readFileSync(workspaceRegistryPath(box.env));
    for (const env of [{}, { UB_WORKSPACE_ID: `notes-${WORKSPACE}`, UB_HUB_URL: "wss://override.example.test/ws" }]) {
      const text = await runInProcess(["workspace", "list"], box, env);
      expect(text.status, text.output).toBe(0);
      expect(text.stderr).toBe("");
      expect(text.stdout).toBe(`* ${WORKSPACE} |  | ${display}\n`);
      const json = await runInProcess(["workspace", "list", "--json"], box, env);
      expect(json.status, json.output).toBe(0);
      expect(json.stderr).toBe("");
      expect(JSON.parse(json.stdout)).toEqual([
        { uuid: WORKSPACE, name: null, active: true, databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`), hub: hub ?? "local" },
      ]);
    }
    expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(before);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it("lists the configured workspace without creating a data directory", async () => {
    const box = sandbox();
    bind(box);
    const run = await runInProcess(["workspace", "list"], box, { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local" });
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toBe(`* ${WORKSPACE} |  | local\n`);
    expect(existsSync(box.dataHome)).toBe(false);
    expect(existsSync(workspaceRegistryPath(box.env))).toBe(false);
  });

  it.each([HUB, null])("shows an active unrecorded replica as local despite a %s selection without registering it", async (hub) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: hub } });
    withDatabase(box, WORKSPACE);
    const text = await runInProcess(["workspace", "list"], box);
    expect(text.status, text.output).toBe(0);
    expect(text.stdout).toBe(`* ${WORKSPACE} |  | local\n`);
    const json = await runInProcess(["workspace", "list", "--json"], box);
    expect(json.status, json.output).toBe(0);
    expect(JSON.parse(json.stdout)[0].hub).toBe("local");
    expect(existsSync(workspaceRegistryPath(box.env))).toBe(false);
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: hub });
  });

  it.each(["unnamed", "empty", "old schema", "unreadable"])(
    "keeps a %s replica in the list and workspace use prefix resolution",
    async (kind) => {
      const box = sandbox();
      bind(box);
      withDatabase(box, OTHER);
      const path = join(box.dataHome, "uberblick", `${OTHER}.sqlite`);
      if (kind === "unreadable") writeFileSync(path, "not a SQLite database");
      if (kind === "old schema" || kind === "unnamed") {
        const db = new DatabaseSync(path);
        try {
          db.exec("CREATE TABLE updates (seq INTEGER PRIMARY KEY, room TEXT, payload BLOB)");
          if (kind === "unnamed") {
            db.exec("CREATE TABLE snapshots (room TEXT PRIMARY KEY, state BLOB, through_seq INTEGER)");
          }
        } finally {
          db.close();
        }
      }
      const before = readFileSync(path);
      const list = await runInProcess(["workspace", "list", "--json"], box);
      expect(list.status, list.output).toBe(0);
      expect(JSON.parse(list.stdout)).toEqual([
        { uuid: OTHER, name: null, active: false, databasePath: path, hub: "local" },
        { uuid: WORKSPACE, name: null, active: true, databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`), hub: HUB },
      ]);
      expect(readFileSync(path)).toEqual(before);
      const selected = await runInProcess(["workspace", "use", OTHER.slice(0, 8)], box);
      expect(selected.status, selected.output).toBe(0);
      expect(binding(box).workspaceId).toBe(OTHER);
    },
  );

  it.each(["malformed JSON", "invalid hub", "unreadable"])("refuses %s records before stdout, even with no workspaces", async (kind) => {
    for (const configured of [false, true]) {
      const box = unboundSandbox({ userConfig: { displayName: "Synthetic operator" } });
      const protectedPaths = [join(box.configHome, "uberblick", "config.json")];
      if (configured) {
        bind(box);
        withDatabase(box, OTHER);
        protectedPaths.push(join(box.cwd, ".uberblick.json"), join(box.dataHome, "uberblick", `${OTHER}.sqlite`));
      }
      const registry = workspaceRegistryPath(box.env);
      if (kind === "unreadable") {
        mkdirSync(registry);
        protectedPaths.push(join(registry, "untouched"));
        writeFileSync(join(registry, "untouched"), "synthetic-sensitive-value");
      } else {
        writeFileSync(registry, kind === "malformed JSON" ? "{synthetic-sensitive-value"
          : JSON.stringify({ [WORKSPACE]: HUB, [UNRELATED]: "wss://hub.example.test/ws?token=synthetic-sensitive-value" }));
        protectedPaths.push(registry);
      }
      const before = protectedPaths.map(path => readFileSync(path));
      for (const args of [[], ["--json"]]) {
        const run = await runInProcess(["workspace", "list", ...args], box);
        expect(run.status, run.output).toBe(1);
        expect(run.stdout).toBe("");
        expect(run.stderr).toBe(kind === "unreadable"
          ? `ub workspace list: Cannot read workspace records at ${registry}: expected a regular JSON file\n`
          : `ub workspace list: Invalid workspace records at ${registry}: expected a UUID-to-hub map (null for local)\n`);
      }
      expect(protectedPaths.map(path => readFileSync(path))).toEqual(before);
    }
  });

  it("prints a plain install entry independently of invalid workspace records", async () => {
    const box = sandbox();
    withDatabase(box, OTHER);
    const registry = workspaceRegistryPath(box.env);
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, "{invalid");
    const installed = await runInProcess([
      "mcp", "install", "claude", "--print",
    ], box);
    expect(installed.status, installed.output).toBe(0);
    expect(JSON.parse(installed.stdout)).toEqual({ mcpServers: {
      uberblick: { command: "ub", args: ["mcp", "serve"] },
    } });
    expect(readFileSync(registry, "utf8")).toBe("{invalid");
  });

  it.each(["list", "use"])("explains the local fallback without reading records for %s help", async (command) => {
    const box = sandbox();
    const registry = workspaceRegistryPath(box.env);
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, "{invalid");
    const run = await runInProcess(["workspace", command, "--help"], box);
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain("hub this machine recorded");
    expect(run.stdout).toContain("no hub record");
    expect(run.stdout).toContain("local");
    expect(run.stdout).not.toContain("unknown");
    expect(run.stdout).not.toContain("UB_HUB_URL=local ub mcp serve");
    expect(run.stderr).toBe("");
  });

  it("refuses an unreadable database directory instead of resolving against a short list", async () => {
    const box = sandbox();
    mkdirSync(box.dataHome, { recursive: true });
    writeFileSync(join(box.dataHome, "uberblick"), "not a directory");
    const run = await runInProcess(["workspace", "list"], box);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(join(box.dataHome, "uberblick"));
  });
});

describe("ub workspace remove", () => {
  function databasePath(box: Sandbox, uuid = OTHER): string {
    return join(box.dataHome, "uberblick", `${uuid}.sqlite`);
  }

  function replicaFiles(box: Sandbox, uuid = OTHER): string[] {
    return ["", "-wal", "-shm", ".serving-lock"].map(suffix => `${databasePath(box, uuid)}${suffix}`);
  }

  function terminal(box: Sandbox, operand: string, answer: string): ReturnType<typeof runUbAsync> {
    const preload = join(box.cwd, "remove-terminal.mjs");
    writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const readline = require("node:readline/promises");
Object.defineProperty(process.stdin, "isTTY", { value: true });
readline.createInterface = () => ({
  question: async (prompt) => { process.stderr.write(prompt); return ${JSON.stringify(answer)}; },
  close: () => {},
});
syncBuiltinESMExports();
`, "utf8");
    return runUbAsync(["workspace", "remove", operand], box, {
      NODE_OPTIONS: `${box.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
    });
  }

  it.each([OTHER, `notes-${OTHER}`, OTHER.slice(0, 8)])("removes %s and its sidecars without changing other state", async operand => {
    const box = sandbox({
      userConfig: { displayName: "Synthetic operator", hubAdmissions: { [HUB]: "device" } },
      credentials: { hubLogins: { "https://hub.example.test": fixture([OTHER]) } },
    });
    bind(box);
    record(box, WORKSPACE, HUB);
    record(box, OTHER, HUB);
    record(box, UNRELATED, null);
    withDatabase(box, OTHER);
    withDatabase(box, UNRELATED);
    for (const path of replicaFiles(box).slice(1)) writeFileSync(path, "");
    const otherProject = join(box.cwd, "other-project", ".uberblick.json");
    mkdirSync(dirname(otherProject), { recursive: true });
    writeFileSync(otherProject, JSON.stringify({ workspaceId: OTHER, hubUrl: HUB }));
    const protectedPaths = [
      join(box.cwd, ".uberblick.json"), otherProject,
      join(box.configHome, "uberblick", "config.json"),
      join(box.configHome, "uberblick", "credentials.json"), databasePath(box, UNRELATED),
    ];
    const before = protectedPaths.map(path => readFileSync(path));
    const run = await runInProcess(["workspace", "remove", operand, "--yes"], box);
    expect(run.status, run.output).toBe(0);
    expect(replicaFiles(box).map(path => existsSync(path))).toEqual([false, false, false, false]);
    expect(readWorkspaceHub(OTHER, box.env)).toBeUndefined();
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBe(HUB);
    expect(readWorkspaceHub(UNRELATED, box.env)).toBeNull();
    expect(protectedPaths.map(path => readFileSync(path))).toEqual(before);
    const listed = await runInProcess(["workspace", "list", "--json"], box);
    expect(listed.status, listed.output).toBe(0);
    expect(JSON.parse(listed.stdout).map((entry: { uuid: string }) => entry.uuid)).not.toContain(OTHER);
    const selected = await runInProcess(["workspace", "use", OTHER], box);
    expect(selected.status, selected.output).toBe(1);
    expect(selected.stderr).toContain("ub workspace use <link>");
    expect(protectedPaths.map(path => readFileSync(path))).toEqual(before);
  });

  it.each(["database only", "record only"])("resolves a unique prefix from a %s workspace", async source => {
    const box = sandbox();
    if (source === "database only") withDatabase(box, OTHER);
    else record(box, OTHER, null);
    const run = await runInProcess(["workspace", "remove", OTHER.slice(0, 8), "--yes"], box);
    expect(run.status, run.output).toBe(0);
    expect(existsSync(databasePath(box))).toBe(false);
    expect(readWorkspaceHub(OTHER, box.env)).toBeUndefined();
  });

  it("refuses invalid, unknown and ambiguous operands using the complete inventory", async () => {
    const box = sandbox();
    withDatabase(box, WORKSPACE);
    record(box, OTHER, null);
    const files = [databasePath(box, WORKSPACE), workspaceRegistryPath(box.env), join(box.cwd, ".uberblick.json")];
    const before = files.map(path => readFileSync(path));
    for (const [operand, status, message] of [
      ["my-notes", 2, "not a workspace id"],
      ["ffff", 2, "ub workspace use <link>"],
      [UNRELATED, 1, "ub workspace use <link>"],
      ["4d8e", 2, "matches 2"],
    ] as const) {
      const run = await runInProcess(["workspace", "remove", operand, "--yes"], box);
      expect(run.status, run.output).toBe(status);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain(message);
      if (operand === "4d8e") {
        expect(run.stderr).toContain(WORKSPACE);
        expect(run.stderr).toContain(OTHER);
      }
      expect(files.map(path => readFileSync(path))).toEqual(before);
    }
  });

  it.each(["project", "environment"])("refuses the workspace selected by %s even with --yes", async selection => {
    const box = sandbox();
    bind(box, `notes-${WORKSPACE}`);
    const target = selection === "project" ? WORKSPACE : OTHER;
    withDatabase(box, target);
    record(box, target, null);
    const files = [databasePath(box, target), workspaceRegistryPath(box.env), join(box.cwd, ".uberblick.json")];
    const env = selection === "environment" ? { UB_WORKSPACE_ID: `notes-${OTHER}`, UB_HUB_URL: "local" } : {};
    const status = await runInProcess(["status"], box, env);
    expect(status.stdout).toContain(target);
    const before = files.map(path => readFileSync(path));
    const run = await runInProcess(["workspace", "remove", target, "--yes"], box, env);
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain("ub workspace use");
    expect(run.stderr).toMatch(/another workspace|different workspace/);
    expect(files.map(path => readFileSync(path))).toEqual(before);
  });

  it("allows removing a project binding's workspace when the environment selects another one", async () => {
    const box = sandbox();
    bind(box, WORKSPACE);
    withDatabase(box, WORKSPACE);
    record(box, WORKSPACE, HUB);
    record(box, OTHER, null);
    const before = readFileSync(join(box.cwd, ".uberblick.json"));
    const run = await runInProcess(["workspace", "remove", WORKSPACE, "--yes"], box, {
      UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "local",
    });
    expect(run.status, run.output).toBe(0);
    expect(existsSync(databasePath(box, WORKSPACE))).toBe(false);
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBeUndefined();
    expect(readWorkspaceHub(OTHER, box.env)).toBeNull();
    expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(before);
  });

  it("does not delete a replica when malformed records make the inventory incomplete", async () => {
    const box = sandbox();
    withDatabase(box, OTHER);
    const registry = workspaceRegistryPath(box.env);
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, "{broken");
    const run = await runInProcess(["workspace", "remove", OTHER.slice(0, 8), "--yes"], box);
    expect(run.status, run.output).toBe(1);
    expect(existsSync(databasePath(box))).toBe(true);
    expect(readFileSync(registry, "utf8")).toBe("{broken");
  });

  it("keeps the running serving replica and its lock intact until it closes", async () => {
    const box = sandbox();
    record(box, OTHER, null);
    storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: OTHER }), "Served notes");
    const path = databasePath(box);
    const role = acquireServingReplicaRole(path, { pid: process.pid, sessionId: "remove-test-serving-session" });
    const registry = readFileSync(workspaceRegistryPath(box.env));
    // Closing a separate file descriptor in the holder would release its POSIX lock.
    const lockFile = statSync(`${path}.serving-lock`);
    try {
      const run = await runUbAsync(["workspace", "remove", OTHER, "--yes"], box);
      expect(run.status, run.output).toBe(1);
      expect(run.stderr).toMatch(/serving|ub open/);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(registry);
      expect(statSync(`${path}.serving-lock`).ino).toBe(lockFile.ino);
      expect(() => acquireServingReplicaRole(path, { pid: process.pid, sessionId: "contender" })).toThrow(/already held/);
    } finally {
      role.close();
    }
    const removed = await runInProcess(["workspace", "remove", OTHER, "--yes"], box);
    expect(removed.status, removed.output).toBe(0);
    expect(replicaFiles(box).some(path => existsSync(path))).toBe(false);
  });

  it("removes a copy with live MCP sessions and refuses all their later writes without recreating it", async () => {
    const box = sandbox();
    record(box, OTHER, null);
    const config = testConfig({ workspaceId: OTHER, databasePath: databasePath(box) });
    const first = await startServer(config);
    const sessions = [first];
    try {
      await first.ok("create_doc", { title: "Before removal", description: "A document saved before this computer removes its workspace." });
      sessions.push(await startServer(config));
      const removed = await runUbAsync(["workspace", "remove", OTHER, "--yes"], box);
      expect(removed.status, removed.output).toBe(0);
      expect(replicaFiles(box).some(path => existsSync(path))).toBe(false);
      expect(readWorkspaceHub(OTHER, box.env)).toBeUndefined();
      for (const session of sessions) {
        for (const title of ["Next write", "Later write"]) {
          const refused = await session.call("create_doc", { title, description: "An attempted write after this computer removed its workspace." });
          expect(refused.isError).toBe(true);
          expect(refused.payload).toMatchObject({ applied: false, error: "workspace_removed" });
          expect(refused.payload.message).toMatch(/workspace.*removed from this computer/i);
        }
      }
    } finally {
      for (const session of sessions) await session.close();
    }
    expect(replicaFiles(box).some(path => existsSync(path))).toBe(false);
    expect(readWorkspaceHub(OTHER, box.env)).toBeUndefined();
  });

  it("requires --yes without a terminal and asks nothing", async () => {
    const box = sandbox();
    withDatabase(box, OTHER);
    record(box, OTHER, null);
    const before = readFileSync(workspaceRegistryPath(box.env));
    const run = await runInProcess(["workspace", "remove", OTHER], box);
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain("--yes");
    expect(run.output).not.toContain("[y/N]");
    expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(before);
    expect(existsSync(databasePath(box))).toBe(true);
  });

  it.each(["", "n", "no", "sure", "y", "YeS"])("only y or yes authorizes terminal deletion: %j", async answer => {
    const box = sandbox();
    withDatabase(box, OTHER);
    record(box, OTHER, null);
    const run = await terminal(box, OTHER, answer);
    expect(run.stderr).toContain("[y/N]");
    const approved = /^(y|yes)$/i.test(answer);
    expect(existsSync(databasePath(box))).toBe(!approved);
    expect(readWorkspaceHub(OTHER, box.env)).toBe(approved ? undefined : null);
    if (approved) expect(run.status, run.output).toBe(0);
  });

  it.each(["shared", "shared pending", "local", "unknown"])("explains the %s copy's loss before asking", async kind => {
    const box = sandbox();
    bind(box, WORKSPACE, "wss://override.example.test/ws");
    if (kind !== "unknown") record(box, OTHER, kind === "local" ? null : HUB);
    storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: OTHER }), "Disposable notes");
    if (kind !== "shared pending") {
      const database = new DatabaseSync(databasePath(box));
      try { database.exec("DELETE FROM pending_rooms"); }
      finally { database.close(); }
    }
    const registry = workspaceRegistryPath(box.env);
    const before = existsSync(registry) ? readFileSync(registry) : null;
    const run = await terminal(box, OTHER, "no");
    expect(run.stderr).toContain("[y/N]");
    expect(run.stderr).toContain(OTHER);
    if (kind.startsWith("shared")) {
      expect(run.stderr).toContain("hub keeps");
      expect(run.stderr).toContain("ub workspace use");
      expect(run.stderr).toContain(`https://hub.example.test/${OTHER}`);
      expect(run.stderr).not.toContain("override.example.test");
      if (kind === "shared pending") {
        expect(run.stderr).toMatch(/local changes.*not acknowledged/is);
        expect(run.stderr).toContain("lost");
      }
    } else if (kind === "local") {
      expect(run.stderr).toContain("only copy");
    } else {
      expect(run.stderr).toContain("cannot tell");
      expect(run.stderr).toContain("may be the only copy");
    }
    expect(existsSync(databasePath(box))).toBe(true);
    expect(existsSync(registry) ? readFileSync(registry) : null).toEqual(before);
  });

  it("prints missing-operand help on stderr and lets help bypass malformed state", async () => {
    const box = sandbox({ raw: { projectBinding: "{broken" } });
    const registry = workspaceRegistryPath(box.env);
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, "{broken");
    const bare = await runInProcess(["workspace", "remove"], box);
    expect(bare.status, bare.output).toBe(2);
    expect(bare.stdout).toBe("");
    expect(bare.stderr).toContain("usage: ub workspace remove");
    expect(bare.stderr).toContain("--yes");
    for (const args of [["--help"], [OTHER, "--yes", "--help"]]) {
      const run = await runInProcess(["workspace", "remove", ...args], box);
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain("usage: ub workspace remove");
      expect(run.stderr).toBe("");
    }
    const group = await runInProcess(["workspace"], box);
    expect(group.stdout).toMatch(/^\s+remove\b/m);
    expect(readFileSync(registry, "utf8")).toBe("{broken");
    expect(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).toBe("{broken");
    expect(existsSync(box.dataHome)).toBe(false);
  });
});

describe("ub workspace use", () => {
  it("never saves an environment hub when only changing project workspace spelling", async () => {
    const box = sandbox();
    bind(box);
    record(box, WORKSPACE, HUB);
    const run = await runInProcess(["workspace", "use", `docs-${WORKSPACE}`], box, {
      UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "wss://override.example.test/ws",
    });
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: `docs-${WORKSPACE}`, hubUrl: HUB });
    expect(run.stderr).toContain("takes precedence");
  });

  it("requires a record even when the requested UUID matches a complete environment override", async () => {
    const box = sandbox();
    bind(box);
    const run = await runInProcess(["workspace", "use", `docs-${OTHER}`], box, {
      UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "wss://override.example.test/ws",
    });
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain("ub workspace use <link>");
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
  });

  it.each([WORKSPACE, `notes-${WORKSPACE}`, WORKSPACE.slice(0, 8), OTHER])("selects and records an unrecorded replica as local by %s without hub traffic", async (operand) => {
    const box = sandbox();
    bind(box);
    const id = operand === OTHER ? OTHER : WORKSPACE;
    withDatabase(box, id);
    const preload = join(box.cwd, "no-network.mjs");
    writeFileSync(preload, `
import { Socket } from "node:net";
Socket.prototype.connect = () => { throw new Error("use by id must stay local"); };
globalThis.fetch = () => { throw new Error("use by id must stay local"); };
`);
    const run = runUb(["workspace", "use", operand], box, { NODE_OPTIONS: `--import=${preload}` });
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain("local)");
    expect(run.stderr).toBe("");
    expect(binding(box)).toEqual({ workspaceId: operand.startsWith("notes-") ? operand : id, hubUrl: null });
    expect(readWorkspaceHub(id, box.env)).toBeNull();
  });

  it("still refuses to switch away from a different unrecorded replica selected on a hub", async () => {
    const box = sandbox();
    bind(box);
    withDatabase(box, WORKSPACE);
    withDatabase(box, OTHER);
    const run = await runInProcess(["workspace", "use", OTHER], box);
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain("existing replica with no hub record");
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
    expect(existsSync(workspaceRegistryPath(box.env))).toBe(false);
  });

  it("updates both fields together and preserves the unrelated user configuration", async () => {
    const userConfig = { workspace: WORKSPACE, hubUrl: HUB, displayName: "Synthetic operator" };
    const box = sandbox({ userConfig });
    bind(box);
    record(box, OTHER, "wss://other.example.test/ws");
    const run = await runInProcess(["workspace", "use", OTHER], box);
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: OTHER, hubUrl: "wss://other.example.test/ws" });
    expect(JSON.parse(readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"))).toEqual({
      ...userConfig,
      hubAdmissions: { "wss://other.example.test/ws": "device" },
    });
  });

  it("retains the selected destination when only changing its decorated spelling", async () => {
    const box = sandbox();
    bind(box);
    record(box, WORKSPACE, HUB);
    const run = await runInProcess(["workspace", "use", `docs-${WORKSPACE}`], box);
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: `docs-${WORKSPACE}`, hubUrl: HUB });
    expect(run.stdout).toBe(
      `using      docs-${WORKSPACE} (https://hub.example.test)\n` +
      `wrote      ${join(box.cwd, ".uberblick.json")}\n`,
    );
    expect(run.stdout).not.toContain("previous");
    expect(run.stdout).not.toContain("switch back with:");
  });

  it("uses a recorded local workspace even without a database", async () => {
    const box = unboundSandbox();
    record(box, UNRELATED, null);
    const run = await runInProcess(["workspace", "use", UNRELATED.slice(0, 8)], box);
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: UNRELATED, hubUrl: null });
    expect(run.stdout).toBe(
      `using      ${UNRELATED} (local)\nwrote      ${join(box.cwd, ".uberblick.json")}\n`,
    );
    expect(run.stderr).toBe("");
  });

  it("prints the named selections and an id command that restores the previous binding", async () => {
    const box = sandbox();
    bind(box);
    record(box, WORKSPACE, HUB);
    record(box, OTHER, null);
    storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE }), "Project notes");
    storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: OTHER }), "Research notes");

    const selected = await runInProcess(["workspace", "use", OTHER.slice(0, 8)], box);
    expect(selected.status, selected.output).toBe(0);
    expect(selected.stdout).toBe(
      `using      Research notes (${OTHER}, local)\n` +
      `wrote      ${join(box.cwd, ".uberblick.json")}\n` +
      `previous   Project notes (${WORKSPACE}, https://hub.example.test)\n` +
      `switch back with: ub workspace use ${WORKSPACE}\n`,
    );
    expect(selected.stderr).toBe("");
    // Running exactly what it printed restores the entire recorded pair.
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBe(HUB);
    const registryBeforeRecovery = readFileSync(workspaceRegistryPath(box.env));
    const command = selected.stdout.split("switch back with: ub ")[1]?.trim();
    expect(command).toBeDefined();
    const recovered = await runInProcess(command!.split(" "), box);
    expect(recovered.status, recovered.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
    expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(registryBeforeRecovery);
  });

  it("writes the nearest binding and reports that path from a descendant directory", async () => {
    const box = sandbox();
    bind(box, WORKSPACE, null);
    record(box, OTHER, null);
    const nested = join(box.cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const selected = await runInProcess(["workspace", "use", OTHER], { ...box, cwd: nested });
    expect(selected.status, selected.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: OTHER, hubUrl: null });
    expect(selected.stdout).toBe(
      `using      ${OTHER} (local)\n` +
      `wrote      ${join(box.cwd, ".uberblick.json")}\n` +
      `previous   ${WORKSPACE} (local)\n` +
      `switch back with: ub workspace use ${WORKSPACE}\n`,
    );
    expect(existsSync(join(nested, ".uberblick.json"))).toBe(false);
  });

  it.each(["unbound", "different", "unchanged"])(
    "reports only the binding and actual previous binding as JSON when %s",
    async (selection) => {
      const box = unboundSandbox();
      const previous = selection === "unbound" ? null : {
        workspaceId: selection === "unchanged" ? OTHER : WORKSPACE,
        hubUrl: selection === "unchanged" ? null : HUB,
      };
      if (previous !== null) bind(box, previous.workspaceId, previous.hubUrl);
      record(box, OTHER, null);
      const selected = await runInProcess(["workspace", "use", OTHER, "--json"], box);
      expect(selected.status, selected.output).toBe(0);
      expect(JSON.parse(selected.stdout)).toEqual({
        binding: { workspaceId: OTHER, hubUrl: null },
        previous,
      });
      expect(selected.stderr).toBe("");
      expect(binding(box)).toEqual({ workspaceId: OTHER, hubUrl: null });
    },
  );

  it("resolves unique prefixes and refuses ambiguous, missing, and invalid IDs without changing selection", async () => {
    const box = unboundSandbox();
    for (const id of [WORKSPACE, OTHER, UNRELATED]) {
      withDatabase(box, id);
      record(box, id, null);
    }
    expect((await runInProcess(["workspace", "use", "b7c"], box)).status).toBe(0);
    const bindingBefore = readFileSync(join(box.cwd, ".uberblick.json"));
    const registryBefore = readFileSync(workspaceRegistryPath(box.env));
    for (const [id, message] of [["4d8e", "matches 2"], ["ffff", "no workspace"], ["my-notes", "not a workspace id"]]) {
      const run = await runInProcess(["workspace", "use", id!], box);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain(message);
      if (id === "4d8e") {
        expect(run.stderr).toContain(WORKSPACE);
        expect(run.stderr).toContain(OTHER);
      }
      if (id === "ffff") expect(run.stderr).toContain("ub workspace use <link>");
      expect(binding(box).workspaceId).toBe(UNRELATED);
      expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(bindingBefore);
      expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(registryBefore);
    }
  });

  it("refuses malformed project configuration without replacing it", async () => {
    const box = sandbox();
    const path = join(box.cwd, ".uberblick.json");
    const broken = '{"workspaceId":';
    writeFileSync(path, broken);
    record(box, WORKSPACE, null);
    const run = await runInProcess(["workspace", "use", WORKSPACE], box);
    expect(run.status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(broken);
  });

  it("warns when environment selection still overrides the written project binding", async () => {
    const box = sandbox();
    record(box, OTHER, null);
    const run = await runInProcess(["workspace", "use", OTHER], box, {
      UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: HUB,
    });
    expect(run.status, run.output).toBe(0);
    expect(binding(box).workspaceId).toBe(OTHER);
    expect(run.stderr).toContain("takes precedence");
  });

  it("waits for the init lock and publishes a complete tuple", async () => {
    const box = sandbox();
    bind(box);
    record(box, OTHER, null);
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");
    const pending = runUbAsync(["workspace", "use", OTHER], box);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
    rmSync(lock);
    const run = await pending;
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: OTHER, hubUrl: null });
    expect(existsSync(lock)).toBe(false);
  });

  it.each([undefined, null, HUB])("preserves the hub recorded while use waits for the init lock (previous record: %s)", async (initial) => {
    const box = sandbox({ projectBinding: { workspaceId: OTHER, hubUrl: HUB } });
    withDatabase(box, OTHER);
    if (initial !== undefined) record(box, OTHER, initial);
    const lock = await acquireInitLock(box.env);
    const pending = runInProcess(["workspace", "use", OTHER], box);
    const concurrentHub = "wss://concurrent.example.test/ws";
    try {
      // The in-process command reaches the contended lock before returning its promise.
      record(box, OTHER, concurrentHub);
    } finally { lock.release(); }
    const run = await pending;
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: OTHER, hubUrl: concurrentHub });
    expect(readWorkspaceHub(OTHER, box.env)).toBe(concurrentHub);
    expect(run.stdout).toContain("https://concurrent.example.test");
  });

  it("does not register a replica removed while use waits for the init lock", async () => {
    const box = sandbox();
    withDatabase(box, OTHER);
    const lock = await acquireInitLock(box.env);
    const pending = runInProcess(["workspace", "use", OTHER], box);
    try { rmSync(join(box.dataHome, "uberblick", `${OTHER}.sqlite`)); }
    finally { lock.release(); }
    const run = await pending;
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain("ub workspace use <link>");
    expect(binding(box).workspaceId).not.toBe(OTHER);
    expect(existsSync(workspaceRegistryPath(box.env))).toBe(false);
  });

  it("rejects the removed hub flag as usage without any writes", async () => {
    const box = unboundSandbox();
    const run = await runInProcess(["workspace", "use", WORKSPACE, "--hub", "local"], box);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unknown option '--hub'");
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
    expect(existsSync(box.configHome)).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it("refuses a full UUID this machine never recorded with no files written", async () => {
    const box = unboundSandbox();
    const run = await runInProcess(["workspace", "use", WORKSPACE], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("ub workspace use <link>");
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
    expect(existsSync(box.configHome)).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it.each(["different workspace", "same workspace"])(
    "prints the previous hub's link when its recorded hub differs for the %s",
    async (selection) => {
      const box = sandbox();
      bind(box);
      record(box, WORKSPACE, "wss://remembered.example.test/ws");
      record(box, OTHER, null);
      const selected = await runInProcess(["workspace", "use", selection === "same workspace" ? WORKSPACE : OTHER], box);
      expect(selected.status, selected.output).toBe(0);
      expect(selected.stdout).toContain(`previous   ${WORKSPACE} (https://hub.example.test)\n`);
      expect(selected.stdout).toContain(`switch back with: ub workspace use ${HUB}/${WORKSPACE}\n`);
      expect(selected.stdout).not.toContain(`switch back with: ub workspace use ${WORKSPACE}\n`);
      expect(readWorkspaceHub(WORKSPACE, box.env)).toBe("wss://remembered.example.test/ws");
      // An id selects what this machine recorded; it cannot replace that record
      // with the former project's hub. Recovery must fetch the printed link.
      expect((await runInProcess(["workspace", "use", WORKSPACE], box)).status).toBe(0);
      expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: "wss://remembered.example.test/ws" });
      expect(readWorkspaceHub(WORKSPACE, box.env)).toBe("wss://remembered.example.test/ws");
    },
  );

  it.each(["different workspace", "same workspace"])(
    "prints a local session override when the previous local binding is recorded on a hub for the %s",
    async (selection) => {
      const box = sandbox();
      bind(box, WORKSPACE, null);
      record(box, WORKSPACE, HUB);
      record(box, OTHER, null);
      const selected = await runInProcess(["workspace", "use", selection === "same workspace" ? WORKSPACE : OTHER], box);
      expect(selected.status, selected.output).toBe(0);
      expect(selected.stdout).toContain(`previous   ${WORKSPACE} (local)\n`);
      expect(selected.stdout).toContain(
        `Switch back for this session: UB_WORKSPACE_ID=${WORKSPACE} UB_HUB_URL=local ub open\n`,
      );
      expect(selected.stdout).not.toContain("switch back with:");
      expect(readWorkspaceHub(WORKSPACE, box.env)).toBe(HUB);
    },
  );
});
