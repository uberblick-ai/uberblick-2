import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { publishOwnerOnly } from "@uberblick/hub/safe-write";
import { acquireInitLock } from "../src/init-lock.js";
import { writeProjectBinding } from "../src/project-binding.js";
import { readWorkspaceHub, rememberWorkspaceBinding, workspaceRegistryPath } from "../src/workspace-registry.js";
import { removeTempDirs, runUb, sandbox } from "./helpers.js";

vi.mock("@uberblick/hub/safe-write", async (original) => {
  const actual = await original<typeof import("@uberblick/hub/safe-write")>();
  return { ...actual, publishOwnerOnly: vi.fn(actual.publishOwnerOnly) };
});
const { publishOwnerOnly: realPublish } = await vi.importActual<typeof import("@uberblick/hub/safe-write")>("@uberblick/hub/safe-write");
afterAll(removeTempDirs);
afterEach(() => vi.mocked(publishOwnerOnly).mockImplementation(realPublish));
const previous = "11111111-1111-4111-8111-111111111111";
const selected = "22222222-2222-4222-8222-222222222222";

describe("workspace record failure boundaries", () => {
  it.each([null, "wss://recorded.example.test/ws"])("passive registration preserves an existing %s record without waiting on a writer", async (hubUrl) => {
    const box = sandbox();
    await rememberWorkspaceBinding({ workspaceId: selected, hubUrl }, box.env);
    const registry = workspaceRegistryPath(box.env);
    const before = readFileSync(registry);
    const lock = await acquireInitLock(box.env);
    try {
      await rememberWorkspaceBinding({ workspaceId: selected, hubUrl: "wss://serving.example.test/ws" }, box.env);
      expect(readFileSync(registry)).toEqual(before);
      expect(readWorkspaceHub(selected, box.env)).toBe(hubUrl);
    } finally { lock.release(); }
  });

  it.each([false, true])("failed binding publication restores records exactly (existing registry: %s)", async (existing) => {
    const box = sandbox({ projectBinding: { workspaceId: previous, hubUrl: "wss://previous.example.test/ws" } });
    if (existing) await rememberWorkspaceBinding({ workspaceId: selected, hubUrl: null }, box.env);
    const registry = workspaceRegistryPath(box.env);
    const original = existing ? readFileSync(registry) : null;
    const path = join(box.cwd, ".uberblick.json");
    const bindingBefore = readFileSync(path);
    vi.mocked(publishOwnerOnly).mockImplementation((target, contents, command) => {
      if (target === path) throw new Error("injected project publication failure");
      realPublish(target, contents, command);
    });
    const lock = await acquireInitLock(box.env);
    try {
      expect(() => writeProjectBinding({ workspaceId: selected, hubUrl: "wss://joined.example.test/ws" },
        { cwd: box.cwd, env: box.env, record: "join" })).toThrow("injected project publication failure");
    } finally { lock.release(); }
    expect(readFileSync(path)).toEqual(bindingBefore);
    expect(readWorkspaceHub(previous, box.env)).toBeUndefined();
    if (original === null) expect(existsSync(registry)).toBe(false);
    else expect(readFileSync(registry)).toEqual(original);
  });

  it("failed registry publication leaves the project and prior records untouched", async () => {
    const box = sandbox({ projectBinding: { workspaceId: previous, hubUrl: null } });
    await rememberWorkspaceBinding({ workspaceId: previous, hubUrl: null }, box.env);
    const registry = workspaceRegistryPath(box.env);
    const recordsBefore = readFileSync(registry);
    const path = join(box.cwd, ".uberblick.json");
    const bindingBefore = readFileSync(path);
    vi.mocked(publishOwnerOnly).mockImplementation((target, contents, command) => {
      if (target === registry) throw new Error("injected registry publication failure");
      realPublish(target, contents, command);
    });
    const lock = await acquireInitLock(box.env);
    try {
      expect(() => writeProjectBinding({ workspaceId: selected, hubUrl: null }, { cwd: box.cwd, env: box.env }))
        .toThrow("injected registry publication failure");
    } finally { lock.release(); }
    expect(readFileSync(path)).toEqual(bindingBefore);
    expect(readFileSync(registry)).toEqual(recordsBefore);
  });

  it("refuses corrupt records instead of treating an unknown workspace as local or overwriting settings", async () => {
    const box = sandbox({ projectBinding: { workspaceId: previous, hubUrl: null }, userConfig: { displayName: "operator", future: { retained: true } } });
    await rememberWorkspaceBinding({ workspaceId: selected, hubUrl: null }, box.env);
    const registry = workspaceRegistryPath(box.env);
    writeFileSync(registry, "{misplaced-sensitive-value");
    const path = join(box.cwd, ".uberblick.json");
    const config = join(box.configHome, "uberblick", "config.json");
    const bindingBefore = readFileSync(path);
    const settingsBefore = readFileSync(config);
    const run = runUb(["workspace", "use", selected], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Invalid workspace records");
    expect(run.stderr).not.toContain("misplaced-sensitive-value");
    expect(readFileSync(path)).toEqual(bindingBefore);
    expect(readFileSync(config)).toEqual(settingsBefore);
    expect(readFileSync(registry, "utf8")).toBe("{misplaced-sensitive-value");
  });
});
