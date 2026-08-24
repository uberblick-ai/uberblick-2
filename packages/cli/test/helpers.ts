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

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root, so a test can spawn `bin/ub.mjs` the way a user would. */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const UB_BIN = join(PACKAGE_ROOT, "bin", "ub.mjs");

/** Everything `ub` resolves from the environment, removed before every run. */
const RESOLVED_VARIABLES = [
  "WORKSPACE_ID",
  "HUB_URL",
  "HUB_AUTH_TOKEN",
  "UBERBLICK_DB",
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
  /** `./uberblick.json` in the sandbox working directory. */
  directoryFile?: unknown;
  /** Raw text instead of JSON, for the malformed-file cases. */
  raw?: { userConfig?: string; credentials?: string; directoryFile?: string };
  /** Mode to force on credentials.json after writing it. */
  credentialsMode?: number;
}

export interface Sandbox {
  /** The working directory `ub` runs in — where `./uberblick.json` lives. */
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
  const directoryPath = join(cwd, "uberblick.json");

  if (files.userConfig !== undefined) writeJson(userConfigPath, files.userConfig);
  if (files.credentials !== undefined) writeJson(credentialsPath, files.credentials);
  if (files.directoryFile !== undefined) writeJson(directoryPath, files.directoryFile);
  if (files.raw?.userConfig !== undefined) writeText(userConfigPath, files.raw.userConfig);
  if (files.raw?.credentials !== undefined) writeText(credentialsPath, files.raw.credentials);
  if (files.raw?.directoryFile !== undefined) writeText(directoryPath, files.raw.directoryFile);
  if (files.credentialsMode !== undefined) chmodSync(credentialsPath, files.credentialsMode);

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

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Both streams, for "this string appears nowhere" assertions. */
  output: string;
}

/** Run `ub` to completion in a sandbox. */
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

/** A hub address nothing listens on: `ub status` must not wait on the network. */
export const DEAD_HUB_URL = "ws://127.0.0.1:1";
