import { bundlePlan, ensureBundle } from "./open-bundle.js";
import { createApiAuthenticator, serveBoundRequest } from "./open-api.js";
import { ensureHub } from "./open-hub.js";
import { DEFAULT_WEB_PORT, WEB_HOST, portTakenMessage, whoHoldsPort, whyNotStartable } from "./open-ports.js";
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { silentLogger, type Hub } from "@uberblick/hub";
import { createLocalBrowserServer, type LocalBrowserServer } from "./local-browser-server.js";
import { hubTransportProblem, isLoopbackHost } from "@uberblick/mcp-server/remote-url";
import { readDeviceLogin } from "@uberblick/mcp-server/device-login";
import {
  DIRECTORY_SUFFIX,
  SIDEBAR_SUFFIX,
  parseRoom,
} from "@uberblick/schema";
import {
  DEFAULT_HUB_URL,
  ServingReplicaHeldError,
  collectServingSyncStatus,
  captureWorkspaceDetachGeneration,
  createMcpEngine,
  readWorkspaceName,
  usesDeviceLogin,
  withLoggingDisabled,
  type ServingSyncStatus,
  type HubState,
  type UberblickMcpEngine,
} from "@uberblick/mcp-server";
import { resolveMcpConfig } from "./budget.js";
import { openBrowser } from "./browser.js";
import { errorMessage, trimmed } from "./strings.js";
import { BindingResolutionError, ensureLocalSigningSecret, readCredentials, resolveConfig, requireBinding, SigningSecretExposureError } from "@uberblick/mcp-server/project-config";
import { type CommandArgs, usageError } from "./command.js";
import { acquireInitLock, tryAcquireInitLock } from "@uberblick/mcp-server/init-lock";
import type { Io } from "./io.js";
import { processIo, shellArgument } from "./io.js";
import type { AccessBinding } from "./open-access.js";
import { createBrowserAccess } from "./open-session.js";
import { monitorOpenHub, waitForOpenHubState } from "./open-hub-output.js";
import { openBanner } from "./open-output.js";
import { startUpdateCheck, type UpdateCheck } from "./open-update.js";
import { cliVersion, isInstallPayload } from "./version.js";
import { requestRecentDevices } from "./recent-devices.js";
import { BrowserReplicas, browserWorkspaces, type ServedWorkspace } from "./open-workspaces.js";
import { assertWorkspaceBinding, rememberWorkspaceBindings } from "@uberblick/mcp-server/workspace-registry";
import { displayWorkspaceHub } from "./workspace-use-output.js";
import {
  endpointOf,
  probePort,
} from "./probes.js";

export const OPEN_HELP = `usage: ub open [options]

Serve the web app for this project's workspace, with a hub behind it, and open the browser. Runs until Ctrl-C.

options:
  --no-browser      Print the address instead of opening a browser
  --port <n>        Port for the web app (default ${DEFAULT_WEB_PORT})
  --verbose         Also print hub, sync and startup details for debugging
  -h, --help        show this help

BROWSER in the environment names the command used to open the URL; BROWSER=none
suppresses it, like --no-browser.
`;

const runFile = promisify(execFile);

/** Optional git configuration must never keep the web app from serving. */
async function defaultPresenceName(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await runFile("git", ["config", "user.name"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      maxBuffer: Number.POSITIVE_INFINITY,
      timeout: 1_000,
      killSignal: "SIGKILL",
    });
    const name = trimmed(stdout);
    if (name !== null) return name;
  } catch {
    // Missing git, an unset name, failed configuration and a stalled lookup
    // all use the same OS identity without a prompt or startup refusal.
  }
  return userInfo().username;
}

/**
 * The endpoint describes startup; the UUID map gives each offered replica its
 * upstream. Preserve workspace spelling but admit by bare UUID. The document is
 * public and carries no key: a page with a session asks for room tokens.
 * servingConfigSource freezes destinations and updates only rebound, keeping
 * browser and replica identities aligned.
 */
function configDocument(
  hubUrl: string,
  serving: {
    remoteHubUrl: string;
    rebound: boolean;
    workspaces: readonly string[];
    servedWorkspaces: Record<string, { remoteHubUrl: string | null; name: string | null }>;
  },
  defaultPresenceName: string,
): string {
  return JSON.stringify({
    hubUrl,
    workspaces: serving.workspaces,
    hubAuthToken: "",
    remoteHubUrl: serving.remoteHubUrl,
    ...(serving.rebound ? { rebound: true } : {}),
    servedWorkspaces: serving.servedWorkspaces,
    defaultPresenceName,
  });
}

interface Binding {
  hubUrl: string;
  workspace: string | null;
  hubAuthToken: string;
  hubAdmission: string | null;
  deviceAdmission: boolean;
}

function bindingOf(resolved: ReturnType<typeof resolveConfig>): Binding {
  const hubUrl = trimmed(resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
  const deviceAdmission = usesDeviceLogin(hubUrl, resolved.env);
  return {
    hubUrl,
    workspace: trimmed(resolved.env.WORKSPACE_ID),
    hubAuthToken: deviceAdmission ? "" : trimmed(resolved.env.HUB_AUTH_TOKEN) ?? "",
    hubAdmission: trimmed(resolved.env.HUB_ADMISSION),
    deviceAdmission,
  };
}

function sameBinding(left: Binding, right: Binding): boolean {
  return (
    left.hubUrl === right.hubUrl &&
    left.workspace === right.workspace &&
    left.hubAdmission === right.hubAdmission &&
    // A login changes live device authority, not the served binding. Local
    // secret rotations still require restart while using local admission.
    (left.deviceAdmission || right.deviceAdmission || left.hubAuthToken === right.hubAuthToken)
  );
}

/**
 * Freeze startup destinations; a later binding change sets rebound until restart.
 * Re-resolve from the original environment: feeding resolved file values back
 * would turn them into permanent environment pins and hide binding changes.
 * Hold the writers' init lock across the atomic-file reads for one publication;
 * serve the last accepted value without waiting only while a writer holds it.
 */
function servingConfigSource(
  env: NodeJS.ProcessEnv,
  startup: ReturnType<typeof resolveConfig>,
  localHubUrl: string,
  workspaces: ReadonlyMap<string, ServedWorkspace>,
  defaultPresenceName: string,
): () => string {
  const binding = bindingOf(startup);
  const startupId = workspaces.keys().next().value;
  const destinations = {
    workspaces: [...workspaces.values()].map(entry => entry.workspace),
    servedWorkspaces: Object.fromEntries([...workspaces].map(([id, entry]) => [id, {
      name: entry.name,
      // The startup replica retains ensureHub's loopback behavior. Explicit
      // local-only secondaries have no upstream to name or start.
      remoteHubUrl: id === startupId ? binding.hubUrl : entry.binding.hubUrl,
    }])),
  };
  let accepted = configDocument(
    localHubUrl,
    { remoteHubUrl: binding.hubUrl, rebound: false, ...destinations },
    defaultPresenceName,
  );
  return () => {
    const lock = tryAcquireInitLock(env);
    if (lock === null) return accepted;
    try {
      const current = bindingOf(resolveConfig({ env }));
      accepted = configDocument(
        localHubUrl,
        { remoteHubUrl: binding.hubUrl, rebound: !sameBinding(binding, current), ...destinations },
        defaultPresenceName,
      );
      return accepted;
    } finally {
      lock.release();
    }
  };
}

function startupRefusal(error: unknown): string {
  if (error instanceof BindingResolutionError) {
    const recovery = error.reason === "missing"
      ? "ub workspace create <name>, or ub workspace use <link|id>"
      : "fix the binding, then run ub open again";
    return `${error.message}\n  → ${recovery}\n`;
  }
  if (error instanceof SigningSecretExposureError) {
    return `error: ${error.path} can be read by others (${error.permissions}), so its secret may have leaked\n` +
      `  → rm ${shellArgument(error.path)}, then ub open makes a new one\n`;
  }
  return `ub open: ${errorMessage(error)}\n`;
}

/** Resolve the startup binding under the writers' init lock. */
async function initialConfig(env: NodeJS.ProcessEnv, ensureSecret = false): Promise<{
  resolved: ReturnType<typeof resolveConfig>;
  secretCreated: string | null;
  detachGeneration: string | null;
}> {
  const lock = await acquireInitLock(env, { command: "ub open" });
  try {
    let resolved = resolveConfig({ env });
    if (resolved.binding === null) {
      throw new BindingResolutionError(resolved.bindingProblem ?? "no .uberblick.json here or in any parent directory", "missing");
    }
    const binding = requireBinding(resolved);
    assertWorkspaceBinding(binding, resolved.env, resolved.paths.projectConfig ?? "environment");
    let secretCreated: string | null = null;
    if (ensureSecret) {
      rememberWorkspaceBindings([binding], resolved.env);
      const hubUrl = trimmed(resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
      const endpoint = endpointOf(hubUrl);
      // A device-authenticated deployment stays external even on localhost.
      // A secret is useful only for an endpoint this command can start here.
      if (endpoint !== null && isLoopbackHost(endpoint.host) &&
          !usesDeviceLogin(hubUrl, resolved.env) &&
          whyNotStartable(hubUrl, new URL(hubUrl)) === null &&
          trimmed(resolved.env.HUB_AUTH_TOKEN) === null) {
        // Refuse an exposed store before looking for an existing local hub;
        // repairing its permissions would keep a possibly leaked secret.
        if (readCredentials(env).exposed) ensureLocalSigningSecret(env);
        // An occupied endpoint belongs to a hub or another process that this
        // command will leave alone. It needs none of our new credentials.
        if ((await probePort(endpoint.host, endpoint.port)).state === "free") {
          const secret = ensureLocalSigningSecret(env);
          if (secret.created) secretCreated = secret.path;
          resolved = resolveConfig({ env });
        }
      }
    }
    const databasePath = resolveMcpConfig(resolved.env).databasePath;
    return { resolved, secretCreated, detachGeneration: captureWorkspaceDetachGeneration(databasePath) };
  } finally {
    lock.release();
  }
}

interface Options {
  port: number;
  browser: boolean;
  verbose: boolean;
}

export const OPEN_OPTIONS = {
  "no-browser": { type: "boolean" },
  port: { type: "string" },
  verbose: { type: "boolean" },
} as const;

function openOptions({ values }: CommandArgs<typeof OPEN_OPTIONS>): Options {
  const raw = values.port;
  let port = DEFAULT_WEB_PORT;
  if (raw !== undefined) {
    port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      usageError(`--port must be an integer in 1..65535, got ${JSON.stringify(raw)}`);
    }
  }
  return { port, browser: !values["no-browser"], verbose: values.verbose ?? false };
}

/** What this command started, and is therefore responsible for stopping. */
interface Owned {
  hub: Hub | null;
  localServer: LocalBrowserServer | null;
  engine: UberblickMcpEngine | null;
  engineMonitor: EngineMonitor | null;
  replicas: BrowserReplicas | null;
  hubMonitor: { stop(): void } | null;
  updateCheck: UpdateCheck | null;
}

interface EngineMonitor {
  readonly failed: Promise<string>;
  failure(): string | null;
  stop(): void;
}

function openHubSource(engine: UberblickMcpEngine, hubUrl: string, env: NodeJS.ProcessEnv, deviceHub: boolean) {
  if (hubTransportProblem(hubUrl, env) !== null) return null;
  const sync = engine.replicas.sync;
  return {
    state: (): HubState => {
      const state = sync.state();
      if (state.authRecovery !== undefined) deviceHub = true;
      // A missing local login cannot establish whether the hub is reachable.
      if ((state.status === "connecting" || state.status === "hub-down") && missingHubLogin(hubUrl, env, deviceHub)) {
        return { ...state, status: "auth-failed", authRecovery: "sign-in-required" };
      }
      return state;
    },
    onStateChange: (listener: () => void) => sync.onStateChange(listener),
    deviceAuthenticated: () => deviceHub,
  };
}

function missingHubLogin(hubUrl: string, env: NodeJS.ProcessEnv, deviceHub: boolean): boolean {
  if (hubTransportProblem(hubUrl, env) !== null) return false;
  const workspace = trimmed(env.WORKSPACE_ID);
  return workspace !== null && deviceHub &&
    readDeviceLogin(hubUrl, workspace, env).status === "sign-in-required";
}

/** Both readings share the startup connection budget, including response bodies. */
async function openStartupReadings(
  sync: ReturnType<typeof openHubSource>,
  connectTimeoutMs: number,
  binding: AccessBinding,
) {
  return await Promise.all([
    sync === null ? null : waitForOpenHubState(sync, connectTimeoutMs),
    sync === null || !sync.deviceAuthenticated() || connectTimeoutMs <= 0 ? null
      : requestRecentDevices(binding, AbortSignal.timeout(Math.floor(connectTimeoutMs))).then(reading => reading?.devices ?? null),
  ]);
}

function monitorEngine(engine: UberblickMcpEngine): EngineMonitor {
  let failure: string | null = null;
  let wake!: (message: string) => void;
  const failed = new Promise<string>((resolve) => {
    wake = resolve;
  });
  const inspect = (): void => {
    if (failure !== null) return;
    const health = engine.health;
    const refresh = engine.refreshStatus;
    if (health.status === "quarantined") {
      failure = `local replica quarantined in ${health.room}: ${health.message}`;
    } else if (refresh.status === "failed") {
      failure = `local replica refresh failed: ${refresh.message}`;
    }
    if (failure !== null) wake(failure);
  };
  // Prime the pre-banner failure check; the interval has not fired yet.
  inspect();
  const timer = setInterval(inspect, 1_000);
  return {
    failed,
    failure: () => { inspect(); return failure; },
    stop: () => clearInterval(timer),
  };
}

interface Foreground {
  /** True once a signal has arrived. Checked between startup steps. */
  interrupted: () => boolean;
  /** Resolves on the first SIGINT or SIGTERM. */
  signalled: Promise<void>;
  /** Stop everything started so far, drop the handlers, and return `code`. */
  shutdown: (code: number) => Promise<number>;
}

/**
 * Install signal handlers before startup so Ctrl-C cannot skip a hub flush
 * between socket binds. Register owned resources as they start for partial teardown.
 */
function takeForeground(owned: Owned, io: Io): Foreground {
  let seen = false;
  let wake!: () => void;
  const signalled = new Promise<void>((done) => {
    wake = done;
  });
  const onSignal = (): void => {
    seen = true;
    wake();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const shutdown = async (code: number): Promise<number> => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    owned.engineMonitor?.stop();
    owned.hubMonitor?.stop();
    owned.updateCheck?.stop();
    let result = code;

    if (owned.localServer !== null) {
      try {
        await owned.localServer.stop();
      } catch (error) {
        io.err(`ub open: the browser server did not shut down cleanly: ${errorMessage(error)}\n`);
        result = 1;
      }
    }

    if (owned.replicas !== null || owned.engine !== null) {
      try {
        if (owned.replicas !== null) await owned.replicas.close();
        else await owned.engine?.close();
      } catch (error) {
        io.err(`ub open: the local replica did not shut down cleanly: ${errorMessage(error)}\n`);
        result = 1;
      }
    }
    if (owned.hub !== null) {
      try {
        // Every exit path must flush the owned hub before closing it.
        await owned.hub.stop();
      } catch (error) {
        io.err(`ub open: the hub did not shut down cleanly: ${errorMessage(error)}\n`);
        result = 1;
      }
    }
    return result;
  };

  return { interrupted: () => seen, signalled, shutdown };
}

export async function openCommand(
  args: CommandArgs<typeof OPEN_OPTIONS>,
  io: Io = processIo,
): Promise<number> {
  const options = openOptions(args);

  const serve = () => serveOpen(options, io);
  return options.verbose ? serve() : withLoggingDisabled(serve);
}

interface BrowserStartup {
  options: Options;
  io: Io;
  env: NodeJS.ProcessEnv;
  startupEnv: NodeJS.ProcessEnv;
  projectBinding: ReturnType<typeof requireBinding>;
  resolved: ReturnType<typeof resolveConfig>;
  detachGeneration: string | null;
  presenceName: string;
  root: string;
  servedUrl: URL;
  owned: Owned;
}

async function startBrowserServer(startup: BrowserStartup) {
  const { options, io, env, startupEnv, projectBinding, resolved, detachGeneration,
    presenceName, root, servedUrl, owned } = startup;
  const mcpConfig = resolveMcpConfig(env);
  const lock = await acquireInitLock(startupEnv, { command: "ub open" });
  let starting: Promise<UberblickMcpEngine>;
  try {
    if (captureWorkspaceDetachGeneration(mcpConfig.databasePath) !== detachGeneration) {
      throw new Error("The workspace was detached while ub open was starting. Restart ub open to use its current selection.");
    }
    assertWorkspaceBinding(projectBinding, startupEnv, resolved.paths.projectConfig ?? "environment");
    // The engine takes its serving role synchronously before its first await,
    // preventing detach from passing after this final selection check.
    starting = createMcpEngine(mcpConfig, { serving: true });
  } finally { lock.release(); }
  const engine = await starting;
  owned.engine = engine;
  const engineMonitor = monitorEngine(engine);
  owned.engineMonitor = engineMonitor;
  const workspaces = browserWorkspaces(projectBinding, mcpConfig, startupEnv,
    message => io.err(`ub: warning: ${message}\n`));
  const authenticateApi = await createApiAuthenticator(workspaces);
  const access = await createBrowserAccess(new Map([...workspaces].map(([id, entry]) => [id, entry.browserKey])), startupEnv);
  const document = servingConfigSource(
    startupEnv,
    resolved,
    `ws://${WEB_HOST}:${options.port}`,
    workspaces,
    presenceName,
  );
  const observedServedRooms = new Set<string>();
  let collectingServedRooms: Set<string> | null = null;
  let localServer: LocalBrowserServer | null = null;
  const replicas = new BrowserReplicas(workspaces, engine, workspaceId => localServer?.refresh(workspaceId));
  owned.replicas = replicas;
  // Only an installed copy can follow the banner's advice to run ub update.
  const updateCheck = isInstallPayload() ? startUpdateCheck(cliVersion()) : null;
  owned.updateCheck = updateCheck;
  const status = (workspaceId: string): ServingSyncStatus => {
    if (localServer !== null) {
      const current = new Set<string>();
      collectingServedRooms = current;
      try {
        // Synchronous refresh/read callbacks collect exactly this workspace's
        // loaded rooms, including directory and sidebar, for this status cut.
        localServer.refresh(workspaceId);
      } finally {
        collectingServedRooms = null;
      }
      observedServedRooms.clear();
      for (const room of current) observedServedRooms.add(room);
    }
    return collectServingSyncStatus(replicas.read(workspaceId), [...observedServedRooms].filter(room => parseRoom(room).workspaceId === workspaceId));
  };
  const engineForRoom = (room: string): UberblickMcpEngine => {
    const { workspaceId, uuid } = parseRoom(room);
    const engine = replicas.read(workspaceId);
    engine.replicas.assertNotDeleted(uuid);
    return engine;
  };
  localServer = await createLocalBrowserServer({
    ...(!options.verbose ? { log: silentLogger } : {}),
    port: options.port,
    workspaces: new Map([...workspaces].map(([id, entry]) => [id, entry.browserKey])),
    expectedOrigin: servedUrl.origin,
    prepareRoom: async room => {
      await replicas.prepare(parseRoom(room).workspaceId);
      engineForRoom(room);
    },
    assertRoomAvailable: room => { engineForRoom(room); },
    readRoom: (room, afterSeq) => {
      (collectingServedRooms ?? observedServedRooms).add(room);
      return engineForRoom(room).store.readSince(room, afterSeq);
    },
    takeSettingsResetNotice: (room, seq) => engineForRoom(room).store.takeSettingsResetNotice(seq),
    appendUpdate: (room, payload, settingsResetSeq) => {
      const engine = engineForRoom(room);
      engine.store.appendUpdate(room, payload, "local", settingsResetSeq,
        engine.replicas.createUpdateOrigin({ kind: "browser", name: "browser" }));
    },
    awarenessForRoom: (room) => {
      const engine = engineForRoom(room);
      const { uuid } = parseRoom(room);
      if (uuid === DIRECTORY_SUFFIX) return engine.replicas.directory().awareness;
      if (uuid === SIDEBAR_SUFFIX) return engine.replicas.sidebar().awareness;
      return engine.replicas.replica(uuid).awareness;
    },
    onRequest: (request, response) => {
      serveBoundRequest({
        expectedHost: servedUrl.host,
        root,
        document,
        authenticate: authenticateApi,
        replicas,
        statusForWorkspace: status,
        availableUpdate: () => updateCheck?.available() ?? null,
        env: startupEnv,
        expectedOrigin: servedUrl.origin,
        access,
        request,
        response,
      });
    },
  });
  owned.localServer = localServer;
  return { access, engine, engineMonitor };
}

async function serveOpen(options: Options, io: Io): Promise<number> {
  // Retain the original environment for refreshes; resolved file values are not pins.
  const startupEnv: NodeJS.ProcessEnv = { ...process.env };
  let initial: Awaited<ReturnType<typeof initialConfig>>;
  try {
    initial = await initialConfig(startupEnv);
  } catch (error) {
    if (!(error instanceof BindingResolutionError)) throw error;
    io.err(startupRefusal(error));
    return 1;
  }
  let projectBinding = requireBinding(initial.resolved);
  const warnings = initial.resolved.warnings;
  const exposureWarning = initial.resolved.credentialExposure?.message;
  const printWarnings = (excludeExposure = false): void => {
    for (const warning of warnings) {
      if (!excludeExposure || warning !== exposureWarning) io.err(`ub: warning: ${warning}\n`);
    }
  };
  // Share the MCP client's default endpoint rather than defining another.
  let hubUrl = trimmed(initial.resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
  let env: NodeJS.ProcessEnv = { ...initial.resolved.env, HUB_URL: hubUrl };

  const owned: Owned = {
    hub: null,
    localServer: null,
    engine: null,
    engineMonitor: null,
    replicas: null,
    hubMonitor: null,
    updateCheck: null,
  };
  const foreground = takeForeground(owned, io);
  let hubNote = "";
  let showHubNote = false;
  let hubDeviceAuthenticated = false;

  const plan = bundlePlan(env);
  // Before ensureHub: a bundle refusal starts no hub and creates no database.
  const bundle = ensureBundle(plan, io);
  if (bundle === "refused") {
    printWarnings();
    return await foreground.shutdown(1);
  }
  // Freeze the cwd's default for this run, just as the served binding is frozen.
  const presenceName = await defaultPresenceName(startupEnv);
  if (foreground.interrupted()) {
    printWarnings();
    return await foreground.shutdown(0);
  }

  try {
    initial = await initialConfig(startupEnv, true);
    projectBinding = requireBinding(initial.resolved);
    hubUrl = trimmed(initial.resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
    env = { ...initial.resolved.env, HUB_URL: hubUrl };
    const decided = await ensureHub(env, hubUrl, projectBinding.workspaceId, io, options.verbose);
    owned.hub = decided.started;
    hubNote = decided.note;
    showHubNote = decided.showNote ?? false;
    hubDeviceAuthenticated = decided.deviceHub ?? usesDeviceLogin(hubUrl, env);
  } catch (error) {
    printWarnings(error instanceof SigningSecretExposureError);
    io.err(startupRefusal(error));
    return await foreground.shutdown(1);
  }
  printWarnings();
  if (foreground.interrupted()) {
    return await foreground.shutdown(0);
  }

  const servedUrl = new URL(`http://${WEB_HOST}:${options.port}/`);
  let serving: Awaited<ReturnType<typeof startBrowserServer>>;
  try {
    serving = await startBrowserServer({
      options, io, env, startupEnv, projectBinding, resolved: initial.resolved,
      detachGeneration: initial.detachGeneration,
      presenceName, root: plan.dir, servedUrl, owned,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof ServingReplicaHeldError) {
      io.err(
        `ub open: workspace ${readWorkspaceName(error.databasePath, projectBinding.workspaceId) ?? projectBinding.workspaceId} ` +
        `is already open in another \`ub open\` (process ${error.holder.pid}). Stop that one first, or keep using it.\n`,
      );
      if (options.verbose) io.err(`ub open: another \`ub open\` is already serving this store: ${errorMessage(error)}\n`);
    } else if (code === "EADDRINUSE") {
      io.err(portTakenMessage(options.port, await whoHoldsPort(options.port)));
    } else {
      io.err(`ub open: could not serve on port ${options.port}: ${errorMessage(error)}\n`);
    }
    return await foreground.shutdown(1);
  }

  if (foreground.interrupted()) {
    return await foreground.shutdown(0);
  }

  const { access, engine, engineMonitor } = serving;
  // The fragment never reaches a server; the page trades it once for a session.
  const url = `${servedUrl.href}#launch=${access.launch.value}`;
  const sync = openHubSource(engine, hubUrl, env, hubDeviceAuthenticated);
  const connectTimeoutMs = engine.replicas.config.connectTimeoutMs;
  const [hubState, recentDevices] = await openStartupReadings(sync, connectTimeoutMs, { ...projectBinding, env });
  if (foreground.interrupted()) return await foreground.shutdown(0);
  const earlyFailure = engineMonitor.failure();
  if (earlyFailure !== null) {
    io.err(`ub open: ${earlyFailure}\n`);
    return await foreground.shutdown(1);
  }
  const deviceHub = sync?.deviceAuthenticated() ?? hubDeviceAuthenticated;
  const transport = hubTransportProblem(hubUrl, env);
  const hubSignInRequired = missingHubLogin(hubUrl, env, deviceHub);
  const unreachable = !hubSignInRequired && hubState?.status === "hub-down";
  io.out(openBanner({
    url, verbose: options.verbose, secretCreated: initial.secretCreated,
    binding: projectBinding, databasePath: engine.replicas.config.databasePath,
    hubNote, signInRequired: hubSignInRequired, showHubNote,
    deviceHub, hubUrl, hubState, recentDevices, transportProblem: transport,
  }));
  if (sync !== null) {
    owned.hubMonitor = monitorOpenHub(sync, displayWorkspaceHub(hubUrl), text => io.err(text), {
      unreachableAtStart: unreachable,
      notSignedInAtStart: hubSignInRequired,
    });
  }

  if (options.browser) {
    openBrowser(url, env, io);
  }

  let exitCode = 0;
  const failure = await Promise.race([
    foreground.signalled.then(() => null),
    engineMonitor.failed,
  ]);
  if (failure !== null) {
    io.err(`ub open: ${failure}\n`);
    exitCode = 1;
  }

  // Ctrl-C stops what this command started, and only that: a hub somebody else
  // was already running was never registered as owned, so it is still there.
  return await foreground.shutdown(exitCode);
}
