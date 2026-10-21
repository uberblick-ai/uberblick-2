import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findCheckoutRoot } from "./checkout.js";
import { takeHelp } from "./help.js";
import { isInstallPayload } from "./version.js";
import type { Io } from "./io.js";
import { errorMessage } from "./strings.js";
import { useField } from "./workspace-use-output.js";

const FORMULA = "uberblick-ai/tap/uberblick";

const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export const UPDATE_HELP = `usage: ub update

Update a Homebrew installation: \`brew update\`, then
\`brew upgrade ${FORMULA}\`. Which copy that is comes from where
\`ub\`'s own files live, never from the current directory.

A source checkout is not updated. Run \`git pull\`, then \`mise run setup\`
to update it instead. \`ub update\` leaves the checkout unchanged.

options:
  -h, --help        show this help
`;

export type Installation =
  | { kind: "homebrew"; prefix: string }
  | { kind: "checkout"; root: string }
  | { kind: "unknown" };

/**
 * Inject the CLI location: a spawned checkout process cannot fake import.meta.url
 * to exercise another installation without accidentally classifying itself.
 */
export interface UpdateHost {
  /** Where the running CLI's own files live. */
  cliDir: string;
  /** Whether those files came from a versioned install payload. */
  installPayload: boolean;
  /** Read Homebrew's installation prefix or installed formula information. */
  capture(command: string, args: readonly string[]): CaptureResult;
  /** Run a command to completion; `null` when it exited 0, else why not. */
  run(command: string, args: readonly string[], cwd?: string): Promise<string | null>;
}

export interface CaptureResult {
  /** Null when the command could not be run at all. */
  status: number | null;
  stdout: string;
  stderr: string;
}

function named(command: string, args: readonly string[]): string {
  return `\`${[command, ...args].join(" ")}\``;
}

export function processHost(): UpdateHost {
  return {
    cliDir: dirname(fileURLToPath(import.meta.url)),
    installPayload: isInstallPayload(),
    capture(command, args) {
      const result = spawnSync(command, args, { encoding: "utf8" });
      return {
        status: result.error === undefined ? result.status : null,
        stdout: result.stdout ?? "",
        stderr: result.error === undefined ? (result.stderr ?? "") : errorMessage(result.error),
      };
    },
    run(command, args, cwd) {
      const label = named(command, args);
      return new Promise((done) => {
        const child = spawn(command, args, { cwd, stdio: ["ignore", 2, 2] });

        // Forward signals and await Homebrew exit; Node's default would orphan it.
        const forward = SIGNALS.map((signal) => {
          const stop = (): void => {
            child.kill(signal);
          };
          process.on(signal, stop);
          return { signal, stop };
        });
        const finish = (result: string | null): void => {
          for (const { signal, stop } of forward) process.off(signal, stop);
          done(result);
        };

        child.on("error", (error) => finish(`${label} could not be run (${errorMessage(error)})`));
        child.on("close", (status, signal) =>
          finish(
            status === 0
              ? null
              : signal !== null
                ? `${label} was killed by ${signal}`
                : `${label} exited ${status ?? 1}`,
          ),
        );
      });
    },
  };
}

/** Whether `child` is `parent` or lies inside it, both taken as real paths. */
function within(parent: string, child: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const root = real(parent);
  const inner = real(child);
  return inner === root || inner.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Require the payload to lie under Homebrew's reported prefix. An archive
 * unpacked elsewhere is not owned by Homebrew and brew upgrade cannot replace it.
 */
function classify(host: UpdateHost): Installation {
  // A payload inside a checkout still belongs to the payload, not its ancestor.
  if (host.installPayload) {
    const prefix = homebrewPrefix(host);
    return prefix === null ? { kind: "unknown" } : { kind: "homebrew", prefix };
  }
  const root = findCheckoutRoot(host.cliDir);
  if (root !== null) return { kind: "checkout", root };
  return { kind: "unknown" };
}

function homebrewPrefix(host: UpdateHost): string | null {
  const prefix = host.capture("brew", ["--prefix"]);
  if (prefix.status !== 0) return null;
  const dir = prefix.stdout.trim();
  return dir !== "" && within(dir, host.cliDir) ? dir : null;
}

const UNSUPPORTED =
  "ub update: this `ub` is neither a Homebrew installation nor a checkout of " +
  "the uberblick repository. `ub update` only updates Homebrew installations, " +
  `installed with \`brew install ${FORMULA}\`. Nothing has changed.\n`;

/** Report expected installation and Homebrew failures without throwing. */
export async function updateCommand(
  argv: string[],
  io: Io,
  host: UpdateHost = processHost(),
): Promise<number> {
  if (takeHelp(argv, io, UPDATE_HELP)) return 0;
  if (argv.length > 0) {
    io.err(`ub update: expected no arguments, got ${JSON.stringify(argv[0])}\n\n${UPDATE_HELP}`);
    return 2;
  }

  const installation = classify(host);
  if (installation.kind === "homebrew") return await updateHomebrew(io, host, installation.prefix);
  if (installation.kind === "checkout") {
    io.err(
      "ub update: this `ub` runs from a source checkout. Run `git pull`, then " +
        "`mise run setup` to update it. Nothing has changed.\n",
    );
    return 1;
  }
  io.err(UNSUPPORTED);
  return 1;
}

function homebrewVersion(io: Io, host: UpdateHost): string | null {
  const args = ["info", "--json=v2", FORMULA];
  const result = host.capture("brew", args);
  io.err(result.stderr);
  const label = named("brew", args);
  if (result.status !== 0) {
    const failure = result.status === null ? "could not be run" : `exited ${result.status}`;
    io.err(`ub update: ${label} ${failure}.\n`);
    return null;
  }
  try {
    // `installed` includes old kegs; `linked_keg` is the active version and
    // already includes Homebrew's formula revision (for example `0.42.0_1`).
    const version: unknown = JSON.parse(result.stdout)?.formulae?.[0]?.linked_keg;
    if (typeof version === "string" && version.trim() !== "") return version;
  } catch {
    // Unreadable formula information is a failed Homebrew step too.
  }
  io.err(`ub update: ${label} did not report a linked installed version.\n`);
  return null;
}

async function updateHomebrew(io: Io, host: UpdateHost, prefix: string): Promise<number> {
  const before = homebrewVersion(io, host);
  if (before === null) return 1;
  for (const args of [["update"], ["upgrade", FORMULA]]) {
    const failure = await host.run("brew", args);
    if (failure !== null) {
      io.err(`ub update: ${failure}.\n`);
      return 1;
    }
  }
  const after = homebrewVersion(io, host);
  if (after === null) return 1;
  const result = before === after
    ? useField("current", `${after}, nothing to update`)
    : `${useField("updated", `${before} → ${after}`)}restart ub open and running agents to use it\n`;
  io.out(useField("copy", `Homebrew (${prefix})`) + result);
  return 0;
}
