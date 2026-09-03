/**
 * The e2e bootstrap: one real hub, one real dev server, both ephemeral.
 *
 * Nothing here is a test double. The proof points these tests exist for —
 * convergence between two live clients, rendered remote cursors, an IndexedDB
 * replica surviving a reload — only mean something against the real transport
 * and the real bundle, which is also why they are not in the jsdom suite.
 *
 * Two things are deliberate:
 *
 * - **Ephemeral ports, temp database.** The hub binds `port: 0` and writes to a
 *   temp SQLite file, the dev server binds `port: 0`; a `mise run dev` on 1234
 *   and 5173, or a second e2e run, cannot collide with this one. The hub's port
 *   is read back before the dev server starts, because the bundle needs it.
 *
 * - **The bundle is configured the way `mise run web` configures it.**
 *   The dev server answers `/uberblick-config.json` from `process.env` — the
 *   endpoint, the workspaces and the signing secret (`dev-config-document.ts`,
 *   #426) — so setting those here before `createServer` is what points the
 *   browser at *this* hub with a token it accepts. fnox supplies the same
 *   variables in the real task; there is no committed `.env` and no second copy
 *   of that wiring. A deployed host serves the same document from Caddy, and
 *   the one spec that proves a *different* document wins fulfils the request in
 *   its own browser context (see deep-link.spec.ts).
 *
 * The hub is startable and stoppable on its own: the offline proof point needs
 * the hub gone while the browser stays up, and back on the same port and
 * database afterwards — a restart, not a fresh hub.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub, HubConfig } from "@uberblick/hub";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";

/**
 * The hub's HMAC signing secret for the run. Not a secret in any sense worth
 * protecting: this hub exists for the length of one test file.
 */
const SECRET = "uberblick-e2e-hub-secret";

/**
 * The workspace for the run: a fresh uuid, decorated with a display slug.
 *
 * Fresh per run, so nothing shares a corpus with a previous one; decorated,
 * because the bundle's `WORKSPACE_ID` is what `/` redirects to, and a run
 * should exercise the spelling a person would actually configure.
 */
const WORKSPACE_UUID = randomUUID();
const WORKSPACE = `uberblick-${WORKSPACE_UUID}`;

/**
 * A second workspace for the run, so the bundle has a list to switch between.
 *
 * Nothing creates it: a workspace is a uuid, and its rooms exist the moment
 * somebody opens one. That is the whole of "light multi-workspace" (#151), and
 * it is what makes an empty second workspace a real state rather than an error.
 */
const SECOND_UUID = randomUUID();
const SECOND = `ablauf-${SECOND_UUID}`;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Harness {
  /** Where the browser goes. The dev server's real, ephemeral address. */
  readonly appUrl: string;
  /**
   * This run's hub, as a client dials it. The dev server's own document already
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
  /** Start the hub again — same port, same database. */
  startHub(): Promise<void>;
  /** Flush and stop the hub, leaving the dev server and the browser alone. */
  stopHub(): Promise<void>;
  /** Tear everything down: hub, dev server, temp database. */
  stop(): Promise<void>;
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
  await expect
    .poll(async () => {
      await editor.focus();
      await page.keyboard.press(edge === "start" ? "Home" : "End");
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
  const databaseDir = mkdtempSync(join(tmpdir(), "uberblick-e2e-"));
  const config: HubConfig = {
    authSecret: SECRET,
    port: 0,
    databasePath: join(databaseDir, "hub.sqlite"),
    log: silentLogger,
    // Short: a test that stops the hub should not have to wait out a 2s
    // debounce to know its writes are durable.
    debounce: 200,
    maxDebounce: 1_000,
    shutdownTimeoutMs: 5_000,
  };

  let hub: Hub | null = null;
  let vite: ViteDevServer | null = null;

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
    process.env.HUB_URL = hubUrl;
    process.env.HUB_AUTH_TOKEN = SECRET;
    // The one address that names no workspace, `/`, resolves through this — the
    // same define `mise run web` supplies from mise `[env]`.
    process.env.WORKSPACE_ID = WORKSPACE;
    // The switcher's menu — plaintext config like HUB_URL, and the same define
    // `mise run web` supplies. It lists places to go; the address still names
    // the workspace.
    process.env.WORKSPACES = `${WORKSPACE},${SECOND}`;

    vite = await createServer({
      configFile: join(packageRoot, "vite.config.ts"),
      root: packageRoot,
      server: { port: 0 },
      logLevel: "warn",
    });
    await vite.listen();

    const appUrl = vite.resolvedUrls?.local[0];
    if (appUrl === undefined) {
      throw new Error("e2e: the vite dev server reported no local URL");
    }
    const server = vite;

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
      workspace: WORKSPACE,
      workspaceUuid: WORKSPACE_UUID,
      secondWorkspace: SECOND,
      async startHub() {
        if (hub !== null) return;
        hub = await createHub({ ...config, port });
      },
      stopHub,
      async stop() {
        // Every step is best-effort and the temp directory goes last, in a
        // `finally`: a hub or dev server that fails to shut down cleanly must
        // not leave a database behind as well.
        try {
          await stopHub().catch(() => {});
          await server.close().catch(() => {});
        } finally {
          rmSync(databaseDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await vite?.close().catch(() => {});
    await hub?.stop().catch(() => {});
    rmSync(databaseDir, { recursive: true, force: true });
    throw error;
  }
}
