import { authenticationOrigin } from "./remote-url.js";
import { RevisionClientError } from "./revision-client.js";

/** Relate revision deadlines to the hub's clock without periodic requests. */
export class HubHistoryClock {
  private generation = 0;
  private closed = false;
  private sample: { wall: number; monotonic: number } | null = null;
  private attempt: Promise<void> | null = null;
  private pending: { controller: AbortController; timer: NodeJS.Timeout } | null = null;

  constructor(private readonly endpoint: string) {}

  ensure(): Promise<void> {
    if (this.closed) return Promise.reject(new RevisionClientError("unreachable"));
    if (this.attempt !== null) return this.attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref();
    const pending = { controller, timer };
    this.pending = pending;
    this.attempt = this.read(this.generation, pending);
    return this.attempt;
  }

  private async read(generation: number, pending: NonNullable<HubHistoryClock["pending"]>): Promise<void> {
    let response: Response | undefined;
    try {
      response = await fetch(`${authenticationOrigin(this.endpoint)}/auth/claim-state`, {
        method: "GET", credentials: "omit", redirect: "error", signal: pending.controller.signal,
      });
      const receivedAt = performance.now();
      const date = response.headers.get("date");
      const wall = date === null ? Number.NaN : Date.parse(date);
      if (response.status !== 200 || !Number.isFinite(wall) || new Date(wall).toUTCString() !== date) {
        throw new RevisionClientError("unreachable");
      }
      await response.body?.cancel();
      response = undefined;
      if (this.closed || generation !== this.generation || pending.controller.signal.aborted) {
        throw new RevisionClientError("unreachable");
      }
      this.sample = { wall, monotonic: receivedAt };
    } catch {
      throw new RevisionClientError("unreachable");
    } finally {
      clearTimeout(pending.timer);
      if (this.pending === pending) this.pending = null;
      try { await response?.body?.cancel(); } catch { /* The response is already being discarded. */ }
    }
  }

  now(): number {
    return this.sample === null ? Date.now()
      : this.sample.wall + Math.max(0, performance.now() - this.sample.monotonic);
  }

  delay(deadline: number): number {
    if (this.sample === null || !Number.isFinite(deadline)) throw new RevisionClientError("unreachable");
    // HTTP Date has whole-second precision; keep deadline work on the late side.
    return Math.max(0, deadline - this.now()) + 1_000;
  }

  reset(): void {
    this.generation += 1;
    this.sample = null;
    this.attempt = null;
    if (this.pending !== null) {
      clearTimeout(this.pending.timer);
      this.pending.controller.abort();
      this.pending = null;
    }
  }

  close(): void {
    this.closed = true;
    this.reset();
  }
}
