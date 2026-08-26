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
 * - `ub remote join <url>/<workspace-id>` binds this machine to a workspace that
 *   already lives on a remote hub, and hydrates it.
 *
 * **The direction is the user's word, never inferred.** A single command
 * inferring it from whichever side is empty reads as convenient right up to the
 * day both sides hold documents — at which point the convenient behaviour is
 * silently merging two workspaces nobody asked to merge. So `promote` refuses
 * when the target contradicts it, naming both counts.
 *
 * **`join` binds; it does not merge, and it never seeds.** The URL carries the
 * workspace id, so nothing already on this machine is in the way: the id says
 * which rooms and which `<uuid>.sqlite` replica this is about, and a workspace
 * that was here first has a different id — it keeps its documents and its entry
 * in `ub workspace list`, and switching back to it is `ub workspace use`.
 * Nothing is written *into* a joined workspace either: its documents arrive over
 * the wire, and a starter document invented here is one the machine that owns
 * that workspace never asked for. With an id in hand there is no "is this side
 * empty" question left to get wrong, which is what makes one verb enough.
 *
 * **`promote`'s refusal is a set difference over uuids.** It tolerates a target
 * that already holds *part* of this workspace, because that is what an
 * interrupted run leaves behind — and an overlapping uuid is the same document,
 * one lineage, which Yjs merges rather than collides. What it does not tolerate
 * is a target holding documents this workspace has never heard of: that is a
 * second populated workspace, and merging those is out of scope.
 *
 * **Nothing is persisted before the far side is verified.** Both bridges finish
 * by opening the remote through a *fresh* client — no mirror, no local state —
 * and comparing what it sees with what this machine holds, in both directions
 * and including tombstones. Only then is the endpoint — and, for `join`, the
 * workspace binding — written. A bounded sync wait is not a completion signal,
 * and `HUB_URL` changed on the strength of one would strand a corpus on the old
 * hub, which is the exact failure these commands exist to prevent.
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
import { parseWorkspaceId } from "@uberblick/schema";
import {
  USER_CONFIG_FILE,
  credentialsPath,
  directoryHubUrl,
  readCredentials,
  readUserConfig,
  resolveConfig,
  userConfigPath,
  writeUserConfig,
} from "./config.js";
import type { ResolvedConfig } from "./config.js";
import type { InitLock } from "./init-lock.js";
import { acquireInitLock } from "./init-lock.js";
import type { Io } from "./io.js";
import { trustLocalConfig } from "./mise-config.js";
import { processIo } from "./io.js";
import { remoteInitCommand, remoteUpdateCommand } from "./remote-init.js";
import { publishOwnerOnly, removeQuietly } from "./safe-write.js";
import { ORIGIN_LABELS } from "./status.js";
import type { Regeneration } from "./workspace.js";
import { regenerateLocalConfig } from "./workspace.js";

export const REMOTE_HELP = `usage: ub remote [command]

commands:
  (none)                 the endpoint in force and what sharing it buys
  init <ssh-target>      stand up the remote hub + web stack on a tailnet host
  update <ssh-target>    deploy origin/main onto that host now
  set <url>              point the clients at an endpoint; moves nothing
  promote <url> [opts]   move this populated workspace onto an empty remote hub
  join <url>/<id> [opts] bind this machine to the remote workspace the URL names

options for init:
  --dir <path>           checkout directory on the host (default ~/uberblick-remote)
  --host <fqdn>          the host's MagicDNS name, when detection cannot see it
  --ip <v4>              the host's Tailscale IPv4, likewise

The join URL is an endpoint with the workspace id as its last path segment —
\`ub remote init\` prints it. Joining never merges and never seeds: a workspace
already on this machine keeps its documents and its \`ub workspace list\` entry.

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

/**
 * What outranks `config.json`, when something does.
 *
 * `config.json` is the *third* layer: the environment beats it, and so does a
 * committable `./uberblick.json`. Writing an endpoint there and reporting
 * success would be reporting a switch that did not happen — and after a
 * `promote` that is worse than useless, because the documents really did move
 * while every client keeps dialling the old hub.
 *
 * Writing to the higher layer instead is not the fix either. `./uberblick.json`
 * is committable, and {@link secretAppliesTo} deliberately withholds the stored
 * signing secret from a repository-chosen hub — so clients pointed there would
 * dial it with no credential at all. Naming what wins is the fix.
 *
 * Only a higher layer naming a *different* hub is any of this. One naming the
 * endpoint being written outranks nothing that matters: the value takes effect,
 * there is no switch that did not happen, and nothing is worth saying — which is
 * the ordinary shape of a second machine whose `HUB_URL` already points at the
 * hub it is joining. Same hub, not same spelling — see {@link sameEndpoint}.
 */
interface Outranking {
  /** `HUB_URL` or `./uberblick.json`. */
  layer: string;
  endpoint: string;
}

function outranking(
  resolved: ResolvedConfig,
  cwd: string,
  /** The endpoint being written; a higher layer naming it is not a conflict. */
  requested: string,
): Outranking | null {
  const found = (): Outranking | null => {
    if (resolved.origins.hubUrl === "environment") {
      const endpoint = resolved.env.HUB_URL?.trim();
      return endpoint === undefined || endpoint === ""
        ? null
        : { layer: "HUB_URL in the environment", endpoint };
    }
    const pinned = directoryHubUrl(cwd);
    return pinned === null
      ? null
      : { layer: `"hubUrl" in ./uberblick.json`, endpoint: pinned };
  };
  const outranked = found();
  return outranked === null || sameEndpoint(outranked.endpoint, requested)
    ? null
    : outranked;
}

/**
 * Whether two configured endpoints name the same hub.
 *
 * `wss://hub/` and `wss://hub` are one hub spelled two ways — `new URL` says so
 * by normalizing the empty path to a root slash and lowercasing the host — and a
 * higher layer spelling it the other way must not read as a conflict, or the
 * second machine this exists for is refused the credential it joined to get.
 *
 * A value that does not parse falls back to its trimmed text, so garbage in
 * `HUB_URL` compares unequal and keeps the warning path rather than throwing
 * from inside a decision about whether to warn. {@link normalizeRemoteUrl} has
 * already refused anything unparseable on the requested side; this is about the
 * layer above, which nothing validates.
 */
function sameEndpoint(a: string, b: string): boolean {
  const canonical = (value: string): string => {
    const text = value.trim();
    try {
      return new URL(text).href;
    } catch {
      return text;
    }
  };
  return canonical(a) === canonical(b);
}

function outrankedNote(outranked: Outranking, what: string): string {
  return (
    `${outranked.layer} names ${outranked.endpoint}, which outranks the ` +
    `${USER_CONFIG_FILE} this just wrote — so ${what}. Remove it, or set ` +
    "HUB_URL to the endpoint you asked for.\n"
  );
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface RemotePersistence {
  /** Files written, for the report. */
  written: string[];
  /** Things worth saying that did not stop the write. */
  warnings: string[];
  /** True when `credentials.json` now holds a different signing secret. */
  replacedSecret: boolean;
  /**
   * What outranks the file just written, when anything does. Whatever went into
   * `config.json`, *this* is what the clients will dial — so a caller that
   * printed the new endpoint without saying so would be printing a value that
   * does not take effect.
   */
  outrankedBy: Outranking | null;
}

/**
 * Persist the endpoint, and say honestly who will follow it.
 *
 * `config.json` is where `ub` resolves `hubUrl`, so writing it is what makes
 * `ub status`, `ub mcp serve` and the MCP server this CLI spawns dial the new
 * hub. It is not the only layer, and it is not the highest — see
 * {@link outranking}, which is why this reports what beats it instead of
 * assuming the write took effect.
 *
 * A *deployed* web client learns its endpoint at runtime from the served
 * `/uberblick-config.json` (#91), not from anything written here. A checkout's
 * `mise run web` still takes `HUB_URL` from mise's environment, which this does
 * not touch — that is the dev-server fallback, and pointing a development build
 * at a remote hub is `HUB_URL=… mise run web`.
 *
 * **The two authority files must never describe different hubs.** A stored
 * credential that the persisted endpoint cannot use is a machine that
 * authenticates against nothing, and it is not obvious from either file alone.
 * So when both change, the credential is published first and the endpoint
 * second, and a failure to publish the endpoint puts the credential back. The
 * residual window is a failed rollback, which is reported rather than hidden.
 *
 * **A workspace travels with the endpoint, when one is given.** `ub remote join`
 * binds this machine to the workspace its URL names, and that binding and the
 * endpoint have to land in the same file in the same write — a machine pointed
 * at the remote hub while still naming the workspace it had before would dial
 * the right hub for the wrong rooms.
 *
 * Kept a separately callable unit on purpose: `ub remote deploy` (#152) needs
 * exactly this and must not grow a second copy of it.
 */
export function setRemote(
  url: string,
  options: {
    /** A new signing secret to store alongside, or null to leave it alone. */
    secret?: string | null;
    /** The workspace to bind this machine to, or undefined to leave it alone. */
    workspace?: string | undefined;
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
  const nextConfig = {
    ...current.raw,
    hubUrl: url,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  };

  const stored = readCredentials(env);

  // Read before anything is written, because it decides whether the credential
  // may move: `config.json` is only the third layer, and when a higher one
  // names a different hub *that* is the endpoint every client dials. Storing
  // the target's secret anyway would leave the endpoint in force authenticated
  // with a credential that is not its own — the exact mismatch the ordering
  // below exists to prevent, arrived at from the other side. The endpoint is
  // still written, because it is what takes over the moment the higher layer
  // goes away; the secret is not, and the report says so. A higher layer naming
  // the endpoint being written is not this and reads as null — see
  // {@link outranking}, or a second machine already pointed at the hub it is
  // joining would be refused the credential it went there to get.
  // (Neither answer depends on the write: `HUB_URL` and `./uberblick.json` are
  // untouched by it, and with neither present nothing outranks anything.)
  const outrankedBy = outranking(resolveConfig({ env, cwd }), cwd, url);
  const newSecret = secret !== null && secret !== stored.signingSecret;
  if (newSecret && outrankedBy !== null) {
    warnings.push(
      `${credentialsFile} was left alone: ${outrankedBy.layer} names ` +
        `${outrankedBy.endpoint}, so that is the endpoint in force, and ` +
        `storing ${url}'s signing secret would leave it authenticating ` +
        "against a hub the secret does not belong to. Remove the higher layer " +
        "and rerun to store it.",
    );
  }
  const changingSecret = newSecret && outrankedBy === null;
  if (changingSecret) {
    // Captured before anything moves, so the rollback below has something to
    // put back. Null means the file did not exist and rollback is a removal.
    const previous = stored.raw === null ? null : serialize(stored.raw);
    publishOwnerOnly(credentialsFile, serialize({ ...stored.raw, signingSecret: secret }));
    written.push(credentialsFile);
    try {
      publishOwnerOnly(configFile, serialize(nextConfig));
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
    // One writer for this file, and it is the one `ub init` uses.
    writeUserConfig(nextConfig, env);
  }
  written.push(configFile);

  return {
    written,
    warnings,
    replacedSecret: changingSecret,
    outrankedBy,
  };
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

/**
 * The two things a join URL carries: where the hub is, and which workspace.
 *
 * The form is an endpoint with the workspace id as its **last path segment** —
 * `wss://hub.example.ts.net/ws/<workspace-id>` — and `ub remote init` prints
 * exactly that. One string is the whole of what a second machine has to be
 * told, which is the point: an id copied separately is an id copied wrongly,
 * and a machine that invents its own joins a hub and finds nothing of yours on
 * it, because the rooms are keyed by a different id.
 *
 * The id's grammar belongs to schema — a uuid, optionally slug-decorated — and
 * is not restated here. The spelling is kept as typed, the way `ub workspace
 * use` keeps it; only what reaches a room, a token or the database filename is
 * the bare uuid. Everything before the last segment is an ordinary endpoint and
 * goes through {@link normalizeRemoteUrl}, so a credential smuggled into the URL
 * is refused there rather than in two places.
 *
 * Neither refusal echoes the URL back. `ub remote init` prints this string and
 * people paste it about, so the actionable half is the *form*, and repeating a
 * value somebody may have put a secret into is how it reaches a terminal log.
 */
export function parseJoinTarget(value: string): {
  endpoint: string;
  workspace: string;
} {
  const url = new URL(normalizeRemoteUrl(value));
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const workspace = segments.pop();
  if (workspace === undefined) {
    throw new Error(
      "that URL names no workspace. A join URL is the endpoint with the " +
        "workspace id as its last path segment, like " +
        "wss://hub.example.ts.net/ws/<workspace-id> — `ub remote init` prints " +
        "it, and `ub status` on the first machine names the id",
    );
  }
  try {
    parseWorkspaceId(workspace);
  } catch {
    throw new Error(
      "the last path segment of that URL is not a workspace id: it must be a " +
        "uuid, or <slug>-<uuid>. A join URL looks like " +
        "wss://hub.example.ts.net/ws/<workspace-id> — `ub remote init` prints it",
    );
  }
  const path = segments.join("/");
  return {
    endpoint: `${url.protocol}//${url.host}${path === "" ? "" : `/${path}`}`,
    workspace,
  };
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
  /** When the snapshot this verified was taken. See the note it prints. */
  takenAt: string,
  extras: {
    /** What this verb has to say about the documents, if anything. */
    note?: string;
    /** Whether this run also rewrote the checkout's derived mise config. */
    derivedFollowed?: boolean;
  } = {},
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
  text += extras.note ?? "";
  text += "\nconfiguration\n";
  for (const path of persistence.written) {
    text += `  ${path}\n`;
  }
  if (persistence.replacedSecret) {
    text +=
      "\nThe signing secret in credentials.json was replaced with the one that\n" +
      "reached the remote. On a second machine that is the point: a secret\n" +
      "generated here is random, and the remote verifies with the first\n" +
      "machine's.\n";
  }
  text +=
    "\n`ub`, `ub mcp serve` and the MCP server it spawns read this endpoint from\n" +
    "config.json. A deployed web client reads its own from the served\n" +
    "/uberblick-config.json; a checkout's `mise run web` takes it from mise, " +
    (extras.derivedFollowed === true
      ? "which\nthis run's rewrite of mise.local.toml has already brought into line.\n"
      : "so\npoint a development build at it with `HUB_URL=… mise run web`.\n");
  text +=
    "\nVerified here means the hub acknowledged the writes and a fresh client read\n" +
    `them back — not that the hub has flushed them to disk. The snapshot this\n` +
    `verified was taken at ${takenAt}; anything written to the old hub after\n` +
    "that is not part of it, so close the other clients before relying on this.\n";
  if (persistence.outrankedBy !== null) {
    text +=
      `\nThe documents are on ${target}, but ` +
      outrankedNote(
        persistence.outrankedBy,
        "that is still the endpoint in force here",
      );
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

const JOIN_USAGE =
  "usage: ub remote join <url>/<workspace-id> [--secret-file <path>]\n";

interface JoinFlags {
  /** The endpoint, with the workspace id taken off it. */
  endpoint: string;
  /** The workspace id, as typed. */
  workspace: string;
  secretFile: string | undefined;
}

function parseJoinFlags(argv: string[]): JoinFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "secret-file": { type: "string" } },
    allowPositionals: true,
  });
  const [url, ...rest] = positionals;
  if (url === undefined || rest.length > 0) {
    throw new Error("expected exactly one join URL");
  }
  return { ...parseJoinTarget(url), secretFile: values["secret-file"] };
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
      "  ub remote join <url>/<workspace-id>\n" +
      "                           bind this machine to a remote workspace\n";
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

  let persistence: RemotePersistence;
  try {
    persistence = setRemote(url);
  } catch (error) {
    io.err(`ub remote set: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  warn(io, persistence.warnings);

  let text = `remote        ${url}\n`;
  for (const path of persistence.written) {
    text += `config        ${path}\n`;
  }
  text +=
    "\nThis moved no documents. Use `ub remote promote <url>` to move this\n" +
    "workspace onto an empty hub, or `ub remote join <url>/<workspace-id>` to\n" +
    "bind this machine to a workspace that already lives on one.\n\n";
  text += SHARING_BOUNDARY;
  io.out(text);

  // Written, and then plainly contradicted: printing the endpoint alone would
  // be printing a value that does not take effect.
  if (persistence.outrankedBy !== null) {
    io.err(
      "ub remote set: " +
        outrankedNote(
          persistence.outrankedBy,
          "the clients will keep dialling that one",
        ),
    );
    return 1;
  }
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
 * The facts a bounded wait cannot establish on its own, in one place: the hub
 * answered, its directory was read in full, every room is acknowledged, and
 * every document the directory names actually arrived.
 *
 * `pending` exempts rooms from the last two. **A document this machine already
 * holds is not a document the far side has to be able to produce** — it is one
 * the far side is about to receive. A promotion that uploaded a directory stub
 * and died before its room arrived leaves exactly that shape, and treating it
 * as unreadable would make the rerun refuse forever, when attaching the local
 * replica is precisely what repairs it.
 *
 * The exemption is deliberately narrow. It never applies to the directory read
 * itself, which stays fail-closed: an unknown directory is not a small
 * directory. It never applies to a uuid only the far side knows, because that
 * is the one case where the content cannot be verified *and* cannot be
 * supplied. And callers verifying a finished bridge pass no exemption at all —
 * at read-back, missing is missing.
 */
function corpusProblem(
  url: string,
  corpus: Corpus,
  pending: ReadonlySet<string> = new Set(),
): string | null {
  if (corpus.hub.status !== "connected") {
    return `${hubProblem(url, corpus.hub)}.\n`;
  }
  // Before anything is read off it. An incomplete reading is not a small
  // reading: it is no reading at all, and its empty document list must never be
  // mistaken for an empty hub.
  if (!corpus.complete) {
    return (
      `${url} accepted the connection but never finished serving its ` +
      "directory, so what it holds is unknown — which is not the same as " +
      "holding nothing.\n"
    );
  }
  const unsettled = corpus.unsettled.filter((room) => !isPendingRoom(room, pending));
  if (unsettled.length > 0) {
    return (
      `${url} has not acknowledged ${plural(unsettled.length, "room")}, ` +
      "so this sync did not finish inside its time limit:\n" +
      unsettled.map((room) => `  ${room}\n`).join("")
    );
  }
  const missing = corpus.missing.filter((doc) => !pending.has(doc.uuid));
  if (missing.length > 0) {
    return (
      `${plural(missing.length, "document")} named by the directory at ` +
      `${url} did not arrive, and this machine does not hold them either:\n` +
      listDocs(missing)
    );
  }
  return null;
}

/** Whether a room name belongs to a document the local side already holds. */
function isPendingRoom(room: string, pending: ReadonlySet<string>): boolean {
  const uuid = room.slice(room.indexOf("/") + 1);
  return pending.has(uuid);
}

/** The uuids a corpus holds, for use as {@link corpusProblem}'s exemption. */
function uuidsIn(corpus: Corpus): Set<string> {
  return new Set(corpus.entries.map((entry) => entry.uuid));
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
  flags: { secretFile: string | undefined },
  inForce: string | null,
): Credential {
  if (flags.secretFile === undefined) {
    return { secret: inForce, persist: false };
  }
  return { secret: readSecretFile(flags.secretFile), persist: true };
}

/**
 * How a refusal names the documents one side has and the other has never heard
 * of.
 *
 * `where` is not decoration: `promote` compares the target against this
 * workspace and `join` compares this workspace against the target, so the same
 * set difference means "documents on the remote" in one and "documents here" in
 * the other. Naming the wrong side would send somebody looking for their
 * documents on a machine that does not have them.
 *
 * Only uuids the other side has never heard of appear here. A shared uuid is
 * one document's lineage, which is a rerun to finish rather than a collision —
 * see the note on `compareCorpus`.
 */
function foreignDocs(
  target: string,
  extra: readonly CorpusDoc[],
  where: string,
): string {
  return (
    `  ${plural(extra.length, "document")} ${where}\n` +
    listDocs(extra) +
    `Nothing was written, and ${target} was not touched.\n`
  );
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
  // Exempting what this machine holds: a half-finished earlier promotion left
  // stubs whose rooms never arrived, and this run is what completes them.
  const remoteProblem = corpusProblem(bridge.target, remote, uuidsIn(local));
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
  if (before.extra.length > 0) {
    io.err(
      `ub remote promote: ${bridge.target} already holds ` +
        `${plural(liveDocs(remote).length, "document")}; this workspace holds ` +
        `${plural(liveDocs(local).length, "document")}. Merging two populated ` +
        "workspaces is unsupported.\n" +
        foreignDocs(
          bridge.target,
          before.extra,
          "on it are not in this workspace",
        ),
    );
    return 1;
  }

  // Phase three: push, then re-read the source, and keep going until the source
  // stops moving.
  //
  // One `HubSync` binds one endpoint, so a phase attached to the target cannot
  // also be reading the source — which means an upload alone verifies against
  // whatever the mirror held when it *started*. A browser writing to the local
  // hub after phase one would be absent from the upload, absent from that
  // snapshot, and absent from the read-back that compares the two: verification
  // passes, the endpoint switches, and the change is stranded on the old hub.
  // So each push is followed by a fresh read of the source, and a source that
  // moved is pushed again.
  //
  // Bounded at two passes. A workspace somebody is actively typing into is not
  // one this can migrate, and saying so is better than looping until they stop.
  io.err(
    before.missing.length > 0
      ? `ub remote: uploading ${plural(before.missing.length, "document")} to ${bridge.target}…\n`
      : `ub remote: ${bridge.target} already holds this workspace; re-checking…\n`,
  );

  let snapshot = local;
  let sourceMoved = true;
  for (let pass = 0; sourceMoved && pass < 2; pass += 1) {
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
    const joinedMidFlight = compareCorpus(snapshot.entries, uploaded.entries).extra;
    if (joinedMidFlight.length > 0) {
      io.err(
        `ub remote promote: ${plural(joinedMidFlight.length, "document")} appeared ` +
          `on ${bridge.target} while this was running, so it is no longer the ` +
          "empty hub this started against. Nothing was written.\n" +
          listDocs(joinedMidFlight),
      );
      return 1;
    }

    io.err(`ub remote: re-reading ${base.hubUrl} for anything written since…\n`);
    const resurveyed = await readLocal(base, io);
    const sourceProblem = corpusProblem(base.hubUrl, resurveyed);
    if (sourceProblem !== null) {
      io.err(
        `ub remote promote: ${sourceProblem}The endpoint was left at ` +
          `${base.hubUrl}. Nothing was written.\n`,
      );
      return 1;
    }
    sourceMoved = !isIdentical(compareCorpus(snapshot.entries, resurveyed.entries));
    snapshot = resurveyed;
  }
  if (sourceMoved) {
    io.err(
      `ub remote promote: ${base.hubUrl} kept changing while this ran, so no ` +
        "snapshot of it could be uploaded and verified as a whole. Stop editing " +
        "this workspace and rerun. Nothing was written.\n",
    );
    return 1;
  }

  const takenAt = new Date().toISOString();
  const checked = await verify(bridge, snapshot.entries);
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
  io.out(
    report("promoted", bridge.target, checked.corpus, persistence, takenAt),
  );
  return 0;
}

// --- ub remote join --------------------------------------------------------

/**
 * Bind this machine to the workspace the URL names, and hydrate it.
 *
 * Regardless of what is here already — that is the whole shape of the command.
 * See the module note: the id in the URL settles which workspace this is about,
 * so there is nothing to compare, nothing to merge, and nothing to seed.
 */
async function joinCommand(argv: string[], io: Io): Promise<number> {
  let flags: JoinFlags;
  try {
    flags = parseJoinFlags(argv);
  } catch (error) {
    io.err(
      `ub remote join: ${error instanceof Error ? error.message : String(error)}\n\n` +
        JOIN_USAGE,
    );
    return 2;
  }

  const resolved = resolveConfig();
  warn(io, resolved.warnings);
  // The workspace the URL names, not the one in force. A machine with no
  // configuration at all has none — and one that does have a workspace is not
  // what this command was asked about. Everything downstream follows from the
  // id: the rooms opened on the remote, and the `<uuid>.sqlite` replica this
  // hydrates into, which is a different file from any workspace already here.
  let base: McpConfig;
  try {
    base = resolveMcpConfig({
      ...resolved.env,
      WORKSPACE_ID: flags.workspace,
      HUB_URL: flags.endpoint,
    });
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let credential: Credential;
  try {
    credential = startingCredential(flags, base.authSecret);
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const bridge: Bridge = { base, target: flags.endpoint, credential, io };

  // Read as a fresh client, which writes nothing on either side — so every
  // refusal below leaves both this machine and the remote exactly as they were.
  //
  // No `pending` exemption, unlike `promote`. That one exists for a far side
  // holding a directory stub whose room never arrived, which is what an
  // interrupted *upload* leaves behind; `join` uploads nothing, so a document
  // the remote's directory names and cannot produce is simply missing, and
  // hydrating from a remote that cannot serve its own corpus is not a join.
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

  io.err(
    `ub remote: hydrating ${plural(liveDocs(remote).length, "document")} from ${bridge.target}…\n`,
  );
  const joined = await syncWorkspace(remoteConfig(bridge));
  const joinProblem = corpusProblem(bridge.target, joined);
  if (joinProblem !== null) {
    io.err(
      `ub remote join: ${joinProblem}This machine's configuration is ` +
        "unchanged — no endpoint and no workspace were persisted. Rerun to " +
        "finish; what did arrive is in the local update log already.\n",
    );
    return 1;
  }

  const takenAt = new Date().toISOString();
  const checked = await verify(bridge, joined.entries);
  if (checked.problem !== null) {
    io.err(
      `ub remote join: ${checked.problem}This machine's configuration is ` +
        "unchanged — no endpoint and no workspace were persisted. Rerun this " +
        "once the hub is reachable.\n",
    );
    return 1;
  }

  // The workspace this machine was on before, if any. Named in the report
  // because it does not go away and is not merged — a person who has just been
  // switched out of a workspace holding their documents is owed the sentence
  // that says where those documents are and how to get back to them.
  const previous = resolved.env.WORKSPACE_ID?.trim();
  const switched =
    previous !== undefined &&
    previous !== "" &&
    parseWorkspaceId(previous).uuid !== parseWorkspaceId(flags.workspace).uuid;
  // The endpoint that workspace was dialling, from the snapshot taken before
  // anything was written — the built-in default filled in, because "start the
  // hub and point back at it" needs an address a person can paste.
  const previousEndpoint = switched
    ? resolveMcpConfig(resolved.env).hubUrl
    : bridge.target;

  // The binding, and the file derived from it, are two writes that have to
  // agree when this returns — so they happen under the lock `ub init` and
  // `ub workspace use` hold for exactly the same pair. Without it, a concurrent
  // `ub init` can settle a workspace between them and leave the derived file
  // naming one run's workspace over the other run's binding.
  let lock: InitLock;
  try {
    lock = await acquireInitLock();
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let persistence: RemotePersistence;
  // The binding is only half done while this checkout's derived mise config
  // still names the workspace and endpoint it had before: nothing in the
  // repository reads `ub`'s configuration, so `mise run web` and the hub would
  // keep serving the old one. Only ever a rewrite of a file that is already
  // there — see {@link regenerateLocalConfig}, and `ub workspace use`, which
  // pairs the same two writes for the same reason. A second machine joining
  // from outside a checkout has no such file and gets `none`.
  let regenerated: Regeneration = { kind: "none" };
  try {
    persistence = setRemote(bridge.target, {
      secret: bridge.credential.persist ? bridge.credential.secret : null,
      workspace: flags.workspace,
    });
    // Derived from what is on disk now — the binding above included — rather
    // than from what this process decided.
    regenerated = regenerateLocalConfig(process.cwd());
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    lock.release();
  }
  warn(io, persistence.warnings);

  if (regenerated.kind === "written") {
    // Outside the lock: trusting is a `mise` subprocess, and it reads the file
    // rather than writing it. Not a nicety — mise refuses every task in a
    // directory whose config file it does not trust, and trust is bound to the
    // file's contents, so a rewrite untrusts what `ub init` had trusted.
    const trust = trustLocalConfig(regenerated.path);
    if (!trust.trusted) {
      warn(io, [trust.hint]);
    }
  }

  let note = "";
  if (liveDocs(checked.corpus).length === 0) {
    note +=
      "\nThat workspace holds nothing yet. If you expected documents, check the " +
      "workspace id\nin the URL against `ub status` on the machine that has " +
      "them.\n";
  }
  note += `\nworkspace     ${flags.workspace}\n`;
  if (switched) {
    // What this machine holds for the old workspace, rather than "its
    // documents": all this knows is that something configured it, which is not
    // evidence of a replica.
    note +=
      `\n${previous} was not merged into this one and nothing of it was moved. ` +
      "Whatever this\nmachine holds for it is still here — `ub workspace list` " +
      "shows the workspaces with\na replica on this machine — and " +
      `\`ub workspace use ${previous} --user\` switches back.\n` +
      "\nThe endpoint, though, is machine-wide: that workspace now syncs with " +
      `${bridge.target}\ntoo, under its own rooms. Documents that only ever ` +
      "reached a local hub — written in\na browser and never pulled down by an " +
      "MCP session — are in that hub's database and\nnowhere else, and nothing " +
      `points at it any more. Start it and \`ub remote set ${previousEndpoint}\`\n` +
      "to reach them.\n";
  }
  io.out(
    report("joined", bridge.target, checked.corpus, persistence, takenAt, {
      note,
      derivedFollowed: regenerated.kind === "written",
    }) +
      (regenerated.kind === "written"
        ? `\nmise config   ${regenerated.path} (derived, gitignored)\n`
        : ""),
  );

  // Written, and possibly overruled. `config.json` is the third layer for the
  // workspace exactly as it is for the endpoint, and a report naming a binding
  // that something else outranks is the lie `ub status` then contradicts.
  const after = resolveConfig();
  const inForce = after.env.WORKSPACE_ID?.trim();
  if (inForce !== flags.workspace) {
    io.err(
      `ub: warning: ${ORIGIN_LABELS[after.origins.workspace]} sets ${
        inForce ?? "no workspace"
      }, which takes precedence over the binding just written — that is the ` +
        "workspace in force here, whatever this joined.\n",
    );
  }

  if (regenerated.kind === "refused") {
    io.err(
      `ub remote join: this machine is bound to ${flags.workspace}, but ` +
        `${regenerated.path} could not be updated to match: ${regenerated.reason} ` +
        "Until it is, every mise task in this directory still serves the " +
        "workspace that file names.\n",
    );
    return 1;
  }
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
  if (sub === "init") {
    return await remoteInitCommand(rest, io);
  }
  if (sub === "update") {
    return await remoteUpdateCommand(rest, io);
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
