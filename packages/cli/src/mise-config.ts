/**
 * The derived per-checkout mise config.
 *
 * The authority for local configuration is
 * `$XDG_CONFIG_HOME/uberblick/{config,credentials}.json`, and `ub` reads it
 * directly. Everything else in this repository does not: `mise run hub`,
 * `mise run web`, `mise run import-seed` and the `.mcp.json` spawn all inherit
 * their environment from mise, and the hub in particular refuses to start
 * without `HUB_AUTH_TOKEN`. So `ub init` also writes `mise.local.toml` — mise's
 * conventional gitignored local config — as a file **derived** from that
 * authority: same value, one owner, rewritten whenever it drifts. Delete it and
 * rerun `ub init` and it comes back with the same value; it is regenerated, not
 * re-randomised, because the authority is elsewhere.
 *
 * Two mise behaviours shape this module, both verified against mise 2026.7:
 *
 * - A config file mise does not trust is a hard error, not a warning, for every
 *   task in the directory. So a file written here is useless until `mise trust`
 *   has seen it, and {@link trustLocalConfig} is part of writing it, not a
 *   nicety.
 * - mise's `[env]` overrides the ambient environment, and `fnox exec` in turn
 *   overrides mise's. That is the precedence this file lives in: a decryptable
 *   fnox secret always wins over the derived value, which is why the owner's
 *   encrypted path is unaffected by anything here.
 *
 * The file is only ever written inside an uberblick checkout — the thing whose
 * mise tasks need it — and never on top of a `mise.local.toml` somebody else
 * wrote: it carries {@link MARKER} so its own output is recognisable, and a
 * foreign file is left alone rather than silently replaced.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

/** mise's conventional local config: read after `mise.toml`, and gitignored. */
export const LOCAL_CONFIG_FILE = "mise.local.toml";

/** How this file's own output is recognised. Never change it casually. */
export const MARKER = "# Written by `ub init`.";

/**
 * The nearest ancestor that is an uberblick checkout, or null.
 *
 * Both markers are required. `mise.toml` alone is any mise project, and writing
 * a secret into a stranger's repository — whose `.gitignore` need not cover
 * `mise.local.toml` — is exactly the accident that must not happen.
 */
export function findCheckoutRoot(from: string): string | null {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "mise.toml")) && isUberblickPackage(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function isUberblickPackage(dir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { name?: unknown }).name === "uberblick"
    );
  } catch {
    return false;
  }
}

export function localConfigPath(root: string): string {
  return join(root, LOCAL_CONFIG_FILE);
}

/** True when the file at `path` is absent or was written by this module. */
function ours(path: string): boolean {
  try {
    return readFileSync(path, "utf8").startsWith(MARKER);
  } catch {
    return true;
  }
}

/**
 * The signing secret the derived file currently carries, or null.
 *
 * Deliberately a match rather than a TOML parse: this module writes the file, so
 * its shape is known, and anything that does not match is treated as absent and
 * rewritten. A TOML parser would be a new dependency to read four lines we
 * generated ourselves.
 */
export function derivedSecret(root: string): string | null {
  let text: string;
  try {
    text = readFileSync(localConfigPath(root), "utf8");
  } catch {
    return null;
  }
  if (!text.startsWith(MARKER)) {
    return null;
  }
  return /^HUB_AUTH_TOKEN = "([^"\n]+)"$/m.exec(text)?.[1] ?? null;
}

export interface DerivedEnvironment {
  /** The hub signing secret. Written verbatim; never logged. */
  signingSecret: string;
  workspace: string;
  /** Where the authority lives, named in the file so the file explains itself. */
  authorityPath: string;
}

function render(env: DerivedEnvironment): string {
  // The generated secret's alphabet is `A-Za-z0-9._-` (see `ub init`), so it
  // needs no TOML escaping — and a value that did would be refused by
  // `remote-compose.sh` anyway.
  return `${MARKER}
#
# Derived from ${env.authorityPath} — same value, one owner. Do not edit: every
# \`ub init\` rewrites it from that file. Delete it and rerun \`ub init\` and it
# comes back with the same value.
#
# It exists because mise tasks and \`.mcp.json\` inherit their environment from
# mise rather than from \`ub\`. \`fnox exec\` overrides it, so a decryptable
# \`HUB_AUTH_TOKEN\` in fnox.toml still wins for every task.
#
# HUB_AUTH_TOKEN is the HMAC signing secret, not a token. Never commit it —
# .gitignore covers this file.
[env]
WORKSPACE_ID = "${env.workspace}"
HUB_AUTH_TOKEN = "${env.signingSecret}"
`;
}

export type WriteOutcome =
  | { written: true; path: string }
  | { written: false; path: string; reason: string };

/**
 * Write the derived config, owner-only, unless a foreign file is in the way.
 *
 * The mode dance mirrors `writeCredentials`: tighten first, because `mode` on
 * `writeFileSync` applies only to a file being created and is subject to the
 * umask, and this file holds the same secret.
 */
export function writeLocalConfig(
  root: string,
  env: DerivedEnvironment,
): WriteOutcome {
  const path = localConfigPath(root);
  if (!ours(path)) {
    return {
      written: false,
      path,
      reason:
        `${path} was not written by \`ub init\`, so it was left alone. Add ` +
        `HUB_AUTH_TOKEN and WORKSPACE_ID to its [env] yourself — the value is ` +
        `in ${env.authorityPath} — or move the file aside and rerun.`,
    };
  }
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  writeFileSync(path, render(env), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { written: true, path };
}

/** True when the file exists and no other user can read it. */
export function isOwnerOnly(path: string): boolean {
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * Have mise trust the file we just wrote.
 *
 * Not optional politeness: mise refuses *every* task in a directory holding a
 * config file it does not trust, so skipping this would leave a checkout worse
 * off than before `ub init` ran. Best effort all the same — mise need not be on
 * PATH for an installed `ub`, and a user who has to run one command is better
 * served by being told which one than by a failed init.
 */
export function trustLocalConfig(
  path: string,
): { trusted: true } | { trusted: false; hint: string } {
  const hint = `run \`mise trust ${path}\` — until then mise refuses every task in that directory`;
  try {
    const result = spawnSync("mise", ["trust", path], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status === 0) {
      return { trusted: true };
    }
    return { trusted: false, hint };
  } catch {
    return { trusted: false, hint };
  }
}
