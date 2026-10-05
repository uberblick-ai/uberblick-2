/**
 * `ub remote` — where this workspace syncs, and the one-time bridge onto it.
 *
 * `ub remote` names the endpoint and the membership required for sharing.
 * Remote clients use this machine’s stored device login. `ub remote init` and `ub remote update` stand up and
 * deploy the host; `ub remote join <url-with-workspace-id>` binds this machine to a
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
 * **No binding is persisted before the far side is verified.** `join` finishes by
 * opening the remote through a *fresh* client — no mirror, no local state — and
 * comparing what it sees with what this machine holds, in both directions and
 * including tombstones. Only then are the endpoint and the workspace binding
 * written. A bounded sync wait is not a completion signal, and an endpoint
 * changed on the strength of one would strand a corpus on the old hub, which is
 * the exact failure this command exists to prevent.
 *
 * **Persisting means every client, not just `ub`.** See {@link setRemote}.
 *
 * Login keys stay in the owner-only credential store; joining changes only
 * the workspace binding after successful reconciliation and verification.
 */

import { parseArgs } from "node:util";
import {
  compareCorpus,
  inspectRemote,
  isIdentical,
  liveDocs,
  syncWorkspace,
  usesDeviceLogin,
} from "@uberblick/mcp-server";
import type {
  Corpus,
  CorpusDoc,
  HubState,
  McpConfig,
} from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import { parseJoinTarget } from "@uberblick/hub/remote-url";
import { readDeviceLogin } from "@uberblick/hub/device-login";
export { normalizeRemoteUrl, parseJoinTarget } from "@uberblick/hub/remote-url";
import { bridgeConfig, resolveMcpConfig } from "./budget.js";
import {
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
import { ORIGIN_LABELS } from "./status.js";

export const REMOTE_HELP = `usage: ub remote [command]

commands:
  (none)                        the endpoint in force and what sharing it buys
  init <ssh-target>             stand up the remote hub + web stack on a
                                tailnet host
  update <ssh-target>           deploy origin/main onto that host now
  join <url-with-workspace-id>  bind this machine to the remote workspace the
                                URL names

options:
  -h, --help                    show this help; after a command, show that
                                command's help
`;

const SHARING_BOUNDARY =
  "Remote sharing requires this machine's stored login and current workspace membership.\n" +
  "Run `ub auth login <hub>`, then `ub open` to edit in a browser on this computer.\n" +
  "A browser opened directly at the remote host cannot sign in or read documents yet.\n";

export interface RemotePersistence {
  /** Files written, for the report. */
  written: string[];
  /** Things worth saying that did not stop the write. */
  warnings: string[];
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
 * **A workspace travels with the endpoint, when one is given.** `ub remote join`
 * binds this machine to the workspace its URL names, and that binding and the
 * endpoint have to land in the same file in the same write — a machine pointed
 * at the remote hub while still naming the workspace it had before would dial
 * the right hub for the wrong rooms.
 *
 * Deployment and initialization also publish through this helper.
 */
export function setRemote(
  url: string,
  options: { workspace?: string | undefined; env?: NodeJS.ProcessEnv; deviceAdmission?: boolean } = {},
): RemotePersistence {
  const env = options.env ?? process.env;
  const current = readUserConfig(env);
  const updated: Record<string, unknown> = {
    ...current.raw,
    hubUrl: url,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  };
  // Admission belongs to the endpoint, so changing endpoints never carries a
  // previous hub's mode. Existing non-loopback callers need no extra setting.
  delete updated.hubAdmission;
  if (options.deviceAdmission === true) updated.hubAdmission = "device";
  writeUserConfig(updated, env);
  return { written: [userConfigPath(env)], warnings: [] };
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
    return `${url} rejected the credential: ${hub.reason ?? "the hub refused this machine’s credential"}`;
  }
  if (hub.status === "disabled") {
    return `no signing secret is configured, so ${url} cannot be authenticated to`;
  }
  return `${url} did not answer`;
}

/**
 * Dial a hub as a client would and say why it cannot be used, or null when it
 * can. It writes no documents or binding; renewing login may update its store.
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

interface Bridge {
  base: McpConfig;
  /** The environment `base` was resolved from — the ceiling travels with it. */
  env: NodeJS.ProcessEnv;
  target: string;
  io: Io;
}

function remoteConfig(bridge: Bridge): McpConfig {
  return bridgeConfig(bridge.base, bridge.env, {
    hubUrl: bridge.target,
  });
}

/** Read the directory without a mirror; retry a transient dial once. */
async function openRemote(bridge: Bridge): Promise<Corpus> {
  const first = await inspectRemote(remoteConfig(bridge), { silent: true });
  if (first.hub.status !== "hub-down" && first.hub.status !== "connecting") return first;
  bridge.io.err("ub remote join: initial connection did not finish; retrying once…\n");
  return await inspectRemote(remoteConfig(bridge), { silent: true });
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
  let text =
    `${verb} ${plural(corpus.entries.length, "document")} — directory verified on ` +
    `${target}\n\n`;
  text += listDocs(live);
  if (tombstones > 0) {
    text +=
      `\n${plural(tombstones, "archived document")} moved and verified. ` +
      "They stay archived until restored.\n";
  }
  text += note;
  text += "\nconfiguration\n";
  for (const path of persistence.written) {
    text += `  ${path}\n`;
  }
  text +=
    "\n`ub`, `ub mcp serve` and the MCP server it spawns read this endpoint from\n" +
    "config.json. A deployed web client reads its own from the served\n" +
    "/uberblick-config.json.\n";
  text +=
    "\nVerified here means the hub acknowledged the writes. A fresh client read the\n" +
    "full directory back and compared every document's directory entry. Every\n" +
    "archived document's content was read back, plus one live document's content\n" +
    "when the workspace has any. This does not mean the hub flushed them to disk.\n" +
    `The snapshot this verified was taken at ${takenAt}; anything written to the\n` +
    "old hub after that is not part of it, so close the other clients before\n" +
    "relying on this.\n";
  text += `\n${SHARING_BOUNDARY}`;
  return text;
}

/** Exported so `join`'s help can be checked against its parser. */
export const REMOTE_BRIDGE_OPTIONS = {} as const;

export const REMOTE_JOIN_HELP = `usage: ub remote join <url-with-workspace-id>

Bind this machine to a workspace that already lives on a remote hub, whatever is
here already: the remote's documents are hydrated into that workspace's local
replica, and the endpoint and the binding are stored. Remote hubs use this
machine’s stored login from \`ub auth login <hub>\`. No \`ub init\` is needed first.

It never merges two workspaces and it never seeds. A workspace already on this
machine under a different id keeps its documents and its \`ub workspace list\`
entry, and \`ub workspace use <id>\` switches back. A replica this machine
already holds for *this* id is attached, not replaced: it and the remote
reconcile as CRDTs, so neither side loses anything.

operands:
  <url-with-workspace-id>
                        the endpoint with the workspace id as its last path
                        segment, like wss://hub.example.ts.net/ws/<workspace-id>.
                        \`ub remote init\` prints it, and \`ub status\` on the
                        machine that has the workspace names the id. ws:// or
                        wss:// is stored as given; a bare host and an https://
                        address is read as the deployed wss://<host>/ws;
                        http:// is read as ws://<host>/ws. A URL without an id is refused before
                        anything is written

options:
  -h, --help            show this help

Sign in with \`ub auth login <hub>\` before joining a remote workspace.
A loopback-only development hub keeps its local signing-secret admission.`;

interface JoinFlags {
  /** The endpoint, with the workspace id taken off it. */
  endpoint: string;
  /** The workspace id, as typed. */
  workspace: string;
}

function parseJoinFlags(argv: string[]): JoinFlags {
  const { positionals } = parseArgs({
    args: argv,
    // The surface `REMOTE_JOIN_HELP` is checked against: a flag added here and
    // not to the help fails in `help.test.ts` rather than in somebody's
    // terminal.
    options: REMOTE_BRIDGE_OPTIONS,
    allowPositionals: true,
  });
  const [url, ...rest] = positionals;
  if (url === undefined || rest.length > 0) {
    throw new Error("expected exactly one <url-with-workspace-id>");
  }
  return parseJoinTarget(url);
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
      "  ub remote join <url-with-workspace-id>\n" +
      "                           bind this machine to a remote workspace\n";
    io.out(text);
    return 0;
  }

  let text = `remote        ${config.hubUrl} (user config)\n`;
  text += `workspace     ${config.workspaceId}\n`;
  text += `credential    ${
    config.deviceLogin !== undefined
      ? (readDeviceLogin(config.hubUrl, config.workspaceId, resolved.env).status === "ready" ? "stored device login" : "sign-in required — run `ub auth login <hub>`")
      : config.authSecret === null
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
  // The directory proves the complete identity/tombstone set. Reading one live
  // room proves the fresh-client path without making the command's fixed
  // network budget grow with the corpus; archived rooms are all read because a
  // tombstone alone cannot prove their restorable content moved.
  const corpus = await inspectRemote(remoteConfig(bridge), {
    documents: "sample",
  });
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
        "usage: ub remote join <url-with-workspace-id>\n",
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
  const bridgeEnv: NodeJS.ProcessEnv = {
    ...resolved.env,
    WORKSPACE_ID: flags.workspace,
    HUB_URL: flags.endpoint,
  };
  if (flags.endpoint !== resolved.env.HUB_URL) delete bridgeEnv.HUB_ADMISSION;
  // Resolution withheld the local secret while bound to a remote endpoint.
  // Choosing a loopback target recovers that existing authority without
  // copying it into the configuration or credential store.
  if (!usesDeviceLogin(flags.endpoint, bridgeEnv)) {
    const stored = readCredentials();
    const secret = process.env.HUB_AUTH_TOKEN?.trim() ||
      (stored.exposed ? null : stored.signingSecret);
    if (secret !== null) bridgeEnv.HUB_AUTH_TOKEN = secret;
  } else {
    delete bridgeEnv.HUB_AUTH_TOKEN;
  }
  // An unknown loopback deployment with no local authority is still a device
  // client; no signing secret is needed to join a released hub.
  if (bridgeEnv.HUB_AUTH_TOKEN === undefined) bridgeEnv.HUB_ADMISSION = "device";
  let base: McpConfig;
  try {
    base = resolveMcpConfig(bridgeEnv);
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const bridge: Bridge = {
    base,
    env: bridgeEnv,
    target: flags.endpoint,
    io,
  };

  // Read as a fresh client, which writes nothing on either side — so every
  // refusal below leaves both this machine and the remote exactly as they were.
  // Document rooms are not opened here: this machine's replica may hold and
  // upload content the remote lacks. The strict reading after reconciliation
  // decides whether either side could actually produce every room.
  const remote = await openRemote(bridge);
  const remoteProblem = corpusProblem(bridge.target, remote);
  if (remoteProblem !== null) {
    io.err(
      `ub remote join: ${remoteProblem}Nothing was written to the workspace or binding.\n`,
    );
    return 1;
  }

  io.err(
    `ub remote: hydrating ${plural(remote.entries.length, "document")} from ${bridge.target}…\n`,
  );
  const joined = await syncWorkspace(remoteConfig(bridge));
  const joinProblem = corpusProblem(bridge.target, joined);
  if (joinProblem !== null) {
    const contentMissing =
      joined.hub.status === "connected" &&
      joined.complete &&
      joined.unsettled.length === 0 &&
      joined.missing.length > 0;
    let recovery =
      `Rerun this command on this machine once ${bridge.target} can finish the sync.`;
    if (contentMissing) {
      const sourceEndpoint = resolveMcpConfig({
        ...resolved.env,
        WORKSPACE_ID: flags.workspace,
      }).hubUrl;
      recovery =
        sourceEndpoint === bridge.target
          ? "Retry from another replica that still holds the content."
          : `Rerun \`ub remote join ${sourceEndpoint}/${flags.workspace}\` against ` +
            "the endpoint this machine was using before this command, or retry " +
            "from another replica that still holds the content.";
    }
    io.err(
      `ub remote join: ${joinProblem}This machine's configuration is ` +
        `unchanged — no endpoint and no workspace were persisted. ${recovery} ` +
        "What did arrive is in the local update log already.\n",
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
      workspace: flags.workspace,
      deviceAdmission: bridge.base.deviceLogin !== undefined || usesDeviceLogin(bridge.target, bridge.env),
    });
  } catch (error) {
    io.err(`ub remote join: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    lock.release();
  }
  warn(io, persistence.warnings);

  let note = "";
  if (checked.corpus.entries.length === 0) {
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
      `\`ub workspace use ${previous}\` switches back.\n` +
      "\nThe endpoint, though, is machine-wide: that workspace now syncs with " +
      `${bridge.target}\ntoo, under its own rooms. Documents that only ever ` +
      "reached a local hub — written in\na browser and never pulled down by an " +
      "MCP session — are in that hub's database and\nnowhere else, and nothing " +
      "points at it any more. Going back to that endpoint is\n" +
      `\`ub remote join ${previousEndpoint}/${previous}\`, which hydrates from ` +
      "it the way this join did.\n";
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
