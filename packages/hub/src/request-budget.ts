interface RequestEvent {
  at: number;
  keys: string[];
}

/** Accepted requests retain their debt for the entire sliding window. */
export class RequestBudget {
  private events: RequestEvent[] = [];

  constructor(
    private readonly limitPerKey: number,
    private readonly windowMs: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(...keys: string[]): boolean {
    const at = this.now();
    this.events = this.events.filter(event => event.at > at - this.windowMs);
    if (this.events.length >= this.capacity) return false;
    for (const [dimension, key] of keys.entries()) {
      let count = 0;
      for (const event of this.events) {
        if (event.keys[dimension] === key) count++;
      }
      if (count >= this.limitPerKey) return false;
    }
    this.events.push({ at, keys });
    return true;
  }
}
