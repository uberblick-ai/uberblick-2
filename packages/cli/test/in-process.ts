import { runCli } from "../src/cli.js";
import type { Io } from "../src/io.js";
import type { Run, Sandbox } from "./helpers.js";

let running = false;

/**
 * Commands read process configuration; each worker restores it before the next assertion.
 * Sign-in collection commits SQLite state, so its explicit budget leaves margin
 * for healthy storage work independently of capped polling and timeout tests.
 */
export async function runInProcess(
  argv: string[],
  box: Sandbox,
  extraEnv: NodeJS.ProcessEnv = {},
  options: Parameters<typeof runCli>[2] = { authCollectTimeoutMs: 2_000 },
): Promise<Run> {
  if (running) throw new Error("Concurrent CLI invocations require the subprocess helper");
  if (extraEnv.NODE_OPTIONS) throw new Error("Node startup options require the subprocess helper");
  running = true;
  const previousDirectory = process.cwd();
  const previousEnvironment = { ...process.env };
  const streams = [process.stdin, process.stdout];
  const terminalProperties = streams.map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  let stdout = "";
  let stderr = "";
  const io: Io = {
    out: (text) => { stdout += text; },
    err: (text) => { stderr += text; },
  };
  try {
    for (const stream of streams) Object.defineProperty(stream, "isTTY", { configurable: true, value: false });
    process.chdir(box.cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, box.env, extraEnv);
    const status = await runCli(argv, io, options);
    return { status, stdout, stderr, output: stdout + stderr };
  } finally {
    process.chdir(previousDirectory);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    streams.forEach((stream, index) => {
      const property = terminalProperties[index];
      if (property === undefined) Reflect.deleteProperty(stream, "isTTY");
      else Object.defineProperty(stream, "isTTY", property);
    });
    running = false;
  }
}
