import { once } from "node:events";
import { resolveMcpHostConfig } from "./host-config.js";
import { createMcpHost } from "./http-host.js";
import { log } from "./log.js";
import { closeWithDeadline } from "./shutdown.js";

async function main(): Promise<void> {
  const config = resolveMcpHostConfig();
  const host = createMcpHost(config);
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down MCP host", { signal });
    void closeWithDeadline(deadline => host.close(deadline)).then(
      () => process.exit(0),
      () => { log.error("MCP host shutdown failed"); process.exit(1); },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  host.server.listen(config.port, config.host);
  await once(host.server, "listening");
  log.info("MCP host listening", { address: host.server.address() });
}

main().catch((error: unknown) => { log.error("MCP host failed to start", error); process.exit(1); });
