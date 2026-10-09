/** Admission and draining for work that must finish before replicas are destroyed. */
export class ServerShuttingDownError extends Error {
  constructor() {
    super("The MCP server is shutting down and cannot start another call.");
    this.name = "ServerShuttingDownError";
  }
}

export class ServerWork {
  private stopping = false;
  private active = 0;
  private readonly drained: (() => void)[] = [];

  assertOpen(): void {
    if (this.stopping) throw new ServerShuttingDownError();
  }

  stop(): void {
    this.stopping = true;
  }

  async run<T>(handler: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.active += 1;
    try {
      return await handler();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.drained.splice(0)) resolve();
      }
    }
  }

  async drain(): Promise<void> {
    if (this.active === 0) return;
    await new Promise<void>((resolve) => this.drained.push(resolve));
  }
}
