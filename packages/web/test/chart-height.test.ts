import { describe, expect, it } from "vitest";
import { chartHeightEdits } from "../src/editor/chart-height.js";

const members = '"version":1,"type":"line","collection":"points","x":{"field":"x","type":"number"},"y":[{"field":"y"}]';
const mapping = `{${members}}`;

function change(source: string, height: number | undefined): string {
  const edits = chartHeightEdits(source, height);
  if (edits === null) throw new Error("Height edit refused");
  let result = source;
  let previous = source.length;
  for (const edit of edits) {
    expect(edit.to).toBeLessThanOrEqual(previous);
    previous = edit.from;
    result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  }
  return result;
}

describe("chart height source edits", () => {
  it("changes only scatter height and preserves authored details and bound mappings", () => {
    const scatter = '{ "version":1,"type":"scatter","collection":"points","x":{"field":"x","lower":"low"},"y":{"field":"y"},"label":"name","details":[{"field":"url","format":"link"}] }';
    const resized = change(scatter, 320);
    expect(resized).toBe(`${scatter.slice(0, -2)},"height":320 }`);
    expect(change(resized, undefined)).toBe(scatter);
  });
  it("inserts a member using the existing compact, multiline and CRLF separators", () => {
    expect(change(mapping, 160)).toBe(`{${members},"height":160}`);
    const source = JSON.stringify(JSON.parse(mapping), null, "\t").replaceAll("\n", "\r\n");
    expect(change(source, 600)).toBe(`${source.slice(0, -3)},\r\n\t"height": 600\r\n}`);
    expect(change(` \n${mapping} \t`, 100)).toBe(` \n{${members},"height":100} \t`);
  });

  it("replaces only the effective numeric token, preserving escaped keys and strings", () => {
    const source = `{ "height": {"height":13}, ${members}, "title": "\\"height\\":123, braces {}", "he\\u0069ght" \t: 2.0e2 \r\n}`;
    const expected = source.replace("2.0e2", "345");
    expect(change(source, 345)).toBe(expected);
    expect(chartHeightEdits(source, 200)).toEqual([]);
    expect(JSON.parse(expected).height).toBe(345);
  });

  it.each([
    [`{"height":200,${members}}`, `{${members}}`],
    [`{${members},"height":200}`, `{${members}}`],
    [`{"height":100,"height":200,${members},"height":300}`, `{${members}}`],
    [`{${members},"height":100,"height":200}`, `{${members}}`],
    [`{"height":100,"version":1,"height":200,${members.slice('"version":1,'.length)}}`, `{${members}}`],
  ])("clears height and duplicate members without touching other compact members: %s", (source, expected) => {
    expect(change(source, undefined)).toBe(expected);
  });

  it("keeps whitespace and every other literal while removing only height and its comma", () => {
    const source = `{\r\n\t${members}, \n "he\\u0069ght" : 2e2 \r\n}`;
    expect(change(source, undefined)).toBe(`{\r\n\t${members} \n  \r\n}`);
    const front = `{ \n "height" : 200 \t,\r\n ${members} }`;
    expect(change(front, undefined)).toBe(`{ \n  \t\r\n ${members} }`);
  });

  it("does not match nested height strings or punctuation when inserting or clearing", () => {
    const source = `{${members},"title":"height,\\"height\\":300{}"}`;
    expect(change(source, 150)).toBe(`${source.slice(0, -1)},"height":150}`);
    expect(chartHeightEdits(source, undefined)).toEqual([]);
    const duplicates = `{"height":{"height":["},",true,null,2]},${members},"height":200}`;
    expect(change(duplicates, undefined)).toBe(mapping);
  });

  it.each([99, 601, 100.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses invalid requested height %s", (height) => {
    expect(chartHeightEdits(mapping, height)).toBeNull();
  });

  it.each([
    "not JSON", "null", "[]", '{"height":200}',
    `{${members},"height":99}`, `{${members},"height":"200"}`,
    '{"version":1,"type":"table","collection":"points","columns":[{"field":"x"}]}',
  ])("refuses invalid or non-line mappings without a source edit: %s", (source) => {
    expect(chartHeightEdits(source, 200)).toBeNull();
    expect(chartHeightEdits(source, undefined)).toBeNull();
  });
});
