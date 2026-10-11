/**
 * Incomplete websocket close handshakes can keep the loop alive after a command
 * returns. Wait for buffered stdout/stderr before forcing exit so a slow pipe
 * reader receives complete output; limitMs bounds a reader that never drains.
 */

/** As much of a stream as this needs: how many bytes are still unwritten. */
export interface DrainableStream {
  readonly writableLength: number;
}

export interface StopOptions {
  /** Bound a reader that stops draining; otherwise the process can wait forever. */
  limitMs?: number;
  /** Let an ordinary command's loop run dry before forcing an exit. */
  firstDelayMs?: number;
  pollMs?: number;
  /** Injected so a test needs no real clock. */
  now?: () => number;
  /** Production timers must be unref'd so this check cannot hold the loop open. */
  schedule?: (run: () => void, ms: number) => void;
}

export function stopWhenDrained(
  streams: readonly DrainableStream[],
  exit: () => void,
  options: StopOptions = {},
): void {
  const limitMs = options.limitMs ?? 60_000;
  const pollMs = options.pollMs ?? 25;
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((run, ms) => {
      setTimeout(run, ms).unref();
    });

  const deadline = now() + limitMs;
  const check = (): void => {
    const buffered = streams.reduce(
      (total, stream) => total + stream.writableLength,
      0,
    );
    if (buffered > 0 && now() < deadline) {
      schedule(check, pollMs);
      return;
    }
    exit();
  };
  schedule(check, options.firstDelayMs ?? 250);
}
