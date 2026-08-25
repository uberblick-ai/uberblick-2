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
 * **Nothing is persisted before the far side is verified.** Both bridges finish
 * by opening the remote through a *fresh* client — no mirror, no local state —
 * and comparing what it sees with what this machine holds, document by
 * document. Only then is the endpoint written. A bounded sync wait is not a
 * completion signal, and `HUB_URL` changed on the strength of one would strand
 * a corpus on the old hub, which is the exact failure these commands exist to
 * prevent.
 *
 * **The secret never travels through argv.** A hub credential given on a
 * command line is in every `ps` listing and every shell history file, so it
 * comes from a mode-restricted file (`--secret-file`) or from a hidden prompt,
 * and neither the secret nor a token minted from it is ever printed.
 */

import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import {
  bridgeConfig,
  compareCorpus,
  inspectRemote,
  resolveMcpConfig,
  syncWorkspace,
} from "@uberblick/mcp-server";
import type { Corpus, CorpusDoc, HubState, McpConfig } from "@uberblick/mcp-server";
import {
  readCredentials,
  readUserConfig,
  resolveConfig,
  writeCredentials,
  writeUserConfig,
} from "./config.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";

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

/** Persist the endpoint the clients dial, and return the file it was written to. */
export function setRemote(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Merged over what is on disk: identity, workspace and any field a later
  // version writes are not this command's to drop.
  const current = readUserConfig(env);
  return writeUserConfig({ ...current.raw, hubUrl: url }, env);
}

/**
 * Accept a websocket endpoint, or explain what one looks like.
 *
 * `http(s)` is the mistake worth catching by name — it is what a browser
 * address bar hands you, and the hub speaks websockets.
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
  // Keep the plain form a human typed. `new URL` appends a root path, and an
  // endpoint that reads differently from the one they gave invites a second
  // guess about whether it was understood.
  return url.pathname === "/" && url.search === "" && url.hash === ""
    ? `${url.protocol}//${url.host}`
    : url.toString();
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

function probe(bridge: Bridge, documents: boolean): Promise<Corpus> {
  return inspectRemote(
    bridgeConfig(bridge.base, {
      hubUrl: bridge.target,
      authSecret: bridge.credential.secret,
    }),
    { documents },
  );
}

/**
 * Read the remote, asking for a credential once if the first attempt says one
 * would help. Read-only: nothing on either side is written by this.
 */
async function openRemote(bridge: Bridge, secretFileGiven: boolean): Promise<Corpus> {
  const first = await probe(bridge, false);
  if (!credentialCouldFix(first.hub) || secretFileGiven) {
    return first;
  }
  const typed = await promptForSecret(bridge.io);
  if (typed === null) {
    return first;
  }
  bridge.credential = { secret: typed, persist: true };
  return await probe(bridge, false);
}

/**
 * Persist the endpoint, and the credential that reached it if it is new.
 *
 * The endpoint is written last-in-the-run on purpose: every refusal above
 * returns before this is reached, so a failed bridge leaves a configuration
 * that still works against the hub it already had.
 */
function persist(bridge: Bridge, inForce: string | null): string[] {
  const secret = bridge.credential.secret;
  const written = [setRemote(bridge.target)];
  if (bridge.credential.persist && secret !== null && secret !== inForce) {
    const stored = readCredentials();
    written.push(writeCredentials({ ...stored.raw, signingSecret: secret }));
  }
  return written;
}

function listDocs(docs: readonly CorpusDoc[], limit = 10): string {
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
  written: string[],
): string {
  let text = `${verb} ${plural(corpus.docs.length, "document")} — verified on ${target}\n\n`;
  text += listDocs(corpus.docs);
  if (corpus.tombstones > 0) {
    text +=
      `\n${plural(corpus.tombstones, "archived directory entry")} travelled with ` +
      "the directory. Archived documents stay archived; their content is not moved.\n";
  }
  text += "\nconfiguration\n";
  for (const path of written) {
    text += `  ${path}\n`;
  }
  text += `\n${SHARING_BOUNDARY}`;
  return text;
}

interface BridgeFlags {
  url: string;
  secretFile: string | undefined;
}

function parseBridgeFlags(argv: string[]): BridgeFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "secret-file": { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new Error("expected exactly one endpoint");
  }
  const url = positionals[0];
  if (url === undefined) {
    throw new Error("expected exactly one endpoint");
  }
  return { url: normalizeRemoteUrl(url), secretFile: values["secret-file"] };
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

  const path = setRemote(url);
  let text = `remote        ${url}\nconfig        ${path}\n\n`;
  text +=
    "This moved no documents. Use `ub remote promote <url>` to move this\n" +
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

/** The verification both bridges end with: what a fresh client finds there. */
async function verify(
  bridge: Bridge,
  expected: readonly CorpusDoc[],
): Promise<{ corpus: Corpus; problem: string | null }> {
  bridge.io.err(`ub remote: verifying ${bridge.target} as a fresh client…\n`);
  const corpus = await probe(bridge, true);
  if (corpus.hub.status !== "connected") {
    return { corpus, problem: `${hubProblem(bridge.target, corpus.hub)}.\n` };
  }
  const diff = compareCorpus(expected, corpus.docs);
  const incomplete = [...diff.missing, ...diff.differing, ...corpus.missing];
  if (incomplete.length > 0) {
    return {
      corpus,
      problem:
        `${bridge.target} is missing or disagrees about ` +
        `${plural(incomplete.length, "document")}:\n` +
        listDocs(
          incomplete.map((doc) => ({ ...doc, fingerprint: null })),
        ),
    };
  }
  return { corpus, problem: null };
}

// --- ub remote promote -----------------------------------------------------

async function promoteCommand(argv: string[], io: Io): Promise<number> {
  let flags: BridgeFlags;
  try {
    flags = parseBridgeFlags(argv);
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

  let credential: Credential = { secret: inForce, persist: false };
  if (flags.secretFile !== undefined) {
    try {
      credential = { secret: readSecretFile(flags.secretFile), persist: true };
    } catch (error) {
      io.err(`ub remote promote: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  const bridge: Bridge = { base, target: flags.url, credential, io };

  // Phase one: everything this machine has, in the update log.
  //
  // The local hub is required, not optional. The corpus a browser built lives
  // only there until an MCP session pulls it down, and promoting without it
  // would move a subset, report success, and repoint the clients at a hub that
  // has never seen the rest.
  const local = await readLocal(base, io);
  if (local.hub.status !== "connected") {
    io.err(
      `ub remote promote: ${hubProblem(base.hubUrl, local.hub)}, so documents ` +
        "held only by that hub cannot be included. Start it (mise run hub) and " +
        "try again — or use `ub remote set` if there is nothing here to move. " +
        "Nothing was written.\n",
    );
    return 1;
  }
  if (local.missing.length > 0) {
    io.err(
      `ub remote promote: the local directory names ${plural(local.missing.length, "document")} ` +
        "that did not arrive, so this workspace is not fully hydrated. Nothing " +
        `was written.\n${listDocs(local.missing.map((doc) => ({ ...doc, fingerprint: null })))}`,
    );
    return 1;
  }

  // Phase two: the target, read as a fresh client — writes nothing either way.
  const remote = await openRemote(bridge, flags.secretFile !== undefined);
  if (remote.hub.status !== "connected") {
    io.err(
      `ub remote promote: ${hubProblem(bridge.target, remote.hub)}. Nothing was written.\n` +
        (credentialCouldFix(remote.hub)
          ? "Give the remote's signing secret with --secret-file <path> (mode 0600), " +
            "or run this from a terminal to be prompted.\n"
          : ""),
    );
    return 1;
  }

  const before = compareCorpus(local.docs, remote.docs);
  if (before.extra.length > 0) {
    io.err(
      `ub remote promote: ${bridge.target} already holds ` +
        `${plural(remote.docs.length, "document")}, ` +
        `${before.extra.length} of which this workspace does not have. This ` +
        `workspace holds ${plural(local.docs.length, "document")}. Merging two ` +
        "populated workspaces is unsupported, so nothing was written.\n" +
        listDocs(before.extra),
    );
    return 1;
  }

  // Phase three: the same mirror, attached to the target. Skipped when the
  // target already holds everything — which is what makes a rerun, and a
  // promotion interrupted halfway, finish rather than collide.
  if (before.missing.length > 0) {
    io.err(
      `ub remote: uploading ${plural(before.missing.length, "document")} to ${bridge.target}…\n`,
    );
    // `bridge.credential`, not the local one: a prompted secret replaced it.
    const uploaded = await syncWorkspace(
      bridgeConfig(base, {
        hubUrl: bridge.target,
        authSecret: bridge.credential.secret,
      }),
    );
    if (uploaded.hub.status !== "connected") {
      io.err(
        `ub remote promote: ${hubProblem(bridge.target, uploaded.hub)} during the ` +
          "upload. The local workspace is unchanged and still configured for " +
          `${base.hubUrl}. Nothing was written.\n`,
      );
      return 1;
    }
  }

  const checked = await verify(bridge, local.docs);
  if (checked.problem !== null) {
    io.err(
      `ub remote promote: ${checked.problem}The endpoint was left at ` +
        `${base.hubUrl}; rerun this once the hub is reachable.\n`,
    );
    return 1;
  }

  io.out(report("promoted", bridge.target, checked.corpus, persist(bridge, inForce)));
  return 0;
}

// --- ub remote join --------------------------------------------------------

async function joinCommand(argv: string[], io: Io): Promise<number> {
  let flags: BridgeFlags;
  try {
    flags = parseBridgeFlags(argv);
  } catch (error) {
    io.err(
      `ub remote join: ${error instanceof Error ? error.message : String(error)}\n\n` +
        "usage: ub remote join <url> [--secret-file <path>]\n",
    );
    return 2;
  }

  const resolved = resolveConfig();
  warn(io, resolved.warnings);
  const base = resolveMcpConfig(resolved.env);
  const inForce = base.authSecret;

  let credential: Credential = { secret: inForce, persist: false };
  if (flags.secretFile !== undefined) {
    try {
      credential = { secret: readSecretFile(flags.secretFile), persist: true };
    } catch (error) {
      io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  const bridge: Bridge = { base, target: flags.url, credential, io };

  // What is here already. Unlike `promote`, an unreachable local hub is not
  // fatal: the fresh-checkout case — `ub init` then `ub remote join` — has no
  // local hub at all, and requiring one would make the normal second-computer
  // flow impossible. It is said out loud instead, because a local hub that is
  // merely switched off is the one case this cannot see into.
  const local = await readLocal(base, io);
  if (local.hub.status !== "connected") {
    io.err(
      `ub remote join: note: ${hubProblem(base.hubUrl, local.hub)}, so this ` +
        "checked the local update log only. Documents held solely by that hub " +
        "are not accounted for.\n",
    );
  }

  const remote = await openRemote(bridge, flags.secretFile !== undefined);
  if (remote.hub.status !== "connected") {
    io.err(
      `ub remote join: ${hubProblem(bridge.target, remote.hub)}. Nothing was written.\n` +
        (credentialCouldFix(remote.hub)
          ? "Give the remote's signing secret with --secret-file <path> (mode 0600), " +
            "or run this from a terminal to be prompted.\n"
          : ""),
    );
    return 1;
  }

  const before = compareCorpus(remote.docs, local.docs);
  if (before.extra.length > 0) {
    io.err(
      `ub remote join: this workspace already holds ` +
        `${plural(local.docs.length, "document")}, ${before.extra.length} of ` +
        `which ${bridge.target} does not have; the remote holds ` +
        `${plural(remote.docs.length, "document")}. Merging two populated ` +
        "workspaces is unsupported, so nothing was written.\n" +
        listDocs(before.extra),
    );
    return 1;
  }

  io.err(
    `ub remote: hydrating ${plural(remote.docs.length, "document")} from ${bridge.target}…\n`,
  );
  // `bridge.credential`, not the local one: a prompted secret replaced it.
  const joined = await syncWorkspace(
    bridgeConfig(base, {
      hubUrl: bridge.target,
      authSecret: bridge.credential.secret,
    }),
  );
  if (joined.hub.status !== "connected") {
    io.err(
      `ub remote join: ${hubProblem(bridge.target, joined.hub)} during hydration. ` +
        `The endpoint was left at ${base.hubUrl}. Nothing was written.\n`,
    );
    return 1;
  }
  if (joined.missing.length > 0) {
    io.err(
      `ub remote join: ${plural(joined.missing.length, "document")} named by the ` +
        "directory did not arrive, so this workspace is incomplete and the " +
        `endpoint was left at ${base.hubUrl}. Rerun to finish.\n` +
        listDocs(joined.missing.map((doc) => ({ ...doc, fingerprint: null }))),
    );
    return 1;
  }

  const checked = await verify(bridge, joined.docs);
  if (checked.problem !== null) {
    io.err(
      `ub remote join: ${checked.problem}The endpoint was left at ` +
        `${base.hubUrl}; rerun this once the hub is reachable.\n`,
    );
    return 1;
  }

  io.out(report("joined", bridge.target, checked.corpus, persist(bridge, inForce)));
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
