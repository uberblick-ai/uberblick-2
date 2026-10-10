/**
 * What each MCP client's configuration file looks like, and how to tell whether
 * one already registers uberblick.
 *
 * Two clients, two formats. Claude Code keeps a JSON object under `mcpServers`;
 * Codex keeps a TOML table called `[mcp_servers.<name>]`.
 * The paths and shapes here were checked against each vendor's own
 * documentation and against what each vendor's CLI actually writes.
 *
 * **Nothing here writes a config file.** `ub mcp install` either runs the
 * vendor's own CLI or prints a snippet for somebody to paste. Install asks
 * {@link presence} whether our entry is there and matches what it would register.
 * Doctor reads only the binding variables through {@link doctorEntry}, using
 * JSON or TOML parsing and shared entry validation. Install parses TOML with
 * the same options before comparing the entry. No config is edited, so no
 * byte-preserving splicer is needed.
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
import { parse as parseToml } from "smol-toml";

/** The name uberblick registers itself under, in every client. */
export const SERVER_NAME = "uberblick";

/** The clients `ub mcp install` knows how to wire up. */
export const TARGETS = ["claude", "codex"] as const;
export type TargetName = (typeof TARGETS)[number];

export type Scope = "project" | "user";

/** A server as a client registers it: a name, and the program it spawns. */
export interface Entry {
  /** The key it is registered under — {@link SERVER_NAME} for install. */
  name: string;
  command: string;
  args: string[];
}

/** The complete entry install registers, independent of workspace selection. */
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
 * Project scope is relative to the working directory and `--user` to the home
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
 * The whole read side of `ub mcp install`. A file that is not there is
 * `absent`; a file that is there and will not open or
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
    try {
      const doc = parseToml(text, { integersAsBigInt: "asNeeded" });
      if (doc.mcp_servers === undefined) return "absent";
      if (!doctorTable(doc.mcp_servers)) return "unusable";
      if (!Object.hasOwn(doc.mcp_servers, entry.name)) return "absent";
      const held = doc.mcp_servers[entry.name];
      // Codex registers only command, args and env. Dates are scalar values,
      // and JSON's optional stdio type is not part of the TOML entry we write.
      if (!doctorTable(held) || Object.hasOwn(held, "type")) return "foreign";
      if (held.env !== undefined && !doctorTable(held.env)) return "foreign";
      return jsonMatches(held, entry) ? "ours" : "foreign";
    } catch {
      // Parser errors quote source lines that may contain credentials.
      return "unusable";
    }
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

/** Doctor judges a workspace pin, never an entry's command or other values. */
export type DoctorEntry =
  | { status: "absent" | "unusable" }
  | { status: "entry"; env: NodeJS.ProcessEnv };

const PIN_KEYS = new Set(["UB_WORKSPACE_ID", "UB_HUB_URL", "WORKSPACE_ID", "HUB_URL"]);

/** No parser message or non-binding environment value leaves this read. */
function doctorRead(file: TargetFile): string | DoctorEntry {
  try {
    return readFileSync(file.path, "utf8");
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unusable",
    };
  }
}

function doctorJson(text: string): Record<string, unknown> | null {
  try {
    const doc: unknown = JSON.parse(text);
    return isObject(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** TOML date/time scalars are JS objects, but cannot be server or env tables. */
function doctorTable(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !(value instanceof Date);
}

function doctorJsonEntry(doc: unknown): DoctorEntry {
  if (!isObject(doc)) return { status: "unusable" };
  if (doc.mcpServers === undefined) return { status: "absent" };
  if (!doctorTable(doc.mcpServers)) return { status: "unusable" };
  if (!Object.hasOwn(doc.mcpServers, SERVER_NAME)) return { status: "absent" };
  const held = doc.mcpServers[SERVER_NAME];
  if (!doctorTable(held)) return { status: "unusable" };
  if (held.env === undefined) return { status: "entry", env: {} };
  if (!doctorTable(held.env)) return { status: "unusable" };
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(held.env)) {
    if (!PIN_KEYS.has(key)) continue;
    if (typeof value !== "string") return { status: "unusable" };
    env[key] = value;
  }
  return { status: "entry", env };
}

/** The project/user entry doctor can inspect without judging its command. */
export function doctorEntry(file: TargetFile): DoctorEntry {
  const text = doctorRead(file);
  if (typeof text !== "string") return text;
  return file.format === "json" ? doctorJsonEntry(doctorJson(text)) : doctorTomlEntry(text);
}

/** Claude's local and user scopes share one file, so read its bytes once. */
export function claudeDoctorEntries(
  file: TargetFile,
  projectKey: string,
): { local: DoctorEntry; user: DoctorEntry } {
  const text = doctorRead(file);
  if (typeof text !== "string") return { local: text, user: text };
  const doc = doctorJson(text);
  if (doc === null) return { local: { status: "unusable" }, user: { status: "unusable" } };
  let local: DoctorEntry = { status: "absent" };
  if (doc.projects !== undefined) {
    local = !isObject(doc.projects)
      ? { status: "unusable" }
      : Object.hasOwn(doc.projects, projectKey)
        ? doctorJsonEntry(doc.projects[projectKey])
        : { status: "absent" };
  }
  return { local, user: doctorJsonEntry(doc) };
}

/** Parse Codex's config once, then apply the same entry/pin rules as JSON. */
function doctorTomlEntry(text: string): DoctorEntry {
  try {
    // Valid unrelated 64-bit integers must not make a config unreadable.
    const doc = parseToml(text, { integersAsBigInt: "asNeeded" });
    return doctorJsonEntry({ mcpServers: doc.mcp_servers });
  } catch {
    // Parser errors quote source lines that may contain credentials.
    return { status: "unusable" };
  }
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
  // Absent and empty are the same plain entry, spelled two ways. Any environment
  // variable makes this somebody else's configuration. A non-object — `null`,
  // an array, a string, a number — is not an environment at all, and an entry
  // this does not understand is never declared "already installed".
  if (held.env !== undefined && !isObject(held.env)) return false;
  return (
    held.command === entry.command &&
    Array.isArray(args) &&
    args.length === entry.args.length &&
    args.every((arg, index) => arg === entry.args[index]) &&
    Object.keys(held.env ?? {}).length === 0
  );
}

/**
 * A TOML basic string.
 *
 * `JSON.stringify` is the whole implementation because a JSON string *is* a TOML
 * basic string: TOML's escape set — `\b \t \n \f \r \" \\ \uXXXX` — contains
 * every escape JSON emits, including the `\u00XX` form JSON uses for the control
 * characters TOML also forbids raw.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The block to paste into a Codex config, equivalent to what `codex mcp add`
 * writes for the same server.
 */
function tomlBlock(entry: Entry): string {
  const args = entry.args.map(tomlString).join(", ");
  return (
    `[mcp_servers.${entry.name}]\n` +
    `command = ${tomlString(entry.command)}\n` +
    `args = [${args}]\n`
  );
}

function serverObject(entry: Entry): Record<string, unknown> {
  return {
    command: entry.command,
    args: entry.args,
  };
}

/** What `ub mcp install` prints: a snippet valid for the named target. */
export function snippet(format: Format, entry: Entry): string {
  return format === "json"
    ? `${JSON.stringify({ mcpServers: { [entry.name]: serverObject(entry) } }, null, 2)}\n`
    : tomlBlock(entry);
}
