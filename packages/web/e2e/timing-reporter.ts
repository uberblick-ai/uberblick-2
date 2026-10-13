import type { Reporter } from "@playwright/test/reporter";

/** onBegin follows global setup; fixture startup remains part of suite wall time. */
export default class TimingReporter implements Reporter {
  private started = 0;

  onBegin(): void {
    this.started = performance.now();
  }

  onEnd(): void {
    if (this.started !== 0) {
      console.log(`e2e timing: suite wall ${Math.round(performance.now() - this.started)} ms`);
    }
  }
}
