import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { publishOwnerOnly } from "@uberblick/mcp-server/safe-write";
import { acquireInitLock } from "@uberblick/mcp-server/init-lock";
import { writeProjectBinding } from "@uberblick/mcp-server/project-binding";
import { assertWorkspaceBinding, readWorkspaceHub, ensureWorkspaceBinding, workspaceRegistryPath } from "@uberblick/mcp-server/workspace-registry";
import { removeTempDirs, sandbox, type Sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

vi.mock("@uberblick/mcp-server/safe-write", async (original) => {
  const actual = await original<typeof import("@uberblick/mcp-server/safe-write")>();
  return { ...actual, publishOwnerOnly: vi.fn(actual.publishOwnerOnly) };
});
const { publishOwnerOnly: realPublish } = await vi.importActual<typeof import("@uberblick/mcp-server/safe-write")>("@uberblick/mcp-server/safe-write");
afterAll(removeTempDirs);
afterEach(() => vi.mocked(publishOwnerOnly).mockImplementation(realPublish));
const previous = "11111111-1111-4111-8111-111111111111";
const selected = "22222222-2222-4222-8222-222222222222";

function replica(box: Sandbox, id: string): string {
  const path = join(box.dataHome, "uberblick", `${id}.sqlite`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "existing replica contents");
  return path;
}

function customReplica(box: Sandbox, id: string): string {
  const path = join(box.cwd, "custom.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO meta (key, value) VALUES ('workspace', ?)").run(id);
  } finally { database.close(); }
  box.env.UBERBLICK_DB = path;
  return path;
}

describe("workspace record failure boundaries", () => {
  it.each([
    ["wss://HUB.EXAMPLE:443/a/../ws", "wss://hub.example/ws"],
    ["ws://127.1:4444/ws", "ws://127.0.0.1:4444/ws"],
    ["ws://[0:0:0:0:0:0:0:1]:4444/ws", "ws://[::1]:4444/ws"],
  ])("accepts another spelling of recorded hub %s without rewriting either file", async (recorded, hubUrl) => {
    const binding = { workspaceId: selected, hubUrl };
    const box = sandbox({ projectBinding: binding });
    await ensureWorkspaceBinding({ workspaceId: selected, hubUrl: recorded }, box.env);
    const registry = workspaceRegistryPath(box.env);
    const recordsBefore = readFileSync(registry);
    const path = join(box.cwd, ".uberblick.json");
    const bindingBefore = readFileSync(path);
    expect(JSON.parse(recordsBefore.toString("utf8"))).toEqual({ [selected]: recorded });
    expect(assertWorkspaceBinding(binding, box.env)).toBe(true);
    await ensureWorkspaceBinding(binding, box.env);
    expect(readWorkspaceHub(selected, box.env)).toBe(recorded);
    expect(readFileSync(registry)).toEqual(recordsBefore);
    expect(readFileSync(path)).toEqual(bindingBefore);
  });

  it.each([
    "ws://localhost:4444/ws/",
    "ws://localhost:4444/WS",
    "ws://localhost:4444/w%73",
    "ws://127.0.0.1:4444/ws",
    "ws://[::1]:4444/ws",
  ])("rejects distinct hub %s without rewriting the record or binding", async hubUrl => {
    const box = sandbox({ projectBinding: { workspaceId: selected, hubUrl } });
    const recorded = "ws://localhost:4444/ws";
    await ensureWorkspaceBinding({ workspaceId: selected, hubUrl: recorded }, box.env);
    const registry = workspaceRegistryPath(box.env);
    const recordsBefore = readFileSync(registry);
    const path = join(box.cwd, ".uberblick.json");
    const bindingBefore = readFileSync(path);
    expect(() => assertWorkspaceBinding({ workspaceId: selected, hubUrl }, box.env)).toThrow("belongs to");
    expect(readWorkspaceHub(selected, box.env)).toBe(recorded);
    expect(readFileSync(registry)).toEqual(recordsBefore);
    expect(readFileSync(path)).toEqual(bindingBefore);
  });

  it("passive registration cannot attach an existing unrecorded replica to a hub", async () => {
    const box = sandbox();
    const database = replica(box, selected);
    const before = readFileSync(database);
    await expect(ensureWorkspaceBinding({ workspaceId: selected, hubUrl: "wss://binding.example.test/ws" }, box.env))
      .rejects.toThrow("existing replica with no hub record");
    expect(readWorkspaceHub(selected, box.env)).toBeUndefined();
    expect(existsSync(workspaceRegistryPath(box.env))).toBe(false);
    expect(readFileSync(database)).toEqual(before);
  });

  it.each([
    ["selected", undefined],
    ["previous", undefined],
    ["previous", "join"],
    ["previous", "promote"],
  ] as const)("refuses an unrecorded remote %s replica before changing the binding or registry (operation: %s)", async (which, record) => {
    const box = sandbox({ projectBinding: {
      workspaceId: previous,
      hubUrl: which === "previous" ? "wss://binding.example.test/ws" : null,
    } });
    const database = replica(box, which === "previous" ? previous : selected);
    const databaseBefore = readFileSync(database);
    await ensureWorkspaceBinding({ workspaceId: which === "previous" ? selected : previous, hubUrl: null }, box.env);
    const registry = workspaceRegistryPath(box.env);
    const registryBefore = readFileSync(registry);
    const path = join(box.cwd, ".uberblick.json");
    const bindingBefore = readFileSync(path);
    const lock = await acquireInitLock(box.env);
    try {
      expect(() => writeProjectBinding({ workspaceId: selected, hubUrl: which === "selected" ? "wss://binding.example.test/ws" : null },
        { cwd: box.cwd, env: box.env, ...(record === undefined ? {} : { record }) }))
        .toThrow("existing replica with no hub record");
    } finally { lock.release(); }
    expect(readFileSync(path)).toEqual(bindingBefore);
    expect(readFileSync(registry)).toEqual(registryBefore);
    expect(readFileSync(database)).toEqual(databaseBefore);
  });

  it("switching bindings records local for an existing unrecorded local replica", async () => {
    const box = sandbox({ projectBinding: { workspaceId: previous, hubUrl: null } });
    const database = replica(box, previous);
    const before = readFileSync(database);
    const lock = await acquireInitLock(box.env);
    try {
      writeProjectBinding({ workspaceId: selected, hubUrl: null }, { cwd: box.cwd, env: box.env });
    } finally { lock.release(); }
    expect(readWorkspaceHub(previous, box.env)).toBeNull();
    expect(readWorkspaceHub(selected, box.env)).toBeNull();
    expect(readFileSync(database)).toEqual(before);
    expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"))).toEqual({ workspaceId: selected, hubUrl: null });
  });

  it("selecting the same unrecorded replica as local replaces its hub binding without adopting that hub", async () => {
    const box = sandbox({ projectBinding: { workspaceId: `copied-${selected}`, hubUrl: "wss://binding.example.test/ws" } });
    const database = replica(box, selected);
    const before = readFileSync(database);
    const binding = { workspaceId: selected, hubUrl: null };
    const lock = await acquireInitLock(box.env);
    try {
      writeProjectBinding(binding, { cwd: box.cwd, env: box.env });
    } finally { lock.release(); }
    expect(readWorkspaceHub(selected, box.env)).toBeNull();
    expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"))).toEqual(binding);
    expect(readFileSync(database)).toEqual(before);
  });

  it.each([false, true])("failed local fallback publication restores records and the same workspace's hub binding (existing registry: %s)", async (existing) => {
    const box = sandbox({ projectBinding: { workspaceId: selected, hubUrl: "wss://binding.example.test/ws" } });
    const database = replica(box, selected);
    const databaseBefore = readFileSync(database);
    if (existing) await ensureWorkspaceBinding({ workspaceId: previous, hubUrl: "wss://previous.example.test/ws" }, box.env);
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
      expect(() => writeProjectBinding({ workspaceId: selected, hubUrl: null }, { cwd: box.cwd, env: box.env }))
        .toThrow("injected project publication failure");
    } finally { lock.release(); }
    expect(readFileSync(path)).toEqual(bindingBefore);
    expect(readWorkspaceHub(selected, box.env)).toBeUndefined();
    if (original === null) expect(existsSync(registry)).toBe(false);
    else expect(readFileSync(registry)).toEqual(original);
    expect(readFileSync(database)).toEqual(databaseBefore);
  });

  it("a selected workspace's custom replica does not make a previous workspace an existing replica", async () => {
    const previousHub = "wss://previous.example.test/ws";
    const box = sandbox({ projectBinding: { workspaceId: previous, hubUrl: previousHub } });
    await ensureWorkspaceBinding({ workspaceId: selected, hubUrl: null }, box.env);
    const database = customReplica(box, selected);
    const databaseBefore = readFileSync(database);
    const binding = { workspaceId: selected, hubUrl: null };
    const lock = await acquireInitLock(box.env);
    try {
      writeProjectBinding(binding, { cwd: box.cwd, env: box.env });
    } finally { lock.release(); }
    expect(readWorkspaceHub(previous, box.env)).toBe(previousHub);
    expect(readWorkspaceHub(selected, box.env)).toBeNull();
    expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"))).toEqual(binding);
    expect(readFileSync(database)).toEqual(databaseBefore);
  });

  it("refuses to register a previous unknown remote workspace that owns the custom replica", async () => {
    const box = sandbox({ projectBinding: { workspaceId: previous, hubUrl: "wss://previous.example.test/ws" } });
    await ensureWorkspaceBinding({ workspaceId: selected, hubUrl: null }, box.env);
    const database = customReplica(box, previous);
    const databaseBefore = readFileSync(database);
    const registry = workspaceRegistryPath(box.env);
    const registryBefore = readFileSync(registry);
    const path = join(box.cwd, ".uberblick.json");
    const bindingBefore = readFileSync(path);
    const lock = await acquireInitLock(box.env);
    try {
      expect(() => writeProjectBinding({ workspaceId: selected, hubUrl: null }, { cwd: box.cwd, env: box.env }))
        .toThrow("existing replica with no hub record");
    } finally { lock.release(); }
    expect(readWorkspaceHub(previous, box.env)).toBeUndefined();
    expect(readFileSync(path)).toEqual(bindingBefore);
    expect(readFileSync(registry)).toEqual(registryBefore);
    expect(readFileSync(database)).toEqual(databaseBefore);
  });

  it.each(["join", "promote"] as const)("an explicit %s replaces the same workspace's unrecorded, local or remote association", async (record) => {
    for (const oldHub of [undefined, null, "wss://recorded.example.test/ws"]) {
      const box = sandbox({ projectBinding: {
        workspaceId: selected,
        hubUrl: oldHub === undefined ? "wss://binding.example.test/ws" : oldHub,
      } });
      if (oldHub !== undefined) await ensureWorkspaceBinding({ workspaceId: selected, hubUrl: oldHub }, box.env);
      const database = replica(box, selected);
      const before = readFileSync(database);
      const target = { workspaceId: selected, hubUrl: "wss://moved.example.test/ws" };
      const lock = await acquireInitLock(box.env);
      try {
        writeProjectBinding(target, { cwd: box.cwd, env: box.env, record });
      } finally { lock.release(); }
      expect(readWorkspaceHub(selected, box.env)).toBe(target.hubUrl);
      expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"))).toEqual(target);
      expect(readFileSync(database)).toEqual(before);
    }
  });

  it.each([false, true])("failed binding publication restores records exactly (existing registry: %s)", async (existing) => {
    const box = sandbox({ projectBinding: { workspaceId: previous, hubUrl: "wss://previous.example.test/ws" } });
    if (existing) await ensureWorkspaceBinding({ workspaceId: selected, hubUrl: null }, box.env);
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
    await ensureWorkspaceBinding({ workspaceId: previous, hubUrl: null }, box.env);
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
    await ensureWorkspaceBinding({ workspaceId: selected, hubUrl: null }, box.env);
    const registry = workspaceRegistryPath(box.env);
    writeFileSync(registry, "{misplaced-sensitive-value");
    const path = join(box.cwd, ".uberblick.json");
    const config = join(box.configHome, "uberblick", "config.json");
    const bindingBefore = readFileSync(path);
    const settingsBefore = readFileSync(config);
    const run = await runInProcess(["workspace", "use", selected], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Invalid workspace records");
    expect(run.stderr).not.toContain("misplaced-sensitive-value");
    expect(readFileSync(path)).toEqual(bindingBefore);
    expect(readFileSync(config)).toEqual(settingsBefore);
    expect(readFileSync(registry, "utf8")).toBe("{misplaced-sensitive-value");
  });
});
