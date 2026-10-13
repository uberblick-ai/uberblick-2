import { log } from "./log.js";

// Default settle can wait twice for connect (1.5 s) plus sync (3 s). Allow
// another 2 s for publication of a replacement credential already issued by
// the hub, plus I/O grace. The process deadline also bounds longer configured
// waits and any close step that fails to finish.
export const SHUTDOWN_TIMEOUT_MS = 12_000;

// Leave the issued credential's 2 s publication budget and I/O grace for close.
export const SHUTDOWN_CLOSE_RESERVE_MS = 3_000;

/** Close cleanly, or terminate the stdio server if async shutdown stalls. */
export async function closeWithDeadline(
  close: (deadline: number) => Promise<void>,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const expiresAt = performance.now() + timeoutMs;
  // Keep this timer referenced: an unresolved close promise alone would let
  // Node exit successfully before reporting that shutdown did not finish.
  const deadline = setTimeout(() => {
    log.error("shutdown timed out", { timeoutMs });
    process.exit(1);
  }, timeoutMs);
  try {
    await close(expiresAt);
  } finally {
    clearTimeout(deadline);
  }
}
