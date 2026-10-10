/** Project selection never borrows a workspace's hub from another binding. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { writeHubLogin, removeHubLogin } from "@uberblick/hub/auth-store";
import { resolveMcpConfig, storeWorkspaceName } from "@uberblick/mcp-server";
import { resolveConfig } from "../src/config.js";
import { readWorkspaceHub, workspaceRegistryPath } from "../src/workspace-registry.js";
import { removeTempDirs, runUb, runUbAsync, sandbox, unboundSandbox, type Sandbox } from "./helpers.js";
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

describe("ub workspace status", () => {
  it("shows the project binding from a descendant directory and its origin", () => {
    const box = sandbox();
    bind(box);
    const nested = join(box.cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const shown = runUb(["workspace", "status"], { ...box, cwd: nested });
    expect(shown.status, shown.output).toBe(0);
    expect(shown.stdout).toContain(WORKSPACE);
    expect(shown.stdout).toContain(`chosen by  project config in ${box.cwd}`);
    expect(shown.stdout).not.toContain(`project config in ${nested}`);
    expect(shown.stdout).toContain(HUB);
  });

  it("ignores a legacy machine default without an explicit project binding", () => {
    const box = unboundSandbox({ userConfig: { workspace: WORKSPACE, hubUrl: HUB } });
    const shown = runUb(["workspace", "status"], box);
    expect(shown.status).toBe(1);
    expect(shown.stderr).toContain("No workspace selected");
    expect(shown.stderr).toContain("ub workspace create <name>");
    expect(shown.stdout).toBe("");
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it("reports a complete environment override", () => {
    const box = sandbox();
    bind(box);
    const shown = runUb(["workspace", "status"], box, { UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "local" });
    expect(shown.status, shown.output).toBe(0);
    expect(shown.stdout).toContain(OTHER);
    expect(shown.stdout).toContain("environment");
    expect(shown.stdout).toContain("local (this computer)");
  });

  it("shows a local name, canonical id, custom replica path and the doc's line order", () => {
    const box = sandbox({ projectBinding: { workspaceId: `notes-${WORKSPACE}`, hubUrl: null } });
    const databasePath = join(box.cwd, "custom.sqlite");
    storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE, UBERBLICK_DB: databasePath }), "Project notes");
    const shown = runUb(["workspace", "status"], box, { UBERBLICK_DB: databasePath });
    expect(shown.status, shown.output).toBe(0);
    expect(shown.stdout).toBe(
      `workspace  Project notes\nid         ${WORKSPACE}\nhub        local (this computer)\n` +
      `chosen by  project config in ${box.cwd}\nstored in  ${databasePath}\nsync       local only, no hub sync\n`,
    );
  });

  it("still identifies a selected workspace whose replica has no name", () => {
    const box = sandbox({ projectBinding: { workspaceId: `notes-${WORKSPACE}`, hubUrl: null } });
    const shown = runUb(["workspace", "status"], box);
    expect(shown.status, shown.output).toBe(0);
    expect(shown.stdout).toContain(`workspace  notes-${WORKSPACE}\nid         ${WORKSPACE}\n`);
  });

  it.each([false, true])("reports the stored account for shared-secret admission: login present %s", (signedIn) => {
    const endpoint = "ws://127.0.0.1:1";
    const login = fixture([WORKSPACE]);
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint },
      credentials: { signingSecret: "synthetic-status-secret", ...(signedIn
        ? { hubLogins: { "http://127.0.0.1:1": login } } : {}) },
    });
    const shown = runUb(["workspace", "status"], box);
    expect(shown.status, shown.output).toBe(0);
    const account = signedIn ? "@previous-user (GitHub)" : "not signed in, run ub auth login http://127.0.0.1:1";
    expect(shown.stdout).toContain(`hub        ${endpoint}\naccount    ${account}\nchosen by  `);
    expect(shown.stdout).not.toContain("up to date");
    expect(shown.output).not.toContain("synthetic-status-secret");
    expect(shown.output).not.toContain(login.credential.key);
  });

  it("reports a stored device login even when the hub cannot be reached", () => {
    const login = fixture([WORKSPACE]);
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: "wss://hub.example.test/ws" },
      credentials: { hubLogins: { "https://hub.example.test": login } },
    });
    const shown = runUb(["workspace", "status"], box);
    expect(shown.status, shown.output).toBe(0);
    expect(shown.stdout).toContain("account    @previous-user (GitHub)\n");
    expect(shown.stdout).not.toContain("up to date");
  });

  it("names pending rooms when the hub cannot acknowledge local changes", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "ws://127.0.0.1:1" } });
    storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE }), "Pending notes");
    const shown = runUb(["workspace", "status"], box, { HUB_AUTH_TOKEN: "synthetic-pending-secret" });
    expect(shown.status, shown.output).toBe(0);
    expect(shown.stdout).toMatch(/sync\s+\d+ rooms? with unacknowledged local changes/);
    expect(shown.stdout).not.toContain("up to date");
  });

  it.each([["--json"], ["extra"]])("refuses unsupported status arguments %j before opening anything", (args) => {
    const box = unboundSandbox();
    const shown = runUb(["workspace", "status", ...args], box);
    expect(shown.status, shown.output).toBe(2);
    expect(shown.stdout).toBe("");
    expect(existsSync(box.dataHome)).toBe(false);
  });
});

it("workspace use remembers device admission after logout and never clears another hub's mode", async () => {
  const endpoint = "ws://localhost:8080/ws";
  const otherEndpoint = "ws://localhost:8081/ws";
  const box = sandbox({ credentials: { signingSecret: "synthetic-local-secret" } });
  await writeHubLogin("http://localhost:8080", {
    identity: { id: WORKSPACE, githubAccountId: "12345", githubUsername: "synthetic-person" },
    credential: { record: { id: WORKSPACE, principalId: WORKSPACE, deviceId: OTHER,
      workspaces: [WORKSPACE], issuedAt: 0, revokedAt: null }, key: Buffer.alloc(32).toString("base64url") },
  }, box.env);
  record(box, WORKSPACE, endpoint);
  record(box, OTHER, otherEndpoint);
  const selected = runUb(["workspace", "use", WORKSPACE], box);
  expect(selected.status, selected.output).toBe(0);
  await removeHubLogin("http://localhost:8080", box.env);
  const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
  expect(resolved.env.HUB_ADMISSION).toBe("device");
  expect(resolved.env.HUB_AUTH_TOKEN).toBeUndefined();
  const next = runUb(["workspace", "use", OTHER], box);
  expect(next.status, next.output).toBe(0);
  expect(resolveConfig({ env: box.env, cwd: box.cwd }).env.HUB_ADMISSION).toBeUndefined();
  const previous = resolveConfig({ env: { ...box.env, UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: endpoint }, cwd: box.cwd });
  expect(previous.env.HUB_ADMISSION).toBe("device");
  expect(previous.env.HUB_AUTH_TOKEN).toBeUndefined();
});

describe("ub workspace list", () => {
  it("unions database IDs with the explicitly selected workspace", () => {
    const box = sandbox();
    bind(box);
    withDatabase(box, UNRELATED);
    const run = runUb(["workspace", "list", "--json"], box);
    expect(run.status, run.output).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      { uuid: WORKSPACE, name: null, active: true, databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`), hub: "unknown" },
      { uuid: UNRELATED, name: null, active: false, databasePath: join(box.dataHome, "uberblick", `${UNRELATED}.sqlite`), hub: "unknown" },
    ]);
    expect(existsSync(join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`))).toBe(false);
  });

  it("shows local names beside full IDs and preserves JSON parity and selection", () => {
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
      `  ${OTHER} | Research notes | local\n* ${WORKSPACE} | Project notes | https://hub.example.test\n  ${UNRELATED} | hub unknown\n`,
    );
    const json = runUb(["workspace", "list", "--json"], box, env);
    expect(json.status, json.output).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([
      { uuid: OTHER, name: "Research notes", active: false, databasePath: join(box.dataHome, "uberblick", `${OTHER}.sqlite`), hub: "local" },
      { uuid: WORKSPACE, name: "Project notes", active: true, databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`), hub: HUB },
      { uuid: UNRELATED, name: null, active: false, databasePath: join(box.dataHome, "uberblick", `${UNRELATED}.sqlite`), hub: "unknown" },
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
  ] as const)("shows the active workspace's recorded %s hub independently of selection", (hub, display) => {
    const box = sandbox();
    bind(box, `notes-${WORKSPACE}`);
    record(box, WORKSPACE, hub);
    const before = readFileSync(workspaceRegistryPath(box.env));
    for (const env of [{}, { UB_WORKSPACE_ID: `notes-${WORKSPACE}`, UB_HUB_URL: "wss://override.example.test/ws" }]) {
      const text = runUb(["workspace", "list"], box, env);
      expect(text.status, text.output).toBe(0);
      expect(text.stdout).toBe(`* ${WORKSPACE} | ${display}\n`);
      const json = runUb(["workspace", "list", "--json"], box, env);
      expect(json.status, json.output).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([
        { uuid: WORKSPACE, name: null, active: true, databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`), hub: hub ?? "local" },
      ]);
    }
    expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(before);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it("lists the configured workspace without creating a data directory", () => {
    const box = sandbox();
    bind(box);
    const run = runUb(["workspace", "list"], box, { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local" });
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toBe(`* ${WORKSPACE} | hub unknown\n`);
    expect(existsSync(box.dataHome)).toBe(false);
    expect(existsSync(workspaceRegistryPath(box.env))).toBe(false);
  });

  it.each(["unnamed", "empty", "old schema", "unreadable"])(
    "keeps a %s replica in the list and both prefix resolvers",
    (kind) => {
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
      const list = runUb(["workspace", "list", "--json"], box);
      expect(list.status, list.output).toBe(0);
      expect(JSON.parse(list.stdout)).toEqual([
        { uuid: OTHER, name: null, active: false, databasePath: path, hub: "unknown" },
        { uuid: WORKSPACE, name: null, active: true, databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`), hub: "unknown" },
      ]);
      expect(readFileSync(path)).toEqual(before);
      const installed = runUb([
        "mcp", "install", "claude", "--print", "--workspace", OTHER.slice(0, 8), "--hub", "local",
      ], box);
      expect(installed.status, installed.output).toBe(0);
      expect(installed.stdout).toContain(OTHER);
      record(box, OTHER, null);
      const selected = runUb(["workspace", "use", OTHER.slice(0, 8)], box);
      expect(selected.status, selected.output).toBe(0);
      expect(binding(box).workspaceId).toBe(OTHER);
    },
  );

  it.each(["malformed JSON", "invalid hub", "unreadable"])("refuses %s records before stdout, even with no workspaces", (kind) => {
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
        const run = runUb(["workspace", "list", ...args], box);
        expect(run.status, run.output).toBe(1);
        expect(run.stdout).toBe("");
        expect(run.stderr).toBe(kind === "unreadable"
          ? `ub workspace list: Cannot read workspace records at ${registry}: expected a regular JSON file\n`
          : `ub workspace list: Invalid workspace records at ${registry}: expected a UUID-to-hub map (null for local)\n`);
      }
      expect(protectedPaths.map(path => readFileSync(path))).toEqual(before);
    }
  });

  it("keeps install prefix resolution independent of invalid workspace records", () => {
    const box = sandbox();
    withDatabase(box, OTHER);
    const registry = workspaceRegistryPath(box.env);
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, "{invalid");
    const installed = runUb([
      "mcp", "install", "claude", "--print", "--workspace", OTHER.slice(0, 8), "--hub", "local",
    ], box);
    expect(installed.status, installed.output).toBe(0);
    expect(installed.stdout).toContain(OTHER);
    expect(readFileSync(registry, "utf8")).toBe("{invalid");
  });

  it("explains recorded, local and unknown hubs without reading records for help", () => {
    const box = sandbox();
    const registry = workspaceRegistryPath(box.env);
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, "{invalid");
    const run = runUb(["workspace", "list", "--help"], box);
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain("hub this machine recorded");
    expect(run.stdout).toContain("local for an explicit local");
    expect(run.stdout).toContain("hub unknown when no record exists");
    expect(run.stdout).toContain('"unknown"');
    expect(run.stderr).toBe("");
  });

  it("refuses an unreadable database directory instead of resolving against a short list", () => {
    const box = sandbox();
    mkdirSync(box.dataHome, { recursive: true });
    writeFileSync(join(box.dataHome, "uberblick"), "not a directory");
    const run = runUb(["workspace", "list"], box);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(join(box.dataHome, "uberblick"));
  });
});

describe("ub workspace use", () => {
  it("never saves an environment hub when only changing project workspace spelling", () => {
    const box = sandbox();
    bind(box);
    record(box, WORKSPACE, HUB);
    const run = runUb(["workspace", "use", `docs-${WORKSPACE}`], box, {
      UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "wss://override.example.test/ws",
    });
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: `docs-${WORKSPACE}`, hubUrl: HUB });
    expect(run.stderr).toContain("takes precedence");
  });

  it("requires a record even when the requested UUID matches a complete environment override", () => {
    const box = sandbox();
    bind(box);
    const run = runUb(["workspace", "use", `docs-${OTHER}`], box, {
      UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "wss://override.example.test/ws",
    });
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain("ub workspace use <link>");
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
  });

  it("requires a record even if the requested workspace has a local database", () => {
    const box = sandbox();
    bind(box);
    withDatabase(box, OTHER);
    const run = runUb(["workspace", "use", OTHER], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ub workspace use <link>");
    expect(run.stderr).toContain(`UB_WORKSPACE_ID=${OTHER} UB_HUB_URL=local ub mcp serve`);
    expect(run.stderr).toContain("set `UB_HUB_URL=<hub>` for a hub replica");
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
  });

  it("updates both fields together and preserves the unrelated user configuration", () => {
    const userConfig = { workspace: WORKSPACE, hubUrl: HUB, displayName: "Synthetic operator" };
    const box = sandbox({ userConfig });
    bind(box);
    record(box, OTHER, "wss://other.example.test/ws");
    const run = runUb(["workspace", "use", OTHER], box);
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: OTHER, hubUrl: "wss://other.example.test/ws" });
    expect(JSON.parse(readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"))).toEqual({
      ...userConfig,
      hubAdmissions: { "wss://other.example.test/ws": "device" },
    });
  });

  it("retains the selected destination when only changing its decorated spelling", () => {
    const box = sandbox();
    bind(box);
    record(box, WORKSPACE, HUB);
    const run = runUb(["workspace", "use", `docs-${WORKSPACE}`], box);
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: `docs-${WORKSPACE}`, hubUrl: HUB });
    expect(run.stdout).toBe(
      `using      docs-${WORKSPACE} (https://hub.example.test)\n` +
      `wrote      ${join(box.cwd, ".uberblick.json")}\n`,
    );
    expect(run.stdout).not.toContain("previous");
    expect(run.stdout).not.toContain("switch back with:");
  });

  it("uses a recorded local workspace even without a database", () => {
    const box = unboundSandbox();
    record(box, UNRELATED, null);
    const run = runUb(["workspace", "use", UNRELATED.slice(0, 8)], box);
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: UNRELATED, hubUrl: null });
    expect(run.stdout).toBe(
      `using      ${UNRELATED} (local)\nwrote      ${join(box.cwd, ".uberblick.json")}\n`,
    );
    expect(run.stderr).toBe("");
  });

  it("prints the named selections and an id command that restores the previous binding", () => {
    const box = sandbox();
    bind(box);
    record(box, OTHER, null);
    storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE }), "Project notes");
    storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: OTHER }), "Research notes");

    const selected = runUb(["workspace", "use", OTHER.slice(0, 8)], box);
    expect(selected.status, selected.output).toBe(0);
    expect(selected.stdout).toBe(
      `using      Research notes (${OTHER}, local)\n` +
      `wrote      ${join(box.cwd, ".uberblick.json")}\n` +
      `previous   Project notes (${WORKSPACE}, https://hub.example.test)\n` +
      `switch back with: ub workspace use ${WORKSPACE}\n`,
    );
    expect(selected.stderr).toBe("");
    // Publication fills the previous binding's missing record before choosing
    // the command. Running exactly what it printed restores the entire pair.
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBe(HUB);
    const registryBeforeRecovery = readFileSync(workspaceRegistryPath(box.env));
    const command = selected.stdout.split("switch back with: ub ")[1]?.trim();
    expect(command).toBeDefined();
    const recovered = runUb(command!.split(" "), box);
    expect(recovered.status, recovered.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
    expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(registryBeforeRecovery);
  });

  it("writes the nearest binding and reports that path from a descendant directory", () => {
    const box = sandbox();
    bind(box, WORKSPACE, null);
    record(box, OTHER, null);
    const nested = join(box.cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const selected = runUb(["workspace", "use", OTHER], { ...box, cwd: nested });
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
    (selection) => {
      const box = unboundSandbox();
      const previous = selection === "unbound" ? null : {
        workspaceId: selection === "unchanged" ? OTHER : WORKSPACE,
        hubUrl: selection === "unchanged" ? null : HUB,
      };
      if (previous !== null) bind(box, previous.workspaceId, previous.hubUrl);
      record(box, OTHER, null);
      const selected = runUb(["workspace", "use", OTHER, "--json"], box);
      expect(selected.status, selected.output).toBe(0);
      expect(JSON.parse(selected.stdout)).toEqual({
        binding: { workspaceId: OTHER, hubUrl: null },
        previous,
      });
      expect(selected.stderr).toBe("");
      expect(binding(box)).toEqual({ workspaceId: OTHER, hubUrl: null });
    },
  );

  it("resolves unique prefixes and refuses ambiguous, missing, and invalid IDs without changing selection", () => {
    const box = unboundSandbox();
    for (const id of [WORKSPACE, OTHER, UNRELATED]) {
      withDatabase(box, id);
      record(box, id, null);
    }
    expect(runUb(["workspace", "use", "b7c"], box).status).toBe(0);
    const bindingBefore = readFileSync(join(box.cwd, ".uberblick.json"));
    const registryBefore = readFileSync(workspaceRegistryPath(box.env));
    for (const [id, message] of [["4d8e", "matches 2"], ["ffff", "no workspace"], ["my-notes", "not a workspace id"]]) {
      const run = runUb(["workspace", "use", id!], box);
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

  it("refuses malformed project configuration without replacing it", () => {
    const box = sandbox();
    const path = join(box.cwd, ".uberblick.json");
    const broken = '{"workspaceId":';
    writeFileSync(path, broken);
    record(box, WORKSPACE, null);
    const run = runUb(["workspace", "use", WORKSPACE], box);
    expect(run.status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(broken);
  });

  it("warns when environment selection still overrides the written project binding", () => {
    const box = sandbox();
    record(box, OTHER, null);
    const run = runUb(["workspace", "use", OTHER], box, {
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

  it("rejects the removed hub flag as usage without any writes", () => {
    const box = unboundSandbox();
    const run = runUb(["workspace", "use", WORKSPACE, "--hub", "local"], box);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unknown option '--hub'");
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
    expect(existsSync(box.configHome)).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it("refuses a full UUID this machine never recorded with no files written", () => {
    const box = unboundSandbox();
    const run = runUb(["workspace", "use", WORKSPACE], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("ub workspace use <link>");
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
    expect(existsSync(box.configHome)).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it.each(["different workspace", "same workspace"])(
    "prints the previous hub's link when its recorded hub differs for the %s",
    (selection) => {
      const box = sandbox();
      bind(box);
      record(box, WORKSPACE, "wss://remembered.example.test/ws");
      record(box, OTHER, null);
      const selected = runUb(["workspace", "use", selection === "same workspace" ? WORKSPACE : OTHER], box);
      expect(selected.status, selected.output).toBe(0);
      expect(selected.stdout).toContain(`previous   ${WORKSPACE} (https://hub.example.test)\n`);
      expect(selected.stdout).toContain(`switch back with: ub workspace use ${HUB}/${WORKSPACE}\n`);
      expect(selected.stdout).not.toContain(`switch back with: ub workspace use ${WORKSPACE}\n`);
      expect(readWorkspaceHub(WORKSPACE, box.env)).toBe("wss://remembered.example.test/ws");
      // An id selects what this machine recorded; it cannot replace that record
      // with the former project's hub. Recovery must fetch the printed link.
      expect(runUb(["workspace", "use", WORKSPACE], box).status).toBe(0);
      expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: "wss://remembered.example.test/ws" });
      expect(readWorkspaceHub(WORKSPACE, box.env)).toBe("wss://remembered.example.test/ws");
    },
  );

  it.each(["different workspace", "same workspace"])(
    "prints a local session override when the previous local binding is recorded on a hub for the %s",
    (selection) => {
      const box = sandbox();
      bind(box, WORKSPACE, null);
      record(box, WORKSPACE, HUB);
      record(box, OTHER, null);
      const selected = runUb(["workspace", "use", selection === "same workspace" ? WORKSPACE : OTHER], box);
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
