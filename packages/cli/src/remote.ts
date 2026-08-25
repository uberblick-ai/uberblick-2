/**
 * `ub remote` — where this workspace syncs, and the two one-time bridges.
 *
 * Four verbs, and the shape of the command surface is the decision:
 *
 * - `ub remote` says which endpoint is in force and what sharing it actually
 *   buys, in plain words. There is no `invite` (#92): today the served web
 *   bundle carries the shared signing secret, so "sharing" is handing somebody
 *   an address and a secret, and a command named `invite` would imply an access
 *   model that does not exist yet.
 * - `ub remote set <url>` points the clients at an endpoint. Nothing else — it
 *   moves no documents, and it is the right verb only when there is nothing to
 *   move.
 * - `ub remote promote <url>` moves a populated local workspace onto an empty
 *   remote hub.
 * - `ub remote join <url>` pulls a populated remote workspace into an empty
 *   local one.
 *
 * **Two verbs, not one, and each refuses the ambiguous case.** A single command
 * inferring its direction from whichever side is empty reads as convenient
 * right up to the day both sides hold documents — at which point the convenient
 * behaviour is silently merging two workspaces nobody asked to merge. So the
 * direction is the user's word, and the command refuses when the other side
 * contradicts it, naming both counts.
 *
 * **Resumable means identical-so-far, and nothing else.** Both bridges tolerate
 * a far side that already holds *part* of this workspace, because that is what
 * an interrupted run leaves behind. They do not tolerate a far side that holds
 * the same document with different contents: that is divergence, and continuing
 * would merge two histories under one uuid — the same data-loss shape the
 * two-verb split exists to prevent, arrived at through a subset instead of a
 * superset. So the pre-flight probe reads the remote's documents in full, not
 * just its directory, and refuses on any disagreement.
 *
 * **Nothing is persisted before the far side is verified.** Both bridges finish
 * by opening the remote through a *fresh* client — no mirror, no local state —
 * and comparing what it sees with what this machine holds, in both directions
 * and including tombstones. Only then is the endpoint written. A bounded sync
 * wait is not a completion signal, and `HUB_URL` changed on the strength of one
 * would strand a corpus on the old hub, which is the exact failure these
 * commands exist to prevent.
 *
 * **Persisting means every client, not just `ub`.** See {@link setRemote}.
 *
 * **The secret never travels through argv.** A hub credential given on a
 * command line is in every `ps` listing and every shell history file, so it
 * comes from a mode-restricted file (`--secret-file`) or from a hidden prompt,
 * and neither the secret nor a token minted from it is ever printed.
 */

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import {
  bridgeConfig,
  compareCorpus,
  inspectRemote,
  isIdentical,
  liveDocs,
  resolveMcpConfig,
  syncWorkspace,
} from "@uberblick/mcp-server";
import type {
  Corpus,
  CorpusDoc,
  HubState,
  McpConfig,
} from "@uberblick/mcp-server";
import {
  credentialsPath,
  readCredentials,
  readUserConfig,
  resolveConfig,
  userConfigPath,
} from "./config.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import {
  findCheckoutRoot,
  trustLocalConfig,
  writeLocalConfig,
} from "./mise-config.js";
import { publishOwnerOnly, removeQuietly } from "./safe-write.js";

export const REMOTE_HELP = `usage: ub remote [command]

commands:
  (none)                 the endpoint in force and what sharing it buys
  set <url>              point the clients at an endpoint; moves nothing
  promote <url> [opts]   move this populated workspace onto an empty remote hub
  join <url> [opts]      pull a populated remote workspace into this empty one

options for promote and join:
  --secret-file <path>   read the remote's signing secret from a file only you
                         can read (mode 0600). Without it the secret already
                         configured is tried first, and a terminal is prompted
                         with the input hidden. Never pass a secret as an
                         argument.

options for join:
  --fresh                this checkout has no local hub — a second computer.
                         Skips collecting local documents through a local hub,
                         which join otherwise requires so that documents only a
                         browser has made are not left behind.
`;

/**
 * What the endpoint buys you today, stated wherever a remote is named.
 *
 * The web client is a static bundle with the shared signing secret compiled
 * into it, so reaching the app *is* holding the credential. Until accounts land
 * (#84) the network is the access control, and saying so is the honest version
 * of "sharing".
 */
const SHARING_BOUNDARY =
  "Everyone who can reach this endpoint and load the web app receives the\n" +
  "shared signing secret — it is compiled into the served bundle — so reaching\n" +
  "the app is the same as holding the credential. The network is the whole of\n" +
  "the access control: keep the hub on a private network (Tailscale or\n" +
  "equivalent) until accounts land (#84). There is no invite command; sharing\n" +
  "means handing somebody the address and the secret out of band.\n";

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface RemotePersistence {
  /** Files written, for the report. */
  written: string[];
  /** Things worth saying that did not stop the write. */
  warnings: string[];
}

/**
 * Persist the endpoint the clients dial — **all** of them.
 *
 * `ub` resolves `hubUrl` out of `config.json`, so writing that file is enough
 * for `ub status` and `ub mcp serve`. Nothing else in a checkout reads it:
 * `mise run web` compiles `HUB_URL` into the bundle from *mise's* environment,
 * `mise run hub` and `.mcp.json` take theirs from mise too, and the committed
 * `mise.toml` says `ws://localhost:1234`. Writing only `config.json` would
 * therefore leave the browser talking to a hub on this machine while `ub` and
 * its MCP server talked to the remote — one workspace split across two hubs,
 * which is the stranding these commands exist to prevent, reintroduced by the
 * command that was supposed to fix it.
 *
 * So the derived `mise.local.toml` is regenerated too, exactly as `ub init`
 * does it: derived from the authority rather than authored here, gitignored,
 * and read by mise *after* `mise.toml` so its `[env]` wins. The committed
 * default stays localhost, because an endpoint is per-machine client
 * configuration and a contributor who never set a remote must still get a
 * working checkout.
 *
 * **The two authority files must never describe different hubs.** A stored
 * credential that the persisted endpoint cannot use is a machine that
 * authenticates against nothing, and it is not obvious from either file alone.
 * So when both change, the credential is published first and the endpoint
 * second, and a failure to publish the endpoint puts the credential back. The
 * residual window is a failed rollback, which is reported rather than hidden.
 *
 * Kept a separately callable unit on purpose: `ub remote deploy` (#152) needs
 * exactly this and must not grow a second copy of it.
 */
export function setRemote(
  url: string,
  options: {
    /** A new signing secret to store alongside, or null to leave it alone. */
    secret?: string | null;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): RemotePersistence {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const secret = options.secret ?? null;
  const written: string[] = [];
  const warnings: string[] = [];

  const configFile = userConfigPath(env);
  const credentialsFile = credentialsPath(env);
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });

  // Merged over what is on disk: identity, workspace and any field a later
  // version writes are not this command's to drop.
  const current = readUserConfig(env);
  const nextConfig = serialize({ ...current.raw, hubUrl: url });

  const stored = readCredentials(env);
  const changingSecret = secret !== null && secret !== stored.signingSecret;
  if (changingSecret) {
    // Captured before anything moves, so the rollback below has something to
    // put back. Null means the file did not exist and rollback is a removal.
    const previous = stored.raw === null ? null : serialize(stored.raw);
    publishOwnerOnly(credentialsFile, serialize({ ...stored.raw, signingSecret: secret }));
    written.push(credentialsFile);
    try {
      publishOwnerOnly(configFile, nextConfig);
    } catch (error) {
      try {
        if (previous === null) {
          removeQuietly(credentialsFile);
        } else {
          publishOwnerOnly(credentialsFile, previous);
        }
      } catch {
        warnings.push(
          `${credentialsFile} now holds the credential for ${url}, but ` +
            `${configFile} could not be written and the previous credential ` +
            "could not be put back. Rerun this command, or fix the endpoint by " +
            "hand — the two files must name the same hub.",
        );
      }
      throw error;
    }
  } else {
    publishOwnerOnly(configFile, nextConfig);
  }
  written.push(configFile);

  // --- the derived mise config ---------------------------------------------
  //
  // Derived from what is ON DISK, not from what this function decided: the
  // authority is those two files, and a derived file that disagrees with its
  // authority is the one outcome this must not produce.
  const root = findCheckoutRoot(cwd);
  const persistedSecret = readCredentials(env).signingSecret;
  const workspace = readUserConfig(env).config.workspace;
  if (root !== null && persistedSecret !== null) {
    const outcome = writeLocalConfig(root, {
      signingSecret: persistedSecret,
      workspace: workspace ?? resolveMcpConfig(env).workspaceId,
      hubUrl: url,
      authorityPath: credentialsFile,
    });
    if (outcome.written) {
      written.push(outcome.path);
      const trust = trustLocalConfig(outcome.path);
      if (!trust.trusted) {
        warnings.push(trust.hint);
      }
    } else {
      warnings.push(outcome.reason);
    }
  } else if (root !== null) {
    warnings.push(
      `no signing secret is stored, so ${root}'s mise.local.toml was not ` +
        "written and `mise run web` will still build against mise.toml's " +
        "default endpoint.",
    );
  }

  return { written, warnings };
}

/**
 * Accept a websocket endpoint, or explain what one looks like.
 *
 * `http(s)` is the mistake worth catching by name — it is what a browser
 * address bar hands you, and the hub speaks websockets.
 *
 * Userinfo, query and fragment are refused rather than carried. A hub token
 * travels in Hocuspocus' auth message and never in the URL, by invariant, so
 * `wss://user:secret@host/ws?token=…` is at best a misunderstanding and at
 * worst a credential this command would persist into two files and echo back
 * on stdout.
 */
export function normalizeRemoteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      `${JSON.stringify(value)} is not a URL. The hub speaks websockets, so an ` +
        "endpoint looks like wss://hub.example.ts.net",
    );
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const scheme = url.protocol === "https:" ? "wss" : "ws";
    throw new Error(
      `${url.protocol}// is a web address; the hub speaks websockets. Try ` +
        `${scheme}://${url.host}${url.pathname === "/" ? "" : url.pathname}`,
    );
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(
      `${JSON.stringify(value)} is not a websocket endpoint: it must start ` +
        "with ws:// or wss://",
    );
  }
  // Never echo the offending component back — if somebody did put a secret in
  // the URL, repeating it is how it reaches a terminal log.
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "an endpoint must not carry a username or password. The hub is " +
        "authenticated with a signing secret sent in the connection's auth " +
        "message, never in the URL — pass it with --secret-file instead",
    );
  }
  if (url.search !== "") {
    throw new Error(
      "an endpoint must not carry a query string. Nothing reads one, and a " +
        "token put there would be persisted and printed — pass a credential " +
        "with --secret-file instead",
    );
  }
  if (url.hash !== "") {
    throw new Error("an endpoint must not carry a fragment; nothing reads one");
  }
  // Keep the plain form a human typed. `new URL` appends a root path, and an
  // endpoint that reads differently from the one they gave invites a second
  // guess about whether it was understood.
  return url.pathname === "/" ? `${url.protocol}//${url.host}` : url.toString();
}

/** A secret file only its owner may read — ssh's rule for a private key. */
function readSecretFile(path: string): string {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    throw new Error(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `refusing ${path}: mode ${mode.toString(8).padStart(4, "0")} lets other ` +
        `users read the hub signing secret — fix it with: chmod 600 ${path}`,
    );
  }

  const text = readFileSync(path, "utf8");

  // A `credentials.json` is the obvious thing to point this at, so read one —
  // and otherwise treat the file as the secret itself. Nothing about the
  // contents ever reaches a message: `JSON.parse` quotes the source around a
  // syntax error, and for this file that source *is* the secret.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const value = (parsed as Record<string, unknown>).signingSecret;
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `${path} is a JSON object with no "signingSecret" string in it`,
      );
    }
    return value.trim();
  }

  const secret = text.trim();
  if (secret === "") {
    throw new Error(`${path} is empty`);
  }
  return secret;
}

/**
 * Ask for the remote's signing secret without echoing it.
 *
 * Readline echoes what it reads to its `output`, so the output is a sink that
 * discards; the prompt itself goes to stderr, keeping stdout clean. Returns
 * null when there is nobody to ask — a pipe gets `--secret-file`, not a hang.
 */
async function promptForSecret(io: Io): Promise<string | null> {
  if (process.stdin.isTTY !== true) {
    return null;
  }
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  io.err("remote signing secret (input hidden): ");
  const rl = createInterface({
    input: process.stdin,
    output: sink,
    terminal: true,
  });
  try {
    const answer = await rl.question("");
    return answer.trim() === "" ? null : answer.trim();
  } finally {
    rl.close();
    io.err("\n");
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Why a hub could not be read, in one line. Never the hub's own words. */
function hubProblem(url: string, hub: HubState): string {
  if (hub.status === "auth-failed") {
    return `${url} rejected the credential`;
  }
  if (hub.status === "disabled") {
    return `no signing secret is configured, so ${url} cannot be authenticated to`;
  }
  return `${url} did not answer`;
}

interface Credential {
  secret: string | null;
  /** Whether this value is new and should be stored once the bridge succeeds. */
  persist: boolean;
}

/** A hub reading that a different credential could plausibly fix. */
function credentialCouldFix(hub: HubState): boolean {
  return hub.status === "auth-failed" || hub.status === "disabled";
}

interface Bridge {
  base: McpConfig;
  target: string;
  credential: Credential;
  io: Io;
}

function remoteConfig(bridge: Bridge): McpConfig {
  return bridgeConfig(bridge.base, {
    hubUrl: bridge.target,
    authSecret: bridge.credential.secret,
  });
}

/**
 * Read the remote, asking for a credential once if the first attempt says one
 * would help. Read-only: nothing on either side is written by this.
 *
 * Always with documents. Counting what a hub holds would be cheaper, but every
 * decision made from this reading — is it empty, is it a subset of ours, is
 * that subset *the same* subset — needs contents, and a probe that answered
 * only the first question would let a divergent overlap through as an
 * interrupted run.
 */
async function openRemote(bridge: Bridge, secretFileGiven: boolean): Promise<Corpus> {
  const first = await inspectRemote(remoteConfig(bridge), { documents: true });
  if (!credentialCouldFix(first.hub) || secretFileGiven) {
    return first;
  }
  const typed = await promptForSecret(bridge.io);
  if (typed === null) {
    return first;
  }
  bridge.credential = { secret: typed, persist: true };
  return await inspectRemote(remoteConfig(bridge), { documents: true });
}

function listDocs(docs: readonly { uuid: string; title: string }[], limit = 10): string {
  let text = "";
  for (const doc of docs.slice(0, limit)) {
    text += `  ${doc.uuid}  ${doc.title}\n`;
  }
  if (docs.length > limit) {
    text += `  … and ${docs.length - limit} more\n`;
  }
  return text;
}

/** The report both bridges end with. */
function report(
  verb: string,
  target: string,
  corpus: Corpus,
  persistence: RemotePersistence,
): string {
  const live = liveDocs(corpus);
  const tombstones = corpus.entries.length - live.length;
  let text = `${verb} ${plural(live.length, "document")} — verified on ${target}\n\n`;
  text += listDocs(live);
  if (tombstones > 0) {
    text +=
      `\n${plural(tombstones, "archived directory entry")} travelled with the ` +
      "directory. Archived documents stay archived; their content is not moved.\n";
  }
  text += "\nconfiguration\n";
  for (const path of persistence.written) {
    text += `  ${path}\n`;
  }
  text +=
    "\n`ub` and its MCP server read the endpoint from config.json; `mise run web`\n" +
    "and the other mise tasks read it from the derived mise.local.toml.\n";
  text += `\n${SHARING_BOUNDARY}`;
  return text;
}

interface BridgeFlags {
  url: string;
  secretFile: string | undefined;
  fresh: boolean;
}

function parseBridgeFlags(argv: string[], allowFresh: boolean): BridgeFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "secret-file": { type: "string" },
      ...(allowFresh ? { fresh: { type: "boolean" as const, default: false } } : {}),
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new Error("expected exactly one endpoint");
  }
  const url = positionals[0];
  if (url === undefined) {
    throw new Error("expected exactly one endpoint");
  }
  return {
    url: normalizeRemoteUrl(url),
    secretFile: values["secret-file"],
    fresh: values.fresh === true,
  };
}

function warn(io: Io, warnings: readonly string[]): void {
  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
}

// --- ub remote -------------------------------------------------------------

function showRemote(io: Io): number {
  const resolved = resolveConfig();
  warn(io, resolved.warnings);
  const config = resolveMcpConfig(resolved.env);
  const configured = resolved.origins.hubUrl !== "default";

  if (!configured) {
    let text = "no remote configured\n\n";
    text +=
      `Documents sync with ${config.hubUrl}, the built-in default — a hub on ` +
      "this machine.\n\n";
    text += "  ub remote set <url>      point the clients at an endpoint\n";
    text +=
      "  ub remote promote <url>  move this workspace onto an empty remote hub\n";
    text +=
      "  ub remote join <url>     pull a remote workspace into this empty one\n";
    io.out(text);
    return 0;
  }

  const source =
    resolved.origins.hubUrl === "environment"
      ? "HUB_URL"
      : resolved.origins.hubUrl === "directory file"
        ? "./uberblick.json"
        : "user config";
  let text = `remote        ${config.hubUrl} (${source})\n`;
  text += `workspace     ${config.workspaceId}\n`;
  text += `credential    ${
    config.authSecret === null
      ? "none — local-only, no hub sync"
      : `configured (${resolved.origins.credential})`
  }\n`;
  text += `\n${SHARING_BOUNDARY}`;
  io.out(text);
  return 0;
}

// --- ub remote set ---------------------------------------------------------

function setCommand(argv: string[], io: Io): number {
  const [value, ...rest] = argv;
  if (value === undefined || rest.length > 0) {
    io.err("usage: ub remote set <url>\n");
    return 2;
  }
  let url: string;
  try {
    url = normalizeRemoteUrl(value);
  } catch (error) {
    io.err(`ub remote set: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const persistence = setRemote(url);
  warn(io, persistence.warnings);
  let text = `remote        ${url}\n`;
  for (const path of persistence.written) {
    text += `config        ${path}\n`;
  }
  text +=
    "\nThis moved no documents. Use `ub remote promote <url>` to move this\n" +
    "workspace onto an empty hub, or `ub remote join <url>` to pull a remote\n" +
    "workspace into an empty one.\n\n";
  text += SHARING_BOUNDARY;
  io.out(text);
  return 0;
}

// --- the shared bridge machinery -------------------------------------------

/**
 * Read this machine's workspace, hydrating it from the hub it currently uses.
 *
 * Both bridges start here and for the same reason: the mirror is the
 * authoritative *local* replica, but it is not the only place local documents
 * live. A browser that has only ever talked to the local hub holds documents no
 * MCP session has seen, and those are exactly the ones a careless endpoint
 * switch strands.
 */
async function readLocal(base: McpConfig, io: Io): Promise<Corpus> {
  io.err(`ub remote: reading the local workspace via ${base.hubUrl}…\n`);
  return await syncWorkspace(bridgeConfig(base));
}

/**
 * Why a corpus reading cannot be trusted, or null when it can.
 *
 * The three facts a bounded wait cannot establish on its own, in one place:
 * the hub answered, every room is acknowledged, and every document the
 * directory names actually arrived.
 */
function corpusProblem(url: string, corpus: Corpus): string | null {
  if (corpus.hub.status !== "connected") {
    return `${hubProblem(url, corpus.hub)}.\n`;
  }
  if (corpus.unsettled.length > 0) {
    return (
      `${url} has not acknowledged ${plural(corpus.unsettled.length, "room")}, ` +
      "so this sync did not finish inside its time limit:\n" +
      corpus.unsettled.map((room) => `  ${room}\n`).join("")
    );
  }
  if (corpus.missing.length > 0) {
    return (
      `${plural(corpus.missing.length, "document")} named by the directory at ` +
      `${url} did not arrive:\n` +
      listDocs(corpus.missing)
    );
  }
  return null;
}

/**
 * The verification both bridges end with: what a fresh client finds there,
 * compared with what this machine holds, in both directions.
 *
 * Both directions, because "the far side has everything we have" is only half
 * of it. A document that appeared over there while the bridge was running means
 * the corpus this was verified against is already stale, and persisting the
 * endpoint on that basis would claim a completeness nobody checked.
 */
async function verify(
  bridge: Bridge,
  expected: readonly CorpusDoc[],
): Promise<{ corpus: Corpus; problem: string | null }> {
  bridge.io.err(`ub remote: verifying ${bridge.target} as a fresh client…\n`);
  const corpus = await inspectRemote(remoteConfig(bridge), { documents: true });
  const unusable = corpusProblem(bridge.target, corpus);
  if (unusable !== null) {
    return { corpus, problem: unusable };
  }
  const diff = compareCorpus(expected, corpus.entries);
  if (!isIdentical(diff)) {
    let problem = `${bridge.target} does not match this workspace:\n`;
    if (diff.missing.length > 0) {
      problem += `  ${plural(diff.missing.length, "document")} did not reach it\n`;
      problem += listDocs(diff.missing);
    }
    if (diff.differing.length > 0) {
      problem += `  ${plural(diff.differing.length, "document")} differ in content\n`;
      problem += listDocs(diff.differing);
    }
    if (diff.extra.length > 0) {
      problem += `  ${plural(diff.extra.length, "document")} are there and not here\n`;
      problem += listDocs(diff.extra);
    }
    return { corpus, problem };
  }
  return { corpus, problem: null };
}

/** The credential a bridge starts with, from `--secret-file` or what is in force. */
function startingCredential(
  flags: BridgeFlags,
  inForce: string | null,
): Credential {
  if (flags.secretFile === undefined) {
    return { secret: inForce, persist: false };
  }
  return { secret: readSecretFile(flags.secretFile), persist: true };
}

/** How a refusal explains a far side that has content this workspace lacks. */
function divergence(
  target: string,
  extra: readonly CorpusDoc[],
  differing: readonly CorpusDoc[],
): string {
  let text = "";
  if (extra.length > 0) {
    text +=
      `  ${plural(extra.length, "document")} there are not in this workspace\n` +
      listDocs(extra);
  }
  if (differing.length > 0) {
    text +=
      `  ${plural(differing.length, "document")} are in both, with different ` +
      "contents — so this is not an interrupted run to finish, it is two " +
      "histories under one identity\n" +
      listDocs(differing);
  }
  return `${text}Nothing was written, and ${target} was not touched.\n`;
}

// --- ub remote promote -----------------------------------------------------

async function promoteCommand(argv: string[], io: Io): Promise<number> {
  let flags: BridgeFlags;
  try {
    flags = parseBridgeFlags(argv, false);
  } catch (error) {
    io.err(
      `ub remote promote: ${error instanceof Error ? error.message : String(error)}\n\n` +
        "usage: ub remote promote <url> [--secret-file <path>]\n",
    );
    return 2;
  }

  const resolved = resolveConfig();
  warn(io, resolved.warnings);
  const base = resolveMcpConfig(resolved.env);
  const inForce = base.authSecret;

  let credential: Credential;
  try {
    credential = startingCredential(flags, inForce);
  } catch (error) {
    io.err(`ub remote promote: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const bridge: Bridge = { base, target: flags.url, credential, io };

  // Phase one: everything this machine has, in the update log.
  //
  // The local hub is required, not optional. The corpus a browser built lives
  // only there until an MCP session pulls it down, and promoting without it
  // would move a subset, report success, and repoint the clients at a hub that
  // has never seen the rest.
  const local = await readLocal(base, io);
  const localProblem = corpusProblem(base.hubUrl, local);
  if (localProblem !== null) {
    io.err(
      `ub remote promote: ${localProblem}Documents held only by that hub cannot ` +
        "be included, so nothing was written. Start it (mise run hub) and try " +
        "again — or use `ub remote set` if there is nothing here to move.\n",
    );
    return 1;
  }

  // Phase two: the target, read in full as a fresh client — writes nothing
  // either way, which is what lets the refusals below leave it untouched.
  const remote = await openRemote(bridge, flags.secretFile !== undefined);
  const remoteProblem = corpusProblem(bridge.target, remote);
  if (remoteProblem !== null) {
    io.err(
      `ub remote promote: ${remoteProblem}Nothing was written.\n` +
        (credentialCouldFix(remote.hub)
          ? "Give the remote's signing secret with --secret-file <path> (mode 0600), " +
            "or run this from a terminal to be prompted.\n"
          : ""),
    );
    return 1;
  }

  const before = compareCorpus(local.entries, remote.entries);
  if (before.extra.length > 0 || before.differing.length > 0) {
    io.err(
      `ub remote promote: ${bridge.target} already holds ` +
        `${plural(liveDocs(remote).length, "document")}; this workspace holds ` +
        `${plural(liveDocs(local).length, "document")}. Merging two populated ` +
        "workspaces is unsupported.\n" +
        divergence(bridge.target, before.extra, before.differing),
    );
    return 1;
  }

  // Phase three: the same mirror, attached to the target. Run even when the
  // target already holds everything — it is what re-reads the source at
  // verification time, so the thing being verified is the workspace as it is
  // now and not a snapshot taken before the upload.
  io.err(
    before.missing.length > 0
      ? `ub remote: uploading ${plural(before.missing.length, "document")} to ${bridge.target}…\n`
      : `ub remote: ${bridge.target} already holds this workspace; re-checking…\n`,
  );
  const uploaded = await syncWorkspace(remoteConfig(bridge));
  const uploadProblem = corpusProblem(bridge.target, uploaded);
  if (uploadProblem !== null) {
    io.err(
      `ub remote promote: ${uploadProblem}The local workspace is unchanged and ` +
        `still configured for ${base.hubUrl}. Nothing was written.\n`,
    );
    return 1;
  }
  // Nothing foreign may have joined the mirror while it was attached. This is
  // the window between the probe above and this attachment; the probe is what
  // guards it, and this is what proves the guard held.
  const joinedMidFlight = compareCorpus(local.entries, uploaded.entries).extra;
  if (joinedMidFlight.length > 0) {
    io.err(
      `ub remote promote: ${plural(joinedMidFlight.length, "document")} appeared ` +
        `on ${bridge.target} while this was running, so it is no longer the ` +
        "empty hub this started against. Nothing was written.\n" +
        listDocs(joinedMidFlight),
    );
    return 1;
  }

  const checked = await verify(bridge, uploaded.entries);
  if (checked.problem !== null) {
    io.err(
      `ub remote promote: ${checked.problem}The endpoint was left at ` +
        `${base.hubUrl}; rerun this once the hub is reachable.\n`,
    );
    return 1;
  }

  let persistence: RemotePersistence;
  try {
    persistence = setRemote(bridge.target, {
      secret: bridge.credential.persist ? bridge.credential.secret : null,
    });
  } catch (error) {
    io.err(`ub remote promote: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  warn(io, persistence.warnings);
  io.out(report("promoted", bridge.target, checked.corpus, persistence));
  return 0;
}

// --- ub remote join --------------------------------------------------------

async function joinCommand(argv: string[], io: Io): Promise<number> {
  let flags: BridgeFlags;
  try {
    flags = parseBridgeFlags(argv, true);
  } catch (error) {
    io.err(
      `ub remote join: ${error instanceof Error ? error.message : String(error)}\n\n` +
        "usage: ub remote join <url> [--fresh] [--secret-file <path>]\n",
    );
    return 2;
  }

  const resolved = resolveConfig();
  warn(io, resolved.warnings);
  const base = resolveMcpConfig(resolved.env);
  const inForce = base.authSecret;

  let credential: Credential;
  try {
    credential = startingCredential(flags, inForce);
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const bridge: Bridge = { base, target: flags.url, credential, io };

  // What is here already — and, exactly like `promote`, through the local hub,
  // because a browser's documents live only there. `--fresh` is the way to say
  // "this checkout has never had a hub", which is true of a second computer and
  // is the one case where there is genuinely nothing to collect. Without the
  // flag a stopped local hub is a refusal rather than a shrug: an empty mirror
  // and an unreachable hub look identical from here, and one of them means a
  // corpus is about to be left behind.
  const local = await readLocal(base, io);
  if (!flags.fresh) {
    const localProblem = corpusProblem(base.hubUrl, local);
    if (localProblem !== null) {
      io.err(
        `ub remote join: ${localProblem}An empty workspace and a hub that is ` +
          "merely switched off look the same from here, and joining the second " +
          "one would strand whatever it holds. Start it (mise run hub) and try " +
          "again, or pass --fresh if this checkout has never had a local hub. " +
          "Nothing was written.\n",
      );
      return 1;
    }
  }

  const remote = await openRemote(bridge, flags.secretFile !== undefined);
  const remoteProblem = corpusProblem(bridge.target, remote);
  if (remoteProblem !== null) {
    io.err(
      `ub remote join: ${remoteProblem}Nothing was written.\n` +
        (credentialCouldFix(remote.hub)
          ? "Give the remote's signing secret with --secret-file <path> (mode 0600), " +
            "or run this from a terminal to be prompted.\n"
          : ""),
    );
    return 1;
  }

  const before = compareCorpus(remote.entries, local.entries);
  if (before.extra.length > 0 || before.differing.length > 0) {
    io.err(
      `ub remote join: this workspace already holds ` +
        `${plural(liveDocs(local).length, "document")}; the remote holds ` +
        `${plural(liveDocs(remote).length, "document")}. Merging two populated ` +
        "workspaces is unsupported.\n" +
        divergence(bridge.target, before.extra, before.differing),
    );
    return 1;
  }

  io.err(
    `ub remote: hydrating ${plural(liveDocs(remote).length, "document")} from ${bridge.target}…\n`,
  );
  const joined = await syncWorkspace(remoteConfig(bridge));
  const joinProblem = corpusProblem(bridge.target, joined);
  if (joinProblem !== null) {
    io.err(
      `ub remote join: ${joinProblem}The endpoint was left at ${base.hubUrl}. ` +
        "Rerun to finish.\n",
    );
    return 1;
  }

  const checked = await verify(bridge, joined.entries);
  if (checked.problem !== null) {
    io.err(
      `ub remote join: ${checked.problem}The endpoint was left at ` +
        `${base.hubUrl}; rerun this once the hub is reachable.\n`,
    );
    return 1;
  }

  let persistence: RemotePersistence;
  try {
    persistence = setRemote(bridge.target, {
      secret: bridge.credential.persist ? bridge.credential.secret : null,
    });
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  warn(io, persistence.warnings);
  io.out(report("joined", bridge.target, checked.corpus, persistence));
  return 0;
}

export async function remoteCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined) {
    return showRemote(io);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    io.out(REMOTE_HELP);
    return 0;
  }
  if (sub === "set") {
    return setCommand(rest, io);
  }
  if (sub === "promote") {
    return await promoteCommand(rest, io);
  }
  if (sub === "join") {
    return await joinCommand(rest, io);
  }
  io.err(`ub remote: unknown command ${JSON.stringify(sub)}\n\n${REMOTE_HELP}`);
  return 2;
}
