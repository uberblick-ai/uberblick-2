/**
 * `ub remote` — where this workspace syncs, and the one-time bridge onto it.
 *
 * `ub remote` says which endpoint is in force and what sharing it actually
 * buys, in plain words. There is no `invite` (#92): today the host serves the
 * shared signing secret to the app, so "sharing" is handing somebody an address
 * and a secret, and a command named `invite` would imply an access model that
 * does not exist yet. `ub remote init` and `ub remote update` stand up and
 * deploy the host; `ub remote join <url>/<workspace-id>` binds this machine to a
 * workspace that already lives on one, and hydrates it.
 *
 * There is no operator suite here: no verb that points the clients somewhere
 * without moving anything. Release 1 has one owner, one workspace, and `join`.
 *
 * **`join` binds one workspace; it never merges two, and it never seeds.** The
 * URL carries the workspace id, so nothing already on this machine is in the
 * way: the id says which rooms and which `<uuid>.sqlite` replica this is about,
 * and a workspace that was here first has a different id — it keeps its
 * documents and its entry in `ub workspace list`, and switching back to it is
 * `ub workspace use`. For the id the URL *does* name, a replica this machine
 * already holds is attached rather than replaced: {@link syncWorkspace}
 * reconciles it with the remote as CRDTs, so the local log's updates go up, the
 * hub's come down, and neither side is discarded — which is how the machine
 * that ran `ub remote init` joins its own populated workspace. A machine
 * holding nothing for that id simply hydrates. What is never written into a
 * joined workspace is a starter document: one invented here is one the
 * workspace's owner never asked for. With an id in hand there is no "is this
 * side empty" question left to get wrong, which is what makes one verb enough.
 *
 * **Nothing is persisted before the far side is verified.** `join` finishes by
 * opening the remote through a *fresh* client — no mirror, no local state — and
 * comparing what it sees with what this machine holds, in both directions and
 * including tombstones. Only then are the endpoint and the workspace binding
 * written. A bounded sync wait is not a completion signal, and an endpoint
 * changed on the strength of one would strand a corpus on the old hub, which is
 * the exact failure this command exists to prevent.
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
  compareCorpus,
  inspectRemote,
  isIdentical,
  liveDocs,
  syncWorkspace,
} from "@uberblick/mcp-server";
import type {
  Corpus,
  CorpusDoc,
  HubState,
  McpConfig,
} from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import { bridgeConfig, resolveMcpConfig } from "./budget.js";
import {
  credentialsPath,
  readCredentials,
  readUserConfig,
  resolveConfig,
  userConfigPath,
  writeUserConfig,
} from "./config.js";
import { takeHelp } from "./help.js";
import type { InitLock } from "./init-lock.js";
import { acquireInitLock } from "./init-lock.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { remoteInitCommand, remoteUpdateCommand } from "./remote-init.js";
import { publishOwnerOnly, removeQuietly } from "./safe-write.js";
import { ORIGIN_LABELS } from "./status.js";

export const REMOTE_HELP = `usage: ub remote [command]

commands:
  (none)                 the endpoint in force and what sharing it buys
  init <ssh-target>      stand up the remote hub + web stack on a tailnet host
  update <ssh-target>    deploy origin/main onto that host now
  join <url>/<id> [opts] bind this machine to the remote workspace the URL names

options for init:
  --dir <path>           checkout directory on the host (default ~/uberblick-remote)
  --host <fqdn>          the host's MagicDNS name, when detection cannot see it
  --ip <v4>              the host's Tailscale IPv4, likewise

The join URL is an endpoint with the workspace id as its last path segment —
\`ub remote init\` prints it. Joining never merges and never seeds: a workspace
already on this machine keeps its documents and its \`ub workspace list\` entry.

options for join:
  --secret-file <path>   read the remote's signing secret from a file only you
                         can read (mode 0600). Without it the secret already
                         configured is tried first, and a terminal is prompted
                         with the input hidden. Never pass a secret as an
                         argument.

options:
  -h, --help             show this help; after a command, that command's help
`;

/**
 * What the endpoint buys you today, stated wherever a remote is named.
 *
 * The web client is handed the shared signing secret in the configuration
 * document its host serves (#426), so reaching the app *is* holding the
 * credential. Until accounts land (#84) the network is the access control, and
 * saying so is the honest version of "sharing".
 */
const SHARING_BOUNDARY =
  "Everyone who can reach this endpoint and load the web app receives the\n" +
  "shared signing secret — the host serves it to the app — so reaching\n" +
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
  /** True when `credentials.json` now holds a different signing secret. */
  replacedSecret: boolean;
}

/**
 * Persist the endpoint, and say honestly who will follow it.
 *
 * `config.json` is where `ub` resolves `hubUrl`, and it is the only place: it is
 * what makes `ub status`, `ub mcp serve`, the MCP server this CLI spawns and
 * every checkout task running under `ub env` dial the new hub. Nothing ambient
 * outranks it.
 *
 * A *deployed* web client learns its endpoint at runtime from the served
 * `/uberblick-config.json` (#91), not from anything written here.
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
  } = {},
): RemotePersistence {
  const env = options.env ?? process.env;
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

  const changingSecret = secret !== null && secret !== stored.signingSecret;
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

  return { written, warnings, replacedSecret: changingSecret };
}

/** A value carrying its own scheme, as opposed to a bare host. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * The path the deployed stack serves the hub under (REMOTE.md).
 *
 * The one deployment convention this CLI encodes, by the owner's decision, and
 * it is applied only where a scheme had to be invented — see below.
 */
const DEPLOYED_PATH = "/ws";

/** An endpoint, read and validated, in the pieces both callers below need. */
interface RemoteUrl {
  /** Exactly what was typed, trimmed. */
  text: string;
  scheme: "ws" | "wss";
  host: string;
  /** The path, or "" where none was given. */
  path: string;
  /** Whether the scheme was invented here — a bare host or a web address. */
  invented: boolean;
}

/**
 * Read an endpoint from whatever form of it somebody has to hand, or refuse.
 *
 * Three forms, because three are what people actually hold: the host name
 * `tailscale status` prints, the `https://…` address a browser's bar hands
 * back, and a websocket endpoint somebody already knows in full. The first two
 * name the deployment REMOTE.md stands up, which serves the hub at
 * `wss://<host>/ws`, so they are read as it rather than refused with a lecture
 * — and `http://` likewise, to `ws://`, since a plaintext address means a
 * plaintext hub.
 *
 * Userinfo, query and fragment are refused rather than carried. A hub token
 * travels in Hocuspocus' auth message and never in the URL, by invariant, so
 * `wss://user:secret@host/ws?token=…` is at best a misunderstanding and at
 * worst a credential this command would persist into two files and echo back
 * on stdout. **No refusal here repeats the value**, for the same reason: the
 * one that fails to parse is exactly the one somebody may have pasted a secret
 * into, so the message describes the shape that is expected instead.
 */
function readRemoteUrl(value: string): RemoteUrl {
  const text = value.trim();
  // Read from the text, not from what the parser makes of it: `new URL` reads
  // `localhost:1234` as a scheme with a path, so a bare host with a port would
  // otherwise be understood as something else entirely.
  const invented = !SCHEME.test(text);
  let url: URL;
  try {
    url = new URL(invented ? `wss://${text}` : text);
  } catch {
    throw new Error(
      "that is not a URL. The hub speaks websockets, so an endpoint looks " +
        "like wss://hub.example.ts.net/ws — a bare hub.example.ts.net, or its " +
        "https:// address, is read as one",
    );
  }
  const websocket = url.protocol === "ws:" || url.protocol === "wss:";
  const web = url.protocol === "http:" || url.protocol === "https:";
  if (!websocket && !web) {
    throw new Error(
      "that is not a websocket endpoint: it must start with ws:// or wss://, " +
        "or be a bare host or an https:// address",
    );
  }
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
  return {
    text,
    scheme: url.protocol === "wss:" || url.protocol === "https:" ? "wss" : "ws",
    host: url.host,
    path: url.pathname === "/" ? "" : url.pathname,
    invented: invented || web,
  };
}

/**
 * The endpoint to store, built back from its pieces.
 *
 * The deployed path fills in for a path nobody gave — but only where the scheme
 * was invented too, which is the whole of what that convenience buys. An
 * endpoint somebody typed in full names its own path, empty included.
 */
function formatRemoteUrl(url: RemoteUrl, path = url.path): string {
  return `${url.scheme}://${url.host}${path === "" && url.invented ? DEPLOYED_PATH : path}`;
}

/**
 * The endpoint to store, from whatever form of it somebody typed.
 *
 * A `ws://` or `wss://` endpoint comes back **exactly as typed**: it is what
 * somebody who knows their hub wrote down, and rebuilding it through `URL`
 * would fold the host's case, drop an explicit `:443` and eat a trailing slash
 * — three silent rewrites of a value this then stores and compares against on
 * every later run. Only an invented scheme produces a rewritten string, because
 * there the whole point is to produce one.
 */
export function normalizeRemoteUrl(value: string): string {
  const url = readRemoteUrl(value);
  return url.invented ? formatRemoteUrl(url) : url.text;
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
 * goes through the same reader {@link normalizeRemoteUrl} uses, so a credential
 * smuggled into the URL is refused there rather than in two places — and a bare
 * host or an `https://` address gets the deployed path here too, since the id
 * is removed *before* the endpoint is built rather than after.
 *
 * Neither refusal echoes the URL back. `ub remote init` prints this string and
 * people paste it about, so the actionable half is the *form*, and repeating a
 * value somebody may have put a secret into is how it reaches a terminal log.
 */
export function parseJoinTarget(value: string): {
  endpoint: string;
  workspace: string;
} {
  const url = readRemoteUrl(value);
  // The last segment and its own separator; everything before them is the
  // endpoint, **verbatim**. Splitting the path and rejoining the non-empty
  // parts would rewrite it — `/proxy//ws/<id>` would come back as `/proxy/ws`
  // — and an empty segment is somebody's reverse proxy path, which may well
  // route differently from the tidied version. Only the id is this command's
  // to remove. A path of "" leaves an empty workspace, which is the refusal
  // below rather than a special case.
  const cut = url.path.lastIndexOf("/");
  const workspace = url.path.slice(cut + 1);
  if (workspace === "") {
    throw new Error(
      "that URL names no workspace. A join URL is the endpoint with the " +
        "workspace id as its last path segment and nothing after it, like " +
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
  // Everything the id's segment leaves behind. An endpoint somebody typed in
  // full is cut out of the string they typed, so the half that is stored is
  // byte for byte the half they wrote — `wss://Host:443/ws/<id>` keeps its
  // case, its explicit port and its path, none of which survive a rebuild
  // through `URL`. An invented form has no spelling to preserve: it is rebuilt,
  // and a path left as nothing but a root slash (`https://host//<id>`) collapses
  // so that it takes the deployed path like every other invented form.
  const suffix = `/${workspace}`;
  const path = url.path.slice(0, cut);
  const endpoint =
    url.invented || !url.text.endsWith(suffix)
      ? formatRemoteUrl(url, path === "/" ? "" : path)
      : url.text.slice(0, -suffix.length);
  return { endpoint, workspace };
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
  if (hub.status === "update-required") {
    // `HubState.reason` is composed locally from two integers and already names
    // both versions and the side to update — the same sentence `ub status`
    // prints, so a person reads one wording wherever they meet this.
    return `${url} speaks a different sync protocol: ${hub.reason}`;
  }
  if (hub.status === "auth-failed") {
    return `${url} rejected the credential — the secret is wrong, or that hub is older than this client`;
  }
  if (hub.status === "disabled") {
    return `no signing secret is configured, so ${url} cannot be authenticated to`;
  }
  return `${url} did not answer`;
}

/**
 * Dial a hub as a client would and say why it cannot be used, or null when it
 * can. Reads; writes nothing on either side.
 *
 * `ub init <hub-url>` asks this before it writes a line of configuration, so
 * that a machine is never bound to an endpoint that would refuse it — and asks
 * it through {@link corpusProblem}, the same verdict `join` uses, so that
 * nothing answered, a refused credential, a protocol skew and a hub that
 * accepts the socket without ever serving its directory are worded once for
 * both verbs.
 */
export async function remoteProblem(config: McpConfig): Promise<string | null> {
  return corpusProblem(config.hubUrl, await inspectRemote(config));
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
 *
 * The first read is `silent`: it happens before the prompt, and both readings
 * that reach the prompt log themselves otherwise — a machine that ran `ub init`
 * probes with its own secret and gets `hub rejected the token`, a machine with
 * no configuration at all probes with none and gets `running local-only`. Both
 * would land in front of "remote signing secret", on a join that then succeeds
 * (#447). Nothing is hidden by that: whatever this reading says arrives in
 * `hub.status`, and {@link corpusProblem} is what prints it when `join` refuses.
 */
async function openRemote(bridge: Bridge, secretFileGiven: boolean): Promise<Corpus> {
  const first = await inspectRemote(remoteConfig(bridge), {
    documents: true,
    silent: true,
  });
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
  /** What this verb has to say about the documents, if anything. */
  note = "",
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
  text += note;
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
    "/uberblick-config.json.\n";
  text +=
    "\nVerified here means the hub acknowledged the writes and a fresh client read\n" +
    `them back — not that the hub has flushed them to disk. The snapshot this\n` +
    `verified was taken at ${takenAt}; anything written to the old hub after\n` +
    "that is not part of it, so close the other clients before relying on this.\n";
  text += `\n${SHARING_BOUNDARY}`;
  return text;
}

/** Exported so `join`'s help can be checked against its parser. */
export const REMOTE_BRIDGE_OPTIONS = {
  "secret-file": { type: "string" },
} as const;

/** The paragraph `join`'s help ends on: how the credential is supplied. */
const SECRET_FILE_NOTE = `  --secret-file <path>  read the remote's signing secret from a file only you
                        can read (mode 0600). Without it the secret already
                        configured is tried first, and a terminal is prompted
                        with the input hidden.
  -h, --help            show this help

Never pass a secret as an argument: it would be in the shell history and in
every process listing on the machine.
`;

export const REMOTE_JOIN_HELP = `usage: ub remote join <url-with-workspace-id> [--secret-file <path>]

Bind this machine to a workspace that already lives on a remote hub, whatever is
here already: the remote's documents are hydrated into that workspace's local
replica, the endpoint and the binding are stored, and so is the credential that
reached it. No \`ub init\` is needed first.

It never merges two workspaces and it never seeds. A workspace already on this
machine under a different id keeps its documents and its \`ub workspace list\`
entry, and \`ub workspace use <id> --user\` switches back. A replica this machine
already holds for *this* id is attached, not replaced: it and the remote
reconcile as CRDTs, so neither side loses anything.

operands:
  <url-with-workspace-id>
                        the endpoint with the workspace id as its last path
                        segment, like wss://hub.example.ts.net/ws/<workspace-id>.
                        \`ub remote init\` prints it, and \`ub status\` on the
                        machine that has the workspace names the id. ws:// or
                        wss:// is stored as given; a bare host and an https://
                        or http:// address are read as the deployed
                        wss://<host>/ws; a URL without an id is refused before
                        anything is written

options:
${SECRET_FILE_NOTE}`;

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
    // The surface `REMOTE_JOIN_HELP` is checked against: a flag added here and
    // not to the help fails in `help.test.ts` rather than in somebody's
    // terminal.
    options: REMOTE_BRIDGE_OPTIONS,
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
    text +=
      "  ub remote init <ssh-target>\n" +
      "                           stand one up on a host you can reach\n";
    text +=
      "  ub remote join <url>/<workspace-id>\n" +
      "                           bind this machine to a remote workspace\n";
    io.out(text);
    return 0;
  }

  let text = `remote        ${config.hubUrl} (user config)\n`;
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

// --- the shared bridge machinery -------------------------------------------

/**
 * Why a corpus reading cannot be trusted, or null when it can.
 *
 * The facts a bounded wait cannot establish on its own, in one place: the hub
 * answered, its directory was read in full, every room is acknowledged, and
 * every document the directory names actually arrived. Fail-closed throughout:
 * an unknown directory is not a small directory, and missing is missing.
 */
function corpusProblem(url: string, corpus: Corpus): string | null {
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
  const unsettled = corpus.unsettled;
  if (unsettled.length > 0) {
    return (
      `${url} has not acknowledged ${plural(unsettled.length, "room")}, ` +
      "so this sync did not finish inside its time limit:\n" +
      unsettled.map((room) => `  ${room}\n`).join("")
    );
  }
  const missing = corpus.missing;
  if (missing.length > 0) {
    return (
      `${plural(missing.length, "document")} named by the directory at ` +
      `${url} did not arrive, and this machine does not hold them either:\n` +
      listDocs(missing)
    );
  }
  return null;
}

/**
 * The verification `join` ends with: what a fresh client finds there, compared
 * with what this machine holds, in both directions.
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

/** The credential `join` starts with, from `--secret-file` or what is in force. */
function startingCredential(
  flags: { secretFile: string | undefined },
  inForce: string | null,
): Credential {
  if (flags.secretFile === undefined) {
    return { secret: inForce, persist: false };
  }
  return { secret: readSecretFile(flags.secretFile), persist: true };
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
  // First statement, before the URL is even looked at: `ub remote join <url>
  // -h` is somebody asking what the form is, and answering it by refusing the
  // form they got wrong would be the joke this help exists to stop.
  if (takeHelp(argv, io, REMOTE_JOIN_HELP)) return 0;

  let flags: JoinFlags;
  try {
    flags = parseJoinFlags(argv);
  } catch (error) {
    io.err(
      `ub remote join: ${error instanceof Error ? error.message : String(error)}\n\n` +
        "usage: ub remote join <url-with-workspace-id> [--secret-file <path>]\n",
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
  // `join` uploads nothing, so a document the remote's directory names and
  // cannot produce is simply missing, and hydrating from a remote that cannot
  // serve its own corpus is not a join.
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

  // `config.json` is read, merged and republished here, and `ub init` and
  // `ub workspace use` do the same to the same file — so all three run under
  // one lock, or one of them loses a field another had just written.
  let lock: InitLock;
  try {
    lock = await acquireInitLock();
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let persistence: RemotePersistence;
  try {
    persistence = setRemote(bridge.target, {
      secret: bridge.credential.persist ? bridge.credential.secret : null,
      workspace: flags.workspace,
    });
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    lock.release();
  }
  warn(io, persistence.warnings);

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
      "points at it any more. Going back to that endpoint is\n" +
      `\`ub remote join ${previousEndpoint}/${previous}\`, which hydrates from ` +
      "it the way this join did.\n" +
      // Only when it is true: that hub authenticated the old secret, which this
      // join has replaced, so it has to be given back to whatever serves that
      // endpoint before a join could reach it.
      (persistence.replacedSecret
        ? "\nThat hub was authenticated with the signing secret this join has just " +
          "replaced, so\nrejoining it needs that secret: a hub reads " +
          "HUB_AUTH_TOKEN from its own\nenvironment, so start one with the " +
          "previous secret exported:\n\n" +
          "  HUB_AUTH_TOKEN=<that secret> ub open --no-browser\n"
        : "");
  }
  io.out(report("joined", bridge.target, checked.corpus, persistence, takenAt, note));

  // Written, and possibly overruled: `WORKSPACE_ID` in the environment outranks
  // `config.json`, and a report naming a binding that something else outranks is
  // the lie `ub status` then contradicts.
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

  return 0;
}

export async function remoteCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  // The subcommand first, so `ub remote join --help` reaches the help of the
  // leaf it names rather than being answered by the group. A group's own
  // argument is that one word, so only that word can ask for help — an unknown
  // command is still an unknown command, `--help` after it or not.
  const [sub, ...rest] = argv;
  if (sub === "init") {
    return await remoteInitCommand(rest, io);
  }
  if (sub === "update") {
    return await remoteUpdateCommand(rest, io);
  }
  if (sub === "join") {
    return await joinCommand(rest, io);
  }
  if (sub === undefined) {
    return showRemote(io);
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    io.out(REMOTE_HELP);
    return 0;
  }
  io.err(`ub remote: unknown command ${JSON.stringify(sub)}\n\n${REMOTE_HELP}`);
  return 2;
}
