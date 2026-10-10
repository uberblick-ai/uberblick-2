/**
 * The e2e bootstrap: one real hub and the bundle served by one real `ub open`.
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
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub, HubConfig } from "@uberblick/hub";
import { getBlocks } from "@uberblick/schema";
import { buildAppBundle, sharedAppBundle } from "./bundle.js";

/**
 * The hub's HMAC signing secret for the run. Not a secret in any sense worth
 * protecting: this hub exists for the length of one test file.
 */
const SECRET = "uberblick-e2e-hub-secret";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const UB = join(repoRoot, "packages", "cli", "bin", "ub.mjs");

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

async function startOpen(
  runDir: string,
  bundleDir: string,
  fixedPort?: number,
  projectDir = runDir,
): Promise<{ child: ChildProcessWithoutNullStreams; appUrl: string }> {
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
          if (stdout.includes(`uberblick is at http://127.0.0.1:${port}/`)) resolveReady("ready");
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
      return { child, appUrl: `http://127.0.0.1:${port}/` };
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

export interface Harness {
  /** Public fixture identities for access-control browser proofs. */
  readonly access?: { otherDeviceId: string; foreignDeviceId: string };
  /** Where the browser goes. This run's real `ub open` address. */
  readonly appUrl: string;
  /**
   * This run's hub, as a client dials it. `ub open`'s own document already
   * names it; a test that fulfils that request with a document of its own has
   * to name it there too, because that document supplies the endpoint and the
   * signing secret as well as the workspaces.
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
  /** Verify browser navigation left the project's startup binding untouched. */
  projectBinding(): { workspaceId: string; hubUrl: string };
  /** Start the upstream hub again — same port, same database. */
  startHub(): Promise<void>;
  /** Flush and stop upstream, leaving `ub open` and the browser alone. */
  stopHub(): Promise<void>;
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
  running: Pick<Harness, "appUrl" | "hubUrl" | "workspace" | "authSecret">,
  path = "/",
  options: {
    contextOptions?: BrowserContextOptions;
    workspaces?: string[];
    beforeNavigate?: (page: Page) => Promise<void>;
    readySelector?: string | null;
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options.contextOptions);
  try {
    await context.route("**/uberblick-config.json", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          hubUrl: running.hubUrl,
          workspaces: options.workspaces ?? [running.workspace],
          hubAuthToken: running.authSecret,
        }),
      });
    });
    const page = await context.newPage();
    await options.beforeNavigate?.(page);
    await page.goto(new URL(path, running.appUrl).href);
    const readySelector = options.readySelector === undefined ? ".ub-list-head" : options.readySelector;
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

/** Register after ProseMirror's focus handler and its 20ms selection sync. */
async function settleEditorFocus(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate((element) => {
    const root = element.closest(".ProseMirror");
    return root?.classList.contains("ProseMirror-focused") === true && root.contains(element.ownerDocument.activeElement);
  })).toBe(true);
  await target.page().evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
}

/** Settle editor focus before delivering the native caret-placement gesture. */
export async function placeCaretIn(target: Locator, options: { touch?: boolean; edge?: "start" | "end" } = {}): Promise<void> {
  await target.evaluate((element) => {
    const root = element.closest(".ProseMirror");
    if (!(root instanceof HTMLElement)) throw new Error("e2e: caret target has no editor");
    root.focus();
  });
  await settleEditorFocus(target);
  if (options.touch === true) {
    // Touch border controls can cover a cell's edge; use its interior.
    const position = await target.evaluate(element => element.matches("th, td")
      ? { x: element.getBoundingClientRect().width / 4, y: element.getBoundingClientRect().height / 2 }
      : undefined);
    await target.tap(position === undefined ? {} : { position });
  } else await target.click();
  const edge = options.edge ?? "end";
  await target.page().keyboard.press(edge === "start" ? keys.lineStart : keys.lineEnd);
  await target.page().evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect.poll(() => target.evaluate(caretAtEdge, edge)).toBe(true);
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
  const webkit = page.context().browser()?.browserType().name() === "webkit";
  await expect
    .poll(async () => {
      await editor.focus();
      await settleEditorFocus(editor);
      if (webkit) {
        // iOS does not give Home/End desktop block-edge semantics. Native
        // range setup avoids a pointer gesture while retaining real selection
        // geometry and selectionchange; the test supplies the input it proves.
        await editor.evaluate((element, at) => {
          const block = element.firstElementChild;
          if (block === null) throw new Error("e2e: prose has no block");
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(block);
          range.collapse(at === "start");
          const selection = element.ownerDocument.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }, edge);
      } else {
        await page.keyboard.press(edge === "start" ? keys.lineStart : keys.lineEnd);
      }
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      return editor.locator(":scope > *").first().evaluate(caretAtEdge, edge);
    })
    .toBe(true);
}

export async function startHarness(options: {
  accessRole?: "admin" | "member";
  /** Only the deep-link proof of a compiled loopback fallback needs this. */
  compiledFallback?: boolean;
  /** Offer a real on-machine replica backed by a separate authenticated hub. */
  multiWorkspace?: boolean;
} = {}): Promise<Harness> {
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

  // One failure boundary for the whole bootstrap, the temp directory included:
  // a harness that did not finish starting must leave nothing behind — no
  // listening socket, no stray database — and must surface its own error rather
  // than a cleanup error on top of it.
  try {
    hub = await createHub(config, accessRole === undefined ? {} : { deviceCredentials: true });
    // Every later start reuses the port the first one was given, so the served
    // HUB_URL keeps pointing at the hub across a restart.
    const port = hub.port;

    const hubUrl = `ws://127.0.0.1:${port}`;
    const configDir = join(runDir, "config", "uberblick");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(runDir, ".uberblick.json"),
      `${JSON.stringify({ workspaceId: workspace, hubUrl }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const credentials = join(configDir, "credentials.json");
    let storedCredentials: unknown = { signingSecret: SECRET };
    let access: Harness["access"];
    if (accessRole !== undefined) {
      const { principals, memberships, credentials: registry } = hub;
      if (principals === undefined || memberships === undefined || registry === undefined) {
        throw new Error("Access browser fixture needs GitHub registries");
      }
      const principal = principals.identify("1234", "browser-person");
      memberships.grant({ workspaceId: workspaceUuid, principalId: principal.id, role: accessRole });
      const foreign = principals.identify("5678", "other-admin");
      memberships.grant({ workspaceId: workspaceUuid, principalId: foreign.id, role: "admin" });
      const issue = (principalId: string) => registry.issue({ principalId, deviceId: randomUUID(), workspaces: [workspaceUuid] });
      const current = issue(principal.id);
      const other = issue(principal.id);
      const foreignDevice = issue(foreign.id);
      const { replacedAt: _replaced, ...record } = current.record;
      storedCredentials = { hubLogins: { [`http://127.0.0.1:${port}`]: {
        identity: principal, credential: { record, key: Buffer.from(current.keyBytes).toString("base64url") },
      } } };
      access = { otherDeviceId: other.record.deviceId, foreignDeviceId: foreignDevice.record.deviceId };
    }
    let secondHubUrl: string | undefined;
    if (options.multiWorkspace === true) {
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
      secondHub = await createHub({ ...config, databasePath: join(runDir, "second-hub.sqlite") }, { deviceCredentials: true });
      secondHubUrl = `ws://127.0.0.1:${secondHub.port}`;
      writeFileSync(join(project, ".uberblick.json"),
        `${JSON.stringify({ workspaceId: secondWorkspace, hubUrl: secondHubUrl }, null, 2)}\n`, { mode: 0o600 });
      const { principals, memberships, credentials: registry } = secondHub;
      if (principals === undefined || memberships === undefined || registry === undefined) throw new Error("Second hub needs device registries");
      const principal = principals.identify("4321", "second-person");
      memberships.grant({ workspaceId: secondWorkspace, principalId: principal.id, role: "admin" });
      const issued = registry.issue({ principalId: principal.id, deviceId: randomUUID(), workspaces: [secondWorkspace] });
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
    writeFileSync(credentials, `${JSON.stringify(storedCredentials, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(credentials, 0o600);

    const setStoredLogin = (authenticated: boolean): void => {
      if (!authenticated) {
        rmSync(credentials, { force: true });
        return;
      }
      writeFileSync(credentials, `${JSON.stringify(storedCredentials, null, 2)}\n`, { mode: 0o600 });
      chmodSync(credentials, 0o600);
    };

    if (options.compiledFallback === true) {
      await buildAppBundle({ directory: bundleDir, hubUrl, workspace });
    }
    const serving = await startOpen(runDir, bundleDir);
    open = serving.child;
    const appUrl = serving.appUrl;

    const stopHub = async (): Promise<void> => {
      if (hub === null) return;
      const running = hub;
      hub = null;
      await running.stop();
    };

    return {
      ...(access === undefined ? {} : { access }),
      appUrl,
      hubUrl,
      authSecret: SECRET,
      workspace,
      workspaceUuid,
      secondWorkspace,
      ...(secondHubUrl === undefined ? {} : { secondHubUrl }),
      hubText(room, secondary = false) {
        const document = (secondary ? secondHub : hub)?.hocuspocus.documents.get(room);
        return document === undefined ? null : getBlocks(document).map((block) => block.text).join("\n");
      },
      projectBinding() {
        return JSON.parse(readFileSync(join(runDir, ".uberblick.json"), "utf8")) as { workspaceId: string; hubUrl: string };
      },
      async startHub() {
        if (hub !== null) return;
        hub = await createHub({ ...config, port }, accessRole === undefined ? {} : { deviceCredentials: true });
      },
      stopHub,
      setStoredLogin,
      rebindProject(reboundHubUrl) {
        writeFileSync(join(runDir, ".uberblick.json"),
          `${JSON.stringify({ workspaceId: workspace, hubUrl: reboundHubUrl }, null, 2)}\n`, { mode: 0o600 });
      },
      async restartOpen({ authenticated }) {
        const child = open;
        open = null;
        if (child !== null) await stopChild(child);
        setStoredLogin(authenticated);
        const restarted = await startOpen(runDir, bundleDir, Number(new URL(appUrl).port));
        open = restarted.child;
      },
      async startSecondOpen() {
        if (secondProject === null) throw new Error("e2e: the fixture has no second project");
        if (secondOpen !== null) throw new Error("e2e: the second project is already serving");
        const serving = await startOpen(runDir, bundleDir, undefined, secondProject);
        secondOpen = serving.child;
        return {
          appUrl: serving.appUrl,
          async stop() {
            if (secondOpen === serving.child) secondOpen = null;
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
          await stopHub().catch(() => {});
          await secondHub?.stop().catch(() => {});
          secondHub = null;
        } finally {
          rmSync(runDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (open !== null) await stopChild(open).catch(() => {});
    if (secondOpen !== null) await stopChild(secondOpen).catch(() => {});
    await hub?.stop().catch(() => {});
    await secondHub?.stop().catch(() => {});
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}
