/**
 * `ub init` — make this machine ready to run uberblick locally.
 *
 * Three things, all idempotent: the awareness identity a client publishes (a
 * display name and a colour), the workspace this user works in, and a
 * development signing secret for the local hub when nobody else supplies one.
 *
 * It is convenience, never a precondition. Every other command works without it
 * — absent configuration is a default, not an error (see `config.ts`) — so
 * nothing here is the thing that makes `ub status` or `ub mcp serve` possible.
 *
 * **The secret.** `HUB_AUTH_TOKEN` is the HMAC secret hub tokens are signed
 * with, not a token. The owner's copy lives encrypted in `fnox.toml` and that
 * path is untouched: when a secret is already in force — from fnox, or from the
 * user's own shell — nothing is generated. Otherwise a fresh 32-byte value is
 * written to `credentials.json` (mode 0600), which is the authority, and mirrored
 * into the checkout's derived `mise.local.toml` so the existing mise tasks and
 * `.mcp.json` see the same value. It is never printed: not by the report below,
 * not by an error path, not by a warning. The one thing said about it is where it
 * came from.
 *
 * The generated secret is deliberately a trusted single-user arrangement: one
 * workspace, one trusted user, multiple clients and machines; no login and no
 * tenant isolation.
 *
 * **No TTY required.** Every question has a flag, `--yes` takes every default,
 * and a non-interactive stdin behaves like `--yes` rather than blocking — which
 * is what makes `mise run setup -- --yes` an unattended bootstrap.
 */

import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { assertWorkspaceSegment, resolveMcpConfig } from "@uberblick/mcp-server";
import {
  readCredentials,
  readUserConfig,
  resolveConfig,
  writeCredentials,
  writeUserConfig,
} from "./config.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import {
  derivedSecret,
  findCheckoutRoot,
  isOwnerOnly,
  trustLocalConfig,
  writeLocalConfig,
} from "./mise-config.js";

/**
 * Awareness colours to default to.
 *
 * The same eight the web client picks from — `packages/web/src/collab/identity.ts`
 * documents the constraints: 6-digit hex only, because y-prosemirror's cursor
 * plugin rejects anything else, and each one legible on both the light and the
 * dark ground. Copied rather than imported: `@uberblick/web` is an application
 * bundle, not a library, and `ub` must not depend on React to name a colour.
 */
const COLORS = [
  "#e30c4e",
  "#ac6008",
  "#837401",
  "#0c853d",
  "#0e8085",
  "#0675c9",
  "#8c4bf7",
  "#cb26b4",
] as const;

/** 6-digit hex, the only form y-prosemirror's cursor plugin accepts. */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * A display name has to survive a terminal, a TOML file and a cursor label, so
 * control characters are out; the length bound keeps a pasted paragraph from
 * becoming somebody's cursor label.
 */
const NAME_PATTERN = /^[^\p{Cc}\p{Cf}]{1,64}$/u;

/** A stable colour for a name, so the default does not move between runs. */
function colorFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length] ?? COLORS[0];
}

/**
 * 32 random bytes, base64url — 43 characters over `A-Za-z0-9-_`.
 *
 * The alphabet is not cosmetic. `remote-compose.sh` refuses a secret outside
 * `A-Za-z0-9._-`, because a shell and Docker Compose parse the rest differently
 * and the deployed secret could then silently differ from the one clients hold.
 * What is generated here is therefore a value that can be carried to the remote
 * hub unchanged — and one that needs no escaping in the TOML file it is written
 * to either.
 */
function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

function osUserName(): string | null {
  try {
    return trimmed(userInfo().username);
  } catch {
    return null;
  }
}

interface Flags {
  yes: boolean;
  name: string | undefined;
  color: string | undefined;
  workspace: string | undefined;
  /** Undefined means "not asked either way". */
  mcp: boolean | undefined;
}

function parseFlags(argv: string[]): Flags {
  const { values } = parseArgs({
    args: argv,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      name: { type: "string" },
      color: { type: "string" },
      workspace: { type: "string" },
      // Two booleans rather than one negatable flag: parseArgs has no `--no-x`.
      mcp: { type: "boolean" },
      "no-mcp": { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.mcp === true && values["no-mcp"] === true) {
    throw new Error("--mcp and --no-mcp contradict each other");
  }
  return {
    yes: values.yes === true,
    name: values.name,
    color: values.color,
    workspace: values.workspace,
    mcp:
      values.mcp === true ? true : values["no-mcp"] === true ? false : undefined,
  };
}

/**
 * One answer: the flag if it was given, then the question if there is somebody
 * to ask, then the default.
 *
 * A null `rl` is the unattended case, and it is a value rather than a branch at
 * every call site because "no TTY behaves like `--yes`" is the property that
 * makes `mise run setup -- --yes` work at all.
 *
 * The prompt is written to stdout by readline, which is fine here and only here:
 * `ub init` has no machine-readable output, and it is never the process an MCP
 * client talks to.
 */
async function ask(
  rl: ReturnType<typeof createInterface> | null,
  label: string,
  flag: string | undefined,
  fallback: string,
): Promise<string> {
  if (flag !== undefined) {
    return flag;
  }
  if (rl === null) {
    return fallback;
  }
  return trimmed(await rl.question(`${label} [${fallback}]: `)) ?? fallback;
}

function field(name: string, value: string): string {
  return `${name.padEnd(12)}${value}\n`;
}

export async function initCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    io.err(`ub init: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // What is in force right now. This is also the validation pass over the
  // existing files: a workspace that is not a path segment throws here, and
  // there is nothing `ub init` can do about a file it was not asked to fix.
  const resolved = resolveConfig();
  const inForce = resolveMcpConfig(resolved.env);
  const existing = readUserConfig();
  const stored = readCredentials();
  // The same problem is reported by each reader; the set keeps it said once.
  const warnings = new Set([
    ...resolved.warnings,
    ...existing.warnings,
    ...stored.warnings,
  ]);

  // A pipe is not a person: it gets the defaults rather than a blocked prompt.
  const interactive = !flags.yes && process.stdin.isTTY === true;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  let name: string;
  let color: string;
  let workspace: string;
  try {
    name = await ask(
      rl,
      "display name",
      flags.name,
      existing.config.displayName ?? osUserName() ?? "uberblick user",
    );
    color = await ask(
      rl,
      "cursor colour (#rrggbb)",
      flags.color,
      existing.config.color ?? colorFor(name),
    );
    // The workspace in force, so the offered default is what doing nothing would
    // give — including the built-in one, whose owner is the schema package.
    workspace = await ask(rl, "workspace", flags.workspace, inForce.workspaceId);
  } finally {
    rl?.close();
  }

  for (const check of [
    {
      value: name,
      pattern: NAME_PATTERN,
      what: "display name",
      how: "1–64 characters and no control characters",
    },
    {
      value: color,
      pattern: COLOR_PATTERN,
      what: "colour",
      how: "6-digit hex, like #0e8085",
    },
  ]) {
    if (!check.pattern.test(check.value)) {
      io.err(`ub init: the ${check.what} must be ${check.how}\n`);
      return 2;
    }
  }

  // The workspace rule has exactly one owner, and it is not this file: a value
  // `ub status` accepts must not be one `ub init` refuses. The label names where
  // the value came from, and the rule's own message states the constraints.
  try {
    assertWorkspaceSegment(
      workspace,
      flags.workspace === undefined ? "the workspace" : "--workspace",
    );
  } catch (error) {
    io.err(`ub init: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // Merged over what is already there: a `hubUrl` somebody set, or a field a
  // later version of `ub` writes, is not `ub init`'s to drop.
  const configPath = writeUserConfig({
    ...existing.raw,
    workspace,
    displayName: name,
    color,
  });

  // --- the signing secret -------------------------------------------------
  const root = findCheckoutRoot(process.cwd());
  const derived = root === null ? null : derivedSecret(root);
  // The raw environment, not `resolved.env`: what matters here is whether
  // somebody *else* supplies a secret, and `resolved.env` includes the one in
  // `credentials.json`. Our own derived file is not somebody else either —
  // inside a checkout mise puts it into this very environment, so counting it
  // would make a second run report a secret "already supplied" by itself.
  const fromEnvironment = trimmed(process.env.HUB_AUTH_TOKEN);
  const supplied =
    fromEnvironment !== null && fromEnvironment !== derived
      ? fromEnvironment
      : null;

  let secret: string | null;
  let credentialNote: string;
  let wroteCredentials = false;
  if (stored.signingSecret !== null) {
    secret = stored.signingSecret;
    credentialNote = "already on this machine";
    // An exposed file was refused by every other command. Repairing the mode is
    // the one useful thing to do about it, and keeping the value is the point:
    // regenerating would cut this machine off from clients holding the old one.
    if (stored.exposed) {
      writeCredentials({ ...stored.raw, signingSecret: secret });
      wroteCredentials = true;
      credentialNote = "already on this machine (repaired the file's mode)";
    }
  } else if (supplied !== null) {
    secret = null;
    credentialNote = "supplied by the environment (fnox, or your shell)";
  } else if (derived !== null) {
    // The authority went missing while its derived copy survived. Restore it
    // from that copy: the same value, not a new one.
    secret = derived;
    writeCredentials({ ...stored.raw, signingSecret: secret });
    wroteCredentials = true;
    credentialNote = "restored from this checkout's local mise config";
  } else {
    secret = generateSecret();
    writeCredentials({ ...stored.raw, signingSecret: secret });
    wroteCredentials = true;
    credentialNote = "generated for local development";
  }

  // --- the derived mise config --------------------------------------------
  let localConfig: string | null = null;
  if (root !== null && secret !== null) {
    const outcome = writeLocalConfig(root, {
      signingSecret: secret,
      workspace,
      authorityPath: stored.path,
    });
    if (outcome.written) {
      localConfig = outcome.path;
      const trust = trustLocalConfig(outcome.path);
      if (!trust.trusted) {
        warnings.add(trust.hint);
      }
    } else {
      warnings.add(outcome.reason);
    }
  }

  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
  if (flags.mcp === true) {
    // Asked for explicitly, so say plainly that it did not happen. `ub init`
    // itself did succeed, so this is not a failure.
    io.err(
      "ub init: `ub mcp install` is not available yet (#88) — no MCP client " +
        "configuration was written\n",
    );
  }

  let report = "uberblick initialised\n\n";
  report += field("identity", `${name} ${color}`);
  report += field("workspace", workspace);
  report += field("hub", inForce.hubUrl);
  // "credential", not "token": the value is the secret tokens are signed with,
  // and it is not in this report — only where it came from.
  report += field("credential", credentialNote);
  report += field("config", configPath);
  if (wroteCredentials || stored.signingSecret !== null) {
    report += field(
      "credentials",
      `${stored.path}${isOwnerOnly(stored.path) ? " (0600)" : ""}`,
    );
  }
  if (localConfig !== null) {
    report += field("mise config", `${localConfig} (derived, gitignored)`);
  }

  report += "\nnext steps\n";
  if (root !== null) {
    report +=
      "  mise run dev          the hub and the web app on http://localhost:5173\n";
    report += "  mise run import-seed  import the product documents\n";
  }
  if (flags.mcp !== false) {
    report +=
      "  ub mcp install        wire up an agent's MCP client — arrives with #88.\n";
    report +=
      "                        Until then, .mcp.json already registers this\n";
    report +=
      "                        server for MCP clients that read it.\n";
  }
  io.out(report);
  return 0;
}
