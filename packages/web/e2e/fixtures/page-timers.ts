import { withGlobal } from "@sinonjs/fake-timers";
import type { Clock } from "@sinonjs/fake-timers";

export interface PageTimerControls {
  advance(milliseconds: number): Promise<void>;
  fastForward(milliseconds: number): void;
  setTime(time: number): void;
  pause(): void;
  resume(): void;
}

// Capture native intervals before installing either clock so the optional Date
// clock follows real time independently of manually advanced callbacks.
const fakeTimers = withGlobal(window);
const clock = fakeTimers.install({
  toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  shouldAdvanceTime: true,
});
// A separate Date clock keeps timer pumping from changing authentication time.
let dateClock: Clock | undefined;

(window as unknown as { ubPageTimers: PageTimerControls }).ubPageTimers = {
  async advance(milliseconds) { await clock.tickAsync(milliseconds); },
  fastForward(milliseconds) { clock.jump(milliseconds); },
  setTime(time) {
    dateClock ??= fakeTimers.install({ toFake: ["Date"], now: time, shouldAdvanceTime: true });
    dateClock.setSystemTime(time);
  },
  pause() { clock.setTickMode({ mode: "manual" }); },
  resume() { clock.setTickMode({ mode: "interval", delta: 20 }); },
};
