/**
 * The e2e bootstrap: one real hub, the built bundle and one real `ub open`.
 *
 * Nothing here is a test double. The proof points these tests exist for —
 * convergence between two live clients, rendered remote cursors, and reloads
 * receiving only what their server sends — only mean something against the real transport
 * and the real bundle, which is also why they are not in the jsdom suite.
 *
 * Two things are deliberate:
 *
 * - **Run-owned everything.** The hub binds `port: 0`; databases and
 *   XDG homes live below private temporary directories; and `ub open` gets a freshly
 *   selected web port. A bind race is retried, so another e2e run or
 *   `mise run dev` cannot collide with this one.
 *
 * - **The production path.** Global setup builds the checkout's current sources
 *   once into a private directory, then every `ub open` serves them and its real
 *   `/uberblick-config.json`. The harness writes the project binding and private
 *   credential store, and removes inherited configuration pins before spawning
 *   it, so no developer machine state can steer the run.
 *   Direct-upstream proofs use the same bundle behind a same-origin socket
 *   proxy, so they bypass the local replica under the shared enforced policy.
 *
 * The upstream hub is startable and stoppable on its own: the local-first
 * proof point needs it gone while `ub open` and the browser stay up, then back
 * on the same port and database so the silent replica can converge to a
 * restarted upstream rather than a fresh one.
 */

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { silentLogger } from "@uberblick/hub";
import { createTeamHub as createHub } from "@uberblick/hub/team";
import type { TeamHub as Hub } from "@uberblick/hub/team";
import type { TeamHubConfig as HubConfig } from "@uberblick/hub/team-config";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { resolveStorage } from "@uberblick/mcp-server/storage";
import { getBlocks, getWorkspaceMainRepository, getWorkspaceName, listTagCatalog, seedTagCatalog, settingsRoom } from "@uberblick/schema";
import { WEB_CONTENT_SECURITY_POLICY } from "@uberblick/schema/web-policy";
import { preview } from "vite";
import type { PreviewServer } from "vite";
import { LOCAL_SESSION_KEY } from "../src/collab/local-session.js";
import { buildAppBundle, sharedAppBundle } from "./bundle.js";
import { activateControl } from "./input-helpers.js";

/**
 * The hub's HMAC signing secret for the run. Not a secret in any sense worth
 * protecting: this hub exists for the length of one test file.
 */
const SECRET = "uberblick-e2e-hub-secret";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const UB = join(repoRoot, "packages", "cli", "test", "source-ub.mjs");

const OPEN_ATTEMPTS = 5;
const OPEN_READY_MS = 30_000;
const OPEN_STOP_MS = 5_000;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("e2e: the web port probe reported no TCP address"));
        return;
      }
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
}

function exited(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = exited(child);
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), OPEN_STOP_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!stopped) {
    child.kill("SIGKILL");
    await exit;
  }
}

function openEnvironment(runDir: string, bundleDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["HOME", "HUB_AUTH_TOKEN", "HUB_URL", "WORKSPACE_ID", "WORKSPACES", "UB_WORKSPACE_ID", "UB_HUB_URL"]) {
    delete env[key];
  }
  env.HOME = runDir;
  env.XDG_CONFIG_HOME = join(runDir, "config");
  env.XDG_DATA_HOME = join(runDir, "data");
  env.XDG_STATE_HOME = join(runDir, "state");
  env.UBERBLICK_WEB_DIST = bundleDir;
  env.BROWSER = "none";
  return env;
}

/** Sessions of the `ub open` runs this worker serves, by origin. */
const sessions = new Map<string, string>();
const unauthorizedNewContext = new Map<Browser, Browser["newContext"]>();

async function withSessions(context: BrowserContext): Promise<void> {
  await context.addInitScript(({ entries, key }) => {
    const session = new Map(entries).get(location.origin);
    if (session !== undefined) localStorage.setItem(key, session);
  }, { entries: [...sessions], key: LOCAL_SESSION_KEY });
}

/**
 * A person opens the printed address once per browser; a test makes many
 * fresh contexts. Each harness trades its launch secret once, and every
 * context this browser holds or creates starts with that origin's session.
 */
export async function authorizeBrowser(browser: Browser): Promise<void> {
  if (!unauthorizedNewContext.has(browser)) {
    const create = browser.newContext.bind(browser);
    unauthorizedNewContext.set(browser, create);
    browser.once("disconnected", () => unauthorizedNewContext.delete(browser));
    browser.newContext = async (options) => {
      const context = await create(options);
      await withSessions(context);
      return context;
    };
  }
  await Promise.all(browser.contexts().map(withSessions));
}

/** A context that has never opened the printed address. */
export async function unauthorizedContext(browser: Browser, options?: BrowserContextOptions): Promise<BrowserContext> {
  return await (unauthorizedNewContext.get(browser) ?? browser.newContext.bind(browser))(options);
}

async function tradeLaunch(appUrl: string, launch: string): Promise<string> {
  const response = await fetch(new URL("api/session", appUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(appUrl).origin },
    body: JSON.stringify({ launch }),
  });
  const session = (await response.json() as { session?: unknown }).session;
  if (typeof session !== "string") throw new Error(`e2e: ub open refused its own launch secret (${response.status})`);
  sessions.set(new URL(appUrl).origin, session);
  await Promise.all([...unauthorizedNewContext.keys()].flatMap((browser) => browser.contexts().map(withSessions)));
  return session;
}

async function startOpen(
  runDir: string,
  bundleDir: string,
  fixedPort?: number,
  projectDir = runDir,
): Promise<{ child: ChildProcessWithoutNullStreams; appUrl: string; printed: string }> {
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt += 1) {
    const port = fixedPort ?? await freePort();
    const child = spawn(process.execPath, [UB, "open", "--no-browser", "--port", String(port)], {
      cwd: projectDir,
      env: openEnvironment(runDir, bundleDir),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      new Promise<"ready">((resolveReady) => {
        const inspect = (): void => {
          if (stdout.includes(`web        http://127.0.0.1:${port}/`)) resolveReady("ready");
        };
        child.stdout.on("data", inspect);
        inspect();
      }),
      exited(child).then(() => "exit" as const),
      new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), OPEN_READY_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome === "ready") {
      const printed = new RegExp(`^web {8}(http://127\\.0\\.0\\.1:${port}/#launch=[A-Za-z0-9_-]{43})$`, "m").exec(stdout)?.[1];
      if (printed === undefined) {
        await stopChild(child);
        throw new Error(`e2e: ub open printed no launch address\nstdout:\n${stdout}`);
      }
      return { child, appUrl: `http://127.0.0.1:${port}/`, printed };
    }
    await stopChild(child);
    if (fixedPort === undefined && outcome === "exit" && stderr.includes(`port ${port} is in use`) && attempt < OPEN_ATTEMPTS) {
      continue;
    }
    throw new Error(
      `e2e: ub open ${outcome === "timeout" ? "did not become ready" : "exited during startup"}` +
        `\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  throw new Error("e2e: ub open exhausted its web-port retries");
}

export type HubTextHistory = {
  readings: { text: string; authenticated: boolean }[];
  stop(): void;
};

export interface Harness {
  /** Public fixture identities for access-control browser proofs. */
  readonly access?: { otherDeviceId: string; legacyDeviceId: string; foreignDeviceId: string; deviceName: string };
  /** Remove the browser account's hub role while its devices and memberships stay. */
  removeCurrentHubAdmin(): void;
  changeCurrentWorkspaceRole(role: "member" | "admin"): void;
  changeOtherMemberUsername(username: string): string;
  /** Where the browser goes. This run's real `ub open` address. */
  readonly appUrl: string;
  /** The address the latest `ub open` start printed; its launch secret is unused after a restart. */
  printedUrl(): string;
  /** Same-origin bundle and socket proxy that bypasses the serving replica. */
  upstreamAppUrl(): Promise<string>;
  /**
   * The upstream address for Node and MCP clients. Browser fixtures reach this
   * hub through their same-origin socket route under the shared web policy.
   */
  readonly hubUrl: string;
  /**
   * The signing secret this run's hub accepts, for a test that has to connect a
   * client of its own — an agent session, say, which is not something a browser
   * context can stand in for.
   */
  readonly authSecret: string;
  /** The workspace the served runtime document names — what `/` redirects to. */
  readonly workspace: string;
  /** The same workspace, bare. Room keys and token claims carry only this. */
  readonly workspaceUuid: string;
  /** The other workspace on the switcher's menu. Empty until something writes. */
  readonly secondWorkspace: string;
  /** Present when the fixture records a second replica on its own hub. */
  readonly secondHubUrl?: string;
  /** Inspect public document content received by one of the fixture hubs. */
  hubText(room: string, secondary?: boolean): string | null;
  hubWorkspaceSettings(): { name: string | null; mainRepository: string | null; tags: string[] } | null;
  /** Observe completed refusal recovery without connecting a browser that claims its notice. */
  localSettingsReset(): { seq: number; notice: string } | null;
  /** Record upstream admission synchronously across local credential changes. */
  observeHubText(room: string): HubTextHistory;
  /** Verify browser navigation left the project's startup binding untouched. */
  projectBinding(): { workspaceId: string; hubUrl: string };
  /** Start the upstream hub again — same port, same database. */
  startHub(): Promise<void>;
  /** Flush and stop upstream, leaving `ub open` and the browser alone. */
  stopHub(): Promise<void>;
  /** Stop local serving while retaining this machine's credentials and replica. */
  stopOpen(): Promise<void>;
  /** Restart local serving on the same address after changing hub credentials. */
  restartOpen(options: { authenticated: boolean }): Promise<void>;
  /** Serve the second project on another port using the same machine's replicas. */
  startSecondOpen(): Promise<{ appUrl: string; stop(): Promise<void> }>;
  /** Change this computer's login while the same local serving process runs. */
  setStoredLogin(authenticated: boolean): void;
  /** Rebind project configuration without replacing the served workspace. */
  rebindProject(hubUrl: string): void;
  /** Tear down this harness's hub, serving process and temp database. */
  stop(): Promise<void>;
}

/** Open the served bundle against the harness's upstream hub. */
export async function openUpstreamApp(
  browser: Browser,
  running: Pick<Harness, "upstreamAppUrl" | "workspace" | "authSecret">,
  path = "/",
  options: {
    contextOptions?: BrowserContextOptions;
    workspaces?: string[];
    beforeNavigate?: (page: Page) => Promise<void>;
    readySelector?: string | null;
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const appUrl = await running.upstreamAppUrl();
  const context = await browser.newContext(options.contextOptions);
  try {
    await context.route("**/uberblick-config.json", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          hubUrl: `${appUrl.replace("http:", "ws:")}ws`,
          workspaces: options.workspaces ?? [running.workspace],
          hubAuthToken: running.authSecret,
        }),
      });
    });
    const page = await context.newPage();
    await options.beforeNavigate?.(page);
    await page.goto(new URL(path, appUrl).href);
    const readySelector = options.readySelector === undefined ? ".ub-document-sidebar" : options.readySelector;
    if (readySelector !== null) await expect(page.locator(readySelector)).toBeVisible();
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/**
 * Caret keys under the host's native key bindings, which Playwright applies to
 * desktop browsers. On macOS Home and End scroll the document, and Shift+Home
 * and Shift+End select to its edges; Command+Arrow moves instead.
 */
const mac = process.platform === "darwin";
export const keys = {
  lineStart: mac ? "Meta+ArrowLeft" : "Home",
  lineEnd: mac ? "Meta+ArrowRight" : "End",
  documentStart: mac ? "Meta+ArrowUp" : "Control+Home",
} as const;

/** A native caret may end at a text offset or an element's child boundary. */
export function caretAtEdge(element: Element, edge: "start" | "end" = "end"): boolean {
  const owner = element.ownerDocument;
  const selection = owner.getSelection();
  const anchor = selection?.anchorNode;
  const root = element.closest(".ProseMirror");
  if (!selection?.isCollapsed || anchor === null || anchor === undefined || !element.contains(anchor)
    || root === null || !root.contains(owner.activeElement)) return false;
  const outside = owner.createRange();
  outside.selectNodeContents(element);
  if (edge === "start") outside.setEnd(anchor, selection.anchorOffset);
  else outside.setStart(anchor, selection.anchorOffset);
  const copy = outside.cloneContents();
  for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
  return copy.textContent === "";
}

/** Settle pending menu focus restoration and ProseMirror's 20ms focus sync. */
async function settleEditorFocus(target: Locator): Promise<void> {
  await expect.poll(async () => {
    await target.evaluate((element) => {
      const root = element.closest(".ProseMirror");
      if (!(root instanceof HTMLElement)) throw new Error("e2e: caret target has no editor");
      root.focus();
    });
    // Radix can still return focus after its menu has disappeared. Reconcile
    // that lifecycle before placing a caret, without repeating native input.
    await target.page().evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    return target.evaluate((element) => {
      const root = element.closest(".ProseMirror");
      return root?.classList.contains("ProseMirror-focused") === true && root.contains(element.ownerDocument.activeElement);
    });
  }).toBe(true);
}

/** Explicit targets avoid click-count selections; WebKit lacks Home/End semantics. */
async function positionCaret(target: Locator, edge: "start" | "end", explicit = false): Promise<void> {
  const page = target.page();
  if (explicit || page.context().browser()?.browserType().name() === "webkit") {
    await target.evaluate((element, at) => {
      const owner = element.ownerDocument;
      const range = owner.createRange();
      // A td/th child boundary can normalize into the next cell. Keep the
      // native range inside its paragraph, as a person's caret would be.
      const block = element.matches("th, td")
        ? element.querySelector(at === "start" ? ":scope > p:first-child" : ":scope > p:last-child") ?? element
        : element;
      range.selectNodeContents(block);
      range.collapse(at === "start");
      const selection = owner.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, edge);
    // A non-moving native key flushes this selection into ProseMirror before
    // the test sends its actual input. End can move a triple-click selection
    // into the following paragraph/cell instead of placing this target's caret.
    await page.keyboard.press("Shift");
  } else await page.keyboard.press(edge === "start" ? keys.lineStart : keys.lineEnd);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

/** Settle editor focus before delivering the native caret-placement gesture. */
export async function placeCaretIn(target: Locator, options: { touch?: boolean; edge?: "start" | "end" } = {}): Promise<void> {
  await settleEditorFocus(target);
  await activateControl(target, { touch: options.touch });
  const edge = options.edge ?? "end";
  await positionCaret(target, edge, true);
  try { await expect.poll(() => target.evaluate(caretAtEdge, edge)).toBe(true); }
  catch (error) {
    const state = await target.evaluate((element) => {
      const selection = element.ownerDocument.getSelection();
      return { focus: element.ownerDocument.activeElement?.outerHTML.slice(0, 350),
        target: element.outerHTML.slice(0, 350), anchor: selection?.anchorNode?.parentElement?.outerHTML.slice(0, 350),
        anchorType: selection?.anchorNode?.nodeName, offset: selection?.anchorOffset, collapsed: selection?.isCollapsed };
    });
    throw new Error(`e2e: caret did not settle: ${JSON.stringify(state)}`, { cause: error });
  }
}

/**
 * Focus the editor and put its caret at one end of the first text line.
 *
 * ProseMirror groups nearby clicks into double and triple clicks even when a
 * driver issues each click separately. Reusing a coordinate to place a caret
 * can therefore select the whole block and make the next keystroke replace it.
 * Keyboard placement avoids that gesture state entirely.
 */
export async function placeCaret(page: Page, edge: "start" | "end" = "end"): Promise<void> {
  const editor = page.locator(".ub-editor .ProseMirror");
  await expect
    .poll(async () => {
      await settleEditorFocus(editor);
      const block = editor.locator(":scope > *").first();
      await positionCaret(block, edge);
      return block.evaluate(caretAtEdge, edge);
    })
    .toBe(true);
}

export async function startHarness(options: {
  accessRole?: "admin" | "member" | "none";
  hubAdmin?: boolean;
  /** An authored example vocabulary; defaults to generic rendering fixtures only. */
  seedExampleTags?: boolean;
  /** Keep a real stored hub login while serving an entirely local workspace. */
  localWorkspace?: boolean;
  /** A real git default isolated from the developer's own configuration. */
  gitUserName?: string;
  /** Only the deep-link proof of a compiled loopback fallback needs this. */
  compiledFallback?: boolean;
  /** Offer a real on-machine replica backed by a separate authenticated hub. */
  multiWorkspace?: boolean;
  /** Offer a healthy second replica that stays entirely on this device. */
  localReplica?: boolean;
} = {}): Promise<Harness> {
  const startupStarted = performance.now();
  const shared = sharedAppBundle();
  const runDir = mkdtempSync(join(tmpdir(), `uberblick-e2e-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  const bundleDir = options.compiledFallback === true ? join(runDir, "bundle") : shared.directory;
  // Fresh and decorated per harness: room keys stay isolated, while `/`
  // exercises the spelling a person would actually configure.
  const workspaceUuid = randomUUID();
  const workspace = `uberblick-${workspaceUuid}`;
  // Nothing creates the second workspace: its rooms begin existing when the
  // switcher proof opens them, which is the real light-multi-workspace model.
  let secondWorkspace = `research-${randomUUID()}`;
  const accessRole = options.accessRole ?? (options.multiWorkspace === true ? "admin" : undefined);
  const config: HubConfig = {
    authSecret: SECRET,
    port: 0,
    databasePath: join(runDir, "hub.sqlite"),
    log: silentLogger,
    // Short: a test that stops the hub should not have to wait out a 2s
    // debounce to know its writes are durable.
    debounce: 200,
    maxDebounce: 1_000,
    shutdownTimeoutMs: 5_000,
    ...(accessRole === undefined ? {} : {
      github: { clientId: "Iv1.0123456789abcdef", fetch: async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith("/users/missing-user")) return Response.json({}, { status: 404 });
        if (url.endsWith("/users/rate-limited")) return Response.json({}, { status: 429 });
        if (url.endsWith("/users/new-agent") || url.endsWith("/user/9001")) {
          return Response.json({ id: 9001, login: "new-agent", type: "User" });
        }
        throw new Error("Unexpected GitHub request in access browser fixture");
      } },
    }),
  };

  let hub: Hub | null = null;
  let secondHub: Hub | null = null;
  let open: ChildProcessWithoutNullStreams | null = null;
  let secondOpen: ChildProcessWithoutNullStreams | null = null;
  let secondProject: string | null = null;
  let upstreamPreview: Promise<PreviewServer> | undefined;

  // One failure boundary for the whole bootstrap, the temp directory included:
  // a harness that did not finish starting must leave nothing behind — no
  // listening socket, no stray database — and must surface its own error rather
  // than a cleanup error on top of it.
  try {
    if (options.gitUserName !== undefined) {
      const configured = spawnSync("git", ["config", "--file", join(runDir, ".gitconfig"), "user.name", options.gitUserName], {
        env: openEnvironment(runDir, bundleDir),
        encoding: "utf8",
      });
      if (configured.status !== 0) throw new Error("e2e: could not configure the fixture's git display name");
    }
    hub = await createHub(config, accessRole === undefined ? {} : { deviceCredentials: true });
    // Rendering fixtures own their example vocabulary; hub clients do not seed it.
    if (options.seedExampleTags ?? (accessRole === undefined)) {
      const catalog = await hub.hocuspocus.openDirectConnection(settingsRoom(workspaceUuid));
      try { await catalog.transact(document => { seedTagCatalog(document); }); }
      finally { await catalog.disconnect(); }
    }
    // Every later start reuses the port the first one was given, so the served
    // HUB_URL keeps pointing at the hub across a restart.
    const port = hub.port;

    const hubUrl = `ws://127.0.0.1:${port}`;
    const configDir = join(runDir, "config", "uberblick");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(runDir, ".uberblick.json"),
      `${JSON.stringify({ workspaceId: workspace, hubUrl: options.localWorkspace === true ? null : hubUrl }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const credentials = join(configDir, "credentials.json");
    let storedCredentials: unknown = { signingSecret: SECRET };
    let access: Harness["access"];
    if (accessRole !== undefined) {
      const { principals, memberships, credentials: registry, hubAdmins } = hub;
      if (principals === undefined || memberships === undefined || registry === undefined) {
        throw new Error("Access browser fixture needs GitHub registries");
      }
      const principal = principals.identify("1234", "browser-person");
      if (accessRole !== "none") memberships.grant({ workspaceId: workspaceUuid, principalId: principal.id, role: accessRole });
      const foreign = principals.identify("5678", "other-admin");
      memberships.grant({ workspaceId: workspaceUuid, principalId: foreign.id, role: "admin" });
      if (options.hubAdmin === true) {
        if (hubAdmins === undefined) throw new Error("Hub admin browser fixture needs the hub registry");
        hubAdmins.grant(principal.id);
        hubAdmins.grant(foreign.id);
      }
      const issue = (principalId: string, deviceName?: string) => issueCredential(registry, { principalId, deviceId: randomUUID(),
        workspaces: principalId === principal.id && accessRole === "none" ? [] : [workspaceUuid], ...(deviceName === undefined ? {} : { deviceName }) });
      const deviceName = "browser-laptop";
      const current = issue(principal.id, deviceName);
      const other = issue(principal.id, deviceName);
      const legacy = issue(principal.id);
      const foreignDevice = issue(foreign.id, "private-foreign-device");
      const { replacedAt: _replaced, ...record } = current.record;
      storedCredentials = { hubLogins: { [`http://127.0.0.1:${port}`]: {
        identity: principal, credential: { record, key: Buffer.from(current.keyBytes).toString("base64url") },
      } } };
      access = { otherDeviceId: other.record.deviceId, legacyDeviceId: legacy.record.deviceId,
        foreignDeviceId: foreignDevice.record.deviceId, deviceName };
    }
    let secondHubUrl: string | undefined;
    if (options.multiWorkspace === true || options.localReplica === true) {
      // Use the real CLI to create a healthy on-machine replica before serving.
      // Its separate project leaves the startup project's binding untouched.
      const project = join(runDir, "second-project");
      secondProject = project;
      mkdirSync(project);
      const created = spawnSync(process.execPath, [UB, "workspace", "create", "Second workspace"], {
        cwd: project, env: openEnvironment(runDir, bundleDir), encoding: "utf8", timeout: OPEN_READY_MS,
      });
      if (created.status !== 0) throw new Error(`e2e: second replica creation failed\n${created.stderr}`);
      const binding = JSON.parse(readFileSync(join(project, ".uberblick.json"), "utf8")) as { workspaceId: string };
      secondWorkspace = binding.workspaceId;
      if (options.multiWorkspace === true) {
        secondHub = await createHub({ ...config, databasePath: join(runDir, "second-hub.sqlite") }, { deviceCredentials: true });
        secondHubUrl = `ws://127.0.0.1:${secondHub.port}`;
        writeFileSync(join(project, ".uberblick.json"),
          `${JSON.stringify({ workspaceId: secondWorkspace, hubUrl: secondHubUrl }, null, 2)}\n`, { mode: 0o600 });
        const { principals, memberships, credentials: registry } = secondHub;
        if (principals === undefined || memberships === undefined || registry === undefined) throw new Error("Second hub needs device registries");
        const principal = principals.identify("4321", "second-person");
        memberships.grant({ workspaceId: secondWorkspace, principalId: principal.id, role: "admin" });
        const issued = issueCredential(registry, { principalId: principal.id, deviceId: randomUUID(), workspaces: [secondWorkspace] });
        const { replacedAt: _replaced, ...record } = issued.record;
        const logins = storedCredentials as { hubLogins: Record<string, unknown> };
        logins.hubLogins[`http://127.0.0.1:${secondHub.port}`] = {
          identity: principal, credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") },
        };
        // This fixture represents a replica already fetched from that hub.
        writeFileSync(join(configDir, "workspaces.json"), `${JSON.stringify({
          [workspaceUuid]: hubUrl, [secondWorkspace]: secondHubUrl,
        }, null, 2)}\n`, { mode: 0o600 });
      }
    }
    writeFileSync(credentials, `${JSON.stringify(storedCredentials, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(credentials, 0o600);

    let authenticated = true;
    const credentialObservers = new Set<() => void>();
    const setStoredLogin = (available: boolean): void => {
      authenticated = available;
      if (!available) {
        rmSync(credentials, { force: true });
      } else {
        writeFileSync(credentials, `${JSON.stringify(storedCredentials, null, 2)}\n`, { mode: 0o600 });
        chmodSync(credentials, 0o600);
      }
      for (const record of credentialObservers) record();
    };

    if (options.compiledFallback === true) {
      await buildAppBundle({ directory: bundleDir, hubUrl, workspace });
    }
    const serving = await startOpen(runDir, bundleDir);
    open = serving.child;
    const appUrl = serving.appUrl;
    let printed = serving.printed;
    await tradeLaunch(appUrl, new URL(printed).hash.slice("#launch=".length));
    console.log(`e2e timing: harness startup ${Math.round(performance.now() - startupStarted)} ms`);

    const stopHub = async (): Promise<void> => {
      if (hub === null) return;
      const running = hub;
      hub = null;
      await running.stop();
    };
    const stopOpen = async (): Promise<void> => {
      const child = open;
      open = null;
      if (child !== null) await stopChild(child);
    };

    return {
      ...(access === undefined ? {} : { access }),
      appUrl,
      printedUrl: () => printed,
      async upstreamAppUrl() {
        upstreamPreview ??= preview({ configFile: false, root: packageRoot, logLevel: "error",
          build: { outDir: bundleDir }, preview: { port: 0, host: "127.0.0.1", strictPort: true,
            headers: { "Content-Security-Policy": WEB_CONTENT_SECURITY_POLICY },
            proxy: { "/ws": { target: hubUrl, ws: true } } } });
        const serving = await upstreamPreview;
        const address = serving.httpServer.address();
        if (address === null || typeof address === "string") throw new Error("e2e: upstream preview has no TCP address");
        return `http://127.0.0.1:${address.port}/`;
      },
      hubUrl,
      authSecret: SECRET,
      workspace,
      workspaceUuid,
      secondWorkspace,
      removeCurrentHubAdmin() {
        const { principals, hubAdmins } = hub ?? {};
        if (principals === undefined || hubAdmins === undefined) throw new Error("Hub admin fixture is missing");
        hubAdmins.remove(principals.identify("5678", "other-admin").id, principals.identify("1234", "browser-person").id);
      },
      changeCurrentWorkspaceRole(role) {
        const { principals, memberships } = hub ?? {};
        if (principals === undefined || memberships === undefined) throw new Error("Workspace role fixture is missing");
        memberships.changeRole({ workspaceId: workspaceUuid,
          principalId: principals.identify("1234", "browser-person").id, role });
      },
      changeOtherMemberUsername(username) {
        const { principals } = hub ?? {};
        if (principals === undefined) throw new Error("Workspace member fixture is missing");
        return principals.identify("5678", username).id;
      },
      ...(secondHubUrl === undefined ? {} : { secondHubUrl }),
      hubText(room, secondary = false) {
        const document = (secondary ? secondHub : hub)?.hocuspocus.documents.get(room);
        return document === undefined ? null : getBlocks(document).map((block) => block.text).join("\n");
      },
      hubWorkspaceSettings() {
        const document = hub?.hocuspocus.documents.get(settingsRoom(workspaceUuid));
        return document === undefined ? null : { name: getWorkspaceName(document),
          mainRepository: getWorkspaceMainRepository(document), tags: listTagCatalog(document).map((tag) => tag.name) };
      },
      localSettingsReset() {
        const storage = resolveStorage({ env: openEnvironment(runDir, bundleDir) });
        const db = new DatabaseSync(join(storage.workspaceDir, `${workspaceUuid}.sqlite`), { readOnly: true });
        try {
          const row = db.prepare("SELECT value FROM meta WHERE key = 'settings_reset'").get();
          return row === undefined ? null : JSON.parse(String(row.value)) as { seq: number; notice: string };
        } finally { db.close(); }
      },
      observeHubText(room) {
        const document = hub?.hocuspocus.documents.get(room);
        if (document === undefined) throw new Error("e2e: hub history needs a loaded document");
        const readings: HubTextHistory["readings"] = [];
        const record = (): void => {
          readings.push({ text: getBlocks(document).map(block => block.text).join("\n"), authenticated });
        };
        record();
        document.on("update", record);
        credentialObservers.add(record);
        return { readings, stop: () => { document.off("update", record); credentialObservers.delete(record); } };
      },
      projectBinding() {
        return JSON.parse(readFileSync(join(runDir, ".uberblick.json"), "utf8")) as { workspaceId: string; hubUrl: string };
      },
      async startHub() {
        if (hub !== null) return;
        hub = await createHub({ ...config, port }, accessRole === undefined ? {} : { deviceCredentials: true });
      },
      stopHub,
      stopOpen,
      setStoredLogin,
      rebindProject(reboundHubUrl) {
        writeFileSync(join(runDir, ".uberblick.json"),
          `${JSON.stringify({ workspaceId: workspace, hubUrl: reboundHubUrl }, null, 2)}\n`, { mode: 0o600 });
      },
      async restartOpen({ authenticated }) {
        await stopOpen();
        setStoredLogin(authenticated);
        const restarted = await startOpen(runDir, bundleDir, Number(new URL(appUrl).port));
        open = restarted.child;
        printed = restarted.printed;
      },
      async startSecondOpen() {
        if (secondProject === null) throw new Error("e2e: the fixture has no second project");
        if (secondOpen !== null) throw new Error("e2e: the second project is already serving");
        const serving = await startOpen(runDir, bundleDir, undefined, secondProject);
        secondOpen = serving.child;
        await tradeLaunch(serving.appUrl, new URL(serving.printed).hash.slice("#launch=".length));
        return {
          appUrl: serving.appUrl,
          async stop() {
            if (secondOpen === serving.child) secondOpen = null;
            sessions.delete(new URL(serving.appUrl).origin);
            await stopChild(serving.child);
          },
        };
      },
      async stop() {
        // Every step is best-effort and the temp directory goes last, in a
        // `finally`: a hub or serving process that fails to shut down cleanly must
        // not leave a database behind as well.
        try {
          const child = open;
          open = null;
          if (child !== null) await stopChild(child).catch(() => {});
          const secondChild = secondOpen;
          secondOpen = null;
          if (secondChild !== null) await stopChild(secondChild).catch(() => {});
          if (upstreamPreview !== undefined) await upstreamPreview.then((server) => server.close()).catch(() => {});
          await stopHub().catch(() => {});
          await secondHub?.stop().catch(() => {});
          secondHub = null;
        } finally {
          sessions.delete(new URL(appUrl).origin);
          rmSync(runDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (open !== null) await stopChild(open).catch(() => {});
    if (secondOpen !== null) await stopChild(secondOpen).catch(() => {});
    if (upstreamPreview !== undefined) await upstreamPreview.then((server) => server.close()).catch(() => {});
    await hub?.stop().catch(() => {});
    await secondHub?.stop().catch(() => {});
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}
