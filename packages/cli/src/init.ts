/**
 * `ub init` — make this machine ready to run uberblick locally.
 *
 * Three things, all idempotent: the awareness identity a client publishes (a
 * display name and a colour), the workspace this user works in, and a
 * development signing secret for the local hub when nobody else supplies one.
 *
 * **The workspace.** A workspace id is a uuid, and this is where one comes
 * from: with none in force, `ub init` generates it and asks only for an
 * optional display slug, storing `<slug>-<uuid>` (or the bare uuid when the
 * answer is empty). With one in force it is offered as the default, so a second
 * run changes nothing. Two first-time runs at once settle on one workspace
 * rather than two: a uuid a run generated is a proposal, and whichever run
 * publishes second adopts the one already on disk. Nothing guesses a workspace
 * anywhere else — the MCP server refuses to start without one.
 *
 * **The starter documents.** A workspace holding nothing but the two documents
 * in `templates/` is topped up with whatever of them is missing, through the
 * same seed importer `mise run import-seed` uses — so a fresh workspace gets
 * both, an interrupted seed is finished by the next run, and a workspace that
 * holds anything else is never written into. `--workspace` opts out entirely:
 * naming an id is joining a workspace that exists elsewhere, and its emptiness
 * here means only that it has not been hydrated yet. See `starter.ts`. They are
 * ordinary documents from the moment they land.
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

import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { resolveMcpConfig } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import {
  claimSigningSecret,
  readCredentials,
  readUserConfig,
  resolveConfig,
  userConfigPath,
  writeCredentials,
  writeUserConfig,
} from "./config.js";
import { takeHelp } from "./help.js";
import type { InitLock } from "./init-lock.js";
import { acquireInitLock, seedLockPath } from "./init-lock.js";
import { installCommand } from "./install.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import {
  derivedSecret,
  findCheckoutRoot,
  isOwnerOnly,
  tomlUnsafeReason,
  trustLocalConfig,
  writeLocalConfig,
} from "./mise-config.js";
import { seedStarterDocs } from "./starter.js";

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

/** Exported so the help below can be checked against the parser it describes. */
export const INIT_OPTIONS = {
  yes: { type: "boolean", short: "y", default: false },
  name: { type: "string" },
  color: { type: "string" },
  workspace: { type: "string" },
  // Two booleans rather than one negatable flag: parseArgs has no `--no-x`.
  mcp: { type: "boolean" },
  "no-mcp": { type: "boolean" },
} as const;

export const INIT_HELP = `usage: ub init [options]

Settle what every other command needs: your awareness identity, the workspace
this machine works in, and a hub signing secret. Idempotent — it never replaces
a secret that already exists, and it is safe to run again.

options:
  -y, --yes          take every default and never prompt (also what a
                     non-interactive stdin does on its own)
  --name <name>      awareness display name (default: this account's name)
  --color <#rrggbb>  awareness cursor colour, 6-digit hex (default: one of the
                     eight the web client uses, picked for you)
  --workspace <id>   the workspace to work in, as <uuid> or <slug>-<uuid>
                     (default: a fresh uuid, with the slug asked for)
  --mcp, --no-mcp    whether to register uberblick with an MCP client — the
                     question this ends on, answered up front
  -h, --help         show this help

The signing secret is generated only when none is visible, is written to
$XDG_CONFIG_HOME/uberblick/credentials.json at mode 0600, and is never printed.
`;

function parseFlags(argv: string[]): Flags {
  const { values } = parseArgs({
    args: argv,
    options: INIT_OPTIONS,
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

/**
 * A workspace for a machine that has none: a fresh uuid, plus an optional slug
 * to read it by.
 *
 * The uuid is generated, never asked for — it is an identity, and there is
 * nothing for a person to decide about it. The slug is the only question, it is
 * cosmetic, and an empty answer is a real answer: the id is then the bare uuid.
 * `--workspace` skips the question and is taken as given (and validated with
 * everything else below), because somebody joining an existing workspace
 * already has its id.
 */
async function newWorkspace(
  rl: ReturnType<typeof createInterface> | null,
  flag: string | undefined,
): Promise<string> {
  if (flag !== undefined) {
    return flag;
  }
  const uuid = randomUUID();
  if (rl === null) {
    return uuid;
  }
  const slug = trimmed(
    await rl.question(
      `workspace name (optional, for display; the id is ${uuid}): `,
    ),
  );
  return slug === null ? uuid : `${slug}-${uuid}`;
}

export async function initCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  if (takeHelp(argv, io, INIT_HELP)) return 0;

  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    io.err(`ub init: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // What is in force right now. This is also the validation pass over the
  // existing files: a workspace that is not a workspace id throws here, and
  // there is nothing `ub init` can do about a file it was not asked to fix.
  const resolved = resolveConfig();
  // As typed, not parsed: what gets stored and shown is the spelling its owner
  // chose. Null means no workspace anywhere — the case this command exists to
  // end, and the reason the MCP config below is resolved only once one is
  // settled, since resolving it without a workspace is an error by design.
  const inForceWorkspace = trimmed(resolved.env.WORKSPACE_ID);
  const existing = readUserConfig();
  // The same problem is reported by each reader; the set keeps it said once.
  const warnings = new Set([...resolved.warnings, ...existing.warnings]);
  // `--workspace` is somebody naming a workspace that already exists somewhere —
  // a scripted setup, say. Whatever that workspace holds is not this machine's
  // to add to, and it may hold nothing *yet*, so the emptiness `starter.ts`
  // reads would be the wrong answer. (Binding to a remote workspace is
  // `ub remote join <url>/<workspace-id>`, which needs no `ub init` first and
  // seeds nothing either.) The
  // rest of the decision is read from the workspace itself, not from this run.
  const maySeed = flags.workspace === undefined;
  // Whether the workspace below is this run's own invention. A generated uuid is
  // a proposal until it is published, and the write phase treats it as one — see
  // the claim under the lock.
  const generatingWorkspace =
    inForceWorkspace === null && flags.workspace === undefined;

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
    workspace =
      inForceWorkspace === null
        ? await newWorkspace(rl, flags.workspace)
        : // One in force is the offered default, so a second run changes nothing.
          await ask(rl, "workspace", flags.workspace, inForceWorkspace);
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
    parseWorkspaceId(
      workspace,
      flags.workspace === undefined ? "the workspace" : "--workspace",
    );
  } catch (error) {
    io.err(`ub init: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  // And the one thing that rule does not cover, because it is about the files
  // this command writes rather than about rooms: a workspace with a control
  // character in it cannot be put into the derived TOML at all.
  const unsafe = tomlUnsafeReason(workspace);
  if (unsafe !== null) {
    const label = flags.workspace === undefined ? "the workspace" : "--workspace";
    io.err(`ub init: ${label} cannot be used because ${unsafe}\n`);
    return 2;
  }

  // Which checkout, if any, this is being run in. A property of the working
  // directory rather than of the machine's configuration, so it needs no lock.
  const root = findCheckoutRoot(process.cwd());

  // --- everything that writes ---------------------------------------------
  //
  // Under one lock, from here to its release. Each file below is published
  // atomically on its own, but the three of them have to agree with each other
  // when this returns, and only serialising the whole phase gives that. It is
  // taken after the prompts on purpose: a lock held while a terminal waits for
  // somebody to type their name is a lock held for as long as they are at lunch.
  let lock: InitLock;
  try {
    lock = await acquireInitLock(process.env, {
      // Seconds of silence with nothing on the terminal is indistinguishable
      // from a wedged command. Only ever printed when something is actually
      // being waited for.
      onWait: (path) =>
        io.err(`ub init: waiting for another \`ub init\` to finish (${path})\n`),
    });
  } catch (error) {
    io.err(`ub init: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let configPath: string;
  let stored: ReturnType<typeof readCredentials>;
  let secret: string | null;
  let credentialNote: string;
  let wroteCredentials = false;
  let persistedWorkspace: string;
  let localConfig: string | null = null;
  let trustAfterRelease: string | null = null;
  // Replaced once the workspace on disk is known.
  let mcpEnv: NodeJS.ProcessEnv = resolved.env;
  try {
    // Read inside the lock, not before it: a decision made from a snapshot
    // taken before the lock was held is a decision about a machine that may
    // have changed since.
    stored = readCredentials();
    for (const warning of stored.warnings) {
      warnings.add(warning);
    }

    // Merged over what is already there: a `hubUrl` somebody set, or a field a
    // later version of `ub` writes, is not `ub init`'s to drop. Read again here
    // rather than reusing the copy taken before the prompts — that one is a
    // snapshot of a machine somebody may have changed since, and it exists only
    // to offer defaults. What gets written is merged over what is on disk now.
    const current = readUserConfig();
    for (const warning of current.warnings) {
      warnings.add(warning);
    }
    // A uuid this run generated is claimed the way the signing secret is: the
    // loser adopts the winner's. Another `ub init` may have published a
    // workspace while this one was waiting for the lock, and writing a second
    // uuid over it would leave this machine's configuration naming one
    // workspace while the run that got there first — the one holding the seed
    // lock — writes the starter documents into another.
    const settled = generatingWorkspace
      ? trimmed(current.config.workspace)
      : null;
    if (settled !== null) {
      // Adopting is reading a workspace out of a file, so it is held to what
      // every other reader of that file holds it to — the shared rule, plus
      // the one thing that rule does not cover, which is whether the value can
      // be put into the derived TOML at all. A file this command cannot read
      // is not one it may invent a workspace over: it throws with the message
      // the next `ub init` would give for the same file, rather than
      // publishing a value that would make a later run, a seed or a report
      // fail somewhere less obvious.
      const label = `"workspace" in ${userConfigPath()}`;
      parseWorkspaceId(settled, label);
      const settledUnsafe = tomlUnsafeReason(settled);
      if (settledUnsafe !== null) {
        throw new Error(`${label} cannot be used because ${settledUnsafe}`);
      }
      workspace = settled;
    }
    configPath = writeUserConfig({
      ...current.raw,
      workspace,
      displayName: name,
      color,
    });

    // --- the signing secret -------------------------------------------------
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

    if (stored.signingSecret !== null) {
      secret = stored.signingSecret;
      credentialNote = "already on this machine";
      // An exposed file was refused by every other command. Repairing the mode
      // is the one useful thing to do about it, and keeping the value is the
      // point: regenerating would cut this machine off from clients holding it.
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
      secret = claimSigningSecret(derived);
      wroteCredentials = true;
      credentialNote = "restored from this checkout's local mise config";
    } else {
      secret = claimSigningSecret(generateSecret());
      wroteCredentials = true;
      credentialNote = "generated for local development";
    }

    // --- the derived mise config --------------------------------------------
    //
    // Derived from what is ON DISK, not from what this process decided. Under
    // the lock the two are the same thing; the re-read costs nothing and keeps
    // the invariant true of the code rather than of the lock — a derived file
    // that disagrees with its authority is the one outcome this must not
    // produce. Same for the workspace, whose authority is `config.json`.
    const persisted = readCredentials();
    const persistedConfig = readUserConfig().config;
    persistedWorkspace = persistedConfig.workspace ?? workspace;
    if (secret !== null && persisted.signingSecret !== null) {
      secret = persisted.signingSecret;
    }

    if (root !== null && secret !== null) {
      const outcome = writeLocalConfig(root, {
        signingSecret: secret,
        workspace: persistedWorkspace,
        // Carried, not chosen: an endpoint `ub remote` put in `config.json` is
        // part of the authority this file is derived from, and dropping it here
        // would point the mise tasks back at localhost on the next `ub init`.
        hubUrl: persistedConfig.hubUrl,
        authorityPath: stored.path,
      });
      if (outcome.written) {
        localConfig = outcome.path;
        // Trusting is a `mise` subprocess taking a few hundred milliseconds,
        // and it needs no lock: it is idempotent and it reads the file rather
        // than writing it.
        trustAfterRelease = outcome.path;
      } else {
        warnings.add(outcome.reason);
      }
    }
  } finally {
    lock.release();
  }

  if (trustAfterRelease !== null) {
    const trust = trustLocalConfig(trustAfterRelease);
    if (!trust.trusted) {
      warnings.add(trust.hint);
    }
  }

  // --- the starter documents -----------------------------------------------
  //
  // What the MCP server would resolve for the workspace that is now on disk.
  // `secret` is added explicitly because it may have been generated moments ago,
  // after `resolved` was read — and a seed written without it stays local
  // instead of reaching a hub that is up.
  mcpEnv = {
    ...resolved.env,
    WORKSPACE_ID: persistedWorkspace,
    ...(secret === null ? {} : { HUB_AUTH_TOKEN: secret }),
  };

  // Under the seed's own lock, not the one above: what to write is decided by
  // reading the workspace, so two runs reading before either writes would both
  // find it empty and both write the same documents into it — but the read and
  // the write together take seconds, and holding the file lock across them
  // would make every concurrent `ub init` fail on a hub connection it has no
  // stake in. Nothing waits for this lock either: a run that finds it held has
  // nothing to add, because whoever holds it is writing exactly these documents.
  //
  // A failure is a warning rather than an exit code: everything `ub init` was
  // asked to settle is settled by now, and the seed is not lost with the run —
  // it is decided by what the workspace is missing, so the next `ub init`
  // writes whatever this one did not.
  let starter: string[] = [];
  let seedLock: InitLock | null = null;
  if (maySeed) {
    try {
      seedLock = await acquireInitLock(process.env, {
        path: seedLockPath(),
        waitMs: 0,
      });
    } catch (error) {
      warnings.add(
        `${error instanceof Error ? error.message : String(error)} — this run ` +
          "left the starter documents to it",
      );
    }
  }
  if (seedLock !== null) {
    try {
      // Which workspace to seed is read here, under the seed lock, rather than
      // remembered from the write phase: an `ub init --workspace` may have
      // settled a different one in between, and writing the starter documents
      // into the workspace this run had in hand would leave a corpus nothing on
      // this machine points at. A workspace somebody named by id is not this
      // run's to seed either — that is what `--workspace` opting out means.
      const configured = trimmed(readUserConfig().config.workspace);
      if (configured !== persistedWorkspace) {
        warnings.add(
          `this machine is configured for ${configured ?? "no workspace"} now, ` +
            `not ${persistedWorkspace} — another \`ub init\` settled that ` +
            "while this one was running, so no starter documents were written",
        );
      } else {
        starter = await seedStarterDocs(mcpEnv);
      }
    } catch (error) {
      warnings.add(
        `${error instanceof Error ? error.message : String(error)} — the ` +
          "starter documents are incomplete; run `ub init` again to finish them",
      );
    } finally {
      seedLock.release();
    }
  }

  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }

  let report = "uberblick initialised\n\n";
  report += field("identity", `${name} ${color}`);
  // What is on disk, which under a concurrent run is not always what this
  // process asked for. The report describes the machine, not the intention.
  report += field("workspace", persistedWorkspace);
  report += field("hub", resolveMcpConfig(mcpEnv).hubUrl);
  if (starter.length > 0) {
    report += field("documents", starter.join(", "));
  }
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
  // Only when the question was left open: `--mcp` does it below instead, and
  // `--no-mcp` is somebody saying they do not want to be told about it.
  if (flags.mcp === undefined) {
    report +=
      "  ub mcp install        wire up an agent's MCP client (claude, codex, cursor)\n";
  }
  io.out(report);

  if (flags.mcp === true) {
    // The wiring itself lives in `ub mcp install`; this only delegates to it
    // with its defaults. A refusal there — an entry somebody else owns, a file
    // that will not parse — is reported by that command and stays a warning
    // here: everything `ub init` was asked to settle has been settled already,
    // and failing a bootstrap over an unrelated config file would be wrong.
    if ((await installCommand([], io)) !== 0) {
      io.err(
        "ub init: no MCP client configuration was written — see above, or run " +
          "`ub mcp install --print` for the snippet to paste\n",
      );
    }
  }
  return 0;
}
