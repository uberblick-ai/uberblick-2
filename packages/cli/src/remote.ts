/** Verified workspace fetching and promotion share the same bridge checks. */

import { Console } from "node:console";
import { Writable } from "node:stream";
import { readDeviceLogin } from "@uberblick/hub/device-login";
import {
  compareCorpus,
  inspectRemote,
  isIdentical,
  defaultDatabasePath,
  readWorkspaceName,
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
export { normalizeRemoteUrl, parseJoinTarget } from "@uberblick/hub/remote-url";
import { bridgeConfig, resolveMcpConfig } from "./budget.js";
import {
  resolveConfig,
  writeHubAdmission,
} from "./config.js";
import { resolveProjectBinding, validateProjectBinding, writeProjectBinding } from "./project-binding.js";
import { acquireInitLock } from "./init-lock.js";
import { type Io, shellArgument } from "./io.js";
import { displayWorkspaceHub, useBindingLines, useField } from "./workspace-use-output.js";
import { ORIGIN_LABELS } from "./status.js";
import { readWorkspaceHub, workspaceRegistryPath } from "./workspace-registry.js";

export interface RemotePersistence {
  /** Files written, for the report. */
  written: string[];
  /** Things worth saying that did not stop the write. */
  warnings: string[];
}

/** Persist the verified complete project destination in one atomic write. */
export function setRemote(
  url: string,
  options: { workspace?: string | undefined; env?: NodeJS.ProcessEnv; cwd?: string; deviceAdmission?: boolean } = {},
): RemotePersistence {
  const env = options.env ?? process.env;
  const current = resolveProjectBinding({ env: {}, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
  const workspaceId = options.workspace ?? current.binding?.workspaceId;
  if (workspaceId === undefined) throw new Error("a workspace is required before binding a remote hub");
  const binding = validateProjectBinding({ workspaceId, hubUrl: url }, "project binding");
  const previousHub = readWorkspaceHub(workspaceId, env);
  const registersPrevious = current.binding !== null && readWorkspaceHub(current.binding.workspaceId, env) === undefined;
  // Failure to remember device admission must never leave the project pointing
  // at a Docker hub that could later fall back to this computer's local secret.
  const admission = writeHubAdmission(url, options.deviceAdmission === true, env);
  const path = writeProjectBinding(binding, {
    env,
    record: "join",
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return { written: [...admission.written, ...(previousHub === binding.hubUrl && !registersPrevious ? [] : [workspaceRegistryPath(env)]), path], warnings: admission.warnings };
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
  if (hub.status === "quarantined") {
    return `${url} stopped syncing because this replica is not durable: ${hub.reason}`;
  }
  return `${url} did not answer`;
}

/**
 * Dial a hub as a client would and say why it cannot be used, or null when it
 * can. It writes no documents or binding; renewing login may update its store.
 *
 * `ub init <hub-url>` asks this before it writes a line of configuration, so
 * that a machine is never bound to an endpoint that would refuse it — and asks
 * it through {@link corpusProblem}, the same verdict `use <link>` uses, so that
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

function warn(io: Io, warnings: readonly string[]): void {
  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
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
export function corpusProblem(url: string, corpus: Corpus): string | null {
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
 * The verification `use <link>` ends with: what a fresh client finds there, compared
 * with what this machine holds, in both directions.
 *
 * Both directions, because "the far side has everything we have" is only half
 * of it. A document that appeared over there while the bridge was running means
 * the corpus this was verified against is already stale, and persisting the
 * endpoint on that basis would claim a completeness nobody checked.
 */
export async function verify(
  bridge: Bridge,
  expected: readonly CorpusDoc[],
  workspace?: readonly CorpusDoc[],
): Promise<{ corpus: Corpus; problem: string | null }> {
  bridge.io.err(`ub workspace: verifying ${bridge.target} as a fresh client…\n`);
  // The directory proves the complete identity/tombstone set. Reading one live
  // room proves the fresh-client path without making the command's fixed
  // network budget grow with the corpus; archived rooms are all read because a
  // tombstone alone cannot prove their restorable content moved.
  const corpus = await inspectRemote(remoteConfig(bridge), {
    documents: workspace === undefined ? "sample" : true,
    workspace: workspace !== undefined,
  });
  const unusable = corpusProblem(bridge.target, corpus);
  if (unusable !== null) {
    return { corpus, problem: unusable };
  }
  if (workspace !== undefined && (corpus.workspace === undefined ||
      !isIdentical(compareCorpus(workspace, corpus.workspace)))) {
    return { corpus, problem: `${bridge.target} does not match this workspace's name, settings or sidebar.\n` };
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

// --- ub workspace use <link> ------------------------------------------------

/**
 * The CLI runs one command at a time. Give its bounded bridge a quiet console,
 * including lib0/Yjs messages, then restore the caller's console on every exit.
 * Diagnostics come from the returned Corpus and thrown errors instead.
 */
async function quietLibraries<T>(action: () => Promise<T>): Promise<T> {
  const original = globalThis.console;
  const discard = new Writable({ write(_chunk, _encoding, done) { done(); } });
  globalThis.console = new Console({ stdout: discard, stderr: discard });
  try { return await action(); }
  finally {
    globalThis.console = original;
    discard.end();
  }
}

export interface WorkspaceUseOptions {
  verbose: boolean;
  json: boolean;
}

/** Fetch the named replica using the same reconciliation and verification as before. */
export async function useRemoteWorkspace(
  flags: { endpoint: string; workspace: string },
  command: string,
  io: Io,
  options: WorkspaceUseOptions,
): Promise<number> {
  const resolved = resolveConfig();
  // Resolve the target's admission, rather than inheriting the current project's
  // mode. In particular, a recorded Docker endpoint must never use a local secret.
  const target = resolveConfig({ env: { ...process.env, UB_WORKSPACE_ID: flags.workspace, UB_HUB_URL: flags.endpoint } });
  warn(io, [...new Set([...resolved.warnings, ...target.warnings])]);
  const bridgeEnv = target.env;
  // Loopback development with its existing local secret remains exempt.
  if (bridgeEnv.HUB_AUTH_TOKEN === undefined) bridgeEnv.HUB_ADMISSION = "device";
  if (usesDeviceLogin(flags.endpoint, bridgeEnv)) {
    const login = readDeviceLogin(flags.endpoint, flags.workspace, bridgeEnv);
    if (login.status === "sign-in-required") {
      io.err(
        `error: you are not signed in to ${login.origin}\n` +
        "nothing was fetched; the project binding is unchanged\n" +
        "sign in first, then run use again:\n" +
        `  ub auth login ${shellArgument(login.origin)}\n  ${command}\n`,
      );
      return 1;
    }
    if (login.status !== "ready") {
      io.err(`ub workspace use: ${login.message}\nNothing was fetched; the project binding is unchanged.\nRun again: ${command}\n`);
      return 1;
    }
  }
  let base: McpConfig;
  try { base = resolveMcpConfig(bridgeEnv); }
  catch (error) {
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\nRun again: ${command}\n`);
    return 2;
  }
  const bridge: Bridge = { base, env: bridgeEnv, target: flags.endpoint, io: { out() {}, err() {} } };
  let progress = false;
  let bindingWritten = false;
  const finishProgress = () => {
    if (!progress) return;
    progress = false;
    if (process.stderr.isTTY) io.err("\r\x1b[2K");
  };
  const fail = (problem: string, detail: string): number => {
    finishProgress();
    io.err(`ub workspace use: ${problem.trim()}\n${detail}\nRun again: ${command}\n`);
    return 1;
  };
  io.err(`ub workspace: fetching ${displayWorkspaceHub(flags.endpoint)}…${process.stderr.isTTY ? "" : "\n"}`);
  progress = true;
  try {
    const fetched = await quietLibraries(async () => {
      // A fresh directory read writes neither replica nor remote documents.
      const remote = await openRemote(bridge);
      const remoteProblem = corpusProblem(bridge.target, remote);
      if (remoteProblem !== null) return { problem: remoteProblem, detail: "Nothing was written to the workspace or binding." };
      const joined = await syncWorkspace(remoteConfig(bridge));
      const joinProblem = corpusProblem(bridge.target, joined);
      if (joinProblem !== null) {
        const contentMissing = joined.hub.status === "connected" && joined.complete &&
          joined.unsettled.length === 0 && joined.missing.length > 0;
        let recovery = `Retry once ${bridge.target} can finish the sync.`;
        if (contentMissing) {
          const source = resolved.binding;
          recovery = source !== null && parseWorkspaceId(source.workspaceId).uuid === parseWorkspaceId(flags.workspace).uuid &&
              source.hubUrl !== null && source.hubUrl !== bridge.target
            ? `Rerun \`ub workspace use ${shellArgument(`${source.hubUrl}/${flags.workspace}`)}\` against this workspace's previous hub, or retry from another replica that still holds the content.`
            : "Retry from another replica that still holds the content.";
        }
        return { problem: joinProblem, detail: "This machine's configuration is unchanged — no endpoint and no workspace were persisted. " +
          recovery + " What did arrive is in the local update log already." };
      }
      const takenAt = new Date().toISOString();
      const checked = await verify(bridge, joined.entries);
      if (checked.problem !== null) return { problem: checked.problem,
        detail: "This machine's configuration is unchanged — no endpoint and no workspace were persisted. Retry once the hub can finish verification." };
      return { corpus: joined, takenAt };
    });
    if (fetched.problem !== undefined) return fail(fetched.problem, fetched.detail);
    finishProgress();
    const binding = { workspaceId: flags.workspace, hubUrl: flags.endpoint };
    const lock = await acquireInitLock();
    let previous: ReturnType<typeof resolveProjectBinding>["binding"];
    let persistence: RemotePersistence;
    let text: string;
    try {
      previous = resolveProjectBinding({ env: {} }).binding;
      persistence = setRemote(bridge.target, {
        workspace: flags.workspace,
        deviceAdmission: bridge.base.deviceLogin !== undefined || usesDeviceLogin(bridge.target, bridge.env),
      });
      bindingWritten = true;
      const name = readWorkspaceName(defaultDatabasePath(flags.workspace), flags.workspace) ?? flags.workspace;
      const archived = fetched.corpus.entries.filter(doc => doc.deleted).length;
      text = useField("fetched", `${name} from ${displayWorkspaceHub(flags.endpoint)}: ${plural(fetched.corpus.entries.length, "document")}, ${archived} archived`);
      text += useBindingLines(binding, previous, persistence.written[persistence.written.length - 1] ?? "");
      text += "open it with: ub open\n";
    } finally { lock.release(); }
    warn(io, persistence.warnings);
    const source = resolved.binding;
    if (source !== null && parseWorkspaceId(source.workspaceId).uuid === parseWorkspaceId(flags.workspace).uuid &&
        source.hubUrl !== null && source.hubUrl !== bridge.target) {
      io.err(`ub: warning: The verified snapshot was taken at ${fetched.takenAt}; later writes to the previous hub are not included. Close other clients before relying on it.\n`);
    }
    if (options.json) {
      io.out(`${JSON.stringify({ binding, previous, documents: fetched.corpus.entries }, null, 2)}\n`);
    } else {
      if (options.verbose) {
        text += "\nDocuments fetched (including archived):\n" +
          fetched.corpus.entries.map(doc => `  ${doc.uuid}  ${doc.title}${doc.deleted ? " (archived)" : ""}\n`).join("");
        text += "\nVerified: the hub acknowledged the writes; a fresh client read the full directory and compared every entry, every archived document's content and one live document's content when present.\n" +
          "Verification does not establish hub disk durability or convergence of other clients.\n" +
          "\nConfiguration files written:\n" + persistence.written.map(path => `  ${path}\n`).join("");
      }
      io.out(text);
    }
    const after = resolveConfig();
    const inForce = after.env.WORKSPACE_ID?.trim();
    if (inForce !== flags.workspace || after.binding?.hubUrl !== flags.endpoint) {
      io.err(
        `ub: warning: ${ORIGIN_LABELS[after.origins.workspace]} sets ${inForce ?? "no workspace"} at ${after.binding?.hubUrl ?? "local-only"}, which takes precedence over the binding just written — that is the workspace in force here.\n`,
      );
    }
    return 0;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), bindingWritten
      ? "The verified project binding was written, but reporting its result failed."
      : "The project binding is unchanged; no new workspace hub record was persisted. What arrived may already be in the local update log.");
  } finally { finishProgress(); }
}
