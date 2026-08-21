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
 *   `vite.config.ts` reads `HUB_URL` and `HUB_AUTH_TOKEN` from the environment
 *   at config time (fnox supplies them in the real task), so setting them here
 *   before `createServer` is what points the browser at *this* hub with a token
 *   it accepts. No committed `.env`, no second copy of that wiring.
 *
 * The hub is startable and stoppable on its own: the offline proof point needs
 * the hub gone while the browser stays up, and back on the same port and
 * database afterwards — a restart, not a fresh hub.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub, HubConfig } from "@uberblick/hub";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";

/**
 * The hub's HMAC signing secret for the run. Not a secret in any sense worth
 * protecting: this hub exists for the length of one test file.
 */
const SECRET = "uberblick-e2e-hub-secret";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Harness {
  /** Where the browser goes. The dev server's real, ephemeral address. */
  readonly appUrl: string;
  /** Start the hub again — same port, same database. */
  startHub(): Promise<void>;
  /** Flush and stop the hub, leaving the dev server and the browser alone. */
  stopHub(): Promise<void>;
  /** Tear everything down: hub, dev server, temp database. */
  stop(): Promise<void>;
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

  let hub: Hub | null = await createHub(config);
  // Every later start reuses the port the first one was given, so the bundle's
  // baked-in HUB_URL keeps pointing at the hub across a restart.
  const port = hub.port;

  process.env.HUB_URL = `ws://127.0.0.1:${port}`;
  process.env.HUB_AUTH_TOKEN = SECRET;

  let vite: ViteDevServer;
  try {
    vite = await createServer({
      configFile: join(packageRoot, "vite.config.ts"),
      root: packageRoot,
      server: { port: 0 },
      logLevel: "warn",
    });
    await vite.listen();
  } catch (error) {
    await hub.stop().catch(() => {});
    rmSync(databaseDir, { recursive: true, force: true });
    throw error;
  }

  const appUrl = vite.resolvedUrls?.local[0];
  if (appUrl === undefined) {
    await vite.close();
    await hub.stop().catch(() => {});
    rmSync(databaseDir, { recursive: true, force: true });
    throw new Error("e2e: the vite dev server reported no local URL");
  }

  const stopHub = async (): Promise<void> => {
    if (hub === null) return;
    const running = hub;
    hub = null;
    await running.stop();
  };

  return {
    appUrl,
    async startHub() {
      if (hub !== null) return;
      hub = await createHub({ ...config, port });
    },
    stopHub,
    async stop() {
      await stopHub().catch(() => {});
      await vite.close();
      rmSync(databaseDir, { recursive: true, force: true });
    },
  };
}
