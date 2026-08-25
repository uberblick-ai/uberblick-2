/**
 * `ub init` has one job that must never go wrong and several that must never
 * surprise: a signing secret that is strong, owner-only, never printed, and
 * never regenerated behind somebody's back.
 *
 * These spawn the real binary in a throwaway XDG home whose working directory
 * looks like a checkout, because the derived `mise.local.toml` and the file modes
 * are the contract — not a function's return value.
 *
 * What is deliberately NOT here: `mise trust` succeeding (mise need not exist in
 * a review container, and the failure path is tested instead), and the full
 * `mise run setup` → `mise run dev` → hub handshake, which needs a toolchain and
 * long-running servers. Those are the scripted probe in the pull request.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MARKER } from "../src/mise-config.js";
import {
  REPO_ROOT,
  removeTempDirs,
  runUb,
  runUbAsync,
  sandbox,
  type Sandbox,
} from "./helpers.js";

afterAll(removeTempDirs);

const CREDENTIALS = ["uberblick", "credentials.json"] as const;

function credentialsPath(box: Sandbox): string {
  return join(box.configHome, ...CREDENTIALS);
}

function storedSecret(box: Sandbox): string {
  const parsed: unknown = JSON.parse(
    readFileSync(credentialsPath(box), "utf8"),
  );
  const secret = (parsed as { signingSecret?: unknown }).signingSecret;
  expect(typeof secret).toBe("string");
  return secret as string;
}

function userConfig(box: Sandbox): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"),
  ) as Record<string, unknown>;
}

function localConfigPath(box: Sandbox): string {
  return join(box.cwd, "mise.local.toml");
}

function derivedSecret(box: Sandbox): string | null {
  const text = readFileSync(localConfigPath(box), "utf8");
  return /^HUB_AUTH_TOKEN = "([^"\n]+)"$/m.exec(text)?.[1] ?? null;
}

/** mise is not on this PATH, which makes the trust step's failure path testable. */
const WITHOUT_MISE = { PATH: "/usr/bin:/bin" };

/**
 * U+007F, written as an escape so it is visible in this source rather than an
 * invisible byte. It is the character `JSON.stringify` leaves raw and TOML
 * forbids raw — the reason values are checked before the derived file is written.
 */
const DELETE = "\u007f";

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("ub init", () => {
  it("generates an owner-only secret, mirrors it into the checkout, prints none of it", () => {
    const box = sandbox({ checkout: true });
    const run = runUb(["init", "--yes"], box, WITHOUT_MISE);
    expect(run.status).toBe(0);

    // At least 32 random bytes, over the alphabet `remote-compose.sh` accepts
    // (`A-Za-z0-9._-`) so the same secret survives a shell and Docker Compose.
    const secret = storedSecret(box);
    expect(secret).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(Buffer.from(secret, "base64url").length).toBeGreaterThanOrEqual(32);

    // The authority is 0600, and so is the file derived from it.
    expect(statSync(credentialsPath(box)).mode & 0o777).toBe(0o600);
    expect(statSync(localConfigPath(box)).mode & 0o777).toBe(0o600);
    expect(readFileSync(localConfigPath(box), "utf8").startsWith(MARKER)).toBe(
      true,
    );
    expect(derivedSecret(box)).toBe(secret);
    // One workspace, agreed between `ub` and every mise task.
    expect(readFileSync(localConfigPath(box), "utf8")).toMatch(
      /^WORKSPACE_ID = "main"$/m,
    );

    // Identity is recorded, and the colour is one y-prosemirror will accept.
    expect(userConfig(box).workspace).toBe("main");
    expect(typeof userConfig(box).displayName).toBe("string");
    expect(userConfig(box).color).toMatch(/^#[0-9a-f]{6}$/i);

    // The one thing this command must never do.
    expect(run.output).not.toContain(secret);
    expect(run.stdout).toMatch(/credential\s+generated for local development/);
  });

  it("is a no-op for the secret on a second run", () => {
    const box = sandbox({ checkout: true });
    expect(runUb(["init", "--yes"], box, WITHOUT_MISE).status).toBe(0);
    const first = storedSecret(box);

    const again = runUb(["init", "--yes"], box, WITHOUT_MISE);
    expect(again.status).toBe(0);
    expect(storedSecret(box)).toBe(first);
    expect(again.stdout).toMatch(/credential\s+already on this machine/);
    expect(again.output).not.toContain(first);
  });

  it("rebuilds the derived config from the authority — same value, not a new one", () => {
    const box = sandbox({ checkout: true });
    expect(runUb(["init", "--yes"], box, WITHOUT_MISE).status).toBe(0);
    const secret = storedSecret(box);

    // Deleted: regenerated from the authority, which is what "derived" means.
    rmSync(localConfigPath(box));
    expect(runUb(["init", "--yes"], box, WITHOUT_MISE).status).toBe(0);
    expect(derivedSecret(box)).toBe(secret);
    expect(storedSecret(box)).toBe(secret);

    // Drifted: the authority wins, rather than two files disagreeing quietly.
    writeFileSync(
      localConfigPath(box),
      `${MARKER}\n[env]\nHUB_AUTH_TOKEN = "stale-value"\n`,
    );
    expect(runUb(["init", "--yes"], box, WITHOUT_MISE).status).toBe(0);
    expect(derivedSecret(box)).toBe(secret);
  });

  it("generates nothing when the environment already supplies a secret", () => {
    // fnox is the owner's path: `mise run init` runs `ub init` inside
    // `fnox exec`, so a decryptable secret arrives exactly like this one.
    const supplied = "environment-supplied-signing-secret-4c19";
    const box = sandbox({ checkout: true });
    const run = runUb(["init", "--yes"], box, {
      ...WITHOUT_MISE,
      HUB_AUTH_TOKEN: supplied,
    });

    expect(run.status).toBe(0);
    expect(existsSync(credentialsPath(box))).toBe(false);
    expect(existsSync(localConfigPath(box))).toBe(false);
    expect(run.stdout).toMatch(/credential\s+supplied by the environment/);
    expect(run.output).not.toContain(supplied);
  });

  it("repairs the mode of an exposed credentials file, keeping its value", () => {
    // Every other command refuses a secret other users can read. Regenerating
    // would cut this machine off from clients holding the old one, so the fix is
    // the mode.
    const secret = "exposed-but-shared-signing-secret-77b1";
    const box = sandbox({
      checkout: true,
      credentials: { signingSecret: secret },
      credentialsMode: 0o644,
    });

    const run = runUb(["init", "--yes"], box, WITHOUT_MISE);
    expect(run.status).toBe(0);
    expect(statSync(credentialsPath(box)).mode & 0o777).toBe(0o600);
    expect(storedSecret(box)).toBe(secret);
    expect(run.output).not.toContain(secret);
  });

  it("leaves a mise.local.toml somebody else wrote alone, and says what to do", () => {
    const box = sandbox({ checkout: true });
    const foreign = "[env]\nMY_OWN_SETTING = \"1\"\n";
    writeFileSync(localConfigPath(box), foreign);

    const run = runUb(["init", "--yes"], box, WITHOUT_MISE);
    expect(run.status).toBe(0);
    expect(readFileSync(localConfigPath(box), "utf8")).toBe(foreign);
    expect(run.stderr).toMatch(/was not written by `ub init`/);
    expect(run.output).not.toContain(storedSecret(box));
  });

  it("names the command to run when mise cannot be reached", () => {
    // An untrusted config file is a hard error for every mise task in the
    // directory, so a `mise trust` that did not happen has to be said out loud.
    const box = sandbox({ checkout: true });
    const run = runUb(["init", "--yes"], box, WITHOUT_MISE);
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/mise trust .*mise\.local\.toml/);
  });

  it("needs no TTY: takes flags, and defaults rather than prompting", () => {
    const box = sandbox({ checkout: true });
    // No `--yes`, stdin a pipe: this must complete rather than block on input.
    expect(runUb(["init"], box, WITHOUT_MISE).status).toBe(0);
    expect(userConfig(box).workspace).toBe("main");

    const flagged = runUb(
      ["init", "--name", "Ada", "--color", "#0675c9", "--workspace", "team-b"],
      box,
      WITHOUT_MISE,
    );
    expect(flagged.status).toBe(0);
    expect(userConfig(box)).toMatchObject({
      displayName: "Ada",
      color: "#0675c9",
      workspace: "team-b",
    });
    expect(readFileSync(localConfigPath(box), "utf8")).toMatch(
      /^WORKSPACE_ID = "team-b"$/m,
    );
  });

  it("refuses an answer it cannot write safely, without printing the secret", () => {
    const secret = "already-stored-signing-secret-1d05";
    const box = sandbox({ checkout: true, credentials: { signingSecret: secret } });

    for (const argv of [
      ["init", "--yes", "--color", "teal"],
      // The workspace names a room AND a SQLite file, and `path.join` follows
      // every one of these out of the data directory.
      ["init", "--yes", "--workspace", "a/b"],
      ["init", "--yes", "--workspace", ".."],
      ["init", "--yes", "--mcp", "--no-mcp"],
    ]) {
      const run = runUb(argv, box, WITHOUT_MISE);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.output).not.toContain(secret);
    }

    // The rejection is the shared rule's, so it names the source and states the
    // real constraints rather than a rule this command invented.
    const named = runUb(["init", "--yes", "--workspace", "a/b"], box, WITHOUT_MISE);
    expect(named.stderr).toMatch(/--workspace must be a single path and room segment/);
    expect(named.stderr).toMatch(/not "\."/);
  });

  it("accepts every workspace the shared rule accepts, and quotes it correctly", () => {
    // The regression Copilot caught: `ub init` had its own, stricter alphabet, so
    // it exited 2 for workspaces every other command is happy with. There is one
    // owner of that rule — `assertWorkspaceSegment` — and writing the value into
    // TOML is an escaping problem, not a reason to narrow it.
    for (const workspace of ["team b", 'sales"q3', "équipe"]) {
      const box = sandbox({ checkout: true });
      const run = runUb(["init", "--yes", "--workspace", workspace], box, WITHOUT_MISE);
      expect(run.status, run.stderr).toBe(0);
      expect(userConfig(box).workspace).toBe(workspace);

      const local = readFileSync(localConfigPath(box), "utf8");
      expect(local).toContain(`WORKSPACE_ID = ${JSON.stringify(workspace)}`);
      // And the file is still readable by the reader that has to rebuild it.
      expect(derivedSecret(box)).toBe(storedSecret(box));
    }
  });

  it("keeps the authority and the derived file agreeing under concurrent runs", async () => {
    // Several fresh `ub init`s at the same moment — a `mise run setup` and an
    // editor's MCP client, say. Last-write-wins would leave one of them having
    // written a derived file for a secret that is no longer the authority's.
    //
    // Six at a time rather than two, though being honest about what this can
    // prove: node's startup dominates each run, so the microseconds where the
    // interleave happens are hard to hit on purpose, and reverting the fix does
    // NOT reliably turn this red. The load-bearing regression test is the
    // deterministic one in config.test.ts — the loser adopting the winner's
    // secret, with no timing involved. What this defends is the property under
    // real concurrency: every process exits 0 (an exclusive create that threw
    // EEXIST at the caller would not), and the pair on disk agrees afterwards.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const box = sandbox({ checkout: true });
      const runs = await Promise.all(
        Array.from({ length: 6 }, () =>
          runUbAsync(["init", "--yes"], box, WITHOUT_MISE),
        ),
      );
      for (const run of runs) {
        expect(run.status, run.output).toBe(0);
      }

      const authority = storedSecret(box);
      expect(derivedSecret(box)).toBe(authority);
      // Exactly one secret survives: neither process printed its own, and the
      // one on disk is the one both of them now describe.
      for (const run of runs) {
        expect(run.output).not.toContain(authority);
      }
    }
  });

  it("waits for another init that is holding the lock, then proceeds", async () => {
    // The deterministic half of the concurrency contract: with the lock held,
    // the write phase does not start at all. Held by hand here rather than by a
    // second process, so the timing is a fact rather than a hope.
    const box = sandbox({ checkout: true });
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");

    const running = runUbAsync(["init", "--yes"], box, WITHOUT_MISE);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Still waiting: nothing has been written, because nothing may be.
    expect(existsSync(credentialsPath(box))).toBe(false);
    expect(existsSync(localConfigPath(box))).toBe(false);

    rmSync(lock);
    const run = await running;
    expect(run.status, run.output).toBe(0);
    expect(derivedSecret(box)).toBe(storedSecret(box));
    // And the lock it took in turn is not left behind.
    expect(existsSync(lock)).toBe(false);
  });

  it("never removes a lock it did not create, however old that lock is", () => {
    // No automatic takeover, deliberately: deciding a holder is dead needs a
    // second mechanism, and every version of that races — two processes agreeing
    // a lock is stale unlink it twice, and the second unlink deletes a lock
    // somebody had just legitimately taken. A crashed holder is instead a
    // visible situation with a one-line fix, so the message has to carry it.
    // A fresh lock and a long-dead one get the same answer, and the second case
    // puts the lock somewhere whose name a shell would mangle: that recovery
    // line is going to be pasted into one.
    for (const [ageMs, home] of [
      [0, null],
      [120_000, "it's here/config dir"],
    ] as const) {
      const box = sandbox({ checkout: true });
      const configHome =
        home === null ? box.configHome : join(box.configHome, home);
      const lock = join(configHome, "uberblick", ".init.lock");
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, "999999\n");
      const when = new Date(Date.now() - ageMs);
      utimesSync(lock, when, when);

      const run = runUb(["init", "--yes"], box, {
        ...WITHOUT_MISE,
        XDG_CONFIG_HOME: configHome,
      });
      expect(run.status).toBe(1);
      // The path, how old it is, and the command that fixes it.
      expect(run.stderr).toMatch(/another `ub init` is holding .*\.init\.lock/);
      expect(run.stderr).toMatch(/\d+s old/);
      // Quoted for a shell: single quotes around the path, with any single
      // quote in it spliced as '\'' — so the line survives spaces, quotes and
      // anything else XDG_CONFIG_HOME can carry.
      expect(run.stderr).toContain(
        `rm -- '${lock.split("'").join(`'\\''`)}'`,
      );
      // Somebody else's lock is left exactly where it was, and nothing was
      // half-written around it.
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(join(configHome, "uberblick", "credentials.json"))).toBe(
        false,
      );
      expect(existsSync(localConfigPath(box))).toBe(false);
    }
  });

  it("refuses to write a value mise could not parse", () => {
    // `JSON.stringify` is not a complete TOML escaper: it leaves U+007F raw,
    // and TOML forbids it raw in a basic string. `assertWorkspaceSegment`
    // accepts it — a room key does not care — so this refusal belongs to the
    // file rather than to the shared rule, and it happens before the write.
    const box = sandbox({ checkout: true });
    const run = runUb(
      ["init", "--yes", "--workspace", `team${DELETE}`],
      box,
      WITHOUT_MISE,
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(
      /--workspace cannot be used because it contains control characters/,
    );
    expect(existsSync(localConfigPath(box))).toBe(false);
  });

  it("keeps a path out of the file it writes, however that path is spelled", () => {
    // The authority's path is attacker-influenced (XDG_CONFIG_HOME), the derived
    // file is TOML, and `ub init` asks mise to TRUST it — so a newline in that
    // path must not be able to add a line to it. It is not interpolated at all.
    const box = sandbox({ checkout: true });
    const evil = join(box.configHome, 'evil\nINJECTED = "yes"');
    mkdirSync(evil, { recursive: true });

    const run = runUb(["init", "--yes"], box, {
      ...WITHOUT_MISE,
      XDG_CONFIG_HOME: evil,
    });
    expect(run.status).toBe(0);

    const local = readFileSync(localConfigPath(box), "utf8");
    expect(local).not.toMatch(/INJECTED/);
    expect(local).not.toContain(evil);
    // Still a file whose one derived value reads back.
    const secret = JSON.parse(
      readFileSync(join(evil, ...CREDENTIALS), "utf8"),
    ).signingSecret;
    expect(derivedSecret(box)).toBe(secret);
  });

  it("leaves a mise.local.toml it cannot read, and one that is a symlink", () => {
    // Failing open here means chmodding and truncating somebody else's file —
    // or, through a symlink, writing the signing secret into whatever the link
    // points at.
    const unreadable = sandbox({ checkout: true });
    writeFileSync(localConfigPath(unreadable), "[env]\nMINE = \"1\"\n");
    chmodSync(localConfigPath(unreadable), 0o000);
    const first = runUb(["init", "--yes"], unreadable, WITHOUT_MISE);
    expect(first.status).toBe(0);
    expect(first.stderr).toMatch(/was left alone: it could not be opened/);
    expect(statSync(localConfigPath(unreadable)).mode & 0o777).toBe(0o000);

    const linked = sandbox({ checkout: true });
    const target = join(linked.cwd, "target.toml");
    writeFileSync(target, "[env]\nMINE = \"1\"\n");
    symlinkSync(target, localConfigPath(linked));
    const second = runUb(["init", "--yes"], linked, WITHOUT_MISE);
    expect(second.status).toBe(0);
    expect(second.stderr).toMatch(/was left alone: it is a symbolic link/);
    // The link is intact and its target never saw the secret.
    expect(lstatSync(localConfigPath(linked)).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("[env]\nMINE = \"1\"\n");
    expect(readFileSync(target, "utf8")).not.toContain(storedSecret(linked));
  });

  it("repairs the mode of a config.json that was left readable", () => {
    const box = sandbox({ checkout: true, userConfig: { workspace: "main" } });
    chmodSync(join(box.configHome, "uberblick", "config.json"), 0o644);

    expect(runUb(["init", "--yes"], box, WITHOUT_MISE).status).toBe(0);
    expect(
      statSync(join(box.configHome, "uberblick", "config.json")).mode & 0o077,
    ).toBe(0);
  });

  it("offers the MCP wiring, and honours --no-mcp instead of blocking", () => {
    const box = sandbox({ checkout: true });
    const offered = runUb(["init", "--yes"], box, WITHOUT_MISE);
    expect(offered.stdout).toMatch(/ub mcp install/);

    const declined = runUb(["init", "--yes", "--no-mcp"], box, WITHOUT_MISE);
    expect(declined.status).toBe(0);
    expect(declined.stdout).not.toMatch(/ub mcp install/);
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);

    // Asked for outright, it delegates to `ub mcp install` — with no vendor CLI
    // reachable, so this is the file-editing path, in the sandbox's own
    // directory rather than anywhere on the developer's machine.
    const asked = runUb(["init", "--yes", "--mcp"], box, {
      ...WITHOUT_MISE,
      PATH: "/nonexistent-for-tests",
    });
    expect(asked.status).toBe(0);
    expect(asked.stdout).toMatch(/uberblick registered with claude/);
    const registered = JSON.parse(
      readFileSync(join(box.cwd, ".mcp.json"), "utf8"),
    );
    expect(registered.mcpServers.uberblick.args).toEqual(["mcp", "serve"]);
  });

  it("writes no derived config outside a checkout", () => {
    // An installed `ub` with no checkout still initialises: the derived file
    // exists for mise's benefit, and there is no mise here.
    const box = sandbox();
    const run = runUb(["init", "--yes"], box, WITHOUT_MISE);
    expect(run.status).toBe(0);
    expect(existsSync(localConfigPath(box))).toBe(false);
    expect(storedSecret(box)).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(run.stdout).not.toMatch(/mise run dev/);
  });

  it.skipIf(!hasGit)("leaves a checkout with nothing for git to report", () => {
    // The real `.gitignore`, so this fails if the ignore rule for the derived
    // config is ever dropped — that file carries the signing secret.
    const box = sandbox({ checkout: true });
    copyFileSync(join(REPO_ROOT, ".gitignore"), join(box.cwd, ".gitignore"));
    const git = (...args: string[]): void => {
      const result = spawnSync("git", args, { cwd: box.cwd, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "--quiet");
    git("add", "-A");
    git(
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "checkout",
    );

    expect(runUb(["init", "--yes"], box, WITHOUT_MISE).status).toBe(0);
    expect(existsSync(localConfigPath(box))).toBe(true);

    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: box.cwd,
      encoding: "utf8",
    });
    expect(status.stdout).toBe("");
  });

  it("keeps both files owner-only under a umask that would widen them", () => {
    // `mode:` on a write is subject to the umask, so both files are chmodded
    // afterwards. Prove it with the widest umask a system will accept.
    const box = sandbox({ checkout: true });
    const previous = process.umask(0o000);
    try {
      expect(runUb(["init", "--yes"], box, WITHOUT_MISE).status).toBe(0);
    } finally {
      process.umask(previous);
    }
    expect(statSync(credentialsPath(box)).mode & 0o077).toBe(0);
    expect(statSync(localConfigPath(box)).mode & 0o077).toBe(0);
  });
});
