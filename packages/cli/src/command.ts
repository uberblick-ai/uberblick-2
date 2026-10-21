import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { Io } from "./io.js";
import type { UpdateHost } from "./update.js";

export type CommandArgs<Options extends ParseArgsOptionsConfig = ParseArgsOptionsConfig> =
  ReturnType<typeof parseArgs<{ options: Options; allowPositionals: true }>>;

export interface RunOptions {
  authCollectTimeoutMs?: number;
  updateHost?: UpdateHost;
}

export class UsageError extends Error {
  constructor(message: string, readonly recovery?: string, readonly path?: string) {
    super(message);
  }
}

export function usageError(message: string, recovery?: string, path?: string): never {
  throw new UsageError(message, recovery, path);
}

interface CommandPath {
  path: readonly string[];
}

export interface CommandGroup extends CommandPath {
  help: string;
  children: readonly Command[];
  unknownCommand?: (child: string) => string;
  version?: () => string;
}

interface Parsing {
  options: ParseArgsOptionsConfig;
  positionals: false | {
    min: number;
    max: number;
    error: string | ((positionals: string[]) => string);
  };
  argumentError?: (argv: string[]) => string | undefined;
  parseError?: (error: unknown) => string;
  errorPath?: string;
}

interface HumanCommand extends CommandPath, Parsing {
  help: string;
  hidden?: false;
  run: (args: CommandArgs, io: Io, options: RunOptions) => number | Promise<number>;
}

interface HiddenCommand extends CommandPath, Parsing {
  hidden: true;
  help?: never;
  run: (err: Io["err"]) => number | Promise<number>;
}

export type Command = CommandGroup | HumanCommand | HiddenCommand;

export function command<Options extends ParseArgsOptionsConfig>(definition:
  Omit<HumanCommand, "options" | "run"> & {
    options: Options;
    run: (args: CommandArgs<Options>, io: Io, options: RunOptions) => number | Promise<number>;
  },
): HumanCommand {
  return { ...definition, run: (args, io, options) => definition.run(args as CommandArgs<Options>, io, options) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printUsageError(entry: Command, error: UsageError, io: Io): number {
  const path = error.path ?? ("errorPath" in entry ? entry.errorPath : undefined) ?? entry.path.join(" ");
  io.err(`ub${path === "" ? "" : ` ${path}`}: ${error.message.trimEnd()}\n${entry.help === undefined ? "" : `\n${entry.help}`}${error.recovery === undefined ? "" : `${error.recovery}\n`}`);
  return 2;
}

/** Resolve children before scanning leaf arguments; `--` ends only that scan. */
export async function dispatchCommand(
  entry: Command, argv: string[], io: Io, options: RunOptions = {},
): Promise<number> {
  if ("children" in entry) {
    const [child, ...rest] = argv;
    if (child === undefined || child === "help" || child === "--help" || child === "-h") {
      io.out(entry.help);
      return 0;
    }
    if ((child === "--version" || child === "-v") && entry.version !== undefined) {
      io.out(`${entry.version()}\n`);
      return 0;
    }
    const next = entry.children.find(candidate => candidate.path.at(-1) === child);
    return next === undefined
      ? printUsageError(entry, new UsageError(entry.unknownCommand?.(child) ?? `unknown command ${JSON.stringify(child)}`), io)
      : dispatchCommand(next, rest, io, options);
  }

  if (!entry.hidden) {
    for (const arg of argv) {
      if (arg === "--") break;
      if (arg === "--help" || arg === "-h") {
        io.out(entry.help);
        return 0;
      }
    }
  }
  try {
    const argumentError = entry.argumentError?.(argv);
    if (argumentError !== undefined) usageError(argumentError);
    let parsed: CommandArgs;
    try {
      parsed = parseArgs({ args: argv, options: entry.options, allowPositionals: entry.positionals !== false });
    } catch (error) {
      usageError(entry.parseError?.(error) ?? errorMessage(error));
    }
    if (entry.positionals !== false &&
      (parsed.positionals.length < entry.positionals.min || parsed.positionals.length > entry.positionals.max)) {
      usageError(typeof entry.positionals.error === "string"
        ? entry.positionals.error : entry.positionals.error(parsed.positionals));
    }
    return await (entry.hidden ? entry.run(io.err) : entry.run(parsed, io, options));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return printUsageError(entry, error, io);
  }
}
