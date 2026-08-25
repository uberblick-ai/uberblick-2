/**
 * The one ordering `stopWhenDrained` exists to guarantee: handles are given up
 * on, buffered output never is.
 *
 * Both halves are load-bearing and they pull against each other — exit too
 * eagerly and a large `ub status --json` reaches its reader truncated, exit
 * never and a hub that accepts a connection and goes silent hangs the process.
 * Real streams cannot be made to apply backpressure on demand, which is why the
 * predicate takes injectable streams and a clock.
 */

import { describe, expect, it } from "vitest";
import { stopWhenDrained } from "../src/exit.js";

/** A stream with however many bytes the test says are still unwritten. */
function stream(writableLength: number): { writableLength: number } {
  return { writableLength };
}

/** Run the scheduled work synchronously, advancing a fake clock as it goes. */
function drive(): {
  now: () => number;
  schedule: (run: () => void, ms: number) => void;
  run: () => void;
} {
  let clock = 0;
  const queue: { at: number; run: () => void }[] = [];
  return {
    now: () => clock,
    schedule: (run, ms) => queue.push({ at: clock + ms, run }),
    run: () => {
      // Bounded: a predicate that never settles is a bug, not a reason to spin.
      for (let step = 0; step < 10_000 && queue.length > 0; step += 1) {
        const next = queue.shift();
        if (next === undefined) return;
        clock = next.at;
        next.run();
      }
    },
  };
}

describe("stopWhenDrained", () => {
  it("exits once nothing is buffered", () => {
    const clock = drive();
    let exited = false;
    stopWhenDrained([stream(0)], () => {
      exited = true;
    }, { now: clock.now, schedule: clock.schedule });

    clock.run();
    expect(exited).toBe(true);
  });

  it("waits for a slow reader instead of truncating it", () => {
    const clock = drive();
    // 4KB still queued until well past any fixed grace period — the large
    // `ub status --json` into a slow reader, which is the whole reason
    // `main.ts` does not call `process.exit` directly.
    const slow = {
      get writableLength(): number {
        return clock.now() < 5_000 ? 4096 : 0;
      },
    };
    let exitedAt: number | null = null;
    stopWhenDrained(
      [slow],
      () => {
        exitedAt = clock.now();
      },
      { now: clock.now, schedule: clock.schedule, pollMs: 10 },
    );

    clock.run();
    expect(exitedAt).not.toBeNull();
    // The assertion that matters: it did not exit while bytes were queued.
    expect(exitedAt).toBeGreaterThanOrEqual(5_000);
  });

  it("gives up on a reader that never drains, rather than hanging", () => {
    const clock = drive();
    let exited = false;
    stopWhenDrained([stream(4096)], () => {
      exited = true;
    }, {
      now: clock.now,
      schedule: clock.schedule,
      pollMs: 10,
      limitMs: 1_000,
    });

    clock.run();
    expect(exited).toBe(true);
    // …and only after the documented limit, never on the first look.
    expect(clock.now()).toBeGreaterThanOrEqual(1_000);
  });
});
