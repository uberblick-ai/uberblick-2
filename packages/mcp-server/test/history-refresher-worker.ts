import type { McpConfig } from "../src/config.js";
import { createMcpEngine } from "../src/engine.js";
import { HistoryMirrorCache } from "../src/history-mirror-cache.js";
import { createMcpRuntime } from "../src/server.js";

const [mode, serializedConfig, blockRevision] = process.argv.slice(2);
if (serializedConfig === undefined) throw new Error("config is required");
const config = JSON.parse(serializedConfig) as McpConfig;
const deadline = setTimeout(() => process.exit(1), 40_000);
if (mode === "unref") {
  const resume = HistoryMirrorCache.prototype.resume;
  HistoryMirrorCache.prototype.resume = async function () {
    const result = await resume.call(this);
    process.send?.({ type: "cache-ready" });
    return result;
  };
}
const owner = mode === "browser"
  ? await createMcpEngine(config, { serving: true })
  : createMcpRuntime(config);
const request = owner.replicas.sync.requestRevisions.bind(owner.replicas.sync);
owner.replicas.sync.requestRevisions = (room, operation, timeout, options) => {
  process.send?.({ type: "request", room, operation });
  if (operation.operation === "get" && operation.revisionId === blockRevision) {
    process.send?.({ type: "blocked", revision: blockRevision });
    return new Promise(() => {});
  }
  return request(room, operation, timeout, options);
};
process.on("message", (message: { type: string }) => {
  if (message.type === "abandon") {
    void owner.replicas.sync.destroy().then(() => {
      // Remove the serving runtime's existing awareness timers, leaving the
      // refresher, its worker and its process-held role alive for this proof.
      for (const replica of owner.replicas.attachedReplicas()) replica.awareness.destroy();
      clearTimeout(deadline);
      process.disconnect?.();
    });
  }
  if (message.type === "close") {
    void owner.close().then(() => {
      clearTimeout(deadline);
      process.disconnect?.();
    });
  }
});
await owner.replicas.waitForSettled();
process.send?.({ type: "ready" });
