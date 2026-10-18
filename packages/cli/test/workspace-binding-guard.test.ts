import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { defaultWorkspaceDatabasePath } from "@uberblick/mcp-server";
import { MirrorStore } from "../../mcp-server/src/store.js";
import { afterAll, describe, expect, it } from "vitest";
import { readWorkspaceHub, rememberWorkspaceBinding, workspaceRegistryPath } from "../src/workspace-registry.js";
import { DEAD_HUB_URL, removeTempDirs, runUbAsync, sandbox } from "./helpers.js";
import type { Run, Sandbox } from "./helpers.js";
import { parseJoinTarget } from "@uberblick/mcp-server/remote-url";

const WORKSPACE = "2f1f3b7a-c48d-4cb8-bc74-7c585ed5c365";
const DOCUMENT = "ed00f579-a232-45fe-af61-9dc0a0500cdf";
const RECORDED_HUB = "wss://recorded.example.test/ws";
const COMMANDS = [
  { name: "serve", args: ["mcp", "serve"] },
  { name: "open", args: ["open", "--no-browser"] },
  { name: "data", args: ["data", "get", DOCUMENT] },
  { name: "status", args: ["status", "--json"] },
];

afterAll(removeTempDirs);

/** Count connections rather than HTTP requests: even the first TCP dial is forbidden. */
async function hubTrap(): Promise<{ url: string; connections(): number; close(): Promise<void> }> {
  let connections = 0;
  const server = createServer(socket => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP listener");
  return {
    url: `ws://127.0.0.1:${address.port}/proxy/socket`,
    connections: () => connections,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function replica(box: Sandbox, path = defaultWorkspaceDatabasePath(WORKSPACE, box.env)): Buffer {
  const store = new MirrorStore(path, WORKSPACE);
  store.close();
  return readFileSync(path);
}

function mismatch(run: Run, command: string): string {
  expect(run.status, run.output).toBe(command === "status" ? 0 : 1);
  if (command !== "status") {
    expect(run.stdout).toBe("");
    return run.stderr;
  }
  const report = JSON.parse(run.stdout);
  expect(report.connection).toEqual({ state: "refused", cause: null, detail: null });
  expect(report.problems).toEqual([{ name: "workspace-hub-mismatch", fix: expect.any(String) }]);
  return run.output;
}

describe("passive commands preserve this machine's workspace hub", () => {
  for (const command of COMMANDS) {
    it.each([
      { source: "project", recorded: null },
      { source: "project", recorded: RECORDED_HUB },
      { source: "environment", recorded: null },
      { source: "environment", recorded: RECORDED_HUB },
    ])(`${command.name} refuses a $source hub differing from a $recorded record before dialing it`, async ({ source, recorded }) => {
      const trap = await hubTrap();
      try {
        const box = sandbox({
          projectBinding: { workspaceId: WORKSPACE, hubUrl: source === "project" ? trap.url : recorded },
          credentials: { signingSecret: "binding-guard-test-secret" },
        });
        await rememberWorkspaceBinding({ workspaceId: WORKSPACE, hubUrl: recorded }, box.env);
        const databaseBefore = replica(box);
        const registryBefore = readFileSync(workspaceRegistryPath(box.env));
        const bindingPath = join(box.cwd, ".uberblick.json");
        const bindingBefore = readFileSync(bindingPath);
        const extraEnv = source === "environment" ? { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: trap.url } : {};
        const run = await runUbAsync(command.args, box, extraEnv);
        const output = mismatch(run, command.name);
        expect(output).toContain(WORKSPACE);
        expect(output).toContain(recorded ?? "local");
        expect(output).toContain(trap.url);
        expect(output).toContain(source === "project" ? bindingPath : "UB_WORKSPACE_ID/UB_HUB_URL");
        const recovery = output.match(/ub workspace use '((?:https?|wss?):\/\/[^']+)'/);
        expect(recovery, output).not.toBeNull();
        expect(parseJoinTarget(recovery![1]!)).toEqual({ endpoint: trap.url, workspace: WORKSPACE });
        expect(output).toMatch(/upload|offer.*content/i);
        if (source === "environment") expect(output).toContain("env -u UB_WORKSPACE_ID -u UB_HUB_URL");
        expect(trap.connections()).toBe(0);
        expect(readFileSync(defaultWorkspaceDatabasePath(WORKSPACE, box.env))).toEqual(databaseBefore);
        expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(registryBefore);
        expect(readFileSync(bindingPath)).toEqual(bindingBefore);
      } finally { await trap.close(); }
    });

    it.each(["project", "environment"])(`${command.name} refuses a %s local destination and gives restore guidance`, async source => {
      const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: source === "project" ? null : RECORDED_HUB } });
      await rememberWorkspaceBinding({ workspaceId: WORKSPACE, hubUrl: RECORDED_HUB }, box.env);
      const databaseBefore = replica(box);
      const registryBefore = readFileSync(workspaceRegistryPath(box.env));
      const extraEnv = source === "environment" ? { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local" } : {};
      const run = await runUbAsync(command.args, box, extraEnv);
      const output = mismatch(run, command.name);
      expect(output).toContain(WORKSPACE);
      expect(output).toContain(RECORDED_HUB);
      expect(output).toMatch(/local.*(?:not|isn't) supported/is);
      expect(output).toContain(source === "project" ? `ub workspace use ${WORKSPACE}` : "unset UB_WORKSPACE_ID UB_HUB_URL");
      expect(readFileSync(defaultWorkspaceDatabasePath(WORKSPACE, box.env))).toEqual(databaseBefore);
      expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(registryBefore);
    });

    it(`${command.name} cannot attach an unrecorded replica to a project hub`, async () => {
      const trap = await hubTrap();
      try {
        const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: trap.url },
          credentials: { signingSecret: "unrecorded-binding-test-secret" },
        });
        const before = replica(box);
        const run = await runUbAsync(command.args, box);
        expect(mismatch(run, command.name)).toMatch(/unrecorded|no.*record/i);
        expect(trap.connections()).toBe(0);
        expect(readWorkspaceHub(WORKSPACE, box.env)).toBeUndefined();
        expect(readFileSync(defaultWorkspaceDatabasePath(WORKSPACE, box.env))).toEqual(before);
      } finally { await trap.close(); }
    });
  }
});

describe("first workspace registration", () => {
  it.each(["status", "data"])("%s records a first hub binding before opening its new replica", async command => {
    const trap = await hubTrap();
    try {
      const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: trap.url },
        credentials: { signingSecret: "first-binding-test-secret" },
      });
      const run = await runUbAsync(command === "status" ? ["status", "--json"] : ["data", "get", DOCUMENT], box);
      expect(run.status, run.output).toBe(command === "status" ? 0 : 1);
      expect(readWorkspaceHub(WORKSPACE, box.env)).toBe(trap.url);
      expect(existsSync(defaultWorkspaceDatabasePath(WORKSPACE, box.env))).toBe(true);
      expect(trap.connections()).toBeGreaterThan(0);
    } finally { await trap.close(); }
  });

  it.each(["status", "data"])("%s records an existing unrecorded replica as local", async command => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    replica(box);
    const run = await runUbAsync(command === "status" ? ["status", "--json"] : ["data", "get", DOCUMENT], box);
    expect(run.status, run.output).toBe(command === "status" ? 0 : 1);
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBeNull();
  });

  it("lets only one of two concurrent first hubs claim a workspace", async () => {
    const first = await hubTrap();
    const second = await hubTrap();
    try {
      const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
        credentials: { signingSecret: "concurrent-binding-test-secret" },
      });
      const hubs = [first, second];
      const runs = await Promise.all(hubs.map(hub => runUbAsync(["status", "--json"], box, {
        UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: hub.url,
      })));
      const winner = readWorkspaceHub(WORKSPACE, box.env);
      expect(hubs.map(hub => hub.url)).toContain(winner);
      for (const [index, hub] of hubs.entries()) {
        const run = runs[index]!;
        expect(run.status, run.output).toBe(0);
        const problems = JSON.parse(run.stdout).problems as { name: string }[];
        if (hub.url === winner) {
          expect(problems.map(problem => problem.name)).not.toContain("workspace-hub-mismatch");
          expect(hub.connections()).toBeGreaterThan(0);
        } else {
          expect(problems.map(problem => problem.name)).toEqual(["workspace-hub-mismatch"]);
          expect(hub.connections()).toBe(0);
        }
      }
      expect(Object.keys(JSON.parse(readFileSync(workspaceRegistryPath(box.env), "utf8")))).toEqual([WORKSPACE]);
    } finally { await Promise.all([first.close(), second.close()]); }
  });

  it.each(["https://RECORDED.example.test:443", "wss://RECORDED.example.test:443/ws"])(
    "accepts equivalent hub spelling %s without changing the existing record", async hubUrl => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl } });
    await rememberWorkspaceBinding({ workspaceId: WORKSPACE, hubUrl: RECORDED_HUB }, box.env);
    const before = readFileSync(workspaceRegistryPath(box.env));
    const run = await runUbAsync(["status", "--json"], box);
    expect(run.status, run.output).toBe(0);
    expect(JSON.parse(run.stdout).problems.map((problem: { name: string }) => problem.name)).not.toContain("workspace-hub-mismatch");
    expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(before);
  });

  it("checks a custom replica path before attaching a first hub", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const path = join(box.cwd, "custom.sqlite");
    const before = replica(box, path);
    const run = await runUbAsync(["data", "get", DOCUMENT], box, { UBERBLICK_DB: path });
    expect(mismatch(run, "data")).toMatch(/unrecorded|no.*record/i);
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBeUndefined();
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(defaultWorkspaceDatabasePath(WORKSPACE, box.env))).toBe(false);
  });
});
