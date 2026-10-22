/** Run with the existing mcp-server tsx; all edits stay in detached Y.Docs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { InlineRun } from "../../packages/schema/src/types.js";

const schemaRequire = createRequire(resolve(__dirname, "../../packages/schema/package.json"));
const schema = schemaRequire("./src/index.ts") as typeof import("../../packages/schema/src/index.ts");
const Y = schemaRequire("yjs") as typeof import("../../packages/schema/node_modules/yjs");
const fastDiff = schemaRequire("fast-diff") as (a: string, b: string) => Array<[-1 | 0 | 1, string]>;

type SnapshotBlock = { id: string; type: string; text: string; hash: string; semantic: string };
type Pair = { old: number; next: number; via: "id" | "hash"; moved?: boolean };
type Span = { op: -1 | 0 | 1; text: string };
type Comparison = ReturnType<typeof compare>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function snapshot(doc: InstanceType<typeof Y.Doc>): SnapshotBlock[] {
  return schema.getBlocksWithInline(doc).map(({ block, ...inline }) => {
    // Product readers drop comments and unknown system attributes, and merge
    // adjacent runs after dropping comments, including table/card/caption runs.
    const { id, rev: _rev, ...authored } = block;
    const element = block.type === "table" ? schema.findBlockElement(doc, id) : null;
    const tableLayout = element === null ? undefined : schema.tableRows(element).map((row) => row.map((cell) => ({
      type: cell.nodeName, colspan: cell.getAttribute("colspan") ?? 1,
      rowspan: cell.getAttribute("rowspan") ?? 1, colwidth: cell.getAttribute("colwidth") ?? null,
    })));
    const semantic = JSON.stringify({ ...authored, ...inline, ...(tableLayout === undefined ? {} : { tableLayout }) });
    return { id, type: block.type, text: block.text, semantic, hash: digest(semantic) };
  });
}

function lcs(old: number[], next: number[], a: SnapshotBlock[], b: SnapshotBlock[]): Pair[] {
  const rows = Array.from({ length: old.length + 1 }, () => new Uint32Array(next.length + 1));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      rows[i][j] = a[old[i]].hash === b[next[j]].hash
        ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const pairs: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length && j < next.length) {
    if (a[old[i]].hash === b[next[j]].hash) {
      pairs.push({ old: old[i++], next: next[j++], via: "hash" });
    } else if (rows[i + 1][j] >= rows[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

export function matchBlocks(a: SnapshotBlock[], b: SnapshotBlock[]): Pair[] {
  const byId = new Map(a.flatMap((block, i) => block.id === "" ? [] : [[block.id, i] as const]));
  const usedOld = new Set<number>();
  const usedNext = new Set<number>();
  const pairs: Pair[] = [];
  for (const [next, block] of b.entries()) {
    const old = byId.get(block.id);
    if (old === undefined || usedOld.has(old)) continue;
    pairs.push({ old, next, via: "id" });
    usedOld.add(old);
    usedNext.add(next);
  }
  pairs.push(...lcs(a.flatMap((_, i) => usedOld.has(i) ? [] : [i]),
    b.flatMap((_, i) => usedNext.has(i) ? [] : [i]), a, b));
  pairs.sort((left, right) => left.next - right.next);
  // Longest increasing subsequence of old positions in new order.
  const tails: number[] = [];
  const previous = new Array<number>(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]].old < pairs[i].old) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const stationary = new Set<number>();
  let cursor = tails.at(-1) ?? -1;
  while (cursor !== -1) { stationary.add(cursor); cursor = previous[cursor]; }
  return pairs.map((pair, i) => ({ ...pair, moved: !stationary.has(i) }));
}

export function tokenDiff(a: string, b: string): Span[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "word" });
  const vocabulary: string[] = [];
  const codes = new Map<string, string>();
  const encode = (text: string) => [...segmenter.segment(text)].map(({ segment }) => {
    let code = codes.get(segment);
    if (code === undefined) {
      // Encode words as individual non-surrogate UTF-16 units for fast-diff.
      const index = vocabulary.length;
      if (index >= 0xd7ff) throw new Error("A block exceeds the 55,295 distinct-token experiment bound");
      vocabulary.push(segment);
      code = String.fromCharCode(index + 1);
      codes.set(segment, code);
    }
    return code;
  }).join("");
  const left = encode(a);
  const right = encode(b);
  return fastDiff(left, right).map(([op, encoded]) => ({
    op, text: [...encoded].map((code) => vocabulary[code.charCodeAt(0) - 1]).join(""),
  }));
}

function compare(before: InstanceType<typeof Y.Doc>, after: InstanceType<typeof Y.Doc>) {
  const old = snapshot(before);
  const next = snapshot(after);
  const pairs = matchBlocks(old, next);
  const changes = pairs.filter((pair) => !pair.moved && old[pair.old].hash !== next[pair.next].hash)
    .map((pair) => ({ ...pair, type: next[pair.next].type,
      spans: tokenDiff(old[pair.old].text, next[pair.next].text),
      authoredFieldsOnly: old[pair.old].text === next[pair.next].text }));
  const moved = pairs.filter((pair) => pair.moved).length;
  return {
    old, next, pairs, changes,
    summary: {
      changed: changes.length, moved,
      removed: old.length - pairs.length + moved,
      added: next.length - pairs.length + moved,
      hashMatched: pairs.filter((pair) => pair.via === "hash").length,
      authoredFieldsOnly: changes.filter((change) => change.authoredFieldsOnly).length,
      dataChanged: digest(schema.getDocDataEntries(before)) !== digest(schema.getDocDataEntries(after)),
    },
  };
}

function clone(doc: InstanceType<typeof Y.Doc>) {
  const copy = new Y.Doc({ gc: true });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function htmlDiff(name: string, result: Comparison): string {
  const side = (which: "old" | "next") => result[which].map((block, index) => {
    const pair = result.pairs.find((value) => value[which] === index);
    const change = result.changes.find((value) => value[which] === index);
    const removed = pair === undefined || pair.moved;
    const text = change === undefined ? escapeHtml(block.text) : change.spans
      .filter(({ op }) => which === "old" ? op !== 1 : op !== -1)
      .map(({ op, text }) => op === 0 ? escapeHtml(text) : `<${which === "old" ? "del" : "ins"}>${escapeHtml(text)}</${which === "old" ? "del" : "ins"}>`).join("");
    return `<pre class="${removed ? "whole" : ""}"><small>${index}: ${escapeHtml(block.type)}${pair?.moved ? " moved" : ""}${change?.authoredFieldsOnly ? " — authored attributes/marks changed; no text span" : ""}</small>\n${text}</pre>`;
  }).join("");
  return `<h2>${escapeHtml(name)}</h2><p>${escapeHtml(JSON.stringify(result.summary))}</p><div class="sides"><div class="old"><h3>Old positions</h3>${side("old")}</div><div class="next"><h3>New positions</h3>${side("next")}</div></div>`;
}

function selfTest() {
  const blocks = (ids: string[]) => ids.map((id) => ({ id, type: "paragraph", text: id, semantic: id, hash: id }));
  assert.equal(matchBlocks(blocks(["a", "b", "c"]), blocks(["b", "c", "a"])).filter((pair) => pair.moved).length, 1);
  const renamed = blocks(["a", "b"]); renamed[0].id = "new-a";
  assert.equal(matchBlocks(blocks(["a", "b"]), renamed).filter((pair) => pair.via === "hash").length, 1);
  const spans = tokenDiff("The old line.", "The new line.");
  assert.equal(spans.filter((span) => span.op !== 1).map((span) => span.text).join(""), "The old line.");
  assert.equal(spans.filter((span) => span.op !== -1).map((span) => span.text).join(""), "The new line.");
  assert(spans.some((span) => span.op === -1 && span.text === "old"));
}

async function main() {
  selfTest();
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") { console.log("Three-pass matching and token reconstruction passed"); return; }
  assert.equal(args[0], "--out-dir", "Usage: 2031-inline.ts --out-dir SCRATCH SNAPSHOT.yjs [SNAPSHOT.yjs ...]");
  assert(args[1] !== undefined && isAbsolute(args[1]), "The private output directory must be an absolute path");
  const output = resolve(args[1]);
  const files = args.slice(2);
  assert(files.length >= 2 && files.length <= 3, "Choose two or three real hub snapshots");
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  const summaries: unknown[] = [];
  const pages: string[] = [];
  const inputs: Array<{ document: string; sha256: string }> = [];
  const covered = new Set<string>();
  for (const file of files) {
    const original = new Y.Doc({ gc: true });
    const bytes = await readFile(file);
    inputs.push({ document: basename(file), sha256: createHash("sha256").update(bytes).digest("hex") });
    Y.applyUpdate(original, bytes);
    const base = clone(original);
    const originalCounts = Object.fromEntries([...new Set(schema.getBlocks(base).map((block) => block.type))]
      .map((type) => [type, schema.getBlocks(base).filter((block) => block.type === type).length]));
    const types = (["paragraph", "list-item", "table", "card", "figma", "chart"] as const)
      .filter((type) => schema.getBlocks(base).some((block) => block.type === type));
    for (const type of types) covered.add(type);
    const run = (name: string, edit: (after: InstanceType<typeof Y.Doc>) => void) => {
      const after = clone(base);
      try {
        edit(after);
        // Compare serialized full-state snapshots, rather than live references.
        const reread = clone(after);
        const result = compare(base, reread);
        reread.destroy();
        summaries.push({ document: basename(file), trial: name, originalCounts,
          commentResolutionVerified: name.includes("comment"), ...result.summary });
        pages.push(htmlDiff(`${basename(file)} — ${name}`, result));
        return result;
      } finally { after.destroy(); }
    };
    for (const type of types) {
      const result = run(`${type}: authored edit`, (after) => {
        const block = schema.getBlocks(after).find((value) => value.type === type);
        assert(block);
        let next = block.text.replace(/\p{L}[\p{L}\p{M}\p{N}_]*/u, (word) => word === "Revised" ? "Changed" : "Revised");
        if (type === "table") {
          const lines = block.text.split("\n");
          lines[0] = lines[0].replace(/\p{L}[\p{L}\p{M}\p{N}_]*/u, (word) => word === "Revised" ? "Changed" : "Revised");
          next = lines.join("\n");
        } else if (type === "figma") {
          next = block.text.replace(/^title: (.*)$/m, "title: $1 revised");
          if (next === block.text) next = block.text.replace(/\n\n/, "\ntitle: revised\n\n");
          next += " Revised caption.";
        } else if (type === "chart") {
          const config = JSON.parse(block.text);
          next = typeof config.title === "string"
            ? block.text.replace(/("title"\s*:\s*)"(?:\\.|[^"\\])*"/, (_match, prefix: string) => `${prefix}${JSON.stringify(`${config.title} revised`)}`)
            : JSON.stringify({ ...config, title: "Revised chart" });
        } else if (type === "card") next = block.text.replace(/^title: (.*)$/m, "title: $1 revised");
        schema.editBlock(after, block.id, block.text, next);
      });
      assert.equal(result.summary.changed, 1, `${type} must change exactly one matched block`);
      if (type === "paragraph" || type === "list-item" || type === "table") {
        assert(result.changes[0].spans.some((span) => span.op === -1), `${type} must remove a token`);
        assert(result.changes[0].spans.some((span) => span.op === 1), `${type} must insert a token`);
      }
    }
    if (types.includes("list-item")) {
      const attributes = run("list: marker and indent only", (after) => {
      const block = schema.getBlocks(after).find((value) => value.type === "list-item"); assert(block);
      schema.editBlock(after, block.id, block.text, block.text, { list: block.list === "ordered" ? "bullet" : "ordered", indent: block.indent === 1 ? 0 : 1 });
      });
      assert.equal(attributes.summary.authoredFieldsOnly, 1);
    }
    const mark = run("prose: document-link mark only", (after) => {
      const block = schema.getBlocksWithInline(after).find(({ block, inline }) => block.type === "paragraph" && block.text.length > 0 && inline.every((run: InlineRun) => run.marks.link === undefined));
      assert(block);
      schema.setInlineLink(after, block.block.id, { start: 0, end: 1 }, "00000000-0000-4000-8000-000000002031");
    });
    assert.equal(mark.summary.authoredFieldsOnly, 1);
    for (const type of types) {
      const addition = run(`${type}: comment added`, (after) => {
        const block = schema.getBlocks(after).find((value) => value.type === type); assert(block);
        const ranges = schema.listAnnotationRanges(after, block.id);
        const start = type === "table" || type === "card" || type === "figma" ? 0 : Math.min(block.text.length - 1, ranges.reduce((end, range) => Math.max(end, range.end), 0));
        const target = type === "table" ? { row: 0, column: 0 } : type === "card" ? { part: "title" as const } : type === "figma" ? { part: "caption" as const } : undefined;
        const annotation = schema.createAnnotation(after, block.id, start, start + 1, "Spike", "Private scratch control", target);
        const unresolved = compare(base, after);
        assert.equal(unresolved.summary.changed, 0);
        schema.setAnnotationResolved(after, annotation.id, true);
      });
      assert.deepEqual(addition.summary, { changed: 0, moved: 0, removed: 0, added: 0, hashMatched: 0, authoredFieldsOnly: 0, dataChanged: false });
    }
    if (types.includes("chart")) {
      const data = run("chart: actual collection record changed without block edit", (after) => {
        const chartCollections = schema.getBlocks(after).filter((block) => block.type === "chart")
          .map((block) => JSON.parse(block.text).collection);
        const collection = schema.readDocData(after)?.collections.find((value) => value.valid && chartCollections.includes(value.name) && value.records.some((record) => typeof record.value === "object" && record.value !== null && Object.values(record.value).some((field) => typeof field === "number")));
        assert(collection, "Choose a chart with a real numeric data record");
        const record = collection.records.find((value) => typeof value.value === "object" && value.value !== null && Object.values(value.value).some((field) => typeof field === "number")); assert(record);
        const value = { ...(record.value as Record<string, unknown>) };
        const field = Object.keys(value).find((key) => typeof value[key] === "number"); assert(field);
        value[field] = Number(value[field]) + 1;
        const directory = new Y.Doc();
        schema.applyDocData(after, directory, [{ collection: collection.name, upsert: [{ id: record.id, value }] }]);
        directory.destroy();
      });
      assert.equal(data.summary.changed, 0); assert.equal(data.summary.dataChanged, true);
    }
    const regeneration = run("hash fallback: delete/reinsert identical paragraph", (after) => {
      const entries = schema.getBlocksWithInline(after);
      const at = entries.findIndex(({ block }) => block.type === "paragraph" && block.text.length > 0);
      const entry = entries[at]; assert(entry);
      schema.deleteBlock(after, entry.block.id);
      schema.insertBlock(after, at === 0 ? null : entries[at - 1].block.id, { type: "paragraph", text: entry.block.text, inline: entry.inline });
    });
    assert.equal(regeneration.summary.hashMatched, 1); assert.equal(regeneration.summary.changed, 0);
    const movement = run("move: paragraph to end, shown removed at old position", (after) => {
      const entry = schema.getBlocksWithInline(after).find(({ block }) => block.type === "paragraph" && block.text.length > 0); assert(entry);
      schema.deleteBlock(after, entry.block.id);
      schema.appendBlock(after, { type: "paragraph", text: entry.block.text, inline: entry.inline });
    });
    assert.equal(movement.summary.moved, 1); assert.equal(movement.summary.removed, 1); assert.equal(movement.summary.added, 1);
    base.destroy(); original.destroy();
  }
  for (const type of ["paragraph", "list-item", "table", "card", "figma", "chart"]) {
    assert(covered.has(type), `The selected real documents contain no ${type} block`);
  }
  const result = { selfTests: "passed", documentCount: files.length, inputs, coveredTypes: [...covered].sort(), trials: summaries };
  await writeFile(join(output, "inline-summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(output, "inline-preview.html"), `<!doctype html><meta charset="utf-8"><title>Private revision diff experiment</title><style>body{font:14px system-ui;max-width:1500px;margin:auto;padding:20px}.sides{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;border-bottom:1px solid #ddd;padding:10px}small{color:#666}del,.old .whole{background:#ffebe9}ins,.next .whole{background:#dafbe1}</style><h1>Private snapshot comparisons</h1>${pages.join("\n")}`);
  await chmod(join(output, "inline-summary.json"), 0o600);
  await chmod(join(output, "inline-preview.html"), 0o600);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
