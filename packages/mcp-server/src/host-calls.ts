import type { RequestId } from "@modelcontextprotocol/sdk/types.js";

interface CallReservation {
  id: RequestId;
  started: boolean;
  release(): void;
}

/** Reservations follow dispatched handlers, including cancelled or disconnected calls. */
export class HostCalls {
  private readonly reservations = new Map<object, CallReservation[]>();
  private count = 0;

  constructor(private readonly maximum: number) {}

  hasCapacity(count: number): boolean {
    return this.count + count <= this.maximum;
  }

  hasDuplicate(session: object, ids: RequestId[]): boolean {
    return new Set(ids).size !== ids.length || ids.some(id => this.reservations.get(session)?.some(call => call.id === id));
  }

  reserve(session: { requests: number }, ids: RequestId[]): () => void {
    if (ids.length === 0) return () => {};
    const calls = this.reservations.get(session) ?? [];
    this.reservations.set(session, calls);
    const admitted = ids.map(id => {
      let released = false;
      const call: CallReservation = { id, started: false, release: () => {
        if (released) return;
        released = true;
        this.count -= 1;
        session.requests -= 1;
        calls.splice(calls.indexOf(call), 1);
        if (calls.length === 0) this.reservations.delete(session);
      } };
      calls.push(call);
      this.count += 1;
      session.requests += 1;
      return call;
    });
    return () => { for (const call of admitted) if (!call.started) call.release(); };
  }

  started(session: object, id: RequestId): void {
    const call = this.reservations.get(session)?.find(call => call.id === id && !call.started);
    if (call !== undefined) call.started = true;
  }

  finished(session: object, id: RequestId): void {
    this.reservations.get(session)?.find(call => call.id === id && call.started)?.release();
  }
}
