/**
 * The derived per-checkout mise config.
 *
 * The authority for local configuration is
 * `$XDG_CONFIG_HOME/uberblick/{config,credentials}.json`, and `ub` reads it
 * directly. The mise tasks do not: `mise run hub`, `mise run web` and
 * `mise run import-seed` inherit their environment from mise, and the hub in
 * particular refuses to start without `HUB_AUTH_TOKEN`. (The committed
 * `.mcp.json` no longer belongs on that list — it spawns `ub mcp serve`, which
 * resolves the configuration itself.) So `ub init` also writes
 * `mise.local.toml` — mise's conventional gitignored local config — as a file
 * **derived** from that authority: same value, one owner, rewritten whenever it
 * drifts. Delete it and rerun `ub init` and it comes back with the same value;
 * it is regenerated, not re-randomised, because the authority is elsewhere.
 *
 * `ub init` is what *creates* it, and `ub workspace use` rewrites the one it
 * created — a binding the mise tasks never saw would leave them serving the
 * workspace the directory used to be bound to. Both write under the same lock,
 * and both derive from the files rather than from what they just decided.
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
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  describeFsError,
  isSymlinkRefusal,
  publishStaged,
  removeQuietly,
  writeTempBeside,
} from "./safe-write.js";

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

/**
 * What is at `path`, and whether this module may replace it.
 *
 * Every branch here is a decision about somebody else's file, so it fails
 * **closed**: only `absent` and `ours` are writable, and everything unexpected —
 * a permission error, a directory, a symlink, a socket — is refused with a
 * reason rather than treated as "probably fine". Reading with a bare try/catch
 * would say "not there" to all of them, and the next step chmods and truncates.
 *
 * `lstat`, not `stat`: a symlink must be seen as a symlink. Following one would
 * let anything that can create `mise.local.toml` choose which file receives the
 * signing secret — and `writeFileSync` follows symlinks happily.
 */
type Inspection =
  | { kind: "absent" }
  | { kind: "ours"; text: string }
  | { kind: "foreign" }
  | { kind: "unusable"; because: string };

function inspect(path: string): Inspection {
  let fd: number;
  try {
    // O_NOFOLLOW, so a symlink is an ELOOP refusal rather than a decision made
    // about one file and applied to another.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    if (isSymlinkRefusal(error)) {
      return { kind: "unusable", because: "it is a symbolic link" };
    }
    return { kind: "unusable", because: describeFsError(error) };
  }
  try {
    // Both facts come from the descriptor, so they describe the same inode: the
    // name is resolved once, here, and never again.
    if (!fstatSync(fd).isFile()) {
      return { kind: "unusable", because: "it is not a regular file" };
    }
    const text = readFileSync(fd, "utf8");
    return text.startsWith(MARKER) ? { kind: "ours", text } : { kind: "foreign" };
  } catch (error) {
    return { kind: "unusable", because: describeFsError(error) };
  } finally {
    closeSync(fd);
  }
}

/**
 * The `[env]` keys this module owns, and therefore the only ones it rewrites.
 * Everything else in the file belongs to whoever put it there.
 */
export const DERIVED_KEYS = ["WORKSPACE_ID", "HUB_AUTH_TOKEN", "HUB_URL"] as const;

export type DerivedKey = (typeof DERIVED_KEYS)[number];

/** `KEY = "value"`, as {@link toml} writes it. */
const ASSIGNMENT = /^([A-Za-z0-9_-]+) = ("(?:[^"\\\n]|\\.)*")$/;

function isDerivedKey(key: string): key is DerivedKey {
  return (DERIVED_KEYS as readonly string[]).includes(key);
}

/**
 * A derived file split into the values this module owns and the lines it does
 * not.
 *
 * Line-wise rather than a TOML parse, and deliberately so twice over: this
 * module writes the lines it owns, so their shape is known, and a parser would
 * mean a *round trip* — reprinting somebody's `[env]` addition through it is how
 * a comment, a spelling or an ordering gets quietly lost. Anything that is not
 * one of our assignments comes back as the bytes it was found as, so a rewrite
 * costs it nothing. The quoted literal goes back through `JSON.parse`, which
 * exactly undoes the {@link toml} that wrote it.
 */
function parseDerived(text: string): {
  owned: Partial<Record<DerivedKey, string>>;
  extra: string[];
} {
  const owned: Partial<Record<DerivedKey, string>> = {};
  const extra: string[] = [];
  const lines = text.split("\n");
  const start = lines.indexOf("[env]");
  if (start === -1) {
    return { owned, extra };
  }

  for (const line of lines.slice(start + 1)) {
    const match = ASSIGNMENT.exec(line);
    const key = match?.[1];
    const literal = match?.[2];
    if (key !== undefined && literal !== undefined && isDerivedKey(key)) {
      try {
        const value: unknown = JSON.parse(literal);
        if (typeof value === "string" && value !== "") {
          owned[key] = value;
        }
      } catch {
        // Unreadable is the same as absent: the rewrite supplies it afresh.
      }
      continue;
    }
    extra.push(line);
  }
  // The file's final newline arrives here as an empty last line, and keeping it
  // would add a blank line per rewrite — rewriting an unchanged file has to
  // produce an unchanged file.
  while (extra.length > 0 && extra[extra.length - 1]?.trim() === "") {
    extra.pop();
  }
  return { owned, extra };
}

/**
 * What the derived file currently supplies, or nothing when none of ours is
 * there.
 *
 * `ub workspace use` needs it to tell this file's own echo — inside an activated
 * checkout mise exports these three *from* it — from a value somebody genuinely
 * set in their shell.
 */
export function derivedValues(root: string): Partial<Record<DerivedKey, string>> {
  const found = inspect(localConfigPath(root));
  return found.kind === "ours" ? parseDerived(found.text).owned : {};
}

/** The signing secret the derived file currently carries, or null. */
export function derivedSecret(root: string): string | null {
  return derivedValues(root).HUB_AUTH_TOKEN ?? null;
}

export interface DerivedEnvironment {
  /** The hub signing secret. Written verbatim; never logged. */
  signingSecret: string;
  workspace: string;
  /**
   * The endpoint the mise tasks should dial, or undefined to leave `mise.toml`'s
   * committed default in force.
   *
   * `ub` resolves `hubUrl` from `config.json` itself, but nothing else in the
   * repository does: `mise run web` bakes `HUB_URL` into the bundle from mise's
   * environment, and `mise.toml` commits `ws://localhost:1234`. Without this
   * line, `ub remote join` would leave the browser talking to a hub on this
   * machine while `ub` talked to the remote — one workspace split across two
   * hubs, which is precisely the stranding these commands exist to prevent.
   *
   * It goes here rather than into the committed `mise.toml` because an endpoint
   * is per-machine client configuration, and the repository's default has to
   * keep working for a contributor who never set a remote.
   */
  hubUrl?: string | undefined;
  /**
   * Where the authority lives. Used in messages to the user only — never
   * rendered into the file, because a path is attacker-influenced input (an
   * `XDG_CONFIG_HOME` with a newline in it) and this file is fed to mise and
   * then trusted.
   */
  authorityPath: string;
}

/**
 * TOML basic-string form of a value.
 *
 * `JSON.stringify` is the escaper because TOML's basic string accepts every
 * escape JSON emits — `\"`, `\\`, `\n`, `\t`, `\uXXXX` and the rest. Escaping
 * rather than restricting is the point: the values written here have their own
 * owners — schema's `parseWorkspaceId` for the workspace, the generator for the
 * secret — and a value every other command accepts must not be one this file
 * cannot write.
 *
 * It is not a *complete* escaper, which is why {@link tomlUnsafeReason} guards
 * the two values that reach it — see there.
 */
function toml(value: string): string {
  return JSON.stringify(value);
}

/**
 * Why a value cannot go into a TOML basic string, or null when it can.
 *
 * Two gaps in `JSON.stringify` as a TOML escaper, both of which would produce a
 * file that `ub init` exits 0 on and mise then refuses to parse — taking every
 * task in the directory down with it:
 *
 * - It leaves U+007F and the C1 range raw. TOML forbids U+007F in a basic
 *   string outright.
 * - It emits `\uD800`-style escapes for unpaired surrogates, which are not
 *   Unicode scalar values and so are not valid TOML escapes either.
 *
 * Refusing at the boundary rather than escaping harder: a control character in a
 * workspace id or a signing secret is a mistake worth naming, and neither value
 * has any business carrying one. Both pass by construction today — the secret is
 * base64url and a workspace id is `[a-z0-9-]` — so this is the guard that keeps
 * a hand-edited `credentials.json` from taking every mise task in the directory
 * down, not a rule anything is expected to hit.
 */
export function tomlUnsafeReason(value: string): string | null {
  if (/\p{Cc}/u.test(value)) {
    return "it contains control characters";
  }
  // Under `u` the pattern iterates code points, so a well-formed pair is one
  // astral code point and never matches; only an unpaired surrogate does.
  // (`String.isWellFormed` says the same thing, but is ES2024 and the repo's
  // `lib` is ES2023 — not a knob worth turning for one call.)
  if (/\p{Surrogate}/u.test(value)) {
    return "it contains unpaired surrogates";
  }
  return null;
}

/**
 * The file's text: the three values this module owns, then every other line the
 * file already had, verbatim.
 *
 * The pass-through is what makes this safe to run on a file somebody has added
 * to — `WORKSPACES`, say, which the README asks for in exactly this `[env]`.
 * Rendering a fixed shape instead deletes such a line on the next `ub init` or
 * `ub workspace use`, silently.
 */
function render(env: DerivedEnvironment, extra: readonly string[]): string {
  return `${MARKER}
#
# Derived from the config \`ub\` resolves — $XDG_CONFIG_HOME/uberblick/
# {credentials,config}.json and ./uberblick.json — same values, one owner. Do
# not edit the three values below: \`ub init\` writes them and \`ub workspace
# use\` rewrites them, and no other command does. Anything else you add to
# [env] is kept. \`ub remote\` changes the authority files without
# regenerating this — rerun \`ub init\` to pick the new endpoint and secret up.
# Delete it and rerun \`ub init\` and it comes back the same.
#
# It exists because mise tasks inherit their environment from mise rather than
# from \`ub\`. \`fnox exec\` overrides it, so a decryptable \`HUB_AUTH_TOKEN\`
# in fnox.toml still wins for every task.
#
# HUB_AUTH_TOKEN is the HMAC signing secret, not a token. Never commit it —
# .gitignore covers this file.
[env]
WORKSPACE_ID = ${toml(env.workspace)}
HUB_AUTH_TOKEN = ${toml(env.signingSecret)}${
    env.hubUrl === undefined ? "" : `\nHUB_URL = ${toml(env.hubUrl)}`
  }
${extra.length === 0 ? "" : `${extra.join("\n")}\n`}`;
}

export type WriteOutcome =
  | { written: true; path: string }
  | { written: false; path: string; reason: string };

/**
 * Write the derived config, owner-only, unless something is in the way.
 *
 * Nothing but an absent path or this module's own output is ever replaced, and
 * a value mise could not parse is refused before the write rather than after.
 * Every refusal is a message and a still-working machine: the derived file is a
 * convenience for mise, and the authority is untouched either way.
 *
 * Against another `ub init` this is exact, because the whole write phase runs
 * under the init lock. Against an unrelated program writing this same path there
 * is a residual window between the last classification and the `rename` — that
 * is inherent, since no userland writer can hold a path still, and the fallout
 * is bounded to a file this command owns and rewrites on the next run.
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

  for (const value of [
    { what: "the workspace", text: env.workspace },
    // Never the secret itself in the message — only the fact and the fix.
    { what: `the signing secret in ${env.authorityPath}`, text: env.signingSecret },
    ...(env.hubUrl === undefined
      ? []
      : [{ what: "the hub endpoint", text: env.hubUrl }]),
  ]) {
    const unsafe = tomlUnsafeReason(value.text);
    if (unsafe !== null) {
      return {
        written: false,
        path,
        reason:
          `${path} was not written: ${value.what} cannot go into a TOML file ` +
          `because ${unsafe}. mise would refuse to parse the result, and that ` +
          "takes down every task in this directory.",
      };
    }
  }

  const found = inspect(path);
  if (found.kind === "foreign") {
    return {
      written: false,
      path,
      reason:
        `${path} was not written by \`ub init\`, so it was left alone. Add ` +
        `HUB_AUTH_TOKEN and WORKSPACE_ID to its [env] yourself — the value is ` +
        `in ${env.authorityPath} — or move the file aside and rerun.`,
    };
  }
  if (found.kind === "unusable") {
    return {
      written: false,
      path,
      reason:
        `${path} was left alone: ${found.because}. Move it aside and rerun ` +
        "`ub init`, which will write a fresh one.",
    };
  }

  // Published, not written in place. Two things follow, and both matter:
  //
  // - mise may be reading this file right now, and half of a TOML file is a
  //   parse error that takes every task in the directory down. `link` and
  //   `rename` both swap a complete file in, in one step.
  // - Whichever `ub init` publishes last publishes contents derived from an
  //   authority that can no longer change (see `claimSigningSecret`), so the
  //   order they finish in stops mattering.
  //
  // `link` for a path that was absent, because it must not overwrite anything
  // that appeared since; `rename` for one of ours, because it must. Neither
  // writes *through* a symlink even if one is swapped in after the check: they
  // replace the name, they do not follow it.
  const staged = writeTempBeside(
    path,
    // Carried over from the file being replaced: a rewrite must lose nothing its
    // author put there, and `inspect` has already read it once.
    render(env, found.kind === "ours" ? parseDerived(found.text).extra : []),
  );
  let published: boolean;
  try {
    if (found.kind === "absent") {
      published = publishStaged(staged, path, "absent");
    } else {
      // `link` is its own check; `rename` is not, so the classification is
      // repeated as late as it can be. It narrows the window rather than
      // closing it — see the note on writeLocalConfig.
      const now = inspect(path);
      if (now.kind !== "ours") {
        return {
          written: false,
          path,
          reason:
            `${path} changed while \`ub init\` was running, so it was left ` +
            "alone. Run `ub init` again.",
        };
      }
      published = publishStaged(staged, path, "regular");
    }
  } finally {
    removeQuietly(staged);
  }
  if (!published) {
    // Somebody created the file between the check and the publication. That is
    // the same answer as finding it there in the first place: leave it alone.
    return {
      written: false,
      path,
      reason:
        `${path} appeared while \`ub init\` was running, so it was left alone. ` +
        "Run `ub init` again.",
    };
  }
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
