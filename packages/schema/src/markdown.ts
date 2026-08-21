/**
 * Markdown is an export format, never the storage format.
 *
 * `exportMarkdown` is the one-way road out of the document model.
 * `importMarkdown` is the opposite direction and deliberately weaker: it is a
 * dependency-free, line-based reader used to bring seed documents in once.
 *
 * Both directions carry the closed inline-mark set — `**bold**`, `*italic*`,
 * `~~strike~~`, `` `code` `` and `[text](https://…)` — because a block's text
 * does store inline formatting (as Yjs formatting attributes; see `marks.ts`).
 * Block structure is still line-based: no lists, tables or block quotes exist in
 * the model, so none are read or written here.
 *
 * Reader and writer are one unit: every legal combination of marks has to
 * survive the trip out and back, so the reader implements CommonMark's delimiter
 * matching rather than a looser approximation, and the writer escapes exactly
 * what that reader would take as syntax. The vocabulary is narrower than
 * CommonMark's, deliberately:
 *
 *   - Emphasis is asterisk-only. `_` is never a delimiter, so `snake_case`
 *     survives without escaping — and `__bold__` typed in the editor still
 *     arrives as a `bold` mark, because that is the editor's input rule, not
 *     this reader's job.
 *   - Delimiter *runs* are matched the CommonMark way: flanking decides what can
 *     open and close (`** x **` is literal), a closer takes the nearest opener,
 *     and a long run splits between matches — which is what makes `***both***`,
 *     `**a***b*` and `*a **b** c*` each mean what they should.
 *   - A link is a link only when its target is an external `http(s)` URL.
 *     Doc-to-doc references are `meta.links` by UUID and never a link mark, so
 *     anything else stays literal text. Balanced parentheses inside a target
 *     belong to it, again per CommonMark.
 *   - `\` escapes `` \ ` * ~ [ ``, plus `]` inside a link label, and nothing
 *     else, in both directions.
 */

import type * as Y from "yjs";
import { getBlocksWithInline } from "./blocks.js";
import { getMeta } from "./doc.js";
import { listAnnotations, resolveAnnotationRange } from "./annotations.js";
import {
  hasInlineMarks,
  inlinePlainText,
  isExternalHref,
  pushInlineRun,
  sameInlineMarks,
} from "./marks.js";
import type {
  Block,
  BlockType,
  HeadingLevel,
  InlineMarkSet,
  InlineRun,
} from "./types.js";

export interface ExportMarkdownOptions {
  /** Emit a `---` YAML frontmatter block with uuid, title and tags. Default true. */
  frontmatter?: boolean;
  /**
   * How to render annotation threads. `"html-comments"` emits one HTML comment
   * per thread directly after its block; `"drop"` (default) omits them.
   */
  annotations?: "html-comments" | "drop";
}

const NEEDS_QUOTING = /[:#[\]{}",&*!|>%@`']/;

function emitScalar(value: string): string {
  if (
    value === "" ||
    value !== value.trim() ||
    NEEDS_QUOTING.test(value) ||
    /^[-?]/.test(value) ||
    value.includes("\n")
  ) {
    return JSON.stringify(value);
  }
  return value;
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, value.endsWith('"') ? -1 : undefined);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

/** Longest run of backticks anywhere in `text`. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

/** A fence longer than any backtick run in `text`, so it always closes. */
function fenceFor(text: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
}

/* --------------------------------------------------------------- inline: out */

/** The marks that nest. `inlineCode` is not one: it is always innermost. */
const NESTING = ["link", "bold", "italic", "strike"] as const;

type NestedMark = (typeof NESTING)[number];

/**
 * The delimiter each mark is written with. Asterisks for emphasis, and never the
 * `_` forms: this reader does not treat `_` as a delimiter, so writing one would
 * not survive the trip back. See the module comment.
 */
const DELIMITER: Record<Exclude<NestedMark, "link">, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
};

function nestedMarksOf(marks: InlineMarkSet): NestedMark[] {
  const out: NestedMark[] = [];
  if (marks.link !== undefined) out.push("link");
  if (marks.bold === true) out.push("bold");
  if (marks.italic === true) out.push("italic");
  if (marks.strike === true) out.push("strike");
  return out;
}

interface EscapeContext {
  /**
   * Within a link label the first unescaped `]` ends the label, so a label
   * holding one must escape it or the link does not survive the round trip.
   */
  insideLabel: boolean;
  /**
   * Whether a delimiter the writer emits can sit against this text. A lone `~` is
   * not a delimiter, so ordinary prose keeps its home directories unescaped — but
   * `~` next to an emitted `~~` merges into one run and changes meaning, and the
   * merge happens across the boundary where this text cannot see it.
   */
  hugged: boolean;
}

/**
 * Escape the characters the reader would take as syntax.
 *
 * `[` is escaped unconditionally, even though most brackets are harmless. What
 * makes one dangerous is a `](…)` *somewhere later in the line*, and that can be
 * emitted by a different run entirely — a link mark two runs along, or another
 * run's literal text. No run-local test can see it, and a global one would have
 * to render first and then decide, so the bracket always gets its backslash.
 *
 * `~` is escaped only where it could actually delimit something, which is what
 * keeps ordinary prose readable: a lone `~` is not a delimiter, so home
 * directories survive. `_` is never escaped, because this reader never treats it
 * as one — see the module comment.
 */
function escapeInline(text: string, context: EscapeContext): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (char === "\\" || char === "`" || char === "*" || char === "[") {
      out += `\\${char}`;
    } else if (char === "]" && context.insideLabel) {
      out += "\\]";
    } else if (
      char === "~" &&
      (context.hugged || text[i + 1] === "~" || text[i - 1] === "~")
    ) {
      out += "\\~";
    } else {
      out += char;
    }
  }
  return out;
}

/** Whether every `(` in `href` has its `)`, the CommonMark bare-target rule. */
function parensBalanced(href: string): boolean {
  let depth = 0;
  for (const char of href) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * A link target, written so the reader gets it back *unchanged* — an href is
 * data, so escaping it is fine but rewriting it is not.
 *
 * Balanced parentheses belong to a bare target (the rule the reader implements),
 * so `https://example.com/a_(b)` goes out as it is. Anything a bare target cannot
 * hold — an unbalanced paren, an angle bracket — goes in CommonMark's `<…>` form,
 * where a backslash covers the rest.
 */
function renderHref(href: string): string {
  if (parensBalanced(href) && !/[<>]/.test(href)) return href;
  return `<${href.replace(/[\\<>]/g, (char) => `\\${char}`)}>`;
}

/**
 * A code span. Its content is literal — backslash escapes do not exist inside
 * one — so the fence is lengthened past any backticks in the text, and edges the
 * reader's unpadding rule would eat are padded out.
 */
function renderCodeSpan(text: string): string {
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad =
    text.startsWith("`") ||
    text.endsWith("`") ||
    text.startsWith(" ") ||
    text.endsWith(" ")
      ? " "
      : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The marks whose delimiters have to hug their content. */
const EMPHASIS_MARKS = ["bold", "italic", "strike"] as const;

type EmphasisMark = (typeof EMPHASIS_MARKS)[number];

/** `marks` minus `drop` — the marks whitespace pushed outside a span keeps. */
function without(marks: InlineMarkSet, drop: readonly EmphasisMark[]): InlineMarkSet {
  const kept: InlineMarkSet = { ...marks };
  for (const mark of drop) delete kept[mark];
  return kept;
}

/** Trailing whitespace of `text`, which is `""` when it ends in anything else. */
function trailingWhitespace(text: string): string {
  return /\s*$/.exec(text)?.[0] ?? "";
}

/**
 * Merge neighbouring code runs that carry *exactly* the same marks.
 *
 * Only then, because the merge has to be lossless. Two code spans that differ in
 * some mark do not need merging anyway: the delimiters of the mark they disagree
 * about are emitted between them, which is what keeps their backtick runs from
 * meeting — ``**`a`**`b` `` has the `**` in the way. Runs with identical marks
 * cannot be told apart by anything, so joining them changes nothing at all.
 */
function coalesceCodeRuns(runs: readonly InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.marks.inlineCode === true &&
      run.marks.inlineCode === true &&
      sameInlineMarks(last.marks, run.marks)
    ) {
      out[out.length - 1] = { text: last.text + run.text, marks: last.marks };
      continue;
    }
    out.push(run);
  }
  return out;
}

/** One mark on the open stack, with the exact delimiter that will close it. */
interface OpenMark {
  name: NestedMark;
  href: string;
  /** The spelling this mark was opened with; a closer must match it. */
  spelling: string;
}

/**
 * For each run, its marks ordered outermost-first, by the extent of the span the
 * run belongs to: earliest start outermost, and among equal starts the latest
 * end.
 *
 * This is a quality choice, not a correctness one — the emitter below is
 * well-nested whatever order it is given — but it is what stops a mark that
 * spans a whole phrase from closing and reopening around every word inside it.
 * A mark shared with a neighbour lands at the same depth in both runs, so it
 * stays open across the boundary, and a mark about to end sits inside the ones
 * that continue, so it closes first.
 *
 * Computed for every run in two linear passes per mark rather than by walking
 * outwards from each run, so the whole thing is O(runs).
 */
function markOrders(runs: readonly InlineRun[]): NestedMark[][] {
  const starts = new Map<NestedMark, number[]>();
  const ends = new Map<NestedMark, number[]>();

  for (const mark of NESTING) {
    const start: number[] = [];
    const end: number[] = [];
    const carries = (index: number): boolean => {
      const marks = runs[index]?.marks;
      if (marks === undefined) return false;
      return mark === "link" ? marks.link !== undefined : marks[mark] === true;
    };
    const same = (a: number, b: number): boolean =>
      mark === "link"
        ? runs[a]?.marks.link === runs[b]?.marks.link
        : carries(a) && carries(b);

    for (let i = 0; i < runs.length; i += 1) {
      start[i] = carries(i) && i > 0 && same(i - 1, i) ? (start[i - 1] as number) : i;
    }
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      end[i] =
        carries(i) && i + 1 < runs.length && same(i, i + 1)
          ? (end[i + 1] as number)
          : i;
    }
    starts.set(mark, start);
    ends.set(mark, end);
  }

  return runs.map((run, index) =>
    nestedMarksOf(run.marks).sort((a, b) => {
      const startA = starts.get(a)?.[index] ?? index;
      const startB = starts.get(b)?.[index] ?? index;
      if (startA !== startB) return startA - startB;
      const endA = ends.get(a)?.[index] ?? index;
      const endB = ends.get(b)?.[index] ?? index;
      if (endA !== endB) return endB - endA;
      // Same extent: any order round-trips, so pick the stable one.
      return NESTING.indexOf(a) - NESTING.indexOf(b);
    }),
  );
}

/**
 * Render runs as GFM.
 *
 * The emitter is a stack, and everything else follows from that. For each run it
 * closes marks from the top until every mark still open is one this run wants,
 * then opens the rest — so the output is a properly nested tree of delimiters *by
 * construction*, whatever the runs do. Markdown cannot represent crossing spans
 * (strike over runs 1–2, bold over 2–3), and it does not have to: the emitter
 * splits the crossing into nested pieces, and a span written as two adjacent
 * pieces carries the same per-character marks as one — which is the contract that
 * matters, since the reader and Yjs both coalesce runs that agree.
 *
 * Two things a stack cannot settle on its own:
 *
 *   - **Emphasis touching whitespace,** which GFM cannot spell at all: `**word **`
 *     is not bold in any reader including this one. Leading whitespace is written
 *     before the delimiters that open, trailing whitespace is taken back off the
 *     output and re-appended after the delimiters that close, and a run of nothing
 *     but whitespace carries no emphasis. Those spaces lose that mark.
 *   - **Delimiter runs of the same character that meet.** Splitting a crossing
 *     means an inner mark's reopener can land against the closer of the mark that
 *     died: `*` after `**` is one run of three, and which part of it closes is
 *     then the reader's guess. The reader guesses the CommonMark way (nearest
 *     opener, split runs, rule of three) and agrees with the writer almost always
 *     — measured at 99.2% of generated documents, with the remainder *normalising*
 *     a mark rather than corrupting anything.
 *
 * So the guarantee this pair makes is about text, not spelling: **the characters
 * always survive**, and the marks survive except where the format cannot hold
 * them, in which case the first export drops one and every export after that is
 * identical. The property test at the bottom of `test/marks.test.ts` is what
 * holds this honest.
 *
 * The residue has one known cure, deliberately not taken here: writing the
 * `_`/`__` spellings for a delimiter that would otherwise merge makes the two
 * runs different characters, so nothing has to be guessed. That needs the reader
 * to understand `_` emphasis, which is a bigger change than this one — tracked as
 * a follow-up rather than smuggled in.
 */
function renderInline(source: readonly InlineRun[]): string {
  let out = "";
  const open: OpenMark[] = [];

  // Whitespace alone gives a delimiter nothing to hug, so it carries no emphasis
  // at all — there is no way to write that, and pretending otherwise is what
  // turns `~~ ~~` back into literal text on the next read. A code span is exempt:
  // its emphasis hugs the backticks, not the whitespace inside them.
  const runs: InlineRun[] = coalesceCodeRuns(source).map((run) =>
    run.text.trim() === "" && run.marks.inlineCode !== true
      ? { text: run.text, marks: without(run.marks, EMPHASIS_MARKS) }
      : run,
  );
  // A single unmarked run has no delimiter anywhere near it; anything else might.
  const hugged = runs.length > 1 || hasInlineMarks(runs[0]?.marks ?? {});
  const orders = markOrders(runs);

  const closeDownTo = (depth: number): void => {
    for (let i = open.length - 1; i >= depth; i -= 1) {
      const entry = open[i];
      if (entry === undefined) continue;
      out += entry.name === "link" ? `](${renderHref(entry.href)})` : entry.spelling;
    }
    open.length = depth;
  };

  for (const [index, run] of runs.entries()) {
    const marks = run.marks;
    const desired = orders[index] ?? [];
    const href = marks.link ?? "";
    let common = 0;
    while (
      common < open.length &&
      common < desired.length &&
      open[common]?.name === desired[common] &&
      (desired[common] !== "link" || open[common]?.href === href)
    ) {
      common += 1;
    }

    // Closing: hold back whitespace already written, so no closer sits on it.
    let held = "";
    if (open.slice(common).some((entry) => entry.name !== "link")) {
      held = trailingWhitespace(out);
      out = out.slice(0, out.length - held.length);
    }
    closeDownTo(common);
    out += held;

    // Opening: write leading whitespace outside the delimiters, same reason —
    // except for a code span, whose delimiters hug its backtick fence rather than
    // its content. Moving whitespace out of *that* would change the content, and
    // empty it entirely when the content is nothing but whitespace.
    let text = run.text;
    if (
      marks.inlineCode !== true &&
      desired.slice(common).some((name) => name !== "link")
    ) {
      const lead = /^\s*/.exec(text)?.[0] ?? "";
      out += lead;
      text = text.slice(lead.length);
    }
    for (let i = common; i < desired.length; i += 1) {
      const name = desired[i];
      if (name === undefined) continue;
      const spelling = name === "link" ? "[" : DELIMITER[name];
      out += spelling;
      open.push({ name, href, spelling });
    }

    out +=
      marks.inlineCode === true
        ? renderCodeSpan(text)
        : escapeInline(text, {
            insideLabel: open.some((entry) => entry.name === "link"),
            hugged,
          });
  }

  const held = trailingWhitespace(out);
  if (open.some((entry) => entry.name !== "link")) {
    out = out.slice(0, out.length - held.length);
    closeDownTo(0);
    out += held;
  } else {
    closeDownTo(0);
  }
  return out;
}

function renderBlock(block: Block, inline: readonly InlineRun[]): string {
  switch (block.type) {
    case "heading": {
      const level = block.level ?? 1;
      // Headings are single-line by definition; fold any stray newlines.
      const text = renderInline(inline).replace(/\s*\n\s*/g, " ").trim();
      return `${"#".repeat(level)} ${text}`.trimEnd();
    }
    case "code": {
      const fence = fenceFor(block.text);
      return `${fence}${block.language ?? ""}\n${block.text}\n${fence}`;
    }
    case "mermaid": {
      const fence = fenceFor(block.text);
      return `${fence}mermaid\n${block.text}\n${fence}`;
    }
    case "paragraph":
      return renderInline(inline);
  }
}

function renderAnnotationComment(
  id: string,
  range: string,
  resolved: boolean,
  body: string,
): string {
  // Never let comment text terminate the HTML comment early.
  const safeBody = body.replace(/--+(?=>)/g, "–").replace(/\n/g, " ");
  return `<!-- annotation ${id} ${range}${resolved ? " resolved" : ""} ${safeBody} -->`;
}

/**
 * Render the document as markdown.
 *
 * headings → `#`×level, paragraphs → their text, code → a fenced block tagged
 * with its language, mermaid → a ```mermaid fence.
 */
export function exportMarkdown(
  ydoc: Y.Doc,
  options: ExportMarkdownOptions = {},
): string {
  const withFrontmatter = options.frontmatter ?? true;
  const annotationMode = options.annotations ?? "drop";

  const sections: string[] = [];

  if (withFrontmatter) {
    const meta = getMeta(ydoc);
    const lines = [
      "---",
      `uuid: ${emitScalar(meta.uuid)}`,
      `title: ${emitScalar(meta.title)}`,
      `tags: [${meta.tags.map(emitScalar).join(", ")}]`,
      "---",
    ];
    sections.push(lines.join("\n"));
  }

  const annotationsByBlock = new Map<string, string[]>();
  if (annotationMode === "html-comments") {
    for (const annotation of listAnnotations(ydoc)) {
      const range = resolveAnnotationRange(ydoc, annotation.id);
      // Threads whose anchor no longer resolves are omitted: there is nothing
      // in the exported text left to point at.
      if (range === null) continue;
      const body = annotation.comments
        .map((comment) => `${comment.author}: ${JSON.stringify(comment.text)}`)
        .join(" | ");
      const line = renderAnnotationComment(
        annotation.id,
        `range=${range.start}-${range.end}`,
        annotation.resolved === true,
        body,
      );
      const existing = annotationsByBlock.get(annotation.blockId);
      if (existing === undefined) {
        annotationsByBlock.set(annotation.blockId, [line]);
      } else {
        existing.push(line);
      }
    }
  }

  // Blocks and their marks come from one traversal. Looking each block's marks
  // up by id would rescan the whole fragment per block.
  for (const { block, inline } of getBlocksWithInline(ydoc)) {
    sections.push(
      renderBlock(
        block,
        inline.length === 0 ? [{ text: block.text, marks: {} }] : inline,
      ),
    );
    const comments = annotationsByBlock.get(block.id);
    if (comments !== undefined) sections.push(comments.join("\n"));
  }

  return sections.length === 0 ? "" : `${sections.join("\n\n")}\n`;
}

export interface ImportedBlock {
  type: BlockType;
  /** The block's plain text, inline syntax resolved away. */
  text: string;
  level?: HeadingLevel;
  language?: string;
  /**
   * The formatted content, present only when the source carried inline syntax.
   * Feeding it to `appendBlock`/`insertBlock` is what preserves the formatting;
   * a caller that reads only `text` gets the same prose without marks.
   */
  inline?: InlineRun[];
}

export interface ImportedDoc {
  title: string;
  tags: string[];
  /** Present only when the source carried a uuid in its frontmatter. */
  uuid?: string;
  /**
   * Outbound links, present only when the source carried a `links` key. Values
   * are target document UUIDs — a link is never a path or a title, so nothing
   * here is resolved against titles or filenames.
   */
  links?: string[];
  blocks: ImportedBlock[];
}

function parseInlineList(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of inner) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map(parseScalar).filter((tag) => tag !== "");
}

interface Frontmatter {
  uuid?: string;
  title?: string;
  tags?: string[];
  links?: string[];
  /** Index of the first body line after the frontmatter block. */
  bodyStart: number;
}

/**
 * A frontmatter list value in any of the three shapes the seed files use:
 * inline (`[a, b]`), a `- ` block on the following lines, or a bare scalar.
 * Returns the list and the index of the last line it consumed.
 */
function parseListValue(
  lines: string[],
  index: number,
  end: number,
  value: string,
): { list: string[]; last: number } {
  if (value.startsWith("[") && value.endsWith("]")) {
    return { list: parseInlineList(value), last: index };
  }
  if (value === "") {
    const list: string[] = [];
    let j = index + 1;
    for (; j < end; j += 1) {
      const item = /^\s*-\s*(.*)$/.exec(lines[j] ?? "");
      if (item === null) break;
      const entry = parseScalar(item[1] ?? "");
      if (entry !== "") list.push(entry);
    }
    return { list, last: j - 1 };
  }
  const scalar = parseScalar(value);
  return { list: scalar === "" ? [] : [scalar], last: index };
}

function parseFrontmatter(lines: string[]): Frontmatter {
  if (lines[0]?.trim() !== "---") return { bodyStart: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { bodyStart: 0 };

  const result: Frontmatter = { bodyStart: end + 1 };
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? "";
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    const value = match[2] ?? "";
    if (key === "uuid") {
      result.uuid = parseScalar(value);
    } else if (key === "title") {
      result.title = parseScalar(value);
    } else if (key === "tags" || key === "links") {
      const parsed = parseListValue(lines, i, end, value);
      if (key === "tags") {
        result.tags = parsed.list;
      } else {
        result.links = parsed.list;
      }
      i = parsed.last;
    }
  }
  return result;
}

/* ---------------------------------------------------------------- inline: in */

/**
 * The reader is two passes, not one, and that is the whole design.
 *
 * A single left-to-right scan that looks for "the closing delimiter" cannot get
 * nesting right: in `*italic **bold** italic*` the first `*`-run it meets is the
 * inner bold's *opener*, and in ``**bold `a**b`**`` the `**` it meets is inside a
 * code span. So:
 *
 *  1. **Tokenize.** Escapes, code spans and links are resolved first — code spans
 *     bind tighter than everything (their content is literal) and a link's label
 *     is tokenized recursively. What is left of `*` and `~` becomes *delimiter
 *     runs*, each tagged with whether it can open and whether it can close,
 *     from the flanking rule: a run can open when the character after it is not
 *     whitespace, and can close when the character before it is not.
 *  2. **Match delimiters,** CommonMark-style: every closer takes the nearest
 *     compatible opener, and a run of three or more is *split* — two characters
 *     for strong, one for emphasis — which is what makes both `***both***` and
 *     `**a***b*` come out right. Delimiter characters nobody claimed are text.
 *
 * The result is a set of properly nested spans over the token list, so a token's
 * marks are simply the union of the spans containing it.
 */

/** How many characters a mark's delimiter takes from a run. */
const STRONG = 2;
const EMPHASIS = 1;

interface TextToken {
  kind: "text";
  text: string;
  /** The marks the tokenizer had in scope: a code span, a link label, or none. */
  marks: InlineMarkSet;
}

interface DelimToken {
  kind: "delim";
  char: string;
  length: number;
  canOpen: boolean;
  canClose: boolean;
  /** Same as {@link TextToken.marks}: whatever is left over is text in scope. */
  marks: InlineMarkSet;
}

type Token = TextToken | DelimToken;

/** Length of the run of `char` starting at `from`. */
function runLength(source: string, from: number, char: string): number {
  let length = 0;
  while (source[from + length] === char) length += 1;
  return length;
}

/**
 * The link opening at `start`, or null — including for a target that is not an
 * external URL, which stays literal text rather than becoming a mark.
 *
 * The label ends at the first unescaped `]`. The target is either bare — running
 * to the `)` that matches, counting nested pairs, so `https://example.com/a_(b)`
 * survives — or CommonMark's `<…>` form, which holds the targets a bare one
 * cannot. Both are the writer's two forms, read back.
 */
function matchLink(
  source: string,
  start: number,
): { label: string; href: string; next: number } | null {
  if (source[start] !== "[") return null;
  let i = start + 1;
  for (; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    // Code spans are resolved before brackets, so a `]` inside one belongs to the
    // code and not to the label — the same order CommonMark parses in, and what
    // lets a label hold `` `]` `` at all.
    if (char === "`") {
      const span = matchCodeSpan(source, i);
      if (span !== null) {
        i = span.next - 1;
        continue;
      }
    }
    if (char === "]") break;
  }
  if (source[i] !== "]" || source[i + 1] !== "(") return null;
  const label = source.slice(start + 1, i);

  const target =
    source[i + 2] === "<"
      ? matchAngleTarget(source, i + 3)
      : matchBareTarget(source, i + 2);
  if (target === null || label === "" || !isExternalHref(target.href)) return null;
  return { label, href: target.href, next: target.next };
}

/** A bare `(target)`, ending at the `)` that balances. */
function matchBareTarget(
  source: string,
  from: number,
): { href: string; next: number } | null {
  let depth = 1;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i] as string;
    if (/\s/.test(char)) return null;
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { href: source.slice(from, i), next: i + 1 };
    }
  }
  return null;
}

/**
 * A `(<target>)`, ending at the first unescaped `>`.
 *
 * Only the three characters the writer escapes there come off their backslash. A
 * backslash before anything else is part of the target — an href goes out
 * unchanged, so it has to come back unchanged.
 */
function matchAngleTarget(
  source: string,
  from: number,
): { href: string; next: number } | null {
  let href = "";
  for (let i = from; i < source.length; i += 1) {
    const char = source[i] as string;
    if (char === "\\") {
      const next = source[i + 1];
      if (next !== undefined && "\\<>".includes(next)) {
        href += next;
        i += 1;
        continue;
      }
    }
    if (char === "<") return null;
    if (char === ">") {
      return source[i + 1] === ")" ? { href, next: i + 2 } : null;
    }
    href += char;
  }
  return null;
}

/**
 * The code span opening at `start`, or null. Content is literal: the closing
 * fence is a backtick run of exactly the opening length, escapes do not apply,
 * and one space is unpadded from each end when both are spaces.
 */
function matchCodeSpan(
  source: string,
  start: number,
): { content: string; next: number } | null {
  const fence = runLength(source, start, "`");
  const from = start + fence;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] !== "`") continue;
    const length = runLength(source, i, "`");
    if (length !== fence) {
      i += length - 1;
      continue;
    }
    let content = source.slice(from, i);
    if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ")) {
      content = content.slice(1, -1);
    }
    return content === "" ? null : { content, next: i + length };
  }
  return null;
}

/** Pass 1: `source` as text, code and delimiter tokens, with `marks` in scope. */
function tokenizeInline(source: string, marks: InlineMarkSet): Token[] {
  const tokens: Token[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") tokens.push({ kind: "text", text: plain, marks });
    plain = "";
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;

    if (char === "\\") {
      const next = source[i + 1];
      if (next !== undefined && "\\`*~[]".includes(next)) {
        plain += next;
        i += 2;
        continue;
      }
    }

    if (char === "`") {
      const span = matchCodeSpan(source, i);
      if (span !== null) {
        flush();
        tokens.push({
          kind: "text",
          text: span.content,
          marks: { ...marks, inlineCode: true },
        });
        i = span.next;
        continue;
      }
    }

    if (char === "[" && marks.link === undefined) {
      const link = matchLink(source, i);
      if (link !== null) {
        flush();
        tokens.push(
          ...tokenizeInline(link.label, { ...marks, link: link.href }),
        );
        i = link.next;
        continue;
      }
    }

    if (char === "*" || char === "~") {
      flush();
      const length = runLength(source, i, char);
      const before = source[i - 1];
      const after = source[i + length];
      tokens.push({
        kind: "delim",
        char,
        length,
        canOpen: after !== undefined && !/\s/.test(after),
        canClose: before !== undefined && !/\s/.test(before),
        marks,
      });
      i += length;
      continue;
    }

    plain += char;
    i += 1;
  }
  flush();
  return tokens;
}

/** A matched pair of delimiters, and the mark it puts on the tokens between. */
interface Span {
  from: number;
  to: number;
  mark: "bold" | "italic" | "strike";
}

/** How many characters a closer and its opener would each give up, or 0. */
function delimiterTake(char: string, opener: number, closer: number): number {
  if (char === "~") return opener >= STRONG && closer >= STRONG ? STRONG : 0;
  return opener >= STRONG && closer >= STRONG ? STRONG : EMPHASIS;
}

/**
 * CommonMark's "rule of three", which is what keeps a `*` that could go either
 * way from closing the wrong thing: when either delimiter can both open and
 * close, the two runs' lengths may not sum to a multiple of three unless both are
 * multiples of three.
 *
 * Without it, `**~~a*x*~~**` reads the italic's *opener* as the bold's closer —
 * the bold `**` can close (a non-space precedes it) and one asterisk is enough —
 * and the whole span unravels. Strikethrough is a GFM extension with no such
 * rule, so this applies to `*` only.
 *
 * The lengths are what is *left* of each run, not what it started as. A run gets
 * spent a piece at a time, and the rule is about the match being made now:
 * `**a***b**` spends two of the middle three closing the bold, and the remaining
 * one against the final two is the 1+2 the rule exists to reject.
 */
function ruleOfThreeAllows(
  char: string,
  opener: DelimToken,
  closer: DelimToken,
  openerLeft: number,
  closerLeft: number,
): boolean {
  if (char !== "*") return true;
  if (!closer.canOpen && !opener.canClose) return true;
  if ((openerLeft + closerLeft) % 3 !== 0) return true;
  return openerLeft % 3 === 0 && closerLeft % 3 === 0;
}

function markFor(char: string, take: number): Span["mark"] {
  if (char === "~") return "strike";
  return take === STRONG ? "bold" : "italic";
}

/**
 * Pass 2: match delimiter runs — every closer takes the nearest compatible
 * opener, and a long run is split between several matches.
 *
 * Returns the spans plus, per token, how much of its run nobody claimed. That
 * leftover is literal text: `**a*` is not emphasis, it is two asterisks and an
 * asterisk.
 */
function matchDelimiters(tokens: readonly Token[]): {
  spans: Span[];
  unclaimed: number[];
} {
  const spans: Span[] = [];
  const unclaimed = tokens.map((token) =>
    token.kind === "delim" ? token.length : 0,
  );
  /** Indexes of runs still able to open something, innermost last. */
  const openers: number[] = [];

  const lengthAt = (index: number): number => unclaimed[index] ?? 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.kind !== "delim") continue;

    while (token.canClose && lengthAt(i) > 0) {
      // The nearest opener this closer can actually use. An opener it cannot —
      // too short for the mark, or refused by the rule of three — is skipped, not
      // a dead end: `~~a~b~~` matches the outer pair *past* the lone `~`.
      let at = -1;
      let take = 0;
      for (let k = openers.length - 1; k >= 0; k -= 1) {
        const j = openers[k] as number;
        const candidate = tokens[j];
        if (
          candidate === undefined ||
          candidate.kind !== "delim" ||
          candidate.char !== token.char ||
          lengthAt(j) === 0 ||
          !ruleOfThreeAllows(token.char, candidate, token, lengthAt(j), lengthAt(i))
        ) {
          continue;
        }
        const possible = delimiterTake(token.char, lengthAt(j), lengthAt(i));
        if (possible === 0) continue;
        at = k;
        take = possible;
        break;
      }
      if (at === -1) break;
      const j = openers[at] as number;
      unclaimed[j] = lengthAt(j) - take;
      unclaimed[i] = lengthAt(i) - take;
      spans.push({ from: j + 1, to: i - 1, mark: markFor(token.char, take) });
      // Openers inside the pair just closed are unreachable now: any closer they
      // could still meet lies outside the span they would have to cover.
      openers.length = lengthAt(j) === 0 ? at : at + 1;
    }

    if (token.canOpen && lengthAt(i) > 0) openers.push(i);
  }
  return { spans, unclaimed };
}

/** A token's marks: the tokenizer's scope, plus every span covering it. */
function marksFor(
  token: Token,
  spans: readonly Span[],
  index: number,
): InlineMarkSet {
  const marks: InlineMarkSet = { ...token.marks };
  for (const span of spans) {
    if (index >= span.from && index <= span.to) marks[span.mark] = true;
  }
  return marks;
}

/**
 * Read `source` into runs: tokenize, match delimiters, then hand every token the
 * union of the marks covering it. Unclaimed delimiter characters come through as
 * the text they are.
 */
function scanInline(source: string, out: InlineRun[]): void {
  const tokens = tokenizeInline(source, {});
  const { spans, unclaimed } = matchDelimiters(tokens);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    const text =
      token.kind === "text"
        ? token.text
        : token.char.repeat(unclaimed[i] ?? 0);
    pushInlineRun(out, text, marksFor(token, spans, i));
  }
}

/**
 * A prose block from its markdown source. `inline` is present only when the
 * source actually carried formatting, so an unformatted document imports to
 * exactly what it did before inline marks existed.
 */
function proseBlock(
  type: "paragraph" | "heading",
  source: string,
): ImportedBlock {
  const runs: InlineRun[] = [];
  scanInline(source, runs);
  const text = inlinePlainText(runs);
  return runs.some((run) => hasInlineMarks(run.marks))
    ? { type, text, inline: runs }
    : { type, text };
}

/**
 * Parse markdown into the pieces needed to build a document: title, tags, links
 * and a flat block list. Handles frontmatter, ATX headings, fenced code (with
 * language) and mermaid fences; everything else becomes a paragraph, with its
 * inline formatting read into `inline`.
 *
 * Title precedence: frontmatter `title`, else a leading level-1 heading — which
 * is then *consumed*, so the title is not duplicated as a block. Any other
 * heading stays a block.
 *
 * HTML comments (including exported annotation comments) are skipped.
 */
export function importMarkdown(markdown: string): ImportedDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const front = parseFrontmatter(lines);
  const blocks: ImportedBlock[] = [];

  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(proseBlock("paragraph", paragraph.join("\n")));
    paragraph = [];
  };

  for (let i = front.bodyStart; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      flush();
      continue;
    }

    if (trimmed.startsWith("<!--")) {
      flush();
      if (!trimmed.includes("-->")) {
        while (i + 1 < lines.length && !(lines[i] ?? "").includes("-->")) i += 1;
      }
      continue;
    }

    // A *backtick* fence's info string may hold no backticks — CommonMark's rule,
    // and the one that keeps a paragraph apart from a fence here: a code span whose
    // content has two adjacent backticks needs a three-backtick fence of its own,
    // so an exported paragraph can legitimately start with ```, and what tells the
    // two apart is that the rest of the line is then full of backticks. A tilde
    // fence has no such restriction, so `~~~ ` + anything is still a fence.
    const fence =
      /^(`{3,})\s*([^`\s]*)\s*$/.exec(trimmed) ??
      /^(~{3,})\s*(\S*)\s*$/.exec(trimmed);
    if (fence !== null) {
      flush();
      const marker = fence[1] ?? "```";
      const fenceChar = marker.startsWith("~") ? "~" : "`";
      const closeRe = new RegExp(`^[${fenceChar}]{${marker.length},}$`);
      const info = (fence[2] ?? "").toLowerCase();
      const body: string[] = [];
      let closed = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (closeRe.test((lines[j] ?? "").trim())) {
          i = j;
          closed = true;
          break;
        }
        body.push(lines[j] ?? "");
      }
      if (!closed) {
        i = lines.length;
        // An unterminated fence swallowed the rest of the file, including the
        // empty string after its trailing newline.
        while (body.length > 0 && body[body.length - 1] === "") body.pop();
      }
      const text = body.join("\n");
      if (info === "mermaid") {
        blocks.push({ type: "mermaid", text });
      } else {
        blocks.push({ type: "code", text, language: info });
      }
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      flush();
      const level = (heading[1] ?? "#").length as HeadingLevel;
      blocks.push({ ...proseBlock("heading", (heading[2] ?? "").trim()), level });
      continue;
    }

    paragraph.push(line);
  }
  flush();

  let title = front.title ?? "";
  if (front.title === undefined) {
    const first = blocks[0];
    if (first !== undefined && first.type === "heading" && first.level === 1) {
      title = first.text;
      blocks.shift();
    }
  }

  // uuid and links are set only when the source carried them: absent is not the
  // same as empty, and a caller distinguishes "no identity in this file" from
  // "this file declares no links".
  const result: ImportedDoc = { title, tags: front.tags ?? [], blocks };
  if (front.uuid !== undefined) result.uuid = front.uuid;
  if (front.links !== undefined) result.links = front.links;
  return result;
}
