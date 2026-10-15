import type { ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Temporary investigation instrumentation, removed after collecting CI evidence.
export function signalDiagnostics(child: ChildProcess, signal: string): {
  mark(event: string, detail?: unknown): void;
  finish(): void;
} {
  const started = performance.now();
  const events: unknown[] = [];
  const mark = (event: string, detail?: unknown): void => {
    events.push({ ms: Math.round(performance.now() - started), event, detail });
  };
  if (process.platform !== "linux" || child.pid === undefined) {
    return { mark, finish() {} };
  }
  const known = new Set([child.pid]);
  const previous = new Map<number, string>();
  const read = (path: string): string | null => {
    try { return readFileSync(path, "utf8").trim(); } catch { return null; }
  };
  const snapshot = (): void => {
    for (const pid of known) {
      try {
        for (const tid of readdirSync(`/proc/${pid}/task`)) {
          for (const value of (read(`/proc/${pid}/task/${tid}/children`) ?? "").split(/\s+/)) {
            if (value) known.add(Number(value));
          }
        }
      } catch { /* An exited process has no task directory. */ }
      const status = read(`/proc/${pid}/status`);
      if (!previous.has(pid)) {
        mark("discovered", {
          pid,
          command: read(`/proc/${pid}/cmdline`)?.replaceAll("\0", " "),
          limits: read(`/proc/${pid}/limits`)?.split("\n").filter((line) => line.startsWith("Max core")),
        });
      }
      const fds = [0, 1, 2].map((fd) => {
        try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return null; }
      });
      const state = JSON.stringify({
        pid,
        status: status?.split("\n").filter((line) => /^(Name|State|PPid|CoreDumping):/.test(line)),
        wchan: read(`/proc/${pid}/wchan`),
        fds,
      });
      if (previous.get(pid) !== state) {
        previous.set(pid, state);
        mark("process", JSON.parse(state));
      }
    }
  };
  mark("settings", {
    signal, wrapper: child.pid,
    corePattern: read("/proc/sys/kernel/core_pattern"),
    limits: read(`/proc/${child.pid}/limits`)?.split("\n").filter((line) => line.startsWith("Max core")),
  });
  child.on("exit", (code, killedBy) => mark("wrapper exit", { code, signal: killedBy }));
  child.on("close", (code, killedBy) => mark("wrapper close", { code, signal: killedBy }));
  child.stdout?.on("end", () => mark("stdout end"));
  child.stdout?.on("close", () => mark("stdout close"));
  child.stderr?.on("end", () => mark("stderr end"));
  child.stderr?.on("close", () => mark("stderr close"));
  snapshot();
  const timer = setInterval(snapshot, 50);
  return {
    mark,
    finish() {
      clearInterval(timer);
      snapshot();
      const directory = join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? ".", "vitest-results");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `signal-${child.pid}.json`), JSON.stringify(events, null, 2));
    },
  };
}
