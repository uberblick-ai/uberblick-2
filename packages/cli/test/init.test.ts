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
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MARKER } from "../src/mise-config.js";
import {
  REPO_ROOT,
  removeTempDirs,
  runUb,
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
      // A workspace names a room, a file and a TOML value.
      ["init", "--yes", "--workspace", "a/b"],
      ["init", "--yes", "--mcp", "--no-mcp"],
    ]) {
      const run = runUb(argv, box, WITHOUT_MISE);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.output).not.toContain(secret);
    }
  });

  it("offers the MCP wiring, and honours --no-mcp instead of blocking", () => {
    const box = sandbox({ checkout: true });
    const offered = runUb(["init", "--yes"], box, WITHOUT_MISE);
    expect(offered.stdout).toMatch(/ub mcp install/);

    const declined = runUb(["init", "--yes", "--no-mcp"], box, WITHOUT_MISE);
    expect(declined.status).toBe(0);
    expect(declined.stdout).not.toMatch(/ub mcp install/);

    // Asked for outright, it says plainly that #88 has not landed rather than
    // pretending it wrote an MCP client config.
    const asked = runUb(["init", "--yes", "--mcp"], box, WITHOUT_MISE);
    expect(asked.status).toBe(0);
    expect(asked.stderr).toMatch(/not available yet \(#88\)/);
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
