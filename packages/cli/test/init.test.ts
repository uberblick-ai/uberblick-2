/**
 * `ub init` has one job that must never go wrong and several that must never
 * surprise: a signing secret that is strong, owner-only, never printed, and
 * never regenerated behind somebody's back.
 *
 * These spawn the real binary in a throwaway XDG home whose working directory
 * looks like a checkout, because the file modes are the contract — not a
 * function's return value.
 *
 * What is deliberately NOT here: the full `mise run setup` → `mise run dev` →
 * hub handshake, which needs a toolchain and long-running servers. That is the
 * scripted probe in the pull request.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findCheckoutRoot } from "../src/checkout.js";
import {
  REPO_ROOT,
  removeTempDirs,
  runUb,
  runUbAsync,
  sandbox,
  type Sandbox,
  sleep,
  waitUntil,
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

function projectBinding(box: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"));
}

function userConfig(box: Sandbox): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"),
  ) as Record<string, unknown>;
}

/**
 * A `claude` on PATH that records having been run.
 *
 * `ub init --mcp` prints; it never registers. The only way to see the
 * difference is with a vendor CLI reachable, so this one exists to be found and
 * left alone — the assertion is that its record never appears.
 *
 * The record is written by the shell's own redirection, not by `touch`: the run
 * that finds this stub has the stub's directory as its whole PATH, so an
 * external `touch` could never run and the assertion could never fail.
 */
function stubClaude(box: Sandbox): { dir: string; record: string } {
  const dir = join(box.cwd, "..", "stub-claude");
  const program = join(dir, "claude");
  const record = join(dir, "record");
  mkdirSync(dir, { recursive: true });
  writeFileSync(program, `#!/bin/sh\n: > "${record}"\n`, "utf8");
  chmodSync(program, 0o755);
  return { dir, record };
}

const hasGit = spawnSync("git", ["--version"]).status === 0;

/** A workspace id, as `ub init` generates one: a bare lowercase uuid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A workspace somebody else already owns, joined by id. */
const JOINED = "7c2b91d4-3e05-4a68-9f31-b0d5e6a71c82";

describe("ub init", () => {
  it("generates an owner-only secret and prints none of it", () => {
    const box = sandbox({ checkout: true });
    const run = runUb(["init", "--yes"], box);
    expect(run.status).toBe(0);

    // At least 32 random bytes, over the alphabet `bin/remote-compose.sh` accepts
    // (`A-Za-z0-9._-`) so the same secret survives a shell and Docker Compose.
    const secret = storedSecret(box);
    expect(secret).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(Buffer.from(secret, "base64url").length).toBeGreaterThanOrEqual(32);

    expect(statSync(credentialsPath(box)).mode & 0o777).toBe(0o600);
    // One workspace, generated here because nothing else in the system will
    // invent one.
    expect(projectBinding(box).workspaceId).toMatch(UUID);
    // It is in the report too, so the id is not something to go looking for.
    expect(run.stdout).toContain(projectBinding(box).workspaceId as string);

    // Identity is recorded, and the colour is one y-prosemirror will accept.
    expect(typeof userConfig(box).displayName).toBe("string");
    expect(userConfig(box).color).toMatch(/^#[0-9a-f]{6}$/i);

    // The one thing this command must never do.
    expect(run.output).not.toContain(secret);
    expect(run.stdout).toMatch(/credential\s+generated for local development/);
  });

  it("keeps the workspace it generated, rather than minting a second one", () => {
    // A workspace id is an identity, and a second run is not a second
    // workspace: the one in force is what a re-run confirms.
    const box = sandbox({ checkout: true });
    expect(runUb(["init", "--yes"], box).status).toBe(0);
    const first = projectBinding(box).workspaceId as string;
    expect(first).toMatch(UUID);

    expect(runUb(["init", "--yes"], box).status).toBe(0);
    expect(projectBinding(box).workspaceId).toBe(first);
  });

  it("is a no-op for the secret on a second run", () => {
    const box = sandbox({ checkout: true });
    expect(runUb(["init", "--yes"], box).status).toBe(0);
    const first = storedSecret(box);

    const again = runUb(["init", "--yes"], box);
    expect(again.status).toBe(0);
    expect(storedSecret(box)).toBe(first);
    expect(again.stdout).toMatch(/credential\s+already on this machine/);
    expect(again.output).not.toContain(first);
  });

  it("generates nothing when the environment already supplies a secret", () => {
    // fnox is the owner's path: `mise run init` runs `ub init` inside
    // `fnox exec`, so a decryptable secret arrives exactly like this one.
    const supplied = "environment-supplied-signing-secret-4c19";
    const box = sandbox({ checkout: true });
    const run = runUb(["init", "--yes"], box, { HUB_AUTH_TOKEN: supplied });

    expect(run.status).toBe(0);
    expect(existsSync(credentialsPath(box))).toBe(false);
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

    const run = runUb(["init", "--yes"], box);
    expect(run.status).toBe(0);
    expect(statSync(credentialsPath(box)).mode & 0o777).toBe(0o600);
    expect(storedSecret(box)).toBe(secret);
    expect(run.output).not.toContain(secret);
  });

  it("needs no TTY: takes flags, and defaults rather than prompting", () => {
    const box = sandbox({ checkout: true });
    // No `--yes`, stdin a pipe: this must complete rather than block on input.
    // With nobody to ask for a display slug, the id is the bare uuid.
    expect(runUb(["init"], box).status).toBe(0);
    expect(projectBinding(box).workspaceId).toMatch(UUID);

    const decorated = `team-b-${JOINED}`;
    const flagged = runUb(
      ["init", "--name", "Ada", "--color", "#0675c9", "--workspace", decorated],
      box,
    );
    expect(flagged.status).toBe(0);
    expect(userConfig(box)).toMatchObject({
      displayName: "Ada",
      color: "#0675c9",
      workspace: decorated,
    });
  });

  it("refuses an answer it cannot write safely, without printing the secret", () => {
    const secret = "already-stored-signing-secret-1d05";
    const box = sandbox({ checkout: true, credentials: { signingSecret: secret } });

    for (const argv of [
      ["init", "--yes", "--color", "teal"],
      // A workspace id is a uuid, optionally slug-decorated. Nothing else is
      // one — including the name that used to be the default.
      ["init", "--yes", "--workspace", "a/b"],
      ["init", "--yes", "--workspace", ".."],
      ["init", "--yes", "--workspace", "main"],
      ["init", "--yes", "--workspace", `${JOINED}-trailing`],
      ["init", "--yes", "--mcp", "--no-mcp"],
    ]) {
      const run = runUb(argv, box);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.output).not.toContain(secret);
    }

    // The rejection is the shared rule's, so it names the source and states the
    // real constraints rather than a rule this command invented.
    const named = runUb(["init", "--yes", "--workspace", "a/b"], box);
    expect(named.stderr).toMatch(/--workspace must be a workspace id/);
    expect(named.stderr).toMatch(/<slug>-<uuid>/);
  });

  it("accepts every workspace the shared rule accepts, and stores it as typed", () => {
    // One owner of that rule — schema's `parseWorkspaceId` — and `ub init` must
    // not be stricter than it: a workspace `ub status` accepts is not one this
    // command refuses. The slug is display, so the spelling is kept verbatim.
    for (const workspace of [JOINED, `uberblick-${JOINED}`, `team-b-${JOINED}`]) {
      const box = sandbox({ checkout: true });
      const run = runUb(["init", "--yes", "--workspace", workspace], box);
      expect(run.status, run.stderr).toBe(0);
      expect(projectBinding(box).workspaceId).toBe(workspace);
    }
  });

  it("leaves one signing secret and one workspace under concurrent runs", async () => {
    // Several fresh `ub init`s at the same moment — a `mise run setup` and an
    // editor's MCP client, say. Last-write-wins would leave one of them
    // convinced of a secret that is no longer the one on disk.
    //
    // Six at a time rather than two, though being honest about what this can
    // prove: node's startup dominates each run, so the microseconds where the
    // interleave happens are hard to hit on purpose, and reverting the fix does
    // NOT reliably turn this red. The load-bearing regression test is the
    // deterministic one in config.test.ts — the loser adopting the winner's
    // secret, with no timing involved. What this defends is the property under
    // real concurrency: every process exits 0 (an exclusive create that threw
    // EEXIST at the caller would not), and the pair on disk agrees afterwards.
    //
    // Each attempt joins a workspace by id, which is the one way to tell `ub
    // init` not to seed the starter corpus. That seed spends a hub's whole
    // connect-and-sync budget per attempt against a hub no test starts —
    // seconds this test's subject has no stake in, and what used to put 24
    // spawned processes over the file's budget on CI. The starter corpus under
    // concurrent runs is `starter.test.ts`'s subject, and it is tested there.
    //
    // Four rounds of six is the longest sequential wait in this package: each
    // round is bounded by the 25 s `runUbAsync` gives a run, and the vitest
    // budget sits above their sum so a run that overruns reports itself rather
    // than being cut off by an anonymous test timeout.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const box = sandbox({ checkout: true });
      const workspace = randomUUID();
      const runs = await Promise.all(
        Array.from({ length: 6 }, () =>
          runUbAsync(["init", "--yes", "--workspace", workspace], box),
        ),
      );
      for (const run of runs) {
        expect(run.status, run.output).toBe(0);
      }

      const authority = storedSecret(box);
      expect(projectBinding(box).workspaceId).toBe(workspace);
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

    const running = runUbAsync(["init", "--yes"], box);
    await sleep(400);
    // Still waiting: nothing has been written, because nothing may be.
    expect(existsSync(credentialsPath(box))).toBe(false);

    rmSync(lock);
    const run = await running;
    expect(run.status, run.output).toBe(0);
    expect(existsSync(credentialsPath(box))).toBe(true);
    // And the lock it took in turn is not left behind.
    expect(existsSync(lock)).toBe(false);
  });

  it("adopts a workspace another init published while it waited for the lock", async () => {
    // The workspace half of the claim the signing secret already makes: a uuid
    // this run generated before the lock is a proposal, and one that arrived
    // meanwhile wins. Losing this splits the machine in two — `config.json`
    // naming the loser's workspace while the winner, which is also the run
    // holding the seed lock, writes the starter documents into its own. The
    // corpus is then in a workspace nothing on this machine points at.
    //
    // Held by hand, so the interleave is a fact: the run reads an empty
    // configuration, blocks on the lock, and the workspace it has to adopt is
    // published underneath it before it is let go.
    const box = sandbox({ checkout: true });
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");

    // No sleep: the run says when it starts waiting for the lock, and that
    // line is proof it has already read the configuration — a workspace
    // published before then would have been in force rather than adopted, and
    // this would be passing for a lesser reason on a slow machine.
    let waiting = false;
    const running = runUbAsync(
      ["init", "--yes"],
      box,
      {},
      undefined,
      (stderr) => {
        waiting ||= stderr.includes("waiting for another `ub init`");
      },
    );
    await waitUntil("`ub init` to say it is waiting for the lock", () => waiting);
    writeFileSync(
      join(box.cwd, ".uberblick.json"),
      `${JSON.stringify({ workspaceId: JOINED, hubUrl: null }, null, 2)}\n`,
    );
    rmSync(lock);

    const run = await running;
    expect(run.status, run.output).toBe(0);
    expect(projectBinding(box).workspaceId).toBe(JOINED);
    // And the report describes the machine rather than the intention.
    expect(run.stdout).toContain(JOINED);
  });

  it("refuses a workspace it cannot read, rather than inventing one over it", async () => {
    // The other side of adopting: what arrives under the lock is a value out
    // of a file, and it is held to the rule every reader of that file applies.
    // Writing an unusable workspace on would put it into `config.json`, where
    // the next run — or a seed, or a report — is where it would finally go
    // wrong.
    const box = sandbox({ checkout: true });
    const config = join(box.cwd, ".uberblick.json");
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");

    let waiting = false;
    const running = runUbAsync(
      ["init", "--yes"],
      box,
      {},
      undefined,
      (stderr) => {
        waiting ||= stderr.includes("waiting for another `ub init`");
      },
    );
    await waitUntil("`ub init` to say it is waiting for the lock", () => waiting);
    writeFileSync(config, `${JSON.stringify({ workspaceId: "a/b", hubUrl: null }, null, 2)}\n`);
    rmSync(lock);

    const run = await running;
    expect(run.status).not.toBe(0);
    // Named by file, the way every other reader of it reports the same value.
    expect(run.stderr).toContain(config);
    // And nothing was written on top of it.
    expect(projectBinding(box).workspaceId).toBe("a/b");
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
    }
  });

  it("repairs the mode of a config.json that was left readable", () => {
    const box = sandbox({ projectBinding: { workspaceId: JOINED, hubUrl: null }, checkout: true, userConfig: { workspace: JOINED } });
    chmodSync(join(box.configHome, "uberblick", "config.json"), 0o644);

    expect(runUb(["init", "--yes"], box).status).toBe(0);
    expect(
      statSync(join(box.configHome, "uberblick", "config.json")).mode & 0o077,
    ).toBe(0);
  });

  it("offers the MCP wiring, and honours --no-mcp instead of blocking", () => {
    const box = sandbox({ checkout: true });
    const offered = runUb(["init", "--yes"], box);
    expect(offered.stdout).toMatch(/ub mcp install/);

    const declined = runUb(["init", "--yes", "--no-mcp"], box);
    expect(declined.status).toBe(0);
    expect(declined.stdout).not.toMatch(/ub mcp install/);
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);

    // Asked for outright, it delegates to `ub mcp install` print-only — and the
    // case that matters is a vendor CLI that *is* installed, because an empty
    // PATH would pass whether the delegation prints or registers. With `claude`
    // on PATH it must still print the snippet and never run it: registering a
    // server inside somebody's agent is `ub mcp install`, not a side effect of
    // a bootstrap. Nothing is written into the sandbox's directory either.
    const claude = stubClaude(box);
    const asked = runUb(["init", "--yes", "--mcp"], box, { PATH: claude.dir });
    expect(asked.status).toBe(0);
    expect(asked.stdout).toContain('"uberblick"');
    expect(asked.stderr).toMatch(/--print runs nothing/);
    expect(existsSync(claude.record)).toBe(false);
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);
  });

  it("names the contributor task inside the sandbox's own checkout", () => {
    const box = sandbox({ checkout: true });
    const cwd = realpathSync(box.cwd);
    expect(
      findCheckoutRoot(cwd),
      "the fixture must detect its own checkout, not an enclosing checkout",
    ).toBe(cwd);

    const run = runUb(["init", "--yes"], box);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("mise run dev");
  });

  it("initialises outside a checkout, and names no contributor task there", () => {
    // An installed `ub` with no checkout still initialises. The mise tasks only
    // exist inside one, so they are not offered as a next step.
    // Scratch may itself be beneath a checkout. init only reads its cwd, so
    // use the filesystem root while keeping all config and data in scratch.
    const box = { ...sandbox(), cwd: parse(REPO_ROOT).root };
    expect(
      findCheckoutRoot(realpathSync(box.cwd)),
      "the outside-checkout fixture must have no checkout ancestor",
    ).toBeNull();
    const run = runUb(["init", "--yes"], box);
    expect(run.status).toBe(0);
    expect(storedSecret(box)).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(run.stdout).not.toMatch(/mise run dev/);
  });

  it.skipIf(!hasGit)("leaves a checkout with nothing for git to report", () => {
    // The real `.gitignore`: `ub init` writes nothing into a checkout, and this
    // is what would catch it if that ever changed.
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

    expect(runUb(["init", "--yes"], box).status).toBe(0);

    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: box.cwd,
      encoding: "utf8",
    });
    expect(status.stdout).toBe("");
  });

  it("keeps the credential owner-only under a umask that would widen it", () => {
    // `mode:` on a write is subject to the umask, so the file is chmodded
    // afterwards. Prove it with the widest umask a system will accept.
    const box = sandbox({ checkout: true });
    const previous = process.umask(0o000);
    try {
      expect(runUb(["init", "--yes"], box).status).toBe(0);
    } finally {
      process.umask(previous);
    }
    expect(statSync(credentialsPath(box)).mode & 0o077).toBe(0);
  });
});
