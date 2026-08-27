/**
 * Test rig.
 *
 * The interesting behaviour of a CLI is what a process does — its exit code,
 * what lands on stdout, what lands on stderr — so most suites here spawn the
 * real `ub` binary against a throwaway XDG home rather than calling a function.
 *
 * The inherited environment is scrubbed of every variable `ub` resolves. A
 * developer running these tests almost certainly has `HUB_URL` and
 * `HUB_AUTH_TOKEN` exported (that is what `fnox exec` and `mise` do), and
 * `HUB_AUTH_TOKEN` alone would turn every "no configuration" assertion into a
 * test of their machine — including a hub connection to their real corpus.
 */

import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root, so a test can spawn `bin/ub.mjs` the way a user would. */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const UB_BIN = join(PACKAGE_ROOT, "bin", "ub.mjs");

/** The repository root, so a test can read the real `.gitignore`. */
export const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

/** Everything `ub` resolves from the environment, removed before every run. */
const RESOLVED_VARIABLES = [
  "WORKSPACE_ID",
  "HUB_URL",
  "HUB_AUTH_TOKEN",
  "UBERBLICK_DB",
  // `ub status` reports the database a hub started here would open, and
  // `ub open` starts one with it — and inside this checkout mise exports it
  // from `[env]` for every contributor and every CI run, so leaving it in
  // would make those assertions a test of the runner's mise config. A suite
  // that wants one passes it through `extraEnv`, which is applied after this.
  "HUB_DB_PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

const tempDirs: string[] = [];

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface SandboxFiles {
  /** `$XDG_CONFIG_HOME/uberblick/config.json`. */
  userConfig?: unknown;
  /** `$XDG_CONFIG_HOME/uberblick/credentials.json`. */
  credentials?: unknown;
  /** Raw text instead of JSON, for the malformed-file cases. */
  raw?: { userConfig?: string; credentials?: string };
  /**
   * Mode to force on credentials.json instead of the 0600 a correct install
   * has — how a test asks for a file `ub` is supposed to refuse.
   */
  credentialsMode?: number;
  /**
   * Make the working directory look like an uberblick checkout: `mise.toml` and
   * a root `package.json` named `uberblick`, which is what `ub init` requires
   * before it writes a derived mise config into a directory. Both markers are
   * needed, so a bare mise project does not qualify.
   */
  checkout?: boolean;
}

export interface Sandbox {
  /** The working directory `ub` runs in. */
  cwd: string;
  configHome: string;
  dataHome: string;
  /** A scrubbed environment pointing at this sandbox. */
  env: NodeJS.ProcessEnv;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function sandbox(files: SandboxFiles = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "uberblick-cli-"));
  tempDirs.push(root);

  const cwd = join(root, "checkout");
  const configHome = join(root, "config");
  const dataHome = join(root, "data");
  mkdirSync(cwd, { recursive: true });

  const userConfigPath = join(configHome, "uberblick", "config.json");
  const credentialsPath = join(configHome, "uberblick", "credentials.json");

  if (files.checkout === true) {
    writeText(join(cwd, "mise.toml"), "[env]\n");
    writeJson(join(cwd, "package.json"), { name: "uberblick", private: true });
  }
  if (files.userConfig !== undefined) writeJson(userConfigPath, files.userConfig);
  if (files.credentials !== undefined) writeJson(credentialsPath, files.credentials);
  if (files.raw?.userConfig !== undefined) writeText(userConfigPath, files.raw.userConfig);
  if (files.raw?.credentials !== undefined) writeText(credentialsPath, files.raw.credentials);

  // A credentials file others can read is refused, so the sandbox writes the
  // mode a correct install has — `writeFileSync` would leave it at the umask's
  // 0644 and quietly make every credential test a test of the refusal path.
  const wroteCredentials =
    files.credentials !== undefined || files.raw?.credentials !== undefined;
  if (wroteCredentials || files.credentialsMode !== undefined) {
    chmodSync(credentialsPath, files.credentialsMode ?? 0o600);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of RESOLVED_VARIABLES) {
    delete env[key];
  }
  // HOME too: it is where the XDG defaults point, so a test that forgets to set
  // XDG_CONFIG_HOME must still not read the developer's real configuration.
  env.HOME = root;
  env.XDG_CONFIG_HOME = configHome;
  env.XDG_DATA_HOME = dataHome;

  return { cwd, configHome, dataHome, env };
}

/**
 * Point this sandbox's machine at an endpoint, the way `ub remote join` leaves
 * it.
 *
 * The endpoint has one authority — this machine's `config.json` — so a test
 * that needs a run to dial an ephemeral port writes it there. `HUB_URL` in the
 * environment is not a layer and is not read (#385).
 */
export function pointAt(box: Sandbox, hubUrl: string): void {
  const path = join(box.configHome, "uberblick", "config.json");
  mkdirSync(dirname(path), { recursive: true });
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // Absent, which is the ordinary case for a fresh sandbox.
  }
  writeFileSync(path, `${JSON.stringify({ ...current, hubUrl }, null, 2)}\n`, {
    mode: 0o600,
  });
}

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Both streams, for "this string appears nowhere" assertions. */
  output: string;
}

/**
 * Run `ub` to completion in a sandbox.
 *
 * **`spawnSync` blocks this process's event loop.** A test that runs a hub
 * in-process and then calls this will watch the child fail to connect to it and
 * report `hub-down` against a hub that is, from anywhere else, plainly up —
 * because nothing in this process can accept the connection until the child has
 * exited. Use {@link runUbAsync} whenever the `ub` under test has to talk to
 * something this process is serving.
 */
export function runUb(
  args: string[],
  box: Sandbox,
  extraEnv: NodeJS.ProcessEnv = {},
): Run {
  const result: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [UB_BIN, ...args],
    {
      cwd: box.cwd,
      env: { ...box.env, ...extraEnv },
      encoding: "utf8",
      timeout: 25_000,
    },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
}

/**
 * Which `ub` command a run was, for a diagnostic — the subcommand path only.
 *
 * Never the whole argument list: `ub remote join` takes a URL, and the URLs the
 * remote suite feeds it carry passwords and tokens on purpose. A message that
 * echoed argv would print one into CI output the first time a machine was slow,
 * which is the leak those very tests exist to forbid.
 */
function commandOf(args: string[]): string {
  const path: string[] = [];
  for (const token of args) {
    if (token.startsWith("-") || path.length === 2) break;
    path.push(token);
  }
  return path.join(" ");
}

/**
 * The same, without blocking — so a test can have two `ub` processes racing each
 * other, which is the only way to observe what concurrent runs do to a file they
 * both write.
 */
export function runUbAsync(
  args: string[],
  box: Sandbox,
  extraEnv: NodeJS.ProcessEnv = {},
  // A bridge command against a hub that never answers spends its whole sync
  // budget before it can honestly refuse, which is longer than any other `ub`
  // invocation takes.
  timeoutMs = 25_000,
  // Everything the run has said on stderr so far, on every chunk. How a test
  // waits for the run to reach a point it announces — a lock it has started
  // waiting for — instead of guessing at it with a sleep.
  onStderr: (stderr: string) => void = () => {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [UB_BIN, ...args], {
      cwd: box.cwd,
      env: { ...box.env, ...extraEnv },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      onStderr(stderr);
    });
    child.on("error", reject);
    // `close`, not `exit`: both pipes have to be drained before the output is
    // complete, and a test asserting "the secret appears nowhere" on a truncated
    // capture would pass for the wrong reason.
    child.on("close", (status) => {
      // `killed` rather than a signal: `spawn`'s timeout is the only thing that
      // kills this child, and a process that died of a signal nobody sent it
      // crashed — reporting that as slowness would send the reader after the
      // wrong bug. Say which run ran out of time, because a bare null status
      // reads as a crash too.
      if (child.killed) {
        stderr += `\ntimed out waiting for \`ub ${commandOf(args)}\` to exit within ${timeoutMs}ms\n`;
      }
      resolve({ status, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

/** A hub address nothing listens on: `ub status` must not wait on the network. */
export const DEAD_HUB_URL = "ws://127.0.0.1:1";

/**
 * How long one awaited condition gets before the wait gives up.
 *
 * Generous rather than tight, and deliberately so: these suites spawn real
 * processes that bind real sockets and open real SQLite files, and the review
 * container runs every package's suite at once on whatever cores are left. A
 * deadline sized for a quiet machine turns load into a red gate, which trains
 * everyone to re-run — and a re-run habit is how a real regression eventually
 * walks through. What has to stay sharp is the *message*, not the clock: a wait
 * that expires still names the condition it was waiting for, so a genuine hang
 * is still reported as one, just later.
 */
export const WAIT_TIMEOUT_MS = 30_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for `predicate`, polling. Throws with `label` on timeout. */
export async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(25);
  }
}
