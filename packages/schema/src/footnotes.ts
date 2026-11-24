import { SchemaError } from "./errors.js";
import type { BlockInput, InlineRun } from "./types.js";
import { scanValueSources } from "./value-data.js";

export function isFootnoteLabel(value: unknown): value is string {
  return typeof value === "string" && /^[^\s[\]\\]+$/u.test(value);
}

export function acceptsFootnoteReferences(type: string): boolean {
  return ["paragraph", "heading", "list-item", "quote", "callout"].includes(type);
}

/** Literal syntax ranges; odd backslash escapes keep an opener literal. */
export function footnoteReferences(text: string): Array<{ from: number; to: number; label: string }> {
  const matches: Array<{ from: number; to: number; label: string }> = [];
  const values = scanValueSources(text);
  for (const match of text.matchAll(/\[\^([^\s[\]\\]+)\]/gu)) {
    if (values.some((range) => range.from <= match.index && match.index < range.to)) continue;
    let slashes = 0;
    for (let at = match.index - 1; at >= 0 && text[at] === "\\"; at -= 1) slashes += 1;
    if (slashes % 2 === 0) matches.push({ from: match.index, to: match.index + match[0].length, label: match[1] ?? "" });
  }
  return matches;
}

/** Validate the complete input before a Yjs transaction can apply any part. */
export function validateFootnoteInput(input: BlockInput): void {
  if ((input.type === "footnote" && !isFootnoteLabel(input.label)) || (input.type !== "footnote" && input.label !== undefined)) {
    throw new SchemaError("invalid_footnote_label", "A footnote needs a nonempty label without whitespace, brackets or backslashes; label applies only to footnotes");
  }
  for (const run of input.inline ?? []) {
    if (!run.marks.footnoteRef) continue;
    const matches = footnoteReferences(run.text);
    if (!acceptsFootnoteReferences(input.type) || run.marks.inlineCode || run.marks.link !== undefined || run.marks.docLink !== undefined || matches.length !== 1 || matches[0]?.from !== 0 || matches[0]?.to !== run.text.length) {
      throw new SchemaError("invalid_footnote_reference", "A footnoteRef run must be exactly one [^label] in reference-capable prose, outside code and links");
    }
  }
}

/** Split adjacent marked references, degrading broken or protected characters to text. */
export function splitFootnoteRuns(runs: readonly InlineRun[]): InlineRun[] {
  return runs.flatMap((run) => {
    if (!run.marks.footnoteRef) return [{ text: run.text, marks: { ...run.marks } }];
    const plain = { ...run.marks };
    delete plain.footnoteRef;
    const matches = run.marks.inlineCode || run.marks.link !== undefined || run.marks.docLink !== undefined ? [] : footnoteReferences(run.text);
    const result: InlineRun[] = [];
    let from = 0;
    for (const match of matches) {
      if (match.from > from) result.push({ text: run.text.slice(from, match.from), marks: { ...plain } });
      result.push({ text: run.text.slice(match.from, match.to), marks: { ...run.marks } });
      from = match.to;
    }
    if (from < run.text.length) result.push({ text: run.text.slice(from), marks: { ...plain } });
    return result;
  });
}

/** Apply syntax only to new prose, preserving existing formatting and link boundaries. */
export function referenceInline(runs: readonly InlineRun[]): InlineRun[] {
  const source = runs.map((run) => run.text).join("");
  let offset = 0;
  const protectedRanges = runs.flatMap((run) => {
    const from = offset;
    offset += run.text.length;
    return run.marks.inlineCode || run.marks.link !== undefined || run.marks.docLink !== undefined ? [{ from, to: offset }] : [];
  });
  const matches = footnoteReferences(source).filter((match) => !protectedRanges.some((range) => range.from < match.to && match.from < range.to));
  const result: InlineRun[] = [];
  offset = 0;
  let at = 0;
  for (const run of runs) {
    const end = offset + run.text.length;
    let from = offset;
    while (from < end) {
      while (matches[at] !== undefined && (matches[at]?.to ?? 0) <= from) at += 1;
      const match = matches[at];
      const referenced = match !== undefined && match.from <= from;
      const to = Math.min(end, match === undefined ? end : referenced ? match.to : match.from);
      result.push({ text: source.slice(from, to), marks: referenced ? { ...run.marks, footnoteRef: true } : { ...run.marks } });
      from = to;
    }
    offset = end;
  }
  return result;
}
