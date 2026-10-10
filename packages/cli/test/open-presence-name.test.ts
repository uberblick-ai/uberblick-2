/** The presence default comes from the cwd's git configuration, without a prompt. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanUp,
  configured,
  FIRST_REMOTE,
  freePort,
  get,
  open,
} from "./open-fixtures.js";
import { pointAt } from "./helpers.js";

afterEach(cleanUp);

function nameFixture(): ReturnType<typeof configured> {
  const fixture = configured();
  // No shared default hub port: these prove the served config, not hub startup.
  pointAt(fixture.box, FIRST_REMOTE);
  return fixture;
}

async function servedName(
  fixture: ReturnType<typeof configured>,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  const app = await open(fixture.box, ["--port", String(await freePort())], { ...fixture.env, ...extraEnv });
  try {
    const document = await (await get(`${app.url}uberblick-config.json`)).json() as { defaultPresenceName: string };
    return document.defaultPresenceName;
  } finally {
    expect((await app.interrupt()).status).toBe(0);
  }
}

function initGit(fixture: ReturnType<typeof configured>): void {
  execFileSync("git", ["init", "--quiet", fixture.box.cwd], { env: { ...fixture.box.env, ...fixture.env } });
}

function gitName(fixture: ReturnType<typeof configured>, name: string): void {
  execFileSync("git", ["config", "user.name", name], {
    cwd: fixture.box.cwd,
    env: { ...fixture.box.env, ...fixture.env },
  });
}

describe("ub open presence name", () => {
  it("uses the cwd's git user.name ahead of a global name", async () => {
    const fixture = nameFixture();
    initGit(fixture);
    gitName(fixture, "  Zoë Local  ");
    const globalConfig = join(fixture.box.cwd, "global.gitconfig");
    writeFileSync(globalConfig, "[user]\nname = Global Name\n");

    expect(await servedName(fixture, { GIT_CONFIG_GLOBAL: globalConfig })).toBe("Zoë Local");
  });

  it("uses git's global user.name outside a repository", async () => {
    const fixture = nameFixture();
    const globalConfig = join(fixture.box.cwd, "global.gitconfig");
    writeFileSync(globalConfig, "[user]\nname = Global Name\n");

    expect(await servedName(fixture, { GIT_CONFIG_GLOBAL: globalConfig })).toBe("Global Name");
  });

  it.each([undefined, "", " \t "])("falls back to the OS username for unusable git name %s", async name => {
    const fixture = nameFixture();
    initGit(fixture);
    if (name !== undefined) gitName(fixture, name);

    expect(await servedName(fixture)).toBe(userInfo().username);
  });

  it("still serves when git is missing", async () => {
    expect(await servedName(nameFixture(), { PATH: "" })).toBe(userInfo().username);
  });

  it("still serves when the git lookup fails", async () => {
    const fixture = nameFixture();
    initGit(fixture);
    writeFileSync(join(fixture.box.cwd, ".git", "config"), "not a git config document\n");

    expect(await servedName(fixture)).toBe(userInfo().username);
  });

  it("keeps the startup default until ub open restarts", async () => {
    const fixture = nameFixture();
    initGit(fixture);
    gitName(fixture, "First Name");
    const port = await freePort();
    const app = await open(fixture.box, ["--port", String(port)], fixture.env);
    try {
      gitName(fixture, "Second Name");
      expect(await (await get(`${app.url}uberblick-config.json`)).json()).toMatchObject({ defaultPresenceName: "First Name" });
    } finally {
      expect((await app.interrupt()).status).toBe(0);
    }
    const restarted = await open(fixture.box, ["--port", String(port)], fixture.env);
    try {
      expect(await (await get(`${restarted.url}uberblick-config.json`)).json()).toMatchObject({ defaultPresenceName: "Second Name" });
    } finally {
      expect((await restarted.interrupt()).status).toBe(0);
    }
  });

  it("still serves when a stalled git lookup ignores SIGTERM", async () => {
    const fixture = nameFixture();
    const bin = join(fixture.box.cwd, "bin");
    const pidFile = join(fixture.box.cwd, "git.pid");
    const git = join(bin, "git");
    mkdirSync(bin);
    writeFileSync(git, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1_000);\n`);
    chmodSync(git, 0o755);
    try {
      expect(await servedName(fixture, { PATH: bin })).toBe(userInfo().username);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      // A failed assertion must not leave the executable this test started.
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already exited */ }
      }
    }
  });
});
