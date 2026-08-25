/**
 * When it is safe to stop waiting for the event loop.
 *
 * `main.ts` deliberately sets `process.exitCode` and lets the loop run dry
 * rather than calling `process.exit`, because a write to a pipe is asynchronous
 * and exiting at once hands a reader truncated output. That rule assumes every
 * command closes what it opened — and one class of them cannot. A hub that
 * accepts a websocket and then never answers leaves a connection whose close
 * handshake nobody completes, so the loop never drains and "exit cleanly"
 * becomes "hang".
 *
 * This is the reconciliation, and the ordering is the whole of it: give up on
 * the *handles*, never on *buffered output*. Exit happens only once every
 * stream reports nothing left to write, however long that takes — so the
 * truncation the original rule exists to prevent is still prevented, including
 * for a large `ub status --json` going into a reader that is slow to read.
 *
 * Its own module because that ordering is worth a test, and a test cannot make
 * a real `process.stdout` apply backpressure on demand.
 */

/** As much of a stream as this needs: how many bytes are still unwritten. */
export interface DrainableStream {
  readonly writableLength: number;
}

export interface StopOptions {
  /**
   * How long a reader may hold the process open by not reading.
   *
   * Reached only when a pipe is full and nobody is draining it, which means the
   * reader is gone — at which point there is nobody left for the output to be
   * truncated *for*. Without any cap, a vanished reader would hang the process
   * forever, which is the failure this whole module exists to remove.
   */
  limitMs?: number;
  /**
   * How long to wait before looking at all. An ordinary command's loop runs dry
   * inside this, so it exits the original way and never reaches any of this.
   */
  firstDelayMs?: number;
  pollMs?: number;
  /** Injected so a test needs no real clock. */
  now?: () => number;
  /**
   * Injected so a test needs no real timers. Production passes an **unref'd**
   * timer: a process that can exit on its own must not be held open by the
   * mechanism that exists to stop it being held open.
   */
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
