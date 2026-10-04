/**
 * `ub init` — make this machine ready to run uberblick locally.
 *
 * Three things, all idempotent: the awareness identity a client publishes (a
 * display name and a colour), the workspace this user works in, and a
 * development signing secret for the local hub when nobody else supplies one.
 *
 * **The workspace.** A workspace id is a uuid, and this is where one comes
 * from: with none in force, `ub init` generates it and asks for an optional
 * shared workspace name. An ASCII slug derived from the name decorates the
 * UUID; the name itself lives in the synced settings room. With one in force
 * it is offered as the default, so a second run changes nothing. Two first-time
 * runs at once settle on one workspace
 * rather than two: a uuid a run generated is a proposal, and whichever run
 * publishes second adopts the one already on disk. Nothing guesses a workspace
 * anywhere else — the MCP server refuses to start without one.
 *
 * **The starter documents.** A workspace holding nothing but the two documents
 * in `templates/` is topped up with whatever of them is missing, through the
 * package-private markdown reader in `@uberblick/mcp-server` — so a fresh
 * workspace gets both, an interrupted seed is finished by the next run, and a
 * workspace that holds anything else is never written into. `--workspace` opts
 * out entirely: naming an id is joining a workspace that exists elsewhere, and
 * its emptiness here means only that it has not been hydrated yet. See
 * `starter.ts`. They are ordinary documents from the moment they land.
 *
 * **The hub, when one is named.** `ub init <hub-url>` is the fresh-machine
 * one-liner: a new workspace, on a hub that exists already, in one command and
 * with no file edited by hand. It only ever *fills in* the endpoint — a
 * different one already stored is refused rather than overwritten, because
 * repointing the clients moves nothing and would leave the workspace on the old
 * hub (#376, #385); `ub remote join` is the verb that moves a machine, and the
 * *same* endpoint is nothing to do at all — that run prints what is bound and
 * exits without writing. What the hub argument adds beyond storing an endpoint
 * is two guarantees: the hub is dialled and authenticated before a single file
 * is written, so a refusal leaves the machine exactly as it was, and the seed
 * below runs against the endpoint just stored and *reports whether the hub
 * acknowledged it*, so a run that exits 0 is a hub that holds the workspace.
 * Remote hubs use the login already stored for their authentication origin,
 * renewed to current memberships. A loopback hub uses its local signing secret;
 * none is invented for a hub that already exists.
 *
 * It is convenience, never a precondition. Every other command works without it
 * — absent configuration is a default, not an error (see `config.ts`) — so
 * nothing here is the thing that makes `ub status` or `ub mcp serve` possible.
 *
 * **The secret.** `HUB_AUTH_TOKEN` is the HMAC secret hub tokens are signed
 * with, not a token. The owner's copy lives encrypted in `fnox.toml` and that
 * path is untouched: when a secret is already in force — from fnox, or from the
 * user's own shell — nothing is generated. Otherwise a fresh 32-byte value is
 * written to `credentials.json` (mode 0600), which is the authority every reader
 * goes to: the mise tasks reach it through `ub env`, and `.mcp.json` spawns
 * `ub mcp serve`, which resolves it. It is never printed: not by the report
 * below, not by an error path, not by a warning. The one thing said about it is
 * where it came from.
 *
 * The generated secret is for a loopback-only hub, with no GitHub login or
 * membership requirement.
 *
 * **No TTY required.** `--yes` takes every default, and a non-interactive stdin
 * behaves like `--yes` rather than blocking — which
 * is what makes `mise run setup -- --yes` an unattended bootstrap.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { ensureDeviceLogin, readDeviceLogin } from "@uberblick/hub/device-login";
import { isLoopbackEndpoint } from "@uberblick/hub/remote-url";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { bridgeConfig, resolveMcpConfig } from "./budget.js";
import { storeWorkspaceName } from "@uberblick/mcp-server";
import { parseWorkspaceId, validateWorkspaceName } from "@uberblick/schema";
import { findCheckoutRoot } from "./checkout.js";
import {
  claimSigningSecret,
  isOwnerOnly,
  readCredentials,
  readUserConfig,
  resolveConfig,
  userConfigPath,
  writeCredentials,
  writeUserConfig,
} from "./config.js";
import { takeHelp } from "./help.js";
import { isInstallPayload } from "./installation.js";
import type { InitLock } from "./init-lock.js";
import { acquireInitLock, seedLockPath } from "./init-lock.js";
import { installCommand } from "./install.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { normalizeRemoteUrl, remoteProblem, setRemote } from "./remote.js";
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
 * Generated only for loopback admission, and never copied to a remote hub.
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
  /** The hub to put this workspace on, normalized, or undefined for none. */
  hub: string | undefined;
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

export const INIT_HELP = `usage: ub init [hub-url] [options]

Settle what every other command needs: your awareness identity, the workspace
this machine works in, and a signing secret for local hubs. Idempotent — it never replaces
a secret that already exists, and it is safe to run again.

Given a loopback hub, it can create a workspace there and wait for its starter
documents to be acknowledged. A remote hub requires an existing workspace that
this machine's stored login may access. It uses the workspace already selected
here; otherwise pass --workspace <id>. \`ub remote join <url-with-workspace-id>\`
hydrates and verifies an existing workspace without adding starter documents.
A newly chosen endpoint is checked before it is stored. Without a hub binding,
the workspace stays local to this machine. Nothing syncs in the background
afterwards.

When creating a workspace interactively, the optional workspace name is shared
with its replicas. It must be 1–64 characters after trimming, with no control
or format characters. An empty answer, --yes, or non-interactive stdin leaves
it unnamed. Rename it later in Workspace Settings → General. The UUID remains
its identity, with a cosmetic ASCII slug derived from a name when possible.

operands:
  [hub-url]          the hub for this workspace. A bare host or an
                     https:// address is read as the deployed wss://<host>/ws;
                     a ws:// or wss:// endpoint is stored as given. That hub's
                     login must be stored here already — run \`ub auth login
                     <hub>\` and obtain membership in the selected existing
                     workspace. A loopback hub
                     uses HUB_AUTH_TOKEN or credentials.json. An endpoint
                     this machine already stores is never replaced: the same one changes nothing, and a different
                     one is refused, because moving a workspace between hubs is
                     \`ub remote join <url-with-workspace-id>\`, which hydrates and
                     verifies first

options:
  -y, --yes          take every default and never prompt (also what a
                     non-interactive stdin does on its own)
  --name <name>      awareness display name (default: this account's name)
  --color <#rrggbb>  awareness cursor colour, 6-digit hex (default: one of the
                     eight the web client uses, picked for you)
  --workspace <id>   the workspace to work in, as <uuid> or <slug>-<uuid>
                     (default: the selected workspace, or a fresh local uuid)
                     required for a remote hub if no workspace is selected;
                     that existing workspace must grant this login membership
                     joining by id never writes or infers a workspace name
  --mcp, --no-mcp    whether to end by printing the MCP client snippet to paste
                     — the question this ends on, answered up front. It prints;
                     registering a client is \`ub mcp install\`
  -h, --help         show this help

The signing secret is generated only for local use when none is visible and
no endpoint is stored. Remote hubs use this machine’s stored login, never a
signing secret. What is generated is written to
$XDG_CONFIG_HOME/uberblick/credentials.json at mode 0600, and is never printed.

A WORKSPACE_ID in the environment — a project .mcp.json's pin, or your own
shell — outranks the workspace in config.json, whatever this run settles.
`;

function parseFlags(argv: string[]): Flags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: INIT_OPTIONS,
    allowPositionals: true,
  });
  if (values.mcp === true && values["no-mcp"] === true) {
    throw new Error("--mcp and --no-mcp contradict each other");
  }
  const [hub, ...rest] = positionals;
  if (rest.length > 0) {
    throw new Error("expected at most one hub URL");
  }
  return {
    yes: values.yes === true,
    name: values.name,
    color: values.color,
    workspace: values.workspace,
    mcp:
      values.mcp === true ? true : values["no-mcp"] === true ? false : undefined,
    // The one normalizer, shared with `ub remote join`: a bare host and an
    // https:// address are the deployment's endpoint, and this refuses
    // everything that is not an endpoint before the command does anything.
    hub: hub === undefined ? undefined : normalizeRemoteUrl(hub),
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

/** What this machine holds to authenticate a hub with, and where each came from. */
interface Credential {
  /** What this run sends: the environment's, then the file's, then nothing. */
  secret: string | null;
  supplied: string | null;
  onFile: string | null;
  path: string;
}

/**
 * The one credential this run uses, chosen once — before the probe, so the
 * value that authenticated to a hub is the value the seed then writes with.
 *
 * The environment wins over the file, which is `resolveConfig`'s rule and every
 * other reader's. A file whose mode is wrong is **read** here rather than
 * treated as absent: `ub init` is the command that repairs that mode and keeps
 * the value, so ignoring it would both refuse a machine whose secret is right
 * and whose file is merely loose, and — worse — let a *different* value in it
 * past the conflict check below and into the seed, after the probe had used the
 * environment's.
 */
function readCredential(): Credential {
  const stored = readCredentials();
  const supplied = trimmed(process.env.HUB_AUTH_TOKEN);
  const onFile = trimmed(stored.signingSecret ?? undefined);
  return { secret: supplied ?? onFile, supplied, onFile, path: stored.path };
}

/**
 * Why a machine syncing with `endpoint` cannot use what it holds, or null.
 *
 * Both answers are refusals rather than repairs, because both are about a hub
 * that exists and has its own secret: one generated here would be random, and
 * picking a winner between two configured values would leave every other reader
 * on this machine sending the other one.
 */
function credentialRefusal(
  endpoint: string,
  credential: Credential,
): string | null {
  if (!isLoopbackEndpoint(endpoint)) return null;
  if (credential.secret === null) {
    return (
      `${endpoint} needs that hub's signing secret, and this machine has none ` +
      "it can use: HUB_AUTH_TOKEN is not set (fnox, or your shell) and no " +
      `signing secret was readable in ${credential.path}. One generated here ` +
      "would be random, and the hub would refuse it."
    );
  }
  if (
    credential.supplied !== null &&
    credential.onFile !== null &&
    credential.supplied !== credential.onFile
  ) {
    return (
      `HUB_AUTH_TOKEN and ${credential.path} hold different signing secrets, ` +
      `and ${endpoint} can only be authenticated to with one of them. Make ` +
      "them equal, or unset one, and run this again."
    );
  }
  return null;
}

/**
 * A workspace for a machine that has none: a fresh UUID and optional shared name.
 *
 * The uuid is generated, never asked for — it is an identity, and there is
 * nothing for a person to decide about it. An empty name is a real answer:
 * the workspace remains unnamed and its address is the bare UUID.
 * `--workspace` skips the question and is taken as given (and validated with
 * everything else below), because somebody joining an existing workspace
 * already has its id.
 */
async function newWorkspace(
  rl: ReturnType<typeof createInterface> | null,
  flag: string | undefined,
): Promise<{ id: string; name: string | null }> {
  if (flag !== undefined) {
    return { id: flag, name: null };
  }
  const uuid = randomUUID();
  if (rl === null) {
    return { id: uuid, name: null };
  }
  const answer = trimmed(
    await rl.question(
      `workspace name (optional; the id is ${uuid}): `,
    ),
  );
  if (answer === null) return { id: uuid, name: null };
  const name = validateWorkspaceName(answer);
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return { id: slug === "" ? uuid : `${slug}-${uuid}`, name };
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

  // --- the hub, when one was given -----------------------------------------
  //
  // The endpoint has one authority — this machine's `config.json` — and this
  // command may only *fill it in*. Overwriting it would be `ub remote set`
  // reborn: pointing the clients at another hub moves nothing, and the
  // workspace stays on the old one with nothing dialling it (#376, #385). So a
  // stored endpoint that is not the one asked for is refused outright, and the
  // refusal names the verb that does move a machine.
  const bound = trimmed(existing.config.hubUrl);
  if (flags.hub !== undefined && bound !== null && bound !== flags.hub) {
    io.err(
      `ub init: this machine already syncs with ${bound}, and \`ub init\` never ` +
        `replaces an endpoint — pointing it at ${flags.hub} would leave this ` +
        "workspace on the old hub with nothing dialling it. Nothing was " +
        `written. To move this machine: \`ub remote join ${flags.hub}/` +
        `${inForceWorkspace ?? "<workspace-id>"}\`, which hydrates and verifies ` +
        "before it persists anything.\n",
    );
    return 1;
  }
  // The same endpoint, on a machine that already has a workspace: there is
  // nothing left for this command to settle, so it settles nothing. Exiting
  // here rather than falling through is the whole of the idempotence promise —
  // below is the branch that would generate a random local secret for a machine
  // whose hub has its own, and write it.
  if (
    flags.hub !== undefined &&
    bound === flags.hub &&
    inForceWorkspace !== null
  ) {
    for (const warning of warnings) {
      io.err(`ub: warning: ${warning}\n`);
    }
    let already = "uberblick is already set up here\n\n";
    already += field("workspace", inForceWorkspace);
    already += field("hub", bound);
    already += field("config", userConfigPath());
    already += "\nNothing was changed. `ub status` reports the live state.\n";
    io.out(already);
    return 0;
  }
  // The endpoint this run has to store, or null when there is nothing to bind:
  // no hub was named, or one is stored already.
  const binding = flags.hub !== undefined && bound === null ? flags.hub : null;
  // --- the credential a hub in force needs ---------------------------------
  //
  // Whichever endpoint this machine will be dialling when the run is over. A
  // secret generated here is random and a hub that exists has its own, so on a
  // machine with an endpoint the credential is a precondition rather than
  // something to invent: the generating branch below must never be reached for
  // one, and it is refused here instead — before a write, and naming both
  // places a secret is read from.
  // Read once here and again under the lock, and never printed: this is the
  // value the probe below sends, and the one the seed sends afterwards.
  let credential = readCredential();
  const endpoint = binding ?? bound;
  if (endpoint !== null) {
    const refusal = credentialRefusal(endpoint, credential);
    if (refusal !== null) {
      io.err(`ub init: ${refusal} Nothing was written to the workspace or binding.\n`);
      return 1;
    }
  }

  // A pipe is not a person: it gets the defaults rather than a blocked prompt.
  const interactive = !flags.yes && process.stdin.isTTY === true;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  let name: string;
  let color: string;
  let workspace: string;
  let workspaceName: string | null = null;
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
    if (inForceWorkspace === null) {
      const proposed = await newWorkspace(rl, flags.workspace);
      workspace = proposed.id;
      workspaceName = proposed.name;
    } else {
      // One in force is the offered default, so a second run changes nothing.
      workspace = await ask(rl, "workspace", flags.workspace, inForceWorkspace);
    }
  } catch (error) {
    io.err(`ub init: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
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
  if (endpoint !== null && !isLoopbackEndpoint(endpoint)) {
    const login = await ensureDeviceLogin(endpoint, parseWorkspaceId(workspace).uuid);
    if (login.status !== "ready") {
      io.err(`ub init: ${login.message} Nothing was written to the workspace or binding.\n`);
      return 1;
    }
  }
  // The hub is read before anything is written, and as a real client: a
  // machine bound to an endpoint that never answers, or that refuses its
  // credential, is a machine whose every later command reports a hub problem
  // for a binding this command chose. Identity, workspace and secret exist only
  // in memory at this point, so a refusal here leaves the machine untouched.
  if (binding !== null) {
    io.err(`ub init: checking ${binding}…\n`);
    const bridgeEnv: NodeJS.ProcessEnv = {
      ...resolved.env,
      WORKSPACE_ID: workspace,
      HUB_URL: binding,
      // The credential chosen above, named explicitly: `resolved.env` drops a
      // file whose mode is wrong, and this run's own repair is what fixes
      // that — probing without it would refuse a machine whose secret is right
      // and then seed with the value it just repaired.
      ...(credential.secret === null ? {} : { HUB_AUTH_TOKEN: credential.secret }),
    };
    const problem = await remoteProblem(
      bridgeConfig(resolveMcpConfig(bridgeEnv), bridgeEnv),
    );
    if (problem !== null) {
      // `problem` is a sentence of its own, ending in its own newline — the
      // same one `ub remote join` prints for the same hub.
      io.err(`ub init: ${problem}Nothing was written to the workspace or binding.\n`);
      return 1;
    }
  }

  // Whether this is a checkout, which decides only whether the report below
  // names the contributor tasks. Nothing is written into one.
  const root = isInstallPayload() ? null : findCheckoutRoot(process.cwd());

  // --- everything that writes ---------------------------------------------
  //
  // Under one lock, from here to its release. Each file below is published
  // atomically on its own, but the two of them have to agree with each other
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
  // The endpoint this machine syncs with once the write phase is over — this
  // run's binding, or one that was already there. Settled under the lock,
  // because that is the only reading of it nothing can race.
  let hubInForce: string | null = null;
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
    // The endpoint decision, taken again on what is on disk *now*. The one
    // above was taken before the probe and before this lock, and another run —
    // an `ub init` or an `ub remote join` — may have bound this machine in
    // between; writing over that would be the endpoint-only retarget this
    // command refuses by design, arrived at by a race instead of by an
    // argument. The refusal returns from inside the lock, which the `finally`
    // below releases, and nothing has been written yet at this point.
    const settledHub = trimmed(current.config.hubUrl);
    if (binding !== null && settledHub !== null && settledHub !== binding) {
      io.err(
        `ub init: this machine was bound to ${settledHub} while this run was ` +
          "checking " +
          `${binding} — another \`ub init\` or \`ub remote join\` got there ` +
          "first. Nothing was written to the workspace or binding. To move it, `ub remote join " +
          `${binding}/<workspace-id>\`.\n`,
      );
      return 1;
    }
    hubInForce = binding ?? settledHub;
    // And the credential rules with it, on every path rather than only on the
    // one that carried a hub argument. A no-argument run can pass its pre-lock
    // checks on an unbound machine, lose the lock to an `ub init <hub-url>`,
    // and reach the generating branch below with an endpoint now stored — a
    // random secret written for a hub that has its own, arrived at by a race.
    // Re-read here, because the winner may have published a credential too.
    const settledCredential = readCredential();
    // The value the hub actually verified is the value the seed has to send. A
    // file-only credential that changed while this run was waiting means the
    // probe proved nothing about what would be written, so this refuses rather
    // than writing with a secret no hub has answered for. Neither value is
    // printed.
    if (binding !== null && isLoopbackEndpoint(binding) && settledCredential.secret !== credential.secret) {
      io.err(
        `ub init: the signing secret changed while this run was checking ` +
          `${binding} — that hub verified one value and this would write with ` +
          "another. Nothing was written to the workspace or binding. Run this again.\n",
      );
      return 1;
    }
    credential = settledCredential;
    if (hubInForce !== null && !isLoopbackEndpoint(hubInForce)) {
      const login = readDeviceLogin(hubInForce, parseWorkspaceId(workspace).uuid);
      if (login.status !== "ready") {
        io.err(`ub init: ${login.message} Nothing was written to the workspace or binding.\n`);
        return 1;
      }
    }
    if (hubInForce !== null) {
      const refusal = credentialRefusal(hubInForce, credential);
      if (refusal !== null) {
        io.err(`ub init: ${refusal} Nothing was written to the workspace or binding.\n`);
        return 1;
      }
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
      // every other reader of that file holds it to. A file this command
      // cannot read is not one it may invent a workspace over: it throws with
      // the message the next `ub init` would give for the same file, rather
      // than publishing a value that would make a later run, a seed or a
      // report fail somewhere less obvious.
      parseWorkspaceId(settled, `"workspace" in ${userConfigPath()}`);
      workspace = settled;
      workspaceName = null;
    }
    configPath = writeUserConfig({
      ...current.raw,
      workspace,
      displayName: name,
      color,
    });
    // The endpoint goes through the writer `ub remote join` uses, in the same
    // file and under the same lock — one place that decides what being bound to
    // a hub means, rather than a second one that has to be kept in step. Not
    // when the same endpoint arrived while this run was probing: there is
    // nothing left to write, and the check above has already refused any other.
    if (binding !== null && settledHub === null) {
      setRemote(binding);
    }

    // --- the signing secret -------------------------------------------------
    // The raw environment, not `resolved.env`: what matters here is whether
    // somebody *else* supplies a secret — `fnox exec`, or the user's own shell
    // — and `resolved.env` includes the one in `credentials.json`.
    const supplied = trimmed(process.env.HUB_AUTH_TOKEN);

    if (hubInForce !== null && !isLoopbackEndpoint(hubInForce)) {
      secret = null;
      credentialNote = "stored device login for remote sync";
    } else if (stored.signingSecret !== null) {
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
    } else {
      // Unreachable on a machine with an endpoint: this branch is the case
      // where neither the environment nor the file has a secret, and that is
      // exactly what `credentialRefusal` turned away above — from the same two
      // readings, taken under this lock. A hub that exists has its own secret;
      // what is generated here is for a local hub that does not exist yet.
      secret = claimSigningSecret(generateSecret());
      wroteCredentials = true;
      credentialNote = "generated for local development";
    }

    // --- what is on disk ----------------------------------------------------
    //
    // Read back rather than assumed: under the lock the two are the same thing,
    // and the re-read keeps the report describing the machine rather than this
    // process's intention.
    const persisted = readCredentials();
    persistedWorkspace = readUserConfig().config.workspace ?? workspace;
    if (secret !== null && persisted.signingSecret !== null) {
      secret = persisted.signingSecret;
    }
    // Only a generated UUID this run actually claimed owns its prompted name.
    // Store it before releasing the file lock: an adopting init can never
    // publish or seed this workspace ahead of its name. Starter seeding is
    // optional and may lose its separate lock or fail, so it cannot own this
    // required durable write.
    if (generatingWorkspace && workspaceName !== null) {
      try {
        const nameEnv = { ...resolved.env, WORKSPACE_ID: workspace };
        storeWorkspaceName(resolveMcpConfig(nameEnv), workspaceName);
      } catch (error) {
        io.err(
          `ub init: could not store the workspace name: ${error instanceof Error ? error.message : String(error)}. ` +
            "This machine is configured; name the workspace in Workspace Settings → General.\n",
        );
        return 1;
      }
    }
  } finally {
    lock.release();
  }

  // --- the starter documents -----------------------------------------------
  //
  // What the MCP server would resolve for the workspace that is now on disk.
  // `secret` is added explicitly because it may have been generated moments ago,
  // after `resolved` was read — and a seed written without it stays local
  // instead of reaching a hub that is up. The endpoint for the same reason: it
  // was stored moments ago too, and seeding against the configuration resolved
  // before the write phase would send the starter documents to the built-in
  // default rather than the hub this run just bound to — and print that one in
  // the report.
  //
  // The credential is the one the probe used, and the write phase can only have
  // *added* one — a local secret generated where there was none — never
  // replaced it, so there is no path where the hub is authenticated to with one
  // value and written to with another.
  const seedSecret = hubInForce !== null && !isLoopbackEndpoint(hubInForce) ? null : credential.secret ?? secret;
  mcpEnv = {
    ...resolved.env,
    WORKSPACE_ID: persistedWorkspace,
    ...(hubInForce === null ? {} : { HUB_URL: hubInForce }),
    ...(seedSecret === null ? {} : { HUB_AUTH_TOKEN: seedSecret }),
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
  // writes whatever this one did not. The one exception is a machine with an
  // endpoint in force, where the documents were promised to be *on the hub*:
  // see `seeded` and the refusal it drives after the report.
  let starter: string[] = [];
  // Whether the starter corpus is settled on the hub. Every path that leaves it
  // unwritten or unacknowledged clears it; a run with nothing to seed leaves it
  // true, because nothing is outstanding.
  let seeded = true;
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
      // Whoever holds that lock is seeding against the configuration *it*
      // resolved, which is not this run's new endpoint. Left to a warning this
      // would be a run that reported a hub holding a corpus nobody put there.
      seeded = false;
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
        seeded = false;
      } else {
        const result = await seedStarterDocs(mcpEnv);
        starter = result.created;
        seeded = result.synced;
      }
    } catch (error) {
      warnings.add(
        `${error instanceof Error ? error.message : String(error)} — the ` +
          "starter documents are incomplete; run `ub init` again to finish them",
      );
      seeded = false;
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

  report += "\nnext steps\n";
  report +=
    root === null
      ? "  ub open               the web app and a hub in the foreground\n"
      : "  mise run dev          the hub and the web app on http://localhost:5173\n";
  // Only when the question was left open: `--mcp` does it below instead, and
  // `--no-mcp` is somebody saying they do not want to be told about it.
  if (flags.mcp === undefined) {
    report +=
      "  ub mcp install        wire up an agent's MCP client (claude, codex, cursor)\n";
  }
  io.out(report);

  // The one promise a hub argument adds, checked rather than assumed. Local
  // state stands — the configuration is settled and the documents are durable
  // in this machine's update log — so the remedy is to get them up, not to
  // repair anything.
  if (hubInForce !== null && !seeded) {
    io.err(
      `ub init: the starter documents did not reach ${hubInForce}, so that hub ` +
        "does not hold this workspace yet. This machine is configured and the " +
        "documents are in its update log — `ub status` shows the endpoint, and " +
        "they go up the next time a client runs against it (`ub open`, or an " +
        "MCP session). Once the hub is back, `ub init` with no hub argument " +
        "tops up whatever is still missing.\n",
    );
    return 1;
  }

  if (flags.mcp === true) {
    // The wiring itself lives in `ub mcp install`, and this delegates to it
    // print-only: `--print` runs nothing, so a bootstrap never reaches for a
    // vendor CLI and registers a server in somebody's agent as a side effect of
    // `ub init` — with `claude` on PATH, no flag of it asked for that. What
    // `--mcp` buys is being shown the snippet and where it goes; running the
    // vendor is `ub mcp install`, on purpose. A nonzero answer is only a
    // warning: everything `ub init` was asked to settle is settled already.
    if ((await installCommand(["--print"], io)) !== 0) {
      io.err("ub init: no MCP snippet was printed — see above\n");
    }
  }
  return 0;
}
