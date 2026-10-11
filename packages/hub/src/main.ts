import { resolveRemoteHubConfig } from "./config.js";
import { stderrLogger } from "./log.js";
import { createHub } from "./server.js";
import { isEphemeralDatabase } from "./persistence.js";

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

async function main(): Promise<void> {
  const config = resolveRemoteHubConfig();
  const hub = await createHub(config, {
    initializeDefaultWorkspace: true,
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
    // The process entry owns signal handlers; createHub stays embeddable.
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

main().catch((error: unknown) => {
  stderrLogger({ event: "hub.start.failed", error: String(error) });
  process.exitCode = 1;
});
