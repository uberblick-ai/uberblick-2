/**
 * Store startup is a process boundary: several MCP sessions normally share
 * one SQLite file, and the busy handler must exist before WAL takes its lock.
 */

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { MirrorStore } from "../src/store.js";
import { removeTempDirs, tempDatabasePath, WORKSPACE } from "./helpers.js";

const WORKER = fileURLToPath(new URL("./store-open-worker.ts", import.meta.url));
const OPENERS = 8;
const ROUNDS = 60;

type WorkerMessage =
  | { type: "ready" }
  | {
      type: "opened";
      journalMode: string;
      busyTimeout: number;
      foreignKeys: number;
    }
  | { type: "failed"; message: string; code: number | null };

interface Opener {
  child: ChildProcess;
  next(): Promise<WorkerMessage>;
}

function spawnOpener(): Opener {
  const child = fork(WORKER, [WORKSPACE], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    next: () =>
      new Promise<WorkerMessage>((resolve, reject) => {
        const onMessage = (message: WorkerMessage): void => {
          child.off("exit", onExit);
          resolve(message);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          child.off("message", onMessage);
          reject(
            new Error(
              `store opener exited ${String(code ?? signal)} before replying: ${stderr.trim()}`,
            ),
          );
        };
        child.once("message", onMessage);
        child.once("exit", onExit);
      }),
  };
}

afterEach(removeTempDirs);

async function expectConcurrentOpens(
  databasePath: (round: number) => string,
): Promise<void> {
  const openers = Array.from({ length: OPENERS }, () => spawnOpener());

  try {
    expect(await Promise.all(openers.map((opener) => opener.next()))).toEqual(
      Array.from({ length: OPENERS }, () => ({ type: "ready" })),
    );

    const opens: WorkerMessage[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const path = databasePath(round);
      const replies = openers.map((opener) => opener.next());
      for (const opener of openers) {
        opener.child.send({ type: "open", databasePath: path });
      }
      opens.push(...(await Promise.all(replies)));
    }

    expect(opens).toHaveLength(OPENERS * ROUNDS);
    expect(opens.filter((message) => message.type === "failed")).toEqual([]);
    expect(new Set(opens.map((message) => JSON.stringify(message)))).toEqual(
      new Set([
        JSON.stringify({
          type: "opened",
          journalMode: "wal",
          busyTimeout: 5_000,
          foreignKeys: 1,
        }),
      ]),
    );
  } finally {
    const exits = openers.map((opener) =>
      opener.child.exitCode === null ? once(opener.child, "exit") : Promise.resolve(),
    );
    for (const opener of openers) {
      if (opener.child.connected) opener.child.send({ type: "quit" });
      else if (opener.child.exitCode === null) opener.child.kill("SIGTERM");
    }
    await Promise.all(exits);
  }
}

// One pool of openers, alternating between a store that does not exist yet and
// one that does, so both startup paths race without paying for a second pool.
it(
  "opens new and existing stores from eight processes at once without a busy failure",
  async () => {
    const existing = tempDatabasePath();
    new MirrorStore(existing, WORKSPACE).close();
    await expectConcurrentOpens((round) => (round % 2 === 0 ? tempDatabasePath() : existing));
  },
  120_000,
);
