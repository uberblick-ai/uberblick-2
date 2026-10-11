/**
 * An MCP server whose stdin is already at EOF exits, rather than hanging
 * forever with nobody left to talk to.
 *
 * Pipes report close; redirected stdin can report end without close. Both
 * events must reach the shutdown path and release the SQLite file.
 *
 * The other half of the invariant is the transport itself: stdout carries
 * JSON-RPC and nothing else, so a shutdown that logs to stdout would corrupt
 * the channel it is closing.
 *
 * Only a real process can show this — the hang is in Node's own stdin stream,
 * not in anything this package could stand in for.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import {
  mainTsProcess,
  PACKAGE_ROOT,
  removeTempDirs,
  tempDir,
  WORKSPACE,
} from "./helpers.js";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  removeTempDirs();
});

it("shuts down cleanly when redirected stdin is already at EOF", async () => {
  const { command, args } = mainTsProcess();
  const child = spawn(command, args, {
    cwd: PACKAGE_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      WORKSPACE_ID: WORKSPACE,
      XDG_DATA_HOME: tempDir(),
    },
    // `ignore` connects stdin to /dev/null to exercise non-pipe EOF.
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const result = await new Promise<{ code: number | null; stdout: string }>(
    (resolve, reject) => {
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout }));
    },
  );

  expect(result).toEqual({ code: 0, stdout: "" });
}, 10_000);
