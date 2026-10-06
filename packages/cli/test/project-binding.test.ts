import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveProjectBinding, writeProjectBinding } from "../src/project-binding.js";
import { sandbox, unboundSandbox, removeTempDirs } from "./helpers.js";

afterAll(removeTempDirs);
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
    writeProjectBinding({ workspaceId: second, hubUrl: "https://other.example.test" }, { path: nearer });
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
    expect(() => resolveProjectBinding({ env: { ...box.env, ...overrides }, cwd: box.cwd })).toThrow(/Set both UB_WORKSPACE_ID and UB_HUB_URL/);
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
    const path = writeProjectBinding({ workspaceId: second, hubUrl: "https://hub.example.test" }, { cwd: box.cwd });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ workspaceId: second, hubUrl: "wss://hub.example.test/ws", name: "test" });
  });

  it("refuses symlinks, including broken ones, for resolution and updates", () => {
    const box = sandbox();
    const target = join(box.cwd, "other.json");
    const path = join(box.cwd, ".uberblick.json");
    rmSync(path);
    symlinkSync(target, path);
    expect(() => resolveProjectBinding({ env: box.env, cwd: box.cwd })).toThrow(/regular file/);
    expect(() => writeProjectBinding({ workspaceId: first, hubUrl: null }, { cwd: box.cwd })).toThrow(/regular file/);
    writeFileSync(target, JSON.stringify({ workspaceId: second, hubUrl: null }));
    expect(() => writeProjectBinding({ workspaceId: first, hubUrl: null }, { cwd: box.cwd })).toThrow(/regular file/);
    expect(JSON.parse(readFileSync(target, "utf8")).workspaceId).toBe(second);
  });
});
