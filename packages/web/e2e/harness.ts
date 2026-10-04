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
 * - **Run-owned everything.** The hub binds `port: 0`; the bundle, database and
 *   XDG homes live below one temporary directory; and `ub open` gets a freshly
 *   selected web port. A bind race is retried, so another e2e run or
 *   `mise run dev` cannot collide with this one.
 *
 * - **The production path.** Vite builds the checkout's current sources into
 *   that private directory, then `ub open` serves them and its real
 *   `/uberblick-config.json`. The harness writes the same configuration files
 *   `ub init` writes and removes inherited configuration pins before spawning
 *   it, so no developer machine state can steer the run.
 *
 * The upstream hub is startable and stoppable on its own: the local-first
 * proof point needs it gone while `ub open` and the browser stay up, then back
 * on the same port and database so the silent replica can converge to a
 * restarted upstream rather than a fresh one.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub, HubConfig } from "@uberblick/hub";
import { build } from "vite";

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
  for (const key of ["HOME", "HUB_AUTH_TOKEN", "HUB_URL", "WORKSPACE_ID", "WORKSPACES"]) {
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
): Promise<{ child: ChildProcessWithoutNullStreams; appUrl: string }> {
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt += 1) {
    const port = fixedPort ?? await freePort();
    const child = spawn(process.execPath, [UB, "open", "--no-browser", "--port", String(port)], {
      cwd: runDir,
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

async function buildBundle(bundleDir: string, hubUrl: string, workspace: string): Promise<void> {
  await build({
    configFile: join(packageRoot, "vite.config.ts"),
    root: packageRoot,
    logLevel: "error",
    // Override only the public fallbacks. The served document is authoritative,
    // and passing them here keeps concurrent harness builds off process.env.
    define: {
      __HUB_URL__: JSON.stringify(hubUrl),
      __WORKSPACE_ID__: JSON.stringify(workspace),
      __WORKSPACES__: JSON.stringify(""),
    },
    build: { outDir: bundleDir, emptyOutDir: true },
  });
}

export interface Harness {
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
  /** The workspace as the bundle spells it — what `/` redirects to. */
  readonly workspace: string;
  /** The same workspace, bare. Room keys and token claims carry only this. */
  readonly workspaceUuid: string;
  /** The other workspace on the switcher's menu. Empty until something writes. */
  readonly secondWorkspace: string;
  /** Start the upstream hub again — same port, same database. */
  startHub(): Promise<void>;
  /** Flush and stop upstream, leaving `ub open` and the browser alone. */
  stopHub(): Promise<void>;
  /** Restart local serving on the same address after changing hub credentials. */
  restartOpen(options: { authenticated: boolean }): Promise<void>;
  /** Tear everything down: hub, dev server, temp database. */
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
 * Focus the editor and put its caret at one end of the first text line.
 *
 * ProseMirror groups nearby clicks into double and triple clicks even when a
 * driver issues each click separately. Reusing a coordinate to place a caret
 * can therefore select the whole block and make the next keystroke replace it.
 * Keyboard placement avoids that gesture state entirely.
 * Home and End cover different scopes on macOS and Linux, but every caller has
 * one single-line block, where the line, block and document edges coincide.
 */
export async function placeCaret(page: Page, edge: "start" | "end" = "end"): Promise<void> {
  const editor = page.locator(".ub-editor .ProseMirror");
  const webkit = page.context().browser()?.browserType().name() === "webkit";
  await expect
    .poll(async () => {
      await editor.focus();
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
        await page.keyboard.press(edge === "start" ? "Home" : "End");
      }
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      return editor.evaluate((element, expectedEdge) => {
        const selection = element.ownerDocument.getSelection();
        const anchor = selection?.anchorNode;
        const block = element.firstElementChild;
        if (
          !selection?.isCollapsed ||
          anchor === undefined ||
          anchor === null ||
          block === null ||
          !block.contains(anchor) ||
          !element.contains(element.ownerDocument.activeElement)
        ) {
          return false;
        }

        const outside = element.ownerDocument.createRange();
        outside.selectNodeContents(block);
        if (expectedEdge === "start") {
          outside.setEnd(anchor, selection.anchorOffset);
        } else {
          outside.setStart(anchor, selection.anchorOffset);
        }
        const copy = outside.cloneContents();
        for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) {
          cursor.remove();
        }
        return copy.textContent === "";
      }, edge);
    })
    .toBe(true);
}

export async function startHarness(): Promise<Harness> {
  const runDir = mkdtempSync(join(tmpdir(), `uberblick-e2e-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  const bundleDir = join(runDir, "bundle");
  // Fresh and decorated per harness: room keys stay isolated, while `/`
  // exercises the spelling a person would actually configure.
  const workspaceUuid = randomUUID();
  const workspace = `uberblick-${workspaceUuid}`;
  // Nothing creates the second workspace: its rooms begin existing when the
  // switcher proof opens them, which is the real light-multi-workspace model.
  const secondWorkspace = `research-${randomUUID()}`;
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
  };

  let hub: Hub | null = null;
  let open: ChildProcessWithoutNullStreams | null = null;

  // One failure boundary for the whole bootstrap, the temp directory included:
  // a harness that did not finish starting must leave nothing behind — no
  // listening socket, no stray database — and must surface its own error rather
  // than a cleanup error on top of it.
  try {
    hub = await createHub(config);
    // Every later start reuses the port the first one was given, so the served
    // HUB_URL keeps pointing at the hub across a restart.
    const port = hub.port;

    const hubUrl = `ws://127.0.0.1:${port}`;
    const configDir = join(runDir, "config", "uberblick");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      `${JSON.stringify({ workspace, hubUrl }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const credentials = join(configDir, "credentials.json");
    writeFileSync(credentials, `${JSON.stringify({ signingSecret: SECRET }, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(credentials, 0o600);

    await buildBundle(bundleDir, hubUrl, workspace);
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
      appUrl,
      hubUrl,
      authSecret: SECRET,
      workspace,
      workspaceUuid,
      secondWorkspace,
      async startHub() {
        if (hub !== null) return;
        hub = await createHub({ ...config, port });
      },
      stopHub,
      async restartOpen({ authenticated }) {
        const child = open;
        open = null;
        if (child !== null) await stopChild(child);
        if (authenticated) {
          writeFileSync(credentials, `${JSON.stringify({ signingSecret: SECRET }, null, 2)}\n`, {
            mode: 0o600,
          });
          chmodSync(credentials, 0o600);
        } else {
          rmSync(credentials, { force: true });
        }
        const restarted = await startOpen(runDir, bundleDir, Number(new URL(appUrl).port));
        open = restarted.child;
      },
      async stop() {
        // Every step is best-effort and the temp directory goes last, in a
        // `finally`: a hub or serving process that fails to shut down cleanly must
        // not leave a database behind as well.
        try {
          const child = open;
          open = null;
          if (child !== null) await stopChild(child).catch(() => {});
          await stopHub().catch(() => {});
        } finally {
          rmSync(runDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (open !== null) await stopChild(open).catch(() => {});
    await hub?.stop().catch(() => {});
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}
