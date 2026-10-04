/**
 * Hub process entry point (`mise run hub`).
 *
 * Owns the process: reads the environment, starts one hub, and turns
 * SIGTERM/SIGINT into a flush-then-close shutdown, so that killing the hub
 * loses nothing. Hocuspocus can install equivalent handlers itself
 * (`stopOnSignals`), but `createHub` keeps its hands off process state — that
 * is what makes it embeddable in tests — so the signals are wired here, where
 * the shutdown can also be logged and bounded.
 */

import { resolveRemoteHubConfig } from "./config.js";
import { stderrLogger } from "./log.js";
import { createHub } from "./server.js";
import { isEphemeralDatabase } from "./persistence.js";

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

async function main(): Promise<void> {
  const config = resolveRemoteHubConfig();
  const hub = await createHub(config, {
    operatorSetup: process.platform !== "win32" &&
      !isEphemeralDatabase(config.databasePath ?? "durable-default"),
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    // A second signal while the first is still draining must not race it.
    if (shuttingDown) {
      stderrLogger({ event: "hub.signal.ignored", signal });
      return;
    }
    shuttingDown = true;
    stderrLogger({ event: "hub.signal", signal });

    try {
      await hub.stop();
      process.exit(0);
    } catch (error) {
      stderrLogger({ event: "hub.stop.failed", error: String(error) });
      process.exit(1);
    }
  };

  for (const signal of SIGNALS) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

main().catch((error: unknown) => {
  stderrLogger({ event: "hub.start.failed", error: String(error) });
  process.exitCode = 1;
});
