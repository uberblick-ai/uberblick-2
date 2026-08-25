/**
 * What each MCP client's configuration file looks like, and how to put one
 * server into it without disturbing a single other byte.
 *
 * Three clients, two formats. Claude Code and Cursor both keep a JSON object
 * under `mcpServers`; Codex keeps a TOML table called `[mcp_servers.<name>]`.
 * The paths and shapes here were checked against each vendor's own
 * documentation and against what each vendor's CLI actually writes.
 *
 * **Nothing is re-serialised.** Both formats are edited as text: the span the
 * entry occupies is located by scanning the original, and only that span is
 * replaced. Re-emitting a parsed document would be far less code, and it would
 * also reflow a compact entry somebody wrote by hand, renormalise their string
 * escapes, drop their blank lines, and — in a Codex config, which carries the
 * user's model, sandbox and profile settings — do all of that to a file that has
 * nothing to do with MCP. Preserving the file is the contract, so scanning is
 * the price.
 *
 * **What is refused.** The scanners understand ordinary config files, not every
 * document their grammars permit. Anything they cannot place unambiguously —
 * a `mcp_servers` written as an inline value, a table header they cannot read,
 * a JSON member in a shape they do not recognise — is reported as a refusal
 * naming the file, never repaired by guessing. `--print` is the way out.
 *
 * **Nothing echoes a value back.** An existing entry is rendered for a report
 * with every value masked except the command and its arguments: a config file
 * is exactly where somebody keeps an API token, and a diagnostic that quotes one
 * onto a terminal has leaked it. For the same reason a parse failure is reported
 * as "not valid JSON" and nothing more — the parser's own message quotes the
 * fragment it choked on.
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
  /**
   * The existing registration rendered for a report, with values masked, or
   * null when there is none. Never the file's own bytes.
   */
  existing: string | null;
  /** Whether what is there already runs exactly the proposed command. */
  matches: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stands in for a value a report is not willing to print. */
const MASK = "…";

// --- JSON: scanning the original text ---------------------------------------

function skipJsonWs(text: string, index: number): number {
  let i = index;
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) {
    i += 1;
  }
  return i;
}

/** The index just past the string starting at `index` (which holds a quote). */
function skipJsonString(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      return i + 1;
    }
    i += 1;
  }
  throw new UnusableConfig("a string in it is never closed");
}

/** The index just past the value starting at `index`. */
function skipJsonValue(text: string, index: number): number {
  const first = text[index];
  if (first === '"') {
    return skipJsonString(text, index);
  }
  if (first === "{" || first === "[") {
    let i = index;
    let depth = 0;
    while (i < text.length) {
      const character = text[i];
      if (character === '"') {
        i = skipJsonString(text, i);
        continue;
      }
      if (character === "{" || character === "[") {
        depth += 1;
      } else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          return i + 1;
        }
      }
      i += 1;
    }
    throw new UnusableConfig("a bracket in it is never closed");
  }
  // A number, or one of the three literals.
  let i = index;
  while (i < text.length && !' \t\n\r,}]'.includes(text[i] as string)) {
    i += 1;
  }
  if (i === index) {
    throw new UnusableConfig("it has a value this cannot read");
  }
  return i;
}

interface Member {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

/** The members of the object whose `{` is at `open`, as spans of `text`. */
function objectMembers(
  text: string,
  open: number,
): { members: Member[]; close: number } {
  const members: Member[] = [];
  let i = skipJsonWs(text, open + 1);
  if (text[i] === "}") {
    return { members, close: i };
  }
  for (;;) {
    if (text[i] !== '"') {
      throw new UnusableConfig("it has a key this cannot read");
    }
    const keyStart = i;
    const keyEnd = skipJsonString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipJsonWs(text, keyEnd);
    if (text[i] !== ":") {
      throw new UnusableConfig("it has a member this cannot read");
    }
    const valueStart = skipJsonWs(text, i + 1);
    const valueEnd = skipJsonValue(text, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd });
    i = skipJsonWs(text, valueEnd);
    if (text[i] === ",") {
      i = skipJsonWs(text, i + 1);
      // A trailing comma is not JSON, but treating it as the end of the object
      // is better than walking off the end of the text.
      if (text[i] === "}") {
        return { members, close: i };
      }
      continue;
    }
    if (text[i] === "}") {
      return { members, close: i };
    }
    throw new UnusableConfig("it has a member this cannot read");
  }
}

/** The whitespace the line containing `index` begins with. */
function lineLeading(text: string, index: number): string {
  const start = text.lastIndexOf("\n", Math.max(index - 1, 0)) + 1;
  return text.slice(start, index).match(/^[ \t]*/)?.[0] ?? "";
}

/** Whether everything before `index` on its line is whitespace. */
function atLineStart(text: string, index: number): boolean {
  const start = text.lastIndexOf("\n", Math.max(index - 1, 0)) + 1;
  return /^[ \t]*$/.test(text.slice(start, index));
}

/**
 * The file's own indentation, so a spliced-in member matches its neighbours.
 * The first indented line of an object literal is its first key, at depth one.
 */
function indentOf(text: string | null): string | number {
  return text?.match(/\n([ \t]+)\S/)?.[1] ?? 2;
}

/**
 * One `"key": value` member, laid out to sit at `indent`.
 *
 * A null `indent` means the object it is going into is written on one line, so
 * the member is written on one line too — a compact file stays compact.
 */
function renderMember(
  key: string,
  value: unknown,
  indent: string | null,
  unit: string | number,
): string {
  if (indent === null) {
    return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  }
  const body = JSON.stringify(value, null, unit).split("\n").join(`\n${indent}`);
  return `${JSON.stringify(key)}: ${body}`;
}

/** `text` with one member added to the object whose `{` is at `open`. */
function insertMember(
  text: string,
  open: number,
  object: { members: Member[]; close: number },
  key: string,
  value: unknown,
  unit: string | number,
): string {
  const unitText = typeof unit === "number" ? " ".repeat(unit) : unit;
  const first = object.members[0];
  const last = object.members[object.members.length - 1];
  if (first === undefined || last === undefined) {
    // An empty object: it gets a body, indented one step past its own line.
    const outer = lineLeading(text, open);
    const indent = `${outer}${unitText}`;
    const member = renderMember(key, value, indent, unit);
    return `${text.slice(0, open + 1)}\n${indent}${member}\n${outer}${text.slice(object.close)}`;
  }
  const indent = atLineStart(text, first.keyStart)
    ? lineLeading(text, first.keyStart)
    : null;
  const member = renderMember(key, value, indent, unit);
  const separator = indent === null ? "," : `,\n${indent}`;
  return `${text.slice(0, last.valueEnd)}${separator}${member}${text.slice(last.valueEnd)}`;
}

// --- JSON: what is there, and what goes in ----------------------------------

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

/**
 * An existing entry, safe to print.
 *
 * The command and its arguments survive, because comparing them is the whole
 * point of showing this at all. Every other value is replaced — an `env` keeps
 * its keys, so the shape is still legible, but not one of its values. Config
 * files are where tokens live.
 */
function redactJson(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return MASK;
  }
  const out: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(value)) {
    if ((key === "command" || key === "type") && typeof held === "string") {
      out[key] = held;
    } else if (
      key === "args" &&
      Array.isArray(held) &&
      held.every((item) => typeof item === "string")
    ) {
      out[key] = held;
    } else if (isPlainObject(held)) {
      out[key] = Object.fromEntries(Object.keys(held).map((name) => [name, MASK]));
    } else {
      out[key] = MASK;
    }
  }
  return out;
}

function inspectJson(text: string, entry: Entry): Found {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // Deliberately not the parser's own message: it quotes the fragment it
    // choked on, which in a config file may well be a credential.
    throw new UnusableConfig("it is not valid JSON");
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
    existing: JSON.stringify(redactJson(value), null, 2),
    matches: jsonMatches(value, entry),
  };
}

function serverObject(entry: Entry): Record<string, unknown> {
  // `type` is explicit because Cursor's documentation requires it for local
  // servers, and Claude Code accepts it — one object serves both.
  return { type: "stdio", command: entry.command, args: entry.args };
}

/**
 * The file's contents with our entry installed, as a splice of the original.
 *
 * Every byte outside the entry's own span is carried across untouched.
 */
function withEntryJson(text: string | null, entry: Entry): string {
  if (text === null) {
    return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: serverObject(entry) } }, null, 2)}\n`;
  }
  const unit = indentOf(text);
  const rootOpen = skipJsonWs(text, 0);
  if (text[rootOpen] !== "{") {
    throw new UnusableConfig("its top level is not a JSON object");
  }
  const root = objectMembers(text, rootOpen);
  const servers = root.members.find((member) => member.key === "mcpServers");
  if (servers === undefined) {
    return insertMember(text, rootOpen, root, "mcpServers", {
      [SERVER_NAME]: serverObject(entry),
    }, unit);
  }
  if (text[servers.valueStart] !== "{") {
    throw new UnusableConfig('its "mcpServers" is not a JSON object');
  }
  const inner = objectMembers(text, servers.valueStart);
  const ours = inner.members.find((member) => member.key === SERVER_NAME);
  if (ours === undefined) {
    return insertMember(
      text,
      servers.valueStart,
      inner,
      SERVER_NAME,
      serverObject(entry),
      unit,
    );
  }
  const indent = atLineStart(text, ours.keyStart)
    ? lineLeading(text, ours.keyStart)
    : null;
  return (
    text.slice(0, ours.keyStart) +
    renderMember(SERVER_NAME, serverObject(entry), indent, unit) +
    text.slice(ours.valueEnd)
  );
}

function snippetJson(entry: Entry): string {
  return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: serverObject(entry) } }, null, 2)}\n`;
}

// --- TOML: reading a line at a time -----------------------------------------

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

/** The table this module owns, as the key path TOML actually addresses. */
const OUR_PATH = ["mcp_servers", SERVER_NAME];

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function underPath(path: string[], prefix: string[]): boolean {
  return path.length > prefix.length && samePath(path.slice(0, prefix.length), prefix);
}

function skipSpaces(text: string, index: number): number {
  let i = index;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) {
    i += 1;
  }
  return i;
}

/** Past the basic string starting at `index`, or -1 if it is never closed. */
function skipTomlBasic(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * A dotted key, as its exact segments.
 *
 * Quotes are *unwrapped*, never stripped in place: `["uber blick"]` is a key
 * with a space in it, and flattening it to `uberblick` would let `--force`
 * delete a table belonging to somebody else.
 */
function parseKeyPath(
  text: string,
  index: number,
): { path: string[]; end: number } | null {
  const path: string[] = [];
  let i = index;
  for (;;) {
    i = skipSpaces(text, i);
    const character = text[i];
    if (character === '"') {
      const end = skipTomlBasic(text, i);
      if (end === -1) {
        return null;
      }
      try {
        path.push(JSON.parse(text.slice(i, end)) as string);
      } catch {
        return null;
      }
      i = end;
    } else if (character === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) {
        return null;
      }
      path.push(text.slice(i + 1, close));
      i = close + 1;
    } else {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_-]/.test(text[i] as string)) {
        i += 1;
      }
      if (i === start) {
        return null;
      }
      path.push(text.slice(start, i));
    }
    const next = skipSpaces(text, i);
    if (text[next] === ".") {
      i = next + 1;
      continue;
    }
    return { path, end: next };
  }
}

type MultilineDelimiter = '"""' | "'''";

/**
 * Walk the rest of a line for the state the *next* line starts in: how deep
 * inside brackets it is, and whether a multi-line string is still open.
 *
 * This is what keeps a line inside a multi-line array — `[` on a line of its
 * own — from being mistaken for a table header.
 */
function scanRest(
  text: string,
  startDepth: number,
): { depth: number; multiline: MultilineDelimiter | null } {
  let depth = startDepth;
  let i = 0;
  while (i < text.length) {
    const character = text[i];
    if (character === "#") {
      return { depth, multiline: null };
    }
    let opened: MultilineDelimiter | null = null;
    if (text.startsWith('"""', i)) {
      opened = '"""';
    } else if (text.startsWith("'''", i)) {
      opened = "'''";
    }
    if (opened !== null) {
      const close = text.indexOf(opened, i + 3);
      if (close === -1) {
        return { depth, multiline: opened };
      }
      i = close + 3;
      continue;
    }
    if (character === '"') {
      const end = skipTomlBasic(text, i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (character === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
    }
    i += 1;
  }
  return { depth, multiline: null };
}

type TomlLine =
  | { kind: "header"; path: string[]; array: boolean }
  | { kind: "assign"; path: string[]; value: string }
  | { kind: "other" }
  | { kind: "ambiguous"; because: string };

/** Classify one line that begins at bracket depth zero. */
function classifyLine(line: string): { line: TomlLine; rest: string } {
  const start = skipSpaces(line, 0);
  const first = line[start];
  if (start >= line.length || first === "#") {
    return { line: { kind: "other" }, rest: "" };
  }
  if (first === "[") {
    const array = line.startsWith("[[", start);
    const parsed = parseKeyPath(line, start + (array ? 2 : 1));
    const closing = array ? "]]" : "]";
    if (parsed === null || !line.startsWith(closing, parsed.end)) {
      return {
        line: { kind: "ambiguous", because: "it has a table header this cannot read" },
        rest: "",
      };
    }
    const after = line.slice(parsed.end + closing.length).trim();
    if (after !== "" && !after.startsWith("#")) {
      return {
        line: { kind: "ambiguous", because: "it has a table header this cannot read" },
        rest: "",
      };
    }
    return { line: { kind: "header", path: parsed.path, array }, rest: "" };
  }
  const parsed = parseKeyPath(line, start);
  if (parsed === null || line[skipSpaces(line, parsed.end)] !== "=") {
    // Not something this needs to understand — but it still has to be walked
    // for brackets, or a stray `[` would shift every line after it.
    return { line: { kind: "other" }, rest: line.slice(start) };
  }
  const value = line.slice(skipSpaces(line, parsed.end) + 1);
  return { line: { kind: "assign", path: parsed.path, value }, rest: value };
}

/** Every line of a TOML file, classified, with continuations accounted for. */
function scanToml(text: string): TomlLine[] {
  const out: TomlLine[] = [];
  let depth = 0;
  let multiline: MultilineDelimiter | null = null;
  for (const line of text.split("\n")) {
    if (multiline !== null) {
      const close = line.indexOf(multiline);
      if (close === -1) {
        out.push({ kind: "other" });
        continue;
      }
      const state = scanRest(line.slice(close + 3), depth);
      depth = state.depth;
      multiline = state.multiline;
      out.push({ kind: "other" });
      continue;
    }
    if (depth > 0) {
      const state = scanRest(line, depth);
      depth = state.depth;
      multiline = state.multiline;
      out.push({ kind: "other" });
      continue;
    }
    const classified = classifyLine(line);
    out.push(classified.line);
    const state = scanRest(classified.rest, 0);
    depth = state.depth;
    multiline = state.multiline;
  }
  return out;
}

/**
 * The lines `[mcp_servers.uberblick]` owns: its header, its keys, and any
 * sub-table of it such as `[mcp_servers.uberblick.env]`.
 *
 * @throws UnusableConfig when the table appears twice (not valid TOML, and
 * there is no right answer for which copy to replace); when `mcp_servers` or our
 * own key is defined as a value or as an array of tables rather than as a plain
 * table — splicing a header in beside one of those would hand Codex a duplicate
 * key and take its whole configuration down with it; and when a header cannot be
 * read at all, since a header this cannot place is a header it might append a
 * duplicate of.
 */
function ourRegion(
  lines: TomlLine[],
): { start: number; end: number } | null {
  let table: string[] = [];
  let found: { start: number; end: number } | null = null;
  for (const [index, line] of lines.entries()) {
    if (line.kind === "ambiguous") {
      throw new UnusableConfig(line.because);
    }
    if (line.kind === "header") {
      if (
        line.array &&
        (samePath(line.path, ["mcp_servers"]) ||
          samePath(line.path, OUR_PATH) ||
          underPath(line.path, OUR_PATH))
      ) {
        throw new UnusableConfig(
          "it defines `mcp_servers` as an array of tables rather than as tables",
        );
      }
      table = line.path;
      if (samePath(line.path, OUR_PATH)) {
        if (found !== null) {
          throw new UnusableConfig(
            `it defines [mcp_servers.${SERVER_NAME}] more than once`,
          );
        }
        found = { start: index, end: lines.length };
      } else if (
        found !== null &&
        found.end === lines.length &&
        !underPath(line.path, OUR_PATH)
      ) {
        found.end = index;
      }
      continue;
    }
    if (line.kind !== "assign") {
      continue;
    }
    // Keys written under our own header are the ordinary case. Everything else
    // is somebody defining the table itself as a value, including through a
    // dotted key such as `mcp_servers.uberblick.command = "x"` at the top level.
    if (samePath(table, OUR_PATH) || underPath(table, OUR_PATH)) {
      continue;
    }
    const absolute = [...table, ...line.path];
    if (samePath(absolute, ["mcp_servers"])) {
      throw new UnusableConfig(
        "it writes `mcp_servers` as an inline value rather than as tables",
      );
    }
    if (samePath(absolute, OUR_PATH) || underPath(absolute, OUR_PATH)) {
      throw new UnusableConfig(
        `it writes \`${SERVER_NAME}\` as an inline value rather than as a ` +
          `[mcp_servers.${SERVER_NAME}] table`,
      );
    }
  }
  return found;
}

/**
 * The existing block, safe to print: the header, the command and its arguments,
 * and the *names* of anything else it sets. A Codex `env` table is exactly where
 * a token would be, so no other value is echoed back.
 */
function redactTomlRegion(source: string[], classified: TomlLine[]): string {
  const out: string[] = [];
  // Only the table's own `command` and `args` are ever shown. Past the first
  // sub-table header — `[mcp_servers.uberblick.env]` — every key is somebody's
  // environment, whatever it happens to be called.
  let inRoot = true;
  for (const [index, line] of classified.entries()) {
    if (line.kind === "header") {
      if (index > 0) {
        inRoot = false;
      }
      out.push(source[index] as string);
      continue;
    }
    if (line.kind !== "assign") {
      continue;
    }
    const name = line.path.join(".");
    const shown =
      inRoot &&
      (name === "command" || name === "args") &&
      scanRest(line.value, 0).depth === 0;
    out.push(shown ? `${name} = ${line.value.trim()}` : `${name} = ${MASK}`);
  }
  return out.join("\n");
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
  const source = text.split("\n");
  const classified = scanToml(text);
  const region = ourRegion(classified);
  if (region === null) {
    return { existing: null, matches: false };
  }
  const block = source.slice(region.start, region.end).join("\n").replace(/\s+$/, "");
  return {
    existing: redactTomlRegion(
      source.slice(region.start, region.end),
      classified.slice(region.start, region.end),
    ),
    matches: `${block}\n` === tomlBlock(entry),
  };
}

function withEntryToml(text: string | null, entry: Entry): string {
  const block = tomlBlock(entry);
  if (text === null || text.trim() === "") {
    return block;
  }
  const source = text.split("\n");
  const region = ourRegion(scanToml(text));
  if (region !== null) {
    return [
      ...source.slice(0, region.start),
      ...block.split("\n").slice(0, -1),
      ...source.slice(region.end),
    ].join("\n");
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
