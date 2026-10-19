import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { findProjectConfig, resolveProjectBinding, writeProjectBinding } from "../src/project-binding.js";
import { ensureWorkspaceBinding } from "../src/workspace-registry.js";
import { removeTempDirs, sandbox, unboundSandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

const unowned = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: vi.fn((...args: Parameters<typeof fs.lstatSync>) => {
    const entry = fs.lstatSync(...args);
    if (unowned.has(String(args[0]))) Object.defineProperty(entry, "uid", { value: (process.getuid?.() ?? 0) + 1 });
    return entry;
  }) };
});

afterAll(removeTempDirs);
afterEach(() => { unowned.clear(); vi.restoreAllMocks(); });

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

describe.skipIf(process.getuid === undefined)("project binding ownership", () => {
  it.each(["file", "symlink"])("skips another user's %s and keeps discovering the owned parent", (kind) => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: null } });
    const child = join(box.cwd, "nested");
    mkdirSync(child);
    const ignored = join(child, ".uberblick.json");
    if (kind === "symlink") symlinkSync(join(child, "missing.json"), ignored);
    else writeFileSync(ignored, "invalid JSON that must never be read");
    unowned.add(ignored);

    expect(findProjectConfig(child)).toBe(join(box.cwd, ".uberblick.json"));
    expect(resolveProjectBinding({ cwd: child, env: box.env }).binding)
      .toEqual({ workspaceId: first, hubUrl: null });
    expect(writeProjectBinding({ workspaceId: second, hubUrl: null }, { cwd: child, env: box.env }))
      .toBe(join(box.cwd, ".uberblick.json"));
    expect(kind === "symlink" ? lstatSync(ignored).isSymbolicLink() : readFileSync(ignored, "utf8"))
      .toBe(kind === "symlink" ? true : "invalid JSON that must never be read");
  });

  it.each([
    ["status"], ["workspace", "list"],
    ["data", "get", first], ["auth", "login"], ["auth", "status"],
    ["mcp", "install", "codex", "--print"], ["doctor", "--json"],
  ])("names the ignored path when %j has no binding left", async (...argv) => {
    const box = unboundSandbox({ projectBinding: { workspaceId: first, hubUrl: null } });
    const path = join(box.cwd, ".uberblick.json");
    unowned.add(path);
    const result = await runInProcess(argv, box);
    expect(result.output).toContain(path);
    expect(result.output).toContain("another user owns it");
    expect(result.output).not.toContain("no .uberblick.json here");
    expect(readFileSync(path, "utf8")).toContain(first);
  });

  it.each([false, true])("lists without warning or setup text when an unowned binding is skipped (json: %s)", async (json) => {
    const box = unboundSandbox({
      projectBinding: { workspaceId: first, hubUrl: null },
      userConfig: { workspace: first, hubUrl: "wss://legacy.example.test/ws" },
    });
    const path = join(box.cwd, ".uberblick.json");
    unowned.add(path);
    const result = await runInProcess(["workspace", "list", ...(json ? ["--json"] : [])], box);
    expect(result.status, result.output).toBe(0);
    expect(result.stderr).toBe(`No workspace selected. Ignoring ${path}: another user owns it.\n`);
    expect(result.stdout).toBe(json ? "[]\n"
      : "no workspaces on this machine — run `ub workspace create <name>` to create one\n");
  });

  it.each([["mcp", "serve"], ["open"]])("refuses %j with the ignored-file diagnostic before opening a workspace", async (...argv) => {
    const box = unboundSandbox({ projectBinding: { workspaceId: first, hubUrl: null } });
    const path = join(box.cwd, ".uberblick.json");
    unowned.add(path);
    await expect(runInProcess(argv, box)).rejects.toThrow(`${path}: another user owns it`);
    expect(readFileSync(path, "utf8")).toContain(first);
  });

  it("keeps auth login and MCP installation on the owned parent's hub and scope", async () => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: "http://untrusted.invalid" } });
    const child = join(box.cwd, "nested");
    mkdirSync(child);
    const ignored = join(child, ".uberblick.json");
    writeFileSync(ignored, JSON.stringify({ workspaceId: second, hubUrl: "https://another-hub.invalid" }));
    unowned.add(ignored);
    const nested = { ...box, cwd: child };
    const auth = await runInProcess(["auth", "login"], nested);
    expect(auth.status).toBe(1);
    expect(auth.stderr).toContain("wss://untrusted.invalid/ws");
    expect(auth.output).not.toContain("another-hub.invalid");
    const install = await runInProcess(["mcp", "install", "codex", "--print"], nested);
    expect(install.status).toBe(0);
    expect(install.output).toContain(join(box.cwd, ".codex", "config.toml"));
    expect(install.output).not.toContain(join(child, ".codex", "config.toml"));
  });

  it("use writes the discovered owned parent instead of replacing an ignored child", async () => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: null } });
    await ensureWorkspaceBinding({ workspaceId: second, hubUrl: null }, box.env);
    const child = join(box.cwd, "nested");
    mkdirSync(child);
    const ignored = join(child, ".uberblick.json");
    writeFileSync(ignored, "do not read or replace");
    unowned.add(ignored);
    const result = await runInProcess(["workspace", "use", second], { ...box, cwd: child });
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).workspaceId).toBe(second);
    expect(readFileSync(ignored, "utf8")).toBe("do not read or replace");
  });

  it("refuses to replace an unowned current-directory entry when no owned parent exists", () => {
    const box = unboundSandbox({ projectBinding: { workspaceId: first, hubUrl: null } });
    const path = join(box.cwd, ".uberblick.json");
    unowned.add(path);
    expect(() => writeProjectBinding({ workspaceId: second, hubUrl: null }, { cwd: box.cwd, env: box.env }))
      .toThrow(`${path}: another user owns it`);
    expect(JSON.parse(readFileSync(path, "utf8")).workspaceId).toBe(first);
  });

  it("skips owner admission on platforms without POSIX owners", () => {
    const box = sandbox({ projectBinding: { workspaceId: first, hubUrl: null } });
    const path = join(box.cwd, ".uberblick.json");
    unowned.add(path);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      expect(resolveProjectBinding({ cwd: box.cwd, env: box.env }).binding?.workspaceId).toBe(first);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(process, "getuid", descriptor);
    }
  });
});
