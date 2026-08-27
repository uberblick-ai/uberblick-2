/**
 * What each MCP client's configuration file looks like, and how to tell whether
 * one already registers uberblick.
 *
 * Three clients, two formats. Claude Code and Cursor both keep a JSON object
 * under `mcpServers`; Codex keeps a TOML table called `[mcp_servers.<name>]`.
 * The paths and shapes here were checked against each vendor's own
 * documentation and against what each vendor's CLI actually writes.
 *
 * **Nothing here writes a config file.** `ub mcp install` either runs the
 * vendor's own CLI or prints a snippet for somebody to paste, so the only
 * question this module asks of an existing file is {@link presence}: is our
 * entry there, and is it the one we would register. `JSON.parse` and a scan for
 * the one TOML header we own are enough for that — a file nothing splices needs
 * no byte-preserving splicer.
 *
 * **Nothing echoes a value back.** {@link presence} answers with one of four
 * words and never with anything it read. A config file is exactly where
 * somebody keeps an API token, and a diagnostic that quotes one onto a terminal
 * has leaked it — so a file this cannot read is `unusable`, named by path and
 * described no further: not the parser's complaint, not a line of it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The name uberblick registers itself under, in every client. */
export const SERVER_NAME = "uberblick";

/** The clients `ub mcp install` knows how to wire up. */
export const TARGETS = ["claude", "codex", "cursor"] as const;
export type TargetName = (typeof TARGETS)[number];

export type Scope = "project" | "user";

/** A server as a client registers it: a name, and the program it spawns. */
export interface Entry {
  /**
   * The key it is registered under — {@link SERVER_NAME} for the entry `ub`
   * installs by default, `uberblick-<label>` for a workspace-pinned one.
   */
  name: string;
  command: string;
  args: string[];
  /**
   * Environment pinned into the entry, absent for the unpinned one.
   *
   * The only value that ever goes here is `WORKSPACE_ID`, and only when
   * `--workspace` said so: which workspace a project's entry serves is the one
   * thing a client config can say that `ub` cannot work out for itself. No
   * endpoint, no credential, ever.
   */
  env?: Record<string, string>;
}

/**
 * The line every client is pointed at.
 *
 * No arguments and no environment: which workspace, which hub and which
 * credential apply is resolved by `ub` itself, from the layers `config.ts`
 * documents. A client config that pinned the hub or the credential would be a
 * second, stale copy of configuration that already has an owner. `WORKSPACE_ID`
 * is the exception `--workspace` writes — see `install.ts`. This one never
 * carries configuration.
 */
export const DEFAULT_ENTRY: Entry = {
  name: SERVER_NAME,
  command: "ub",
  args: ["mcp", "serve"],
};

export type Format = "json" | "toml";

export interface TargetFile {
  path: string;
  format: Format;
}

/**
 * Where a target keeps the configuration for one scope.
 *
 * `--project` is relative to the working directory and `--user` to the home
 * directory, except for Codex, which lets `CODEX_HOME` move its whole
 * configuration directory — and honouring that is what lets `ub` and `codex mcp
 * add` agree about which file they are both talking about, in either scope.
 */
export function targetFile(
  target: TargetName,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): TargetFile {
  const home = env.HOME?.trim() || homedir();
  if (target === "claude") {
    return scope === "project"
      ? { path: join(cwd, ".mcp.json"), format: "json" }
      : // User scope is the top level of `~/.claude.json`, alongside the
        // per-project `projects` map that holds *local*-scope servers.
        { path: join(home, ".claude.json"), format: "json" };
  }
  if (target === "cursor") {
    return scope === "project"
      ? { path: join(cwd, ".cursor", "mcp.json"), format: "json" }
      : { path: join(home, ".cursor", "mcp.json"), format: "json" };
  }
  const configured = env.CODEX_HOME?.trim();
  return scope === "project"
    ? { path: join(codexHome(cwd), "config.toml"), format: "toml" }
    : {
        path: join(
          configured === undefined || configured === ""
            ? join(home, ".codex")
            : configured,
          "config.toml",
        ),
        format: "toml",
      };
}

/**
 * The Codex configuration directory a project scope means.
 *
 * `codex mcp add` writes whatever `CODEX_HOME` names, and this is the value
 * `install.ts` gives it — so the file this module reads and the file the vendor
 * writes are the same file by construction.
 */
export function codexHome(cwd: string): string {
  return join(cwd, ".codex");
}

/** What a client's config already holds under one entry's name. */
export type Presence =
  /** Nothing there: no file, or a file that registers nothing of ours. */
  | "absent"
  /** Exactly the entry this would register. */
  | "ours"
  /** Something else under our name; not ours to replace. */
  | "foreign"
  /**
   * The file is there and this cannot read it. Distinct from `absent` because
   * the two lead somewhere different: absent means go ahead, unusable means a
   * file exists whose contents nobody here knows — reported by path, never
   * delegated to a vendor CLI that would write over it.
   */
  | "unusable";

/**
 * Whether `file` already registers `entry`, and whether it is ours.
 *
 * The whole read side of `ub mcp install`, and of `ub doctor`'s MCP check. A
 * file that is not there is `absent`; a file that is there and will not open or
 * will not parse is `unusable`, which is a different answer for a different
 * reason: the caller may not treat a file it cannot read as an empty one.
 */
export function presence(file: TargetFile, entry: Entry): Presence {
  let text: string;
  try {
    text = readFileSync(file.path, "utf8");
  } catch (error) {
    // Not there is nobody's install; anything else — a directory, a mode that
    // refuses us — is a file that exists and has not been read.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unusable";
  }
  if (file.format === "toml") {
    const table = tomlTable(text, entry.name);
    if (table === null) return "absent";
    return table === tomlBlock(entry).trim() ? "ours" : "foreign";
  }
  let registered: unknown;
  try {
    const doc = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    registered = doc?.mcpServers?.[entry.name];
  } catch {
    return "unusable";
  }
  if (registered === undefined) return "absent";
  return jsonMatches(registered, entry) ? "ours" : "foreign";
}

/**
 * Keys a stdio entry may carry and still count as the one `ub` installs.
 *
 * `claude mcp add` writes `type: "stdio"` and an empty `env`, and a hand-pasted
 * snippet writes neither, so equality has to be about what the client will *do*
 * rather than about the bytes — otherwise installing with the vendor CLI and
 * then running `ub mcp install` again would report a conflict with itself. Any
 * key outside this set (`cwd`, a URL transport, anything a future client adds)
 * means the entry is not understood, and an entry that is not understood is
 * never silently declared "already installed".
 */
const KNOWN_JSON_KEYS = new Set(["type", "command", "args", "env"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonMatches(held: unknown, entry: Entry): boolean {
  if (!isObject(held)) return false;
  if (Object.keys(held).some((key) => !KNOWN_JSON_KEYS.has(key))) return false;
  if (held.type !== undefined && held.type !== "stdio") return false;
  const args = held.args ?? [];
  // Absent and empty are the same unpinned entry, spelled two ways; a pin has
  // to be the same variable set to the same workspace, because the pin is the
  // whole reason a second entry exists. Anything that is not an object — `null`,
  // an array, a string, a number — is not an environment at all, and an entry
  // this does not understand is never declared "already installed".
  if (held.env !== undefined && !isObject(held.env)) return false;
  const heldEnv = held.env ?? {};
  const env = Object.entries(heldEnv);
  const wanted = Object.entries(entry.env ?? {});
  return (
    held.command === entry.command &&
    Array.isArray(args) &&
    args.length === entry.args.length &&
    args.every((arg, index) => arg === entry.args[index]) &&
    env.length === wanted.length &&
    wanted.every(([key, value]) => heldEnv[key] === value)
  );
}

/**
 * A plain table header's dotted key, or null when the line is not one.
 *
 * `[mcp_servers.uberblick]`, `[mcp_servers."uberblick"]`, `[ mcp_servers.uberblick ]`
 * and `[mcp_servers.uberblick] # note` are one table spelled four ways, and an
 * exact-string match reads three of them as "no entry here" — which would send
 * `codex mcp add` at a file that already has one, to replace it. An
 * array-of-tables header (`[[…]]`) is deliberately not one of these: it names
 * something else.
 */
function tableKey(line: string): string[] | null {
  const match = /^\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/.exec(line.trim());
  if (match === null) return null;
  return (match[1] as string)
    .split(".")
    .map((part) => part.trim().replace(/^(["'])(.*)\1$/, "$2"));
}

/**
 * How many key parts a header adds under `[mcp_servers.<name>]` — 0 for the
 * table itself, 1 for its `env` sub-table — or null for any other table.
 */
function ownedBy(line: string, name: string): number | null {
  const key = tableKey(line);
  if (key === null || key[0] !== "mcp_servers" || key[1] !== name) return null;
  return key.length - 2;
}

/**
 * The lines `[mcp_servers.<name>]` owns — its keys and its `env` sub-table —
 * trimmed, or null when the header is not there.
 *
 * Only a header found here is compared, and the comparison is byte for byte
 * against what `codex mcp add` writes: a table spelled any other way is
 * therefore `foreign` rather than `absent`, which is the conservative answer.
 * Refusing a registration this cannot prove is ours costs somebody one manual
 * paste; treating it as absent costs them their entry.
 */
function tomlTable(text: string, name: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => ownedBy(line, name) === 0);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] as string;
    if (line.trimStart().startsWith("[")) {
      const depth = ownedBy(line, name);
      if (depth === null || depth === 0) break;
    }
    end += 1;
  }
  return lines.slice(start, end).join("\n").trim();
}

/**
 * A TOML basic string.
 *
 * `JSON.stringify` is the whole implementation because a JSON string *is* a TOML
 * basic string: TOML's escape set — `\b \t \n \f \r \" \\ \uXXXX` — contains
 * every escape JSON emits, including the `\u00XX` form JSON uses for the control
 * characters TOML also forbids raw. Only reachable with a `--` override, whose
 * words are whatever the caller typed, so it does have to hold up.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The block to paste into a Codex config, byte for byte what `codex mcp add`
 * writes for the same server — which is what lets a second run recognise either
 * one as installed. The pin is a sub-table because that is where Codex puts it.
 */
function tomlBlock(entry: Entry): string {
  const args = entry.args.map(tomlString).join(", ");
  const pinned = Object.entries(entry.env ?? {});
  // The table name and any pinned variable are bare keys by construction — the
  // names are `uberblick` and `uberblick-<label>`, and the only variable is
  // `WORKSPACE_ID` — so neither needs quoting here.
  return (
    `[mcp_servers.${entry.name}]\n` +
    `command = ${tomlString(entry.command)}\n` +
    `args = [${args}]\n` +
    (pinned.length === 0
      ? ""
      : `\n[mcp_servers.${entry.name}.env]\n${pinned
          .map(([key, value]) => `${key} = ${tomlString(value)}\n`)
          .join("")}`)
  );
}

function serverObject(entry: Entry): Record<string, unknown> {
  // `type` is explicit because Cursor's documentation requires it for local
  // servers, and Claude Code accepts it — one object serves both. `env` is
  // written only when there is one, so an unpinned entry stays exactly the
  // three keys it has always been.
  const object: Record<string, unknown> = {
    type: "stdio",
    command: entry.command,
    args: entry.args,
  };
  if (entry.env !== undefined) {
    object.env = entry.env;
  }
  return object;
}

/** What `ub mcp install` prints: a snippet valid for the named target. */
export function snippet(format: Format, entry: Entry): string {
  return format === "json"
    ? `${JSON.stringify({ mcpServers: { [entry.name]: serverObject(entry) } }, null, 2)}\n`
    : tomlBlock(entry);
}
