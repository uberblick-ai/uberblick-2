import { HistoryHoldSession } from "../src/history-holds.js";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("database path is required");
const session = new HistoryHoldSession(databasePath);
const deadline = setTimeout(() => process.exit(1), 20_000);
process.on("message", (message: { type: string; sessionId?: string }) => {
  if (message.type === "probe" && message.sessionId) {
    process.send?.({ type: "probe", alive: session.isAlive(message.sessionId) });
  }
  if (message.type === "close") {
    session.close();
    clearTimeout(deadline);
    process.disconnect?.();
  }
});
process.send?.({ type: "ready", sessionId: session.id });
