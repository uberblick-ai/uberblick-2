import { TestRunner } from "vitest";

interface Poll {
  cancel(): void;
  cancellation: Error;
  finished: Promise<{ error?: unknown }>;
}

const polls = new Set<Poll>();

/** Stop polling and finish any predicate already using a test resource. */
export async function drainWaits(): Promise<void> {
  const pending = [...polls];
  for (const poll of pending) poll.cancel();
  const results = await Promise.all(pending.map((poll) => poll.finished));
  const errors = results.flatMap((result, index) =>
    result.error !== undefined && result.error !== pending[index]?.cancellation ? [result.error] : []);
  if (errors.length) throw new AggregateError(errors, "test polling failed");
}

/** Wait for a condition, ending polling when its test times out or tears down. */
export function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const signal = TestRunner.getCurrentTest()?.context.signal;
  let cancelled = signal?.aborted ?? false;
  let wake: (() => void) | undefined;
  const cancel = () => { cancelled = true; wake?.(); };
  const cancellation = Object.assign(new Error(`test ended while waiting for ${label}`), { name: "AbortError" });
  signal?.addEventListener("abort", cancel, { once: true });
  const poll: Poll = { cancel, cancellation, finished: Promise.resolve({}) };
  const run = async () => {
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        if (cancelled) throw cancellation;
        const ready = await predicate();
        if (cancelled) throw cancellation;
        if (ready) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25);
          wake = () => { clearTimeout(timer); resolve(); };
          if (cancelled) wake();
        });
        wake = undefined;
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      polls.delete(poll);
    }
  };
  polls.add(poll);
  const waiting = run();
  // Observe completion even when Vitest has already stopped awaiting the body.
  // The caller still receives the predicate failure or cancellation unchanged.
  poll.finished = waiting.then(() => ({}), (error: unknown) => ({ error }));
  return waiting;
}
