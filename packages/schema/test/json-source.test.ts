import { describe, expect, it } from "vitest";
import { formatJsonSource, jsonPathStep, parseJsonSource, JSON_SOURCE_MAX_DEPTH } from "../src/json-source.js";

function parsed(text: string) {
  const result = parseJsonSource(text);
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe("parseJsonSource", () => {
  it("keeps number literals that JSON.parse would change", () => {
    const result = parsed('[9007199254740993, 1.50, 1e3, -0, 0.1E-2]');
    expect(result.value.kind === "array" && result.value.items.map((item) => item.kind === "number" ? item.raw : "")).toEqual(
      ["9007199254740993", "1.50", "1e3", "-0", "0.1E-2"]);
  });

  it("keeps every duplicate key and reports them", () => {
    const result = parsed('{"a": 1, "a": 2}');
    expect(result.duplicateKeys).toBe(true);
    expect(result.value.kind === "object" && result.value.entries.map((entry) => entry.key)).toEqual(["a", "a"]);
    expect(parsed('{"a": {"b": 1}, "b": 2}').duplicateKeys).toBe(false);
  });

  it("decodes strings and keeps their raw text", () => {
    const result = parsed('"caf\\u00e9 \\"quoted\\" \\n"');
    expect(result.value).toMatchObject({ kind: "string", value: 'café "quoted" \n', raw: '"caf\\u00e9 \\"quoted\\" \\n"' });
  });

  it("records source offsets", () => {
    const result = parsed(' {"a": [true, null]} ');
    expect(result.value).toMatchObject({ kind: "object", start: 1, end: 20 });
  });

  it.each([
    ["", 1, 1, "unexpected end"],
    ['{"a": 1,}', 1, 9, "expected a key"],
    ['{\n  "a" 1\n}', 2, 7, 'expected ":"'],
    ["[1 2]", 1, 4, 'expected "," or "]"'],
    ["{'a': 1}", 1, 2, "expected a key"],
    ['"tab\there"', 1, 5, "control character"],
    ['"\\x"', 1, 3, "invalid escape"],
    ["01", 1, 2, "after the value"],
    ["-", 1, 1, "unexpected"],
    ["[1] // note", 1, 5, "after the value"],
    ["NaN", 1, 1, "unexpected"],
  ])("refuses %j at line %i, column %i", (text, line, column, message) => {
    const result = parseJsonSource(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(message);
    expect([result.line, result.column]).toEqual([line, column]);
  });

  it("refuses nesting deeper than the limit without overflowing the stack", () => {
    const deep = `${"[".repeat(JSON_SOURCE_MAX_DEPTH + 2)}${"]".repeat(JSON_SOURCE_MAX_DEPTH + 2)}`;
    const result = parseJsonSource(deep);
    expect(result.ok === false && result.message).toBe("nested too deeply");
    expect(parseJsonSource(`${"[".repeat(JSON_SOURCE_MAX_DEPTH)}${"]".repeat(JSON_SOURCE_MAX_DEPTH)}`).ok).toBe(true);
  });
});

describe("formatJsonSource", () => {
  it("formats with two spaces and keeps literals and key escapes as written", () => {
    const text = '{"n":1.50,"big":9007199254740993,"k\\u00e9y":"caf\\u00e9","list":[],"obj":{},"nested":[{"a":null,"b":false}]}';
    expect(formatJsonSource(parsed(text).value)).toBe([
      "{",
      '  "n": 1.50,',
      '  "big": 9007199254740993,',
      '  "k\\u00e9y": "caf\\u00e9",',
      '  "list": [],',
      '  "obj": {},',
      '  "nested": [',
      "    {",
      '      "a": null,',
      '      "b": false',
      "    }",
      "  ]",
      "}",
    ].join("\n"));
  });

  it("is stable on its own output", () => {
    const once = formatJsonSource(parsed('[{"a":[1,{"b":"c"}]},2]').value);
    expect(formatJsonSource(parsed(once).value)).toBe(once);
  });
});

describe("jsonPathStep", () => {
  it("writes jq steps", () => {
    expect([jsonPathStep("agents"), jsonPathStep(2), jsonPathStep("odd key"), jsonPathStep("1st")]).toEqual(
      [".agents", "[2]", '.["odd key"]', '.["1st"]']);
  });
});
