/** Project selection never borrows a workspace's hub from another binding. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeHubLogin, removeHubLogin } from "@uberblick/hub/auth-store";
import { resolveConfig } from "../src/config.js";
import { removeTempDirs, runUb, runUbAsync, sandbox, type Sandbox } from "./helpers.js";

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
function withDatabase(box: Sandbox, uuid: string): void {
  const dir = join(box.dataHome, "uberblick");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.sqlite`), "", "utf8");
}

describe("ub workspace", () => {
  it("shows the project binding from a descendant directory and its origin", () => {
    const box = sandbox();
    bind(box);
    const nested = join(box.cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const shown = runUb(["workspace"], { ...box, cwd: nested });
    expect(shown.status, shown.output).toBe(0);
    expect(shown.stdout).toContain(WORKSPACE);
    expect(shown.stdout).toContain("project config");
    expect(shown.stdout).toContain(HUB);
  });

  it("ignores a legacy machine default without an explicit project binding", () => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE, hubUrl: HUB } });
    const shown = runUb(["workspace"], box);
    expect(shown.status).toBe(1);
    expect(shown.stderr).toContain("no workspace configured");
    expect(shown.stderr).toContain("--hub <url|local>");
  });

  it("reports a complete environment override", () => {
    const box = sandbox();
    bind(box);
    const shown = runUb(["workspace"], box, { UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "local" });
    expect(shown.status, shown.output).toBe(0);
    expect(shown.stdout).toContain(OTHER);
    expect(shown.stdout).toContain("environment");
    expect(shown.stdout).toContain("local (this computer)");
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
  const selected = runUb(["workspace", "use", WORKSPACE, "--hub", endpoint], box);
  expect(selected.status, selected.output).toBe(0);
  await removeHubLogin("http://localhost:8080", box.env);
  const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
  expect(resolved.env.HUB_ADMISSION).toBe("device");
  expect(resolved.env.HUB_AUTH_TOKEN).toBeUndefined();
  const next = runUb(["workspace", "use", OTHER, "--hub", otherEndpoint], box);
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
      { uuid: WORKSPACE, active: true, databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`) },
      { uuid: UNRELATED, active: false, databasePath: join(box.dataHome, "uberblick", `${UNRELATED}.sqlite`) },
    ]);
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
    const run = runUb(["workspace", "use", `docs-${WORKSPACE}`], box, {
      UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "wss://override.example.test/ws",
    });
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: `docs-${WORKSPACE}`, hubUrl: HUB });
    expect(run.stderr).toContain("takes precedence");
  });

  it("requires an explicit hub even when the requested UUID matches an environment override", () => {
    const box = sandbox();
    bind(box);
    const run = runUb(["workspace", "use", `docs-${OTHER}`], box, {
      UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "wss://override.example.test/ws",
    });
    expect(run.status, run.output).toBe(2);
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
  });

  it("requires a complete destination when selecting another UUID, even if it has a local database", () => {
    const box = sandbox();
    bind(box);
    withDatabase(box, OTHER);
    const run = runUb(["workspace", "use", OTHER], box);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--hub");
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
  });

  it("updates both fields together and preserves the unrelated user configuration", () => {
    const userConfig = { workspace: WORKSPACE, hubUrl: HUB, displayName: "Synthetic operator" };
    const box = sandbox({ userConfig });
    bind(box);
    const run = runUb(["workspace", "use", OTHER, "--hub", "https://other.example.test"], box);
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: OTHER, hubUrl: "wss://other.example.test/ws" });
    expect(JSON.parse(readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"))).toEqual(userConfig);
  });

  it("retains the selected destination when only changing its decorated spelling", () => {
    const box = sandbox();
    bind(box);
    const run = runUb(["workspace", "use", `docs-${WORKSPACE}`], box);
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: `docs-${WORKSPACE}`, hubUrl: HUB });
  });

  it("writes explicit local-only selection without inferring a hub", () => {
    const box = sandbox();
    const run = runUb(["workspace", "use", UNRELATED, "--hub", "local"], box);
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: UNRELATED, hubUrl: null });
  });

  it("resolves unique prefixes and refuses ambiguous, missing, and invalid IDs without changing selection", () => {
    const box = sandbox();
    for (const id of [WORKSPACE, OTHER, UNRELATED]) withDatabase(box, id);
    expect(runUb(["workspace", "use", "b7c", "--hub", "local"], box).status).toBe(0);
    for (const [id, message] of [["4d8e", "matches 2"], ["ffff", "no workspace"], ["my-notes", "not a workspace id"]]) {
      const run = runUb(["workspace", "use", id!, "--hub", "local"], box);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain(message);
      expect(binding(box).workspaceId).toBe(UNRELATED);
    }
  });

  it("refuses malformed project configuration without replacing it", () => {
    const box = sandbox();
    const path = join(box.cwd, ".uberblick.json");
    const broken = '{"workspaceId":';
    writeFileSync(path, broken);
    const run = runUb(["workspace", "use", WORKSPACE, "--hub", "local"], box);
    expect(run.status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(broken);
  });

  it("warns when environment selection still overrides the written project binding", () => {
    const box = sandbox();
    const run = runUb(["workspace", "use", OTHER, "--hub", "local"], box, {
      UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: HUB,
    });
    expect(run.status, run.output).toBe(0);
    expect(binding(box).workspaceId).toBe(OTHER);
    expect(run.stderr).toContain("takes precedence");
  });

  it("waits for the init lock and publishes a complete tuple", async () => {
    const box = sandbox();
    bind(box);
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");
    const pending = runUbAsync(["workspace", "use", OTHER, "--hub", "local"], box);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(binding(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: HUB });
    rmSync(lock);
    const run = await pending;
    expect(run.status, run.output).toBe(0);
    expect(binding(box)).toEqual({ workspaceId: OTHER, hubUrl: null });
    expect(existsSync(lock)).toBe(false);
  });
});
