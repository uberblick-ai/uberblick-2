import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { localBrowserKey } from "../src/browser-key.js";
import { PACKAGE_ROOT, removeTempDirs, sandbox, waitUntil } from "./helpers.js";

afterAll(removeTempDirs);

const WORKSPACE = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "bbbbbbbb-2222-4222-8222-222222222222";

describe("local browser key", () => {
  it("persists one independent owner-only key per canonical workspace", () => {
    const box = sandbox({ credentials: { signingSecret: "upstream-secret" } });
    const key = localBrowserKey(WORKSPACE, box.env);
    const directory = join(box.configHome, "uberblick", "browser-keys");
    const path = join(directory, `${WORKSPACE}.key`);
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
    expect(readFileSync(path, "utf8")).toBe(`${key}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(localBrowserKey(`cosmetic-${WORKSPACE}`, box.env)).toBe(key);
    expect(localBrowserKey(OTHER_WORKSPACE, box.env)).not.toBe(key);
    expect(readFileSync(join(box.configHome, "uberblick", "credentials.json"), "utf8")).not.toContain(key);
    expect(existsSync(join(box.configHome, "uberblick", "config.json"))).toBe(false);
    expect(localBrowserKey(WORKSPACE, { ...box.env, HUB_AUTH_TOKEN: "different-upstream-secret" })).toBe(key);
    expect(readdirSync(directory).sort()).toEqual([`${WORKSPACE}.key`, `${OTHER_WORKSPACE}.key`].sort());
  });

  it("refuses exposed keys without replacing them or printing their contents", () => {
    const box = sandbox();
    const key = localBrowserKey(WORKSPACE, box.env);
    const path = join(box.configHome, "uberblick", "browser-keys", `${WORKSPACE}.key`);
    chmodSync(path, 0o644);
    let diagnostic = "";
    try { localBrowserKey(WORKSPACE, box.env); } catch (error) { diagnostic = String(error); }
    expect(diagnostic).toContain("chmod 600");
    expect(diagnostic).not.toContain(key);
    expect(readFileSync(path, "utf8")).toBe(`${key}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    chmodSync(path, 0o600);
    expect(localBrowserKey(WORKSPACE, box.env)).toBe(key);
  });

  it.each(["", "not-a-key\n", `${"!".repeat(43)}\n`, `${"a".repeat(43)}\n`, "a".repeat(44)])("refuses malformed stored keys without regeneration (%j)", (contents) => {
    const box = sandbox();
    localBrowserKey(WORKSPACE, box.env);
    const directory = join(box.configHome, "uberblick", "browser-keys");
    const path = join(directory, `${WORKSPACE}.key`);
    writeFileSync(path, contents);
    expect(() => localBrowserKey(WORKSPACE, box.env)).toThrow("it is malformed");
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(readdirSync(directory)).toEqual([`${WORKSPACE}.key`]);
  });

  it("refuses a key symlink and leaves its target untouched", () => {
    const box = sandbox();
    const directory = join(box.configHome, "uberblick", "browser-keys");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(box.cwd, "target");
    writeFileSync(target, `${Buffer.alloc(32, 17).toString("base64url")}\n`, { mode: 0o600 });
    const before = readFileSync(target, "utf8");
    symlinkSync(target, join(directory, `${WORKSPACE}.key`));
    expect(() => localBrowserKey(WORKSPACE, box.env)).toThrow("symbolic link");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  it("refuses a non-regular key instead of overwriting it", () => {
    const box = sandbox();
    const path = join(box.configHome, "uberblick", "browser-keys", `${WORKSPACE}.key`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    expect(() => localBrowserKey(WORKSPACE, box.env)).toThrow("regular file you own");
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it("refuses exposed or symlinked key directories", () => {
    const exposed = sandbox();
    const directory = join(exposed.configHome, "uberblick", "browser-keys");
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    chmodSync(directory, 0o755);
    expect(() => localBrowserKey(WORKSPACE, exposed.env)).toThrow("owner-only directory");
    expect(readdirSync(directory)).toEqual([]);

    const linked = sandbox();
    mkdirSync(join(linked.configHome, "uberblick"), { recursive: true });
    symlinkSync(linked.cwd, join(linked.configHome, "uberblick", "browser-keys"));
    expect(() => localBrowserKey(WORKSPACE, linked.env)).toThrow("owner-only directory");
    expect(readdirSync(linked.cwd)).toEqual([]);
  });

  it("rejects invalid workspace paths before creating state", () => {
    const box = sandbox();
    expect(() => localBrowserKey("../../secret", box.env)).toThrow();
    expect(existsSync(box.configHome)).toBe(false);
  });

  it("concurrent first launches both adopt the complete winning key", async () => {
    const box = sandbox();
    const barrier = join(box.cwd, `browser-key-race-${process.env.UB_AGENTS_RUN ?? "test"}`);
    mkdirSync(barrier);
    const worker = join(barrier, "worker.mjs");
    writeFileSync(worker, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [barrier, id] = process.argv.slice(2);
const link = fs.linkSync;
fs.linkSync = (...args) => {
  fs.writeFileSync(barrier + "/ready-" + id, "");
  const deadline = Date.now() + 8000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(barrier + "/release")) {
    if (Date.now() >= deadline) throw new Error("browser key barrier timed out");
    Atomics.wait(sleeper, 0, 0, 10);
  }
  return link(...args);
};
syncBuiltinESMExports();
const { localBrowserKey } = await import(${JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "src/browser-key.ts")).href)});
fs.writeFileSync(barrier + "/result-" + id, localBrowserKey(${JSON.stringify(WORKSPACE)}), { mode: 0o600 });
`, "utf8");
    const children: { child: ChildProcess; done: Promise<number | null> }[] = [];
    for (const id of ["a", "b"]) {
      const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), worker, barrier, id], {
        cwd: box.cwd, env: box.env, timeout: 10_000, stdio: "ignore",
      });
      children.push({ child, done: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }) });
    }
    try {
      await waitUntil("both browser key candidates staged", () => existsSync(join(barrier, "ready-a")) && existsSync(join(barrier, "ready-b")), 7_000);
      writeFileSync(join(barrier, "release"), "");
      expect(await Promise.all(children.map(({ done }) => done))).toEqual([0, 0]);
      const key = localBrowserKey(WORKSPACE, box.env);
      expect(readFileSync(join(barrier, "result-a"), "utf8")).toBe(key);
      expect(readFileSync(join(barrier, "result-b"), "utf8")).toBe(key);
      expect(readdirSync(join(box.configHome, "uberblick", "browser-keys"))).toEqual([`${WORKSPACE}.key`]);
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.allSettled(children.map(({ done }) => done));
    }
  });
});
