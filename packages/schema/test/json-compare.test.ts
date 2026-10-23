import { describe, expect, it } from "vitest";
import {
  JSON_COMPARE_MAX_NODES, changedRanges, compareJsonSources, jsonComparisonOpenPaths, jsonComparisonRows,
} from "../src/index.js";
import type { JsonCompareNode, JsonCompareRow } from "../src/index.js";

function compared(before: string, after: string): JsonCompareNode {
  const result = compareJsonSources(before, after);
  if (!result.ok) throw new Error(result.reason);
  return result.root;
}

/** Every changed node as `kind path`, with a move's origin. */
function changes(node: JsonCompareNode): string[] {
  const own = node.kind === "unchanged" ? [] : [`${node.kind} ${node.path}${node.movedFrom === undefined ? "" : ` from ${node.movedFrom}`}`];
  if (node.kind === "added" || node.kind === "removed") return own;
  return [...own, ...node.children.flatMap(changes)];
}

const AGENTS = (ids: string[]) => JSON.stringify({ agents: ids.map((id) => ({ id, state: "idle" })) });

describe("compareJsonSources", () => {
  it.each([
    ["reformatting", '{"a":1,"b":[1,2]}', '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}', []],
    ["key order", '{"a":1,"b":{"c":true,"d":null}}', '{"b":{"d":null,"c":true},"a":1}', []],
    ["a changed scalar", '{"a":1,"b":2}', '{"a":1,"b":3}', ["changed .b"]],
    ["an added key", '{"a":1}', '{"a":1,"z":{"y":1}}', ["added .z"]],
    ["a removed key", '{"a":1,"b":2,"c":3}', '{"a":1,"c":3}', ["removed .b"]],
    ["a nested change", '{"a":{"b":{"c":"x"}}}', '{"a":{"b":{"c":"y"}}}', ["changed .a.b.c"]],
    ["an element added by id", AGENTS(["a", "b", "c"]), AGENTS(["a", "x", "b", "c"]), ["added .agents[1]"]],
    ["an element removed by id", AGENTS(["a", "b", "c"]), AGENTS(["a", "c"]), ["removed .agents[was 1]"]],
    ["an element moved by id", AGENTS(["a", "b", "c"]), AGENTS(["b", "c", "a"]), ["moved .agents[2] from 0"]],
    ["a changed element by id", AGENTS(["a", "b"]), AGENTS(["a", "b"]).replace('"b","state":"idle"', '"b","state":"busy"'),
      ["changed .agents[1].state"]],
    ["scalars without identity", "[1,2,3,4]", "[1,5,3,4]", ["changed [1]"]],
    ["objects without identity pair up", '[{"v":1},{"v":2}]', '[{"v":1},{"v":3}]', ["changed [1].v"]],
    ["mixed types stay remove plus add", '[1,"a"]', '[1,true]', ["removed [was 1]", "added [1]"]],
    ["a type change", '{"n":2}', '{"n":"2"}', ["type-changed .n"]],
    ["a container type change", '{"n":{}}', '{"n":[]}', ["type-changed .n"]],
    ["repeated keys pair by occurrence", '{"a":1,"a":2}', '{"a":1,"a":3}', ["changed .a#2"]],
  ])("reports %s", (_name, before, after, expected) => {
    expect(changes(compared(before, after))).toEqual(expected);
  });

  it("places a removed key after its older neighbour and keeps the newer key order", () => {
    const root = compared('{"a":1,"b":2,"c":3}', '{"c":3,"a":1}');
    expect(root.children.map((child) => `${child.kind} ${child.path}`)).toEqual(["unchanged .c", "unchanged .a", "removed .b"]);
  });

  it("marks only the changed characters, or words in long strings, and keeps literals", () => {
    const tag = compared('{"image":"ub-hub:0.4.8"}', '{"image":"ub-hub:0.4.9"}').children[0];
    expect(tag?.marks).toEqual({ before: [[12, 13]], after: [[12, 13]] });
    const long = changedRanges(`"${"word ".repeat(20)}old tail"`, `"${"word ".repeat(20)}new tail"`);
    expect(long).toEqual({ before: [[101, 104]], after: [[101, 104]] });
    const big = compared('{"n":9007199254740993,"p":1.50}', '{"n":9007199254740995,"p":1.50}');
    const rows = jsonComparisonRows(big, { isOpen: () => true, collapseUnchanged: false });
    const text = (row: JsonCompareRow | undefined, side: "before" | "after") =>
      row?.type === "node" ? row[side]?.map((piece) => piece.mark === true ? `<${piece.text}>` : piece.text).join("") : "";
    expect(text(rows[1], "before")).toBe('"n": 900719925474099<3>,');
    expect(text(rows[1], "after")).toBe('"n": 900719925474099<5>,');
    expect(text(rows[2], "after")).toBe('"p": 1.50');
  });

  it("falls back on invalid or oversized input without throwing", () => {
    expect(compareJsonSources("{", "{}")).toEqual({ ok: false, reason: "before-invalid" });
    expect(compareJsonSources("{}", "[1,]")).toEqual({ ok: false, reason: "after-invalid" });
    const huge = JSON.stringify(Array.from({ length: JSON_COMPARE_MAX_NODES }, (_, index) => index));
    expect(compareJsonSources(huge, "[]")).toEqual({ ok: false, reason: "too-large" });
  });

  it("counts a changed subtree once and a move plus its inner change twice", () => {
    const result = compareJsonSources(AGENTS(["a", "b"]), JSON.stringify({ agents: [{ id: "b", state: "busy" }, { id: "a", state: "idle" }], extra: { x: 1 } }));
    expect(result.ok && result.changes).toBe(3);
  });
});

describe("jsonComparisonRows", () => {
  const before = JSON.stringify({ name: "planner", a: 1, b: 2, c: 3, d: 4, list: [1, 2], tag: "v1" });
  const after = JSON.stringify({ name: "planner", a: 1, b: 2, c: 3, d: 4, list: [1, 2], tag: "v2", added: true });

  function summary(rows: JsonCompareRow[]): string[] {
    return rows.map((row) => row.type === "run" ? `run ${row.label}`
      : `${row.form} ${row.node.path} | ${row.before?.map((piece) => piece.text).join("") ?? "—"} | ${row.after?.map((piece) => piece.text).join("") ?? "—"}`);
  }

  it("folds unchanged runs but keeps the sibling next to a change, with commas per side", () => {
    const root = compared(before, after);
    const open = jsonComparisonOpenPaths(root, true);
    expect([...open]).toEqual([""]);
    const rows = jsonComparisonRows(root, { isOpen: (key) => open.has(key), collapseUnchanged: true });
    expect(summary(rows)).toEqual([
      "open  | { | {",
      "run 5 unchanged keys",
      'closed .list | "list": [ … ],2 items | "list": [ … ],2 items',
      'leaf .tag | "tag": "v1" | "tag": "v2",',
      "leaf .added | — | \"added\": true",
      "close  | } | }",
    ]);
  });

  it("shows notes for moves and type changes, and opens a run on request", () => {
    const root = compared(AGENTS(["a", "b"]).replace("}]}", '}],"n":2}'), AGENTS(["b", "a"]).replace("}]}", '}],"n":"2"}'));
    const rows = jsonComparisonRows(root, { isOpen: () => true, collapseUnchanged: false });
    const notes = rows.flatMap((row) => row.type === "node" ? row.after?.filter((piece) => piece.role === "note").map((piece) => piece.text) ?? [] : []);
    expect(notes).toEqual(["moved from [1]", "number → string"]);

    const runRoot = compared(before, after);
    const opened = jsonComparisonRows(runRoot, { isOpen: () => true, collapseUnchanged: true });
    expect(opened.some((row) => row.type === "run")).toBe(false);
  });

  it("opens breadth-first within the row budget when unchanged content is shown", () => {
    const root = compared(JSON.stringify({ a: { b: [1, 2, 3] }, c: Array.from({ length: 30 }, (_, index) => index) }), "{}");
    expect([...jsonComparisonOpenPaths(root, false)].sort()).toEqual(["", ".a", ".a.b"]);
  });
});
