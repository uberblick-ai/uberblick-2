import { tryAcquireHistoryRefresherRole, type HistoryRefresherRole } from "../src/history-refresher-role.js";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("database path is required");
let role: HistoryRefresherRole | null = null;
const deadline = setTimeout(() => process.exit(1), 20_000);
process.on("message", (message: { type: string }) => {
  if (message.type === "start") {
    role = tryAcquireHistoryRefresherRole(databasePath);
    process.send?.({ type: role === null ? "refused" : "acquired" });
  }
  if (message.type === "current") process.send?.({ type: "current", current: role?.isCurrent() ?? false });
  if (message.type === "close") {
    role?.close();
    clearTimeout(deadline);
    process.disconnect?.();
  }
});
process.send?.({ type: "ready" });
