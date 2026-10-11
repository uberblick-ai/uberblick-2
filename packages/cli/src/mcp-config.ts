import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export const SERVER_NAME = "uberblick";

export const TARGETS = ["claude", "codex"] as const;
export type TargetName = (typeof TARGETS)[number];

export type Scope = "project" | "user";

export interface Entry {
  name: string;
  command: string;
  args: string[];
}

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
 * Honour user-scope CODEX_HOME so presence reads the file Codex will write.
 * Project scope uses the same directory install passes to Codex explicitly.
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
      : // User entries share this file with the per-project local-scope map.
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

/** Keep project reads aligned with the CODEX_HOME install passes to Codex. */
export function codexHome(cwd: string): string {
  return join(cwd, ".codex");
}

export type Presence =
  /** Nothing there: no file, or a file that registers nothing of ours. */
  | "absent"
  /** Semantically the plain entry, including vendor-written empty defaults. */
  | "ours"
  /** Something else under our name; not ours to replace. */
  | "foreign"
  /** Never delegate a write over an existing file whose contents are unreadable. */
  | "unusable";

/**
 * Return only a verdict: source values and parser messages may contain tokens.
 * Only ENOENT permits treating a file as absent; other read failures refuse it.
 */
export function presence(file: TargetFile, entry: Entry): Presence {
  let text: string;
  try {
    text = readFileSync(file.path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unusable";
  }
  if (file.format === "toml") {
    try {
      const doc = parseToml(text, { integersAsBigInt: "asNeeded" });
      if (doc.mcp_servers === undefined) return "absent";
      if (!doctorTable(doc.mcp_servers)) return "unusable";
      if (!Object.hasOwn(doc.mcp_servers, entry.name)) return "absent";
      const held = doc.mcp_servers[entry.name];
      // A TOML date is not a table; JSON's optional type is not a Codex field.
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

// Decision: 42a229be-a9b9-4c56-9b68-11f26cb145da.
function doctorTomlEntry(text: string): DoctorEntry {
  try {
    const doc = parseToml(text, { integersAsBigInt: "asNeeded" });
    return doctorJsonEntry({ mcpServers: doc.mcp_servers });
  } catch {
    return { status: "unusable" };
  }
}

/**
 * Vendor-written stdio type and empty env are equivalent to omitted defaults.
 * Reject unknown fields, including cwd and URL transports, as foreign entries.
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
  // Only an absent or empty object env matches; pins and malformed env are foreign.
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
 * JSON string escapes are valid TOML basic-string escapes, including controls.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

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

export function snippet(format: Format, entry: Entry): string {
  return format === "json"
    ? `${JSON.stringify({ mcpServers: { [entry.name]: serverObject(entry) } }, null, 2)}\n`
    : tomlBlock(entry);
}
