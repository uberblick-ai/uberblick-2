/**
 * What each MCP client's configuration file looks like, and how to put one
 * server into it without disturbing the rest.
 *
 * Three clients, two formats. Claude Code and Cursor both keep a JSON object
 * under `mcpServers`; Codex keeps a TOML table called `[mcp_servers.<name>]`.
 * The paths and shapes here were checked against each vendor's own
 * documentation and against what each vendor's CLI actually writes.
 *
 * **Formatting.** The JSON path parses and re-serialises, reusing the file's own
 * indentation and its trailing-newline habit. That is the documented trade: an
 * ordinary config file comes back byte-for-byte, and JSON comments — which none
 * of these three write, and none of them promise to read — do not survive. A
 * format-preserving JSON dependency would buy that back, and adding a dependency
 * to keep somebody's comment is not a trade this repository makes. The TOML path
 * does no such thing: a Codex config is a *general* config file, where a rewrite
 * would take the user's model, sandbox and profile settings with it, so it edits
 * one table's lines and leaves every other byte alone.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The name uberblick registers itself under, in every client. */
export const SERVER_NAME = "uberblick";

/** The clients `ub mcp install` knows how to wire up. */
export const TARGETS = ["claude", "codex", "cursor"] as const;
export type TargetName = (typeof TARGETS)[number];

export type Scope = "project" | "user";

/** A program and its arguments — what the client will spawn. */
export interface Entry {
  command: string;
  args: string[];
}

/**
 * The line every client is pointed at.
 *
 * No arguments and no environment, ever: which workspace, which hub and which
 * credential apply is resolved by `ub` itself, from the layers `config.ts`
 * documents. A client config that pinned any of them would be a second,
 * stale copy of configuration that already has an owner.
 */
export const DEFAULT_ENTRY: Entry = { command: "ub", args: ["mcp", "serve"] };

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
 * add` agree about which file they are both talking about.
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
  const codexHome = env.CODEX_HOME?.trim();
  return scope === "project"
    ? { path: join(cwd, ".codex", "config.toml"), format: "toml" }
    : {
        path: join(
          codexHome === undefined || codexHome === ""
            ? join(home, ".codex")
            : codexHome,
          "config.toml",
        ),
        format: "toml",
      };
}

/** A file this command cannot edit without guessing. Reported, never repaired. */
export class UnusableConfig extends Error {}

/** What is registered under {@link SERVER_NAME} in a file already. */
export interface Found {
  /** The existing registration, rendered for a report, or null when absent. */
  existing: string | null;
  /** Whether what is there already runs exactly the proposed command. */
  matches: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- JSON ------------------------------------------------------------------

/**
 * Keys a stdio entry may carry and still count as the one `ub` installs.
 *
 * `claude mcp add` writes `type: "stdio"` and an empty `env`, and `ub` writes
 * neither, so equality has to be about what the client will *do* rather than
 * about the bytes — otherwise installing with the vendor CLI and then running
 * `ub mcp install` again would report a conflict with itself. Any key outside
 * this set (`cwd`, a URL transport, anything a future client adds) means the
 * entry is not understood, and an entry that is not understood is never
 * silently declared "already installed".
 */
const KNOWN_JSON_KEYS = new Set(["type", "command", "args", "env"]);

function jsonMatches(value: unknown, entry: Entry): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_JSON_KEYS.has(key)) {
      return false;
    }
  }
  const type = value.type;
  if (type !== undefined && type !== "stdio") {
    return false;
  }
  const env = value.env;
  if (env !== undefined && !(isPlainObject(env) && Object.keys(env).length === 0)) {
    return false;
  }
  const args = value.args ?? [];
  return (
    value.command === entry.command &&
    Array.isArray(args) &&
    args.length === entry.args.length &&
    args.every((arg, index) => arg === entry.args[index])
  );
}

function inspectJson(text: string, entry: Entry): Found {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new UnusableConfig(
      `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isPlainObject(doc)) {
    throw new UnusableConfig("its top level is not a JSON object");
  }
  const servers = doc.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) {
    throw new UnusableConfig('its "mcpServers" is not a JSON object');
  }
  const value = servers?.[SERVER_NAME];
  if (value === undefined) {
    return { existing: null, matches: false };
  }
  return {
    existing: JSON.stringify(value, null, 2),
    matches: jsonMatches(value, entry),
  };
}

/**
 * The file's own indentation, so a rewrite does not reflow somebody's config.
 * The first indented line of an object literal is its first key, at depth one.
 */
function indentOf(text: string | null): string | number {
  return text?.match(/\n([ \t]+)\S/)?.[1] ?? 2;
}

function serverObject(entry: Entry): Record<string, unknown> {
  // `type` is explicit because Cursor's documentation requires it for local
  // servers, and Claude Code accepts it — one object serves both.
  return { type: "stdio", command: entry.command, args: entry.args };
}

function withEntryJson(text: string | null, entry: Entry): string {
  const doc = text === null ? {} : (JSON.parse(text) as Record<string, unknown>);
  const servers = isPlainObject(doc.mcpServers) ? doc.mcpServers : {};
  // Spreading first keeps every other server where it was — and keeps *our*
  // key in its original position when this is a replacement rather than an add.
  doc.mcpServers = { ...servers, [SERVER_NAME]: serverObject(entry) };
  const eol = text === null || text.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify(doc, null, indentOf(text))}${eol}`;
}

function snippetJson(entry: Entry): string {
  return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: serverObject(entry) } }, null, 2)}\n`;
}

// --- TOML ------------------------------------------------------------------

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
 * The block `ub` writes, and the exact block `codex mcp add` writes for the same
 * server — which is what lets a second run recognise either one as installed.
 */
function tomlBlock(entry: Entry): string {
  const args = entry.args.map(tomlString).join(", ");
  return (
    `[mcp_servers.${SERVER_NAME}]\n` +
    `command = ${tomlString(entry.command)}\n` +
    `args = [${args}]\n`
  );
}

/** A table header line, with its dotted key normalised of quotes and spaces. */
function tableHeader(line: string): string | null {
  const inside = line.match(/^\s*\[([^[\]]*)\]\s*$/)?.[1];
  return inside === undefined ? null : inside.replace(/["'\s]/g, "");
}

/** The bare key an assignment line binds, if the line is an assignment. */
function assignedKey(line: string): string | null {
  return line.match(/^\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*=/)?.slice(1).find((v) => v !== undefined) ?? null;
}

const OUR_TABLE = `mcp_servers.${SERVER_NAME}`;

/**
 * The lines `[mcp_servers.uberblick]` owns: its header, its keys, and any
 * sub-table of it such as `[mcp_servers.uberblick.env]`.
 *
 * Returns a half-open line range, or null when the table is not in the file.
 *
 * @throws UnusableConfig when the table appears twice (not valid TOML, and
 * there is no right answer for which copy to replace), or when `mcp_servers` or
 * our own key is written as an inline value instead of a table — splicing a
 * table header in beside an inline definition would give Codex a duplicate key
 * and take its whole configuration down with it.
 */
function ourRegion(lines: string[]): { start: number; end: number } | null {
  let table = "";
  let found: { start: number; end: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const header = tableHeader(line);
    if (header !== null) {
      table = header;
      if (header === OUR_TABLE) {
        if (found !== null) {
          throw new UnusableConfig(`it defines [${OUR_TABLE}] more than once`);
        }
        found = { start: index, end: lines.length };
      } else if (found !== null && found.end === lines.length && !header.startsWith(`${OUR_TABLE}.`)) {
        found.end = index;
      }
      continue;
    }
    const key = assignedKey(line);
    if (key === null) {
      continue;
    }
    if (table === "" && key === "mcp_servers") {
      throw new UnusableConfig(
        "it writes `mcp_servers` as an inline value rather than as tables",
      );
    }
    if (table === "mcp_servers" && key === SERVER_NAME) {
      throw new UnusableConfig(
        `it writes \`${SERVER_NAME}\` as an inline value under [mcp_servers] ` +
          `rather than as a [${OUR_TABLE}] table`,
      );
    }
  }
  return found;
}

/**
 * Whether the existing block is the one we would write.
 *
 * Byte equality of the block, not a semantic comparison — because `ub` and
 * `codex mcp add` emit identical blocks, so anything else came from a hand edit,
 * and reporting a hand edit as a difference to confirm is the safe answer. There
 * is no TOML parser here to tell "the same table, formatted differently" from
 * "a table that does something else".
 */
function inspectToml(text: string, entry: Entry): Found {
  const lines = text.split("\n");
  const region = ourRegion(lines);
  if (region === null) {
    return { existing: null, matches: false };
  }
  const block = lines.slice(region.start, region.end).join("\n").replace(/\s+$/, "");
  return { existing: block, matches: `${block}\n` === tomlBlock(entry) };
}

function withEntryToml(text: string | null, entry: Entry): string {
  const block = tomlBlock(entry);
  if (text === null || text.trim() === "") {
    return block;
  }
  const lines = text.split("\n");
  const region = ourRegion(lines);
  if (region !== null) {
    const rest = lines.slice(region.end);
    return [...lines.slice(0, region.start), ...block.split("\n").slice(0, -1), ...rest].join("\n");
  }
  const separator = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${block}`;
}

// --- the format-neutral surface --------------------------------------------

/**
 * What is registered under our name already.
 *
 * @throws UnusableConfig when the file cannot be edited without guessing.
 */
export function inspect(format: Format, text: string, entry: Entry): Found {
  return format === "json" ? inspectJson(text, entry) : inspectToml(text, entry);
}

/** The file's full contents with our entry installed. `null` means a new file. */
export function withEntry(
  format: Format,
  text: string | null,
  entry: Entry,
): string {
  return format === "json"
    ? withEntryJson(text, entry)
    : withEntryToml(text, entry);
}

/** What `--print` writes: a snippet valid for the named target, and nothing else. */
export function snippet(format: Format, entry: Entry): string {
  return format === "json" ? snippetJson(entry) : tomlBlock(entry);
}
