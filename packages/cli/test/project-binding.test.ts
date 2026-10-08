import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resolveProjectBinding, writeProjectBinding } from "../src/project-binding.js";
import { rememberWorkspaceBinding, readWorkspaceHub, workspaceRegistryPath } from "../src/workspace-registry.js";
import { sandbox, unboundSandbox, removeTempDirs, runUb } from "./helpers.js";

afterAll(removeTempDirs);
afterEach(() => vi.unstubAllEnvs());
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

describe("atomic project bindings", () => {
  it("inherits the nearest ancestor, without affecting a sibling project", () => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: null } });
    const child = join(box.cwd, "nested", "src");
    mkdirSync(child, { recursive: true });
    const options = { env: box.env, cwd: child };
    expect(resolveProjectBinding(options).binding).toEqual({ workspaceId: first, hubUrl: null });
    const nearer = join(box.cwd, "nested", ".uberblick.json");
    writeProjectBinding({ workspaceId: second, hubUrl: "https://other.example.test" }, { path: nearer, env: box.env });
    expect(resolveProjectBinding(options)).toEqual({ binding: { workspaceId: second, hubUrl: "wss://other.example.test/ws" }, origin: "project config", path: nearer });
    expect(resolveProjectBinding({ env: box.env, cwd: box.cwd }).binding?.workspaceId).toBe(first);
    const sibling = unboundSandbox();
    expect(resolveProjectBinding({ env: sibling.env, cwd: sibling.cwd }).binding).toBeNull();
  });

  it.each(["{broken secret", "null", "{}", '{"workspaceId":42,"hubUrl":null}', `{"workspaceId":"${first}"}`])("refuses an invalid nearest file instead of adopting its parent: %s", (text) => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: null } });
    const child = join(box.cwd, "child");
    mkdirSync(child);
    writeFileSync(join(child, ".uberblick.json"), text);
    expect(() => resolveProjectBinding({ env: box.env, cwd: child })).toThrow(/\.uberblick\.json/);
  });

  it.each([
    { UB_WORKSPACE_ID: first }, { UB_HUB_URL: "https://other.example.test" },
    { UB_WORKSPACE_ID: first, UB_HUB_URL: " " },
    { UB_WORKSPACE_ID: "", UB_HUB_URL: "local" },
  ])("refuses an incomplete override without borrowing project fields", (overrides) => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: "https://project.example.test" } });
    vi.stubEnv("XDG_CONFIG_HOME", box.configHome);
    expect(() => resolveProjectBinding({ env: { ...box.env, ...overrides }, cwd: box.cwd })).toThrow(/UB_WORKSPACE_ID|UB_HUB_URL/);
  });

  it.each([{ WORKSPACE_ID: second }, { HUB_URL: "https://old.example.test" }])("refuses legacy MCP or shell pins instead of adopting another project binding", (legacy) => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: null } });
    expect(() => resolveProjectBinding({ env: { ...box.env, ...legacy }, cwd: box.cwd })).toThrow(/Legacy WORKSPACE_ID/);
    expect(resolveProjectBinding({ env: { ...box.env, ...legacy, UB_WORKSPACE_ID: second, UB_HUB_URL: "local" }, cwd: box.cwd }).binding).toEqual({ workspaceId: second, hubUrl: null });
  });

  it.each(["local", "LOCAL", "Local"])("does not interpret the file's local sentinel as a remote hostname", (hubUrl) => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl } });
    expect(() => resolveProjectBinding({ env: box.env, cwd: box.cwd })).toThrow(/use JSON null/);
  });

  it("permits a complete explicit override even when the project file is invalid", () => {
    const box = sandbox({ raw: { projectBinding: "invalid" } });
    expect(resolveProjectBinding({ env: { ...box.env, UB_WORKSPACE_ID: second, UB_HUB_URL: "local" }, cwd: box.cwd })).toEqual({ binding: { workspaceId: second, hubUrl: null }, origin: "environment", path: null });
  });

  it.each(["https://user:secret@hub.example.test", "https://hub.example.test/?secret=value", "https://hub.example.test/#secret", "file:///secret"])('rejects unsafe endpoint without echoing its value', (hubUrl) => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl } });
    let message = "";
    try { resolveProjectBinding({ env: box.env, cwd: box.cwd }); } catch (error) { message = String(error); }
    expect(message).not.toBe("");
    expect(message).not.toContain(hubUrl);
  });

  it("writes only the complete selection and preserves unrelated project metadata", () => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: null, name: "test" } });
    const path = writeProjectBinding({ workspaceId: second, hubUrl: "https://hub.example.test" }, { cwd: box.cwd, env: box.env });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ workspaceId: second, hubUrl: "wss://hub.example.test/ws", name: "test" });
    expect(readWorkspaceHub(first, box.env)).toBeNull();
    expect(readWorkspaceHub(second, box.env)).toBe("wss://hub.example.test/ws");
  });

  it("refuses symlinks, including broken ones, for resolution and updates", () => {
    const box = sandbox();
    const target = join(box.cwd, "other.json");
    const path = join(box.cwd, ".uberblick.json");
    rmSync(path);
    symlinkSync(target, path);
    expect(() => resolveProjectBinding({ env: box.env, cwd: box.cwd })).toThrow(/regular file/);
    expect(() => writeProjectBinding({ workspaceId: first, hubUrl: null }, { cwd: box.cwd, env: box.env })).toThrow(/regular file/);
    writeFileSync(target, JSON.stringify({ workspaceId: second, hubUrl: null }));
    expect(() => writeProjectBinding({ workspaceId: first, hubUrl: null }, { cwd: box.cwd, env: box.env })).toThrow(/regular file/);
    expect(JSON.parse(readFileSync(target, "utf8")).workspaceId).toBe(second);
  });

  it.each([null, "wss://recorded.example.test/ws"])("resolves id-only overrides by machine record (%s) and keeps child environments complete", async (hubUrl) => {
    const box = sandbox({ projectBinding: { workspaceId: second, hubUrl: "https://project.example.test" } });
    await rememberWorkspaceBinding({ workspaceId: first, hubUrl }, box.env);
    for (const id of [first, `notes-${first}`]) {
      const run = runUb(["workspace", "status"], box, { UB_WORKSPACE_ID: id });
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain(first);
      expect(run.stdout).toContain(hubUrl ?? "local");
      expect(run.stdout).toMatch(/^chosen by\s+environment$/m);
      const child = runUb(["env", "--", process.execPath, "-e",
        "process.stdout.write(JSON.stringify([process.env.UB_WORKSPACE_ID,process.env.UB_HUB_URL]))"], box, { UB_WORKSPACE_ID: id });
      expect(child.status, child.output).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual([id, hubUrl ?? "local"]);
    }
  });

  it("takes registry roots from the process even when checking an MCP entry's partial env", async () => {
    const box = sandbox();
    const wrong = sandbox();
    await rememberWorkspaceBinding({ workspaceId: first, hubUrl: "wss://recorded.example.test/ws" }, box.env);
    await rememberWorkspaceBinding({ workspaceId: first, hubUrl: null }, wrong.env);
    vi.stubEnv("XDG_CONFIG_HOME", box.configHome);
    expect(resolveProjectBinding({ env: { UB_WORKSPACE_ID: `notes-${first}`, XDG_CONFIG_HOME: wrong.configHome } }).binding)
      .toEqual({ workspaceId: `notes-${first}`, hubUrl: "wss://recorded.example.test/ws" });
    expect(resolveProjectBinding({ env: {}, cwd: box.cwd }).origin).toBe("project config");
  });

  it.each([first, `notes-${first}`])("refuses an unknown id-only override instead of inferring local or using the project hub: %s", (id) => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: "https://project.example.test" } });
    const run = runUb(["workspace", "status"], box, { UB_WORKSPACE_ID: id });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Add UB_HUB_URL (a hub address, or local)");
    expect(run.stderr).toContain("ub workspace use <link>");
    expect(readWorkspaceHub(first, box.env)).toBeUndefined();
  });

  it("complete overrides keep precedence without rewriting a conflicting record", async () => {
    const box = sandbox();
    await rememberWorkspaceBinding({ workspaceId: first, hubUrl: null }, box.env);
    const before = readFileSync(workspaceRegistryPath(box.env));
    const run = runUb(["workspace", "status"], box, { UB_WORKSPACE_ID: first, UB_HUB_URL: "https://explicit.example.test" });
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain("wss://explicit.example.test/ws");
    expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(before);
  });
});
