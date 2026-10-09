/** Local creation keeps its signing secret private and publishes only a complete seed. */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultDatabasePath, readWorkspaceName, resolveMcpConfig, syncWorkspace } from "@uberblick/mcp-server";
import { afterAll, expect, it } from "vitest";
import { credentialsPath, resolveConfig } from "../src/config.js";
import { initLockPath, seedLockPath } from "../src/init-lock.js";
import { removeTempDirs, runUb, runUbAsync, sandbox, unboundSandbox, type Sandbox } from "./helpers.js";
import { fixture } from "./auth-fixtures.js";

afterAll(removeTempDirs);

const PREVIOUS = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";
const SECRET = "synthetic-existing-create-secret";

function binding(box: Sandbox): { workspaceId: string; hubUrl: null } {
  return JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"));
}

async function checkSeed(box: Sandbox, name: string): Promise<void> {
  const selected = binding(box);
  expect(selected.hubUrl).toBeNull();
  const config = resolveMcpConfig({ ...box.env, WORKSPACE_ID: selected.workspaceId });
  expect(readWorkspaceName(config.databasePath, config.workspaceId)).toBe(name);
  const { entries } = await syncWorkspace({ ...config, authSecret: null });
  expect(entries.map(doc => doc.title).sort()).toEqual(["How to Use It", "Welcome to Überblick"]);
}

it("creates a private secret that the next MCP process resolves, without dialing a hub", async () => {
  const box = unboundSandbox();
  const preload = join(box.cwd, "refuse-network.mjs");
  writeFileSync(preload, `
import { Socket } from "node:net";
Socket.prototype.connect = () => { throw new Error("workspace create tried to dial a hub"); };
`);
  const created = runUb(["workspace", "create", "Project notes"], box, {
    NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
  });
  expect(created.status, created.output).toBe(0);
  const path = credentialsPath(box.env);
  const credential = JSON.parse(readFileSync(path, "utf8"));
  expect(credential.signingSecret).toMatch(/^[0-9a-f]{64}$/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(created.output).not.toContain(credential.signingSecret);
  const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
  expect(resolveMcpConfig(resolved.env).authSecret).toBe(credential.signingSecret);
  await checkSeed(box, "Project notes");
});

it.each([false, true])("uses an environment secret without writing credentials: existing file %s", async (onFile) => {
  const box = unboundSandbox(onFile ? {
    credentials: { signingSecret: "other-synthetic-secret", hubLogins: {} },
    credentialsMode: 0o644,
  } : {});
  const path = credentialsPath(box.env);
  const before = onFile ? readFileSync(path) : null;
  const created = runUb(["workspace", "create", "Environment notes"], box, { HUB_AUTH_TOKEN: SECRET });
  expect(created.status, created.output).toBe(0);
  expect(created.output).not.toContain(SECRET);
  if (onFile) {
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  } else {
    expect(existsSync(path)).toBe(false);
  }
  await checkSeed(box, "Environment notes");
});

it("uses the existing secret and leaves name and colour settings untouched", async () => {
  const box = sandbox({
    credentials: { signingSecret: SECRET, hubLogins: {} },
    userConfig: { displayName: "Synthetic person", color: "#0e8085", other: "unchanged" },
  });
  const path = credentialsPath(box.env);
  const config = join(box.configHome, "uberblick", "config.json");
  const before = readFileSync(path);
  const settings = readFileSync(config);
  const modified = statSync(path).mtimeMs;
  const created = runUb(["workspace", "create", "Another workspace"], box);
  expect(created.status, created.output).toBe(0);
  expect(readFileSync(path)).toEqual(before);
  expect(statSync(path).mtimeMs).toBe(modified);
  expect(readFileSync(config)).toEqual(settings);
  expect(created.output).not.toContain(SECRET);
  await checkSeed(box, "Another workspace");
});

it("serializes two creates, preserving hub logins and one secret for both projects", async () => {
  const login = fixture([PREVIOUS]);
  const first = unboundSandbox({ credentials: { hubLogins: { "https://hub.example.test": login }, extra: "keep" } });
  const second = unboundSandbox();
  // Two projects on one computer share the same private credential store.
  const otherProject = { ...first, cwd: second.cwd };
  const runs = await Promise.all([
    runUbAsync(["workspace", "create", "First project"], first),
    runUbAsync(["workspace", "create", "Second project"], otherProject),
  ]);
  for (const run of runs) expect(run.status, run.output).toBe(0);
  const credential = JSON.parse(readFileSync(credentialsPath(first.env), "utf8"));
  expect(credential).toEqual({
    signingSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
    hubLogins: { "https://hub.example.test": login }, extra: "keep",
  });
  for (const box of [first, otherProject]) {
    expect(resolveConfig({ env: box.env, cwd: box.cwd }).env.HUB_AUTH_TOKEN).toBe(credential.signingSecret);
  }
  for (const run of runs) expect(run.output).not.toContain(credential.signingSecret);
  expect(binding(first).workspaceId).not.toBe(binding(otherProject).workspaceId);
  await checkSeed(first, "First project");
  await checkSeed(otherProject, "Second project");
});

it("still creates and seeds a workspace when an exposed credential file must be deleted", async () => {
  const box = unboundSandbox({ credentials: { signingSecret: SECRET, hubLogins: {} }, credentialsMode: 0o644 });
  const path = credentialsPath(box.env);
  const before = readFileSync(path);
  const created = runUb(["workspace", "create", "Offline notes"], box);
  expect(created.status, created.output).toBe(0);
  expect(created.stderr).toContain("secret may have leaked");
  expect(created.stderr).toContain(`delete ${path}`);
  expect(created.stderr).toContain("next `ub open` makes a new secret");
  expect(created.stderr).toContain("restart running agents");
  expect(created.stderr).toContain("`ub auth login` again if the file held hub logins");
  expect(created.stderr).not.toContain("chmod");
  expect(created.output).not.toContain(SECRET);
  expect(readFileSync(path)).toEqual(before);
  expect(statSync(path).mode & 0o777).toBe(0o644);
  await checkSeed(box, "Offline notes");
});

it.each(["failure", "interruption"] as const)(
  "keeps the prior binding after a seed %s and creates a fresh complete workspace on retry",
  async (kind) => {
    const box = sandbox({ projectBinding: { workspaceId: PREVIOUS, hubUrl: null } });
    const previous = readFileSync(join(box.cwd, ".uberblick.json"));
    const preload = join(box.cwd, "stop-starter.mjs");
    writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from "node:module";
const fs = createRequire(import.meta.url)("node:fs");
const readdir = fs.readdirSync;
fs.readdirSync = (path, ...args) => {
  if (String(path).endsWith("/templates")) {
    ${kind === "failure" ? 'throw new Error("starter read refused");' : 'process.kill(process.pid, "SIGKILL");'}
  }
  return readdir(path, ...args);
};
syncBuiltinESMExports();
`);
    const failed = runUb(["workspace", "create", "Interrupted notes"], box, {
      NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
    });
    expect(failed.status).not.toBe(0);
    if (kind === "failure") expect(failed.stderr).toContain("Project binding unchanged");
    expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(previous);
    const partials = readdirSync(join(box.dataHome, "uberblick")).filter(file => file.endsWith(".sqlite"));
    expect(partials).toHaveLength(1);
    const partial = join(box.dataHome, "uberblick", partials[0]!);
    const partialBefore = readFileSync(partial);
    if (kind === "interruption") {
      // Locks never take over a crashed holder; remove this test child's locks
      // after it has exited, as the command's recovery diagnostic directs.
      rmSync(initLockPath(box.env));
      rmSync(seedLockPath(box.env));
    }
    const completed = runUb(["workspace", "create", "Complete notes"], box);
    expect(completed.status, completed.output).toBe(0);
    expect(defaultDatabasePath(binding(box).workspaceId, box.env)).not.toBe(partial);
    expect(readFileSync(partial)).toEqual(partialBefore);
    await checkSeed(box, "Complete notes");
  },
);
