import { resolveMcpConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import { closeWithDeadline } from "../src/shutdown.js";

const instance = createMcpServer(resolveMcpConfig());
const stalled = process.argv[2] === "stalled";
instance.replicas.sync.waitForDeviceWork = stalled
  ? () => new Promise(() => {})
  : () => new Promise((resolve) => setTimeout(resolve, 10));
await closeWithDeadline((deadline) => instance.close(deadline), stalled ? 50 : 500);
