/** A real serving-engine process for lock lifecycle tests. */

import { createMcpEngine } from "../src/engine.js";
import { ServingReplicaHeldError } from "../src/serving-role.js";
import { testConfig } from "./helpers.js";

const databasePath = process.argv[2] as string;
const sessionId = process.argv[3] as string;
let engine: Awaited<ReturnType<typeof createMcpEngine>> | null = null;
let started = false;

async function start(): Promise<void> {
  if (started) return;
  started = true;
  const config = testConfig({ databasePath });
  config.sessionId = sessionId;
  try {
    engine = await createMcpEngine(config, {
      serving: true,
      refreshIntervalMs: 1_000,
    });
    process.send?.({ type: "acquired", pid: process.pid, sessionId });
  } catch (error) {
    if (error instanceof ServingReplicaHeldError) {
      process.send?.(
        { type: "refused", holder: error.holder, message: error.message },
        () => process.exit(0),
      );
      return;
    }
    process.send?.(
      { type: "failed", message: String(error) },
      () => process.exit(1),
    );
  }
}

async function close(): Promise<void> {
  await engine?.close();
  process.send?.({ type: "closed" }, () => process.exit(0));
}

process.on("message", (message: { type?: string }) => {
  if (message.type === "start") void start();
  if (message.type === "close") void close();
});
process.on("disconnect", () => {
  void engine?.close().finally(() => process.exit(0));
});
process.send?.({ type: "waiting" });
