/**
 * Strict JSON with source positions. Unlike JSON.parse, numbers keep their
 * literal text and every duplicate key survives, so a view never shows a value
 * the author did not write.
 */

interface Span { start: number; end: number }

export type JsonSourceNode =
  | Span & { kind: "object"; entries: JsonSourceEntry[] }
  | Span & { kind: "array"; items: JsonSourceNode[] }
  | Span & { kind: "string"; value: string; raw: string }
  | Span & { kind: "number"; raw: string }
  | Span & { kind: "boolean"; value: boolean }
  | Span & { kind: "null" };

export interface JsonSourceEntry {
  key: string;
  /** The key as written, quotes and escapes included. */
  rawKey: string;
  value: JsonSourceNode;
}

export type JsonSourceResult =
  | { ok: true; value: JsonSourceNode; duplicateKeys: boolean }
  | { ok: false; message: string; offset: number; line: number; column: number };

/** Deeper nesting is refused rather than risking the call stack. */
export const JSON_SOURCE_MAX_DEPTH = 512;

class JsonSourceError extends Error {
  constructor(message: string, readonly offset: number) { super(message); }
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export function parseJsonSource(text: string): JsonSourceResult {
  let at = 0;
  let duplicateKeys = false;
  const fail = (message: string): never => { throw new JsonSourceError(message, at); };
  const space = (): void => {
    while (at < text.length) {
      const char = text.charCodeAt(at);
      if (char !== 0x20 && char !== 0x09 && char !== 0x0a && char !== 0x0d) return;
      at += 1;
    }
  };
  const describe = (): string => at >= text.length ? "unexpected end" : `unexpected ${JSON.stringify(text[at])}`;
  const string = (): { value: string; raw: string; start: number; end: number } => {
    const start = at;
    at += 1;
    let value = "";
    while (true) {
      if (at >= text.length) fail("unterminated string");
      const char = text[at] as string;
      if (char === '"') break;
      if (char < " ") fail("control character in string");
      if (char !== "\\") { value += char; at += 1; continue; }
      const escaped = text[at + 1];
      if (escaped === "u") {
        const hex = text.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) { at += 1; fail("invalid unicode escape"); }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        at += 6;
        continue;
      }
      const mapped = escaped === undefined ? undefined : ESCAPES[escaped];
      if (mapped === undefined) { at += 1; fail("invalid escape"); }
      value += mapped;
      at += 2;
    }
    at += 1;
    return { value, raw: text.slice(start, at), start, end: at };
  };
  const object = (start: number, depth: number): JsonSourceNode => {
    at += 1;
    const entries: JsonSourceEntry[] = [];
    const seen = new Set<string>();
    space();
    if (text[at] === "}") { at += 1; return { kind: "object", entries, start, end: at }; }
    while (true) {
      space();
      if (text[at] !== '"') fail(`${describe()}, expected a key`);
      const key = string();
      if (seen.has(key.value)) duplicateKeys = true;
      seen.add(key.value);
      space();
      if (text[at] !== ":") fail(`${describe()}, expected ":"`);
      at += 1;
      entries.push({ key: key.value, rawKey: key.raw, value: value(depth + 1) });
      space();
      if (text[at] === ",") { at += 1; continue; }
      if (text[at] === "}") { at += 1; return { kind: "object", entries, start, end: at }; }
      fail(`${describe()}, expected "," or "}"`);
    }
  };
  const array = (start: number, depth: number): JsonSourceNode => {
    at += 1;
    const items: JsonSourceNode[] = [];
    space();
    if (text[at] === "]") { at += 1; return { kind: "array", items, start, end: at }; }
    while (true) {
      items.push(value(depth + 1));
      space();
      if (text[at] === ",") { at += 1; continue; }
      if (text[at] === "]") { at += 1; return { kind: "array", items, start, end: at }; }
      fail(`${describe()}, expected "," or "]"`);
    }
  };
  const scalar = (start: number): JsonSourceNode => {
    if (text[at] === '"') return { kind: "string", ...string() };
    for (const [word, node] of [["true", { kind: "boolean", value: true }], ["false", { kind: "boolean", value: false }], ["null", { kind: "null" }]] as const) {
      if (text.startsWith(word, at)) { at += word.length; return { ...node, start, end: at }; }
    }
    NUMBER.lastIndex = at;
    const number = NUMBER.exec(text);
    if (number !== null && number[0] !== "-") {
      at += number[0].length;
      return { kind: "number", raw: number[0], start, end: at };
    }
    return fail(describe());
  };
  function value(depth: number): JsonSourceNode {
    if (depth > JSON_SOURCE_MAX_DEPTH) fail("nested too deeply");
    space();
    const start = at;
    if (text[at] === "{") return object(start, depth);
    if (text[at] === "[") return array(start, depth);
    return scalar(start);
  }
  try {
    const root = value(0);
    space();
    if (at < text.length) fail(`${describe()} after the value`);
    return { ok: true, value: root, duplicateKeys };
  } catch (error) {
    if (!(error instanceof JsonSourceError)) throw error;
    const before = text.slice(0, error.offset);
    const line = before.split("\n").length;
    return { ok: false, message: error.message, offset: error.offset, line, column: error.offset - before.lastIndexOf("\n") };
  }
}

/** Two-space JSON from parsed source, with every literal as written. */
export function formatJsonSource(node: JsonSourceNode, indent = ""): string {
  const inner = `${indent}  `;
  switch (node.kind) {
    case "object":
      return node.entries.length === 0 ? "{}"
        : `{\n${node.entries.map((entry) => `${inner}${entry.rawKey}: ${formatJsonSource(entry.value, inner)}`).join(",\n")}\n${indent}}`;
    case "array":
      return node.items.length === 0 ? "[]"
        : `[\n${node.items.map((item) => `${inner}${formatJsonSource(item, inner)}`).join(",\n")}\n${indent}]`;
    case "string": return node.raw;
    case "number": return node.raw;
    case "boolean": return String(node.value);
    case "null": return "null";
  }
}

/** A path step in jq syntax: `.name`, `.["odd key"]` or `[2]`. */
export function jsonPathStep(key: string | number): string {
  if (typeof key === "number") return `[${key}]`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `.[${JSON.stringify(key)}]`;
}
