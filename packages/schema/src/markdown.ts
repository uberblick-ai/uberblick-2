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
 * Block structure stays line-based, which is exactly what the flat block model
 * needs: a list is a run of `list-item` blocks and a quote is a `quote` block,
 * so a line maps to a block and back with nothing to nest.
 *
 * Reader and writer are one unit: every legal combination of marks has to
 * survive the trip out and back, so the reader implements CommonMark's delimiter
 * matching rather than a looser approximation, and the writer escapes exactly
 * what that reader would take as syntax. The vocabulary is narrower than
 * CommonMark's, deliberately:
 *
 *   - Both emphasis characters are read, `*` and `_`, because both are standard
 *     GFM and an agent writing markdown by hand will use either. Flanking decides
 *     what can open and close, so `_` between two word characters is not a
 *     delimiter at all and `snake_case` survives untouched.
 *   - The writer only ever *writes* `*` and `~~`, so its output is boring and
 *     its diffs are stable — see {@link DELIMITER}.
 *   - Delimiter *runs* are matched the CommonMark way: flanking decides what can
 *     open and close (`** x **` is literal), a closer takes the nearest opener,
 *     and a long run splits between matches — which is what makes `***both***`,
 *     `**a***b*` and `*a **b** c*` each mean what they should.
 *   - A link is a link only when its target is an external `http(s)` URL.
 *     Doc-to-doc references are `meta.links` by UUID and never a link mark, so
 *     anything else stays literal text. Balanced parentheses inside a target
 *     belong to it, again per CommonMark.
 *   - `\` escapes `` \ ` * [ ``, `~` and `_` where they could delimit, and `]`
 *     inside a link label. Nothing else, in both directions.
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
import { listNumbers } from "./lists.js";
import { parseGfmTable } from "./table.js";
import { MAX_LIST_INDENT } from "./types.js";
import type {
  Block,
  BlockType,
  HeadingLevel,
  InlineMarkSet,
  InlineRun,
  ListStyle,
  ProseBlockType,
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
 * The delimiter each mark is written with.
 *
 * One spelling each, always. The `_` forms are deliberately *not* used: the
 * writer would have to predict, at the moment it opens a mark, whether `_` can
 * still close it at the other end of the span — and that prediction depends on
 * run structure that the first export can normalise, which makes the *output*
 * unstable. Measured, it made both mark preservation and byte stability worse
 * than leaving it alone. See the note on `renderInline`.
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
 * `~` and `_` are escaped only where they could actually delimit something, which
 * is what keeps ordinary prose readable: a lone `~` is not a delimiter, so home
 * directories survive, and a `_` between two word characters can neither open nor
 * close, so `snake_case` does too. Both rules are the reader's, read backwards —
 * and both err towards escaping, since a delimiter from a neighbouring run can
 * change what this text sits against.
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
    } else if (char === "_" && !intraword(text, i)) {
      out += "\\_";
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Whether the character at `index` sits between two word characters, where a `_`
 * can neither open nor close emphasis. Only what is inside this run counts: a
 * neighbour that is a word character stays one wherever the run lands, while a
 * missing neighbour could turn out to be anything, so it errs towards escaping.
 */
function intraword(text: string, index: number): boolean {
  const word = /[\p{L}\p{N}]/u;
  const before = text[index - 1];
  const after = text[index + 1];
  return (
    before !== undefined &&
    after !== undefined &&
    word.test(before) &&
    word.test(after)
  );
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

/**
 * Merge neighbouring runs that carry the same marks.
 *
 * A caller can hand over two runs that say the same thing — `appendBlock` writes
 * whatever delta it is given — and how the text happens to be divided must not
 * change what comes out, or an export and the export of its own re-import would
 * disagree over nothing. Every read of a document already merges them, so this is
 * the writer catching up.
 */
function merged(runs: readonly InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) pushInlineRun(out, run.text, run.marks);
  return out;
}

/**
 * Drop the emphasis a run of nothing but whitespace cannot carry.
 *
 * A delimiter needs something other than whitespace to hug, so a mark that has to
 * *open or close* at a whitespace-only run cannot be written at all. A mark that
 * merely passes through — carried by the runs on both sides — is fine: it opened
 * somewhere real and will close somewhere real, and the whitespace is interior to
 * it. Stripping those too is what made a mark survive one round trip and vanish on
 * the next, because the second export was normalising what the first had kept.
 *
 * A code span is exempt entirely: its emphasis hugs the backtick fence, not the
 * whitespace inside it.
 */
function whitespaceSafe(runs: readonly InlineRun[]): InlineRun[] {
  return runs.map((run, index) => {
    if (run.text.trim() !== "" || run.marks.inlineCode === true) return run;
    const carries = (other: InlineRun | undefined, mark: EmphasisMark): boolean =>
      other?.marks[mark] === true;
    const unwritable = EMPHASIS_MARKS.filter(
      (mark) =>
        run.marks[mark] === true &&
        !(carries(runs[index - 1], mark) && carries(runs[index + 1], mark)),
    );
    return unwritable.length === 0
      ? run
      : { text: run.text, marks: without(run.marks, unwritable) };
  });
}

/** Trailing whitespace of `text`, which is `""` when it ends in anything else. */
function trailingWhitespace(text: string): string {
  return /\s*$/.exec(text)?.[0] ?? "";
}

/** The marks two runs agree on — what a forced merge is allowed to keep. */
function sharedMarks(a: InlineMarkSet, b: InlineMarkSet): InlineMarkSet {
  const marks: InlineMarkSet = { inlineCode: true };
  for (const mark of EMPHASIS_MARKS) {
    if (a[mark] === true && b[mark] === true) marks[mark] = true;
  }
  if (a.link !== undefined && a.link === b.link) marks.link = a.link;
  return marks;
}

/**
 * Merge neighbouring code runs, which is almost always lossless and never
 * optional.
 *
 * Two code spans cannot sit side by side: their fences would meet as one run of
 * backticks that no reader can split. Usually there is nothing to do about it —
 * runs carrying *identical* marks are indistinguishable anyway, so joining them
 * changes nothing; and runs that differ are kept apart for free by the delimiters
 * of the mark they disagree about, ``**`a`**`b` `` having the `**` in the way.
 *
 * The exception is a code run of nothing but whitespace. The mark that would have
 * separated it cannot be written there — an emphasis delimiter has no non-space to
 * hug — so the fences really would meet, and the only choice left is which to
 * give up: the marks the two runs disagree about, or the text. It keeps the text.
 */
function coalesceCodeRuns(runs: readonly InlineRun[]): InlineRun[] {
  /** The two runs joined, or null when they may stay apart. */
  const join = (a: InlineRun, b: InlineRun): InlineRun | null => {
    if (a.marks.inlineCode !== true || b.marks.inlineCode !== true) return null;
    if (sameInlineMarks(a.marks, b.marks)) {
      return { text: a.text + b.text, marks: a.marks };
    }
    if (a.text.trim() === "" || b.text.trim() === "") {
      return { text: a.text + b.text, marks: sharedMarks(a.marks, b.marks) };
    }
    return null;
  };

  const out: InlineRun[] = [];
  for (const run of runs) {
    out.push(run);
    // Collapse backwards, not just once: a forced merge drops the marks that were
    // keeping this span apart from the one before it, which can leave *those* two
    // needing to join as well.
    while (out.length >= 2) {
      const a = out[out.length - 2] as InlineRun;
      const b = out[out.length - 1] as InlineRun;
      const joined = join(a, b);
      if (joined === null) break;
      out.splice(out.length - 2, 2, joined);
    }
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
 *     output and re-appended after the delimiters that close, and a mark that
 *     would have to *open or close* on a whitespace-only run is dropped from it.
 *     Only that mark, and only there: one that merely passes through, carried by
 *     the runs on both sides, is interior to its span and survives.
 *   - **Delimiter runs of the same character that meet.** Splitting a crossing
 *     means an inner mark's reopener lands against the closer of the mark that
 *     died, and `*` after `**` is one run of three. The reader takes those apart
 *     the CommonMark way — nearest opener, runs split a piece at a time, and the
 *     rule of three judging only the *first* match between two runs, since a pair
 *     already mid-construct must not be vetoed halfway.
 *
 * What the pair therefore guarantees, and what the property test at the bottom of
 * `test/marks.test.ts` asserts: the text never changes; the per-character mark
 * sets never change from the first export's own re-read onward; and the bytes
 * settle immediately, an export of a re-import being identical to its source. For
 * a document GFM can express at all, the first export is already exact — the two
 * exceptions being the marked whitespace above and two code spans that would meet
 * with nothing writable between them. Both are the format's limits rather than this
 * code's, and `expressibleInGfm` in the test names them structurally.
 */
function renderInline(source: readonly InlineRun[]): string {
  let out = "";
  const open: OpenMark[] = [];

  const runs: InlineRun[] = whitespaceSafe(coalesceCodeRuns(merged(source)));
  // A single unmarked run has no delimiter anywhere near it; anything else might.
  const hugged = runs.length > 1 || hasInlineMarks(runs[0]?.marks ?? {});
  const orders = markOrders(runs);

  /**
   * Close every mark above `depth`, top down, putting `held` back after the last
   * emphasis closer — outside the emphasis, still inside the marks that enclose
   * it, whose closers have not been written yet.
   *
   * Only emphasis cannot sit against whitespace; a link is perfectly happy to, so
   * `[word ](url)` keeps its space when the link is the deeper of the two. When
   * the link is the *inner* one, though, the space cannot stay in it: the bold
   * closing after it would then cover a trailing space, which the next read strips
   * — the export would keep a mark that its own re-export drops. One mark has to
   * go, and it is the one whose span ends here. `expressibleInGfm` in the test
   * names that case, and the honest cost is recorded there.
   */
  const closeDownTo = (depth: number, held = ""): void => {
    const lastEmphasis = open.findIndex(
      (entry, index) => index >= depth && entry.name !== "link",
    );
    for (let i = open.length - 1; i >= depth; i -= 1) {
      const entry = open[i];
      if (entry === undefined) continue;
      out += entry.name === "link" ? `](${renderHref(entry.href)})` : entry.spelling;
      if (i === lastEmphasis) out += held;
    }
    if (lastEmphasis === -1) out += held;
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

    // Closing: hold back the whitespace already written, so no emphasis closer
    // sits on it. `closeDownTo` puts it back inside whatever may keep it.
    let held = "";
    if (open.slice(common).some((entry) => entry.name !== "link")) {
      held = trailingWhitespace(out);
      out = out.slice(0, out.length - held.length);
    }
    closeDownTo(common, held);

    // Opening: the mirror image. Leading whitespace goes before the first
    // *emphasis* delimiter — so a link opened outside it still covers the space —
    // and never comes out of a code span at all, whose delimiters hug its backtick
    // fence rather than its content.
    //
    // A run of nothing but whitespace opens no emphasis at all. `whitespaceSafe`
    // has already dropped the marks that begin or end there, but a crossing can
    // still force one that merely passes through to close and *reopen* right here,
    // and an opener needs something other than a space to hug. Hoisting instead
    // would empty the run — and an empty link label is not a link.
    let text = run.text;
    // A code run is not "blank" for this purpose however empty it looks: its
    // emphasis hugs the backtick fence, which is not whitespace.
    const blank = text.trim() === "" && marks.inlineCode !== true;
    const opening = blank
      ? desired.slice(common).filter((name) => name === "link")
      : desired.slice(common);
    const firstEmphasis =
      marks.inlineCode === true || blank
        ? -1
        : opening.findIndex((name) => name !== "link");
    for (const [offset, name] of opening.entries()) {
      if (offset === firstEmphasis) {
        const lead = /^\s*/.exec(text)?.[0] ?? "";
        out += lead;
        text = text.slice(lead.length);
      }
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

  if (open.some((entry) => entry.name !== "link")) {
    const held = trailingWhitespace(out);
    out = out.slice(0, out.length - held.length);
    closeDownTo(0, held);
  } else {
    closeDownTo(0);
  }
  return out;
}

/**
 * One indent level, as written.
 *
 * Four spaces rather than two, because both markers have to nest under it: a
 * child of `1. ` has to start at or past the parent's content column, which is
 * three, and two spaces would close the list instead of nesting into it. Four
 * clears every marker this writer emits and still stays under the parent's
 * content column plus four, where an indented code block would begin.
 */
const LIST_INDENT_UNIT = "    ";

/**
 * The marker one list item is written with: its indentation, then `- ` or the
 * number {@link listNumbers} gave it. The numbering rule itself is shared with
 * the editor and lives in `lists.ts`.
 */
function listMarker(block: Block, number: number | null): string {
  const indent = Math.min(block.indent ?? 0, MAX_LIST_INDENT);
  const marker = number === null ? "- " : `${number}. `;
  return `${LIST_INDENT_UNIT.repeat(indent)}${marker}`;
}

function renderBlock(
  block: Block,
  inline: readonly InlineRun[],
  /** The list marker, for a `list-item`; ignored by every other type. */
  marker = "",
): string {
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
    case "list-item": {
      // One item, one line — a second line would be a continuation the reader
      // resolves against the marker's column, which no flat block can promise.
      const text = renderInline(inline).replace(/\s*\n\s*/g, " ").trim();
      return `${marker}${text}`.trimEnd();
    }
    case "quote":
      // Every line marked, so a multi-line quote comes back as one block.
      return renderInline(inline)
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    case "table":
      // The source *is* the markdown: a table goes out exactly as it is stored,
      // down to the spacing someone lined its pipes up with.
      return block.text;
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
 * with its language, mermaid → a ```mermaid fence, list items → a `- `/`1. `
 * line indented by their level, quotes → `> ` on every line, tables → their
 * source verbatim.
 *
 * Blocks are separated by a blank line, except two adjacent list items: a blank
 * line between them is what makes a reader render the list *loose*, so a run of
 * items is written as the tight list it is.
 */
export function exportMarkdown(
  ydoc: Y.Doc,
  options: ExportMarkdownOptions = {},
): string {
  const withFrontmatter = options.frontmatter ?? true;
  const annotationMode = options.annotations ?? "drop";

  /** Rendered blocks, each knowing whether it is a list item — see the join. */
  const sections: Array<{ text: string; listItem: boolean }> = [];
  const push = (text: string, listItem = false): void => {
    sections.push({ text, listItem });
  };

  if (withFrontmatter) {
    const meta = getMeta(ydoc);
    const lines = [
      "---",
      `uuid: ${emitScalar(meta.uuid)}`,
      `title: ${emitScalar(meta.title)}`,
      `tags: [${meta.tags.map(emitScalar).join(", ")}]`,
      "---",
    ];
    push(lines.join("\n"));
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
  const entries = getBlocksWithInline(ydoc);
  const numbers = listNumbers(entries.map((entry) => entry.block));

  // An annotated *list item* takes its comments indented underneath it, where
  // they are the item's own content. Two things have to hold at once, and only
  // that shape holds both: a comment is attributed by the block it follows —
  // it carries a thread id, not a block id — so it must stay with its item;
  // and a comment written *between* two items at column zero is a block between
  // them, blank lines and all, which ends the list for any reader, so the next
  // item would come back at depth zero. Indented, it is inside the item and the
  // run carries on.
  for (const [index, { block, inline }] of entries.entries()) {
    const listItem = block.type === "list-item";
    const marker = listItem ? listMarker(block, numbers[index] ?? null) : "";
    push(
      renderBlock(
        block,
        inline.length === 0 ? [{ text: block.text, marks: {} }] : inline,
        marker,
      ),
      listItem,
    );
    const comments = annotationsByBlock.get(block.id);
    if (comments === undefined) continue;
    if (!listItem) {
      push(comments.join("\n"));
      continue;
    }
    // Indented to the item's own content column, which is the width of its
    // marker — indentation, marker and the space after it. A fixed unit cannot
    // do this: `100. ` is five columns wide, and four spaces would put the
    // comment *outside* the item for any reader that counts columns.
    const inside = " ".repeat(marker.length);
    push(comments.map((line) => `${inside}${line}`).join("\n"), true);
  }

  if (sections.length === 0) return "";
  let out = "";
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    if (section === undefined) continue;
    if (i > 0) {
      out += section.listItem && sections[i - 1]?.listItem === true ? "\n" : "\n\n";
    }
    out += section.text;
  }
  return `${out}\n`;
}

export interface ImportedBlock {
  type: BlockType;
  /** The block's plain text, inline syntax resolved away. */
  text: string;
  level?: HeadingLevel;
  language?: string;
  /** List items only: the marker the source line carried. */
  list?: ListStyle;
  /** List items only: nesting depth, 0–3, read from the source's indentation. */
  indent?: number;
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

/** Absent means the edge of the line, which CommonMark counts as whitespace. */
function isBlank(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/**
 * CommonMark's "punctuation" for the flanking rules: an ASCII punctuation
 * character, or anything in Unicode's P categories. Not the S (symbol)
 * categories — with those in, `€_x_€` reads as emphasis, which it is not.
 */
function isPunctuation(char: string | undefined): boolean {
  return char !== undefined && /[!-/:-@[-`{-~]|\p{P}/u.test(char);
}

/**
 * Whether a delimiter run can open, can close, or both.
 *
 * `*` and `~` use the rule this reader has always used: a run may open when a
 * non-space follows it and close when a non-space precedes it. That is the part
 * of CommonMark's flanking rule that matters for them, and the strict form —
 * which also asks about punctuation on either side — would refuse perfectly good
 * closers like the `~~` after an escaped tilde.
 *
 * `_` gets the strict form, because its whole reason for existing here is the
 * *intraword* restriction: a run that could go either way may only open when
 * punctuation precedes it and only close when punctuation follows, so a `_`
 * between two word characters can do neither and `snake_case` is just a word.
 */
function flanking(
  char: string,
  before: string | undefined,
  after: string | undefined,
): { canOpen: boolean; canClose: boolean } {
  if (char !== "_") {
    return { canOpen: !isBlank(after), canClose: !isBlank(before) };
  }
  const leftFlanking =
    !isBlank(after) &&
    (!isPunctuation(after) || isBlank(before) || isPunctuation(before));
  const rightFlanking =
    !isBlank(before) &&
    (!isPunctuation(before) || isBlank(after) || isPunctuation(after));
  return {
    canOpen: leftFlanking && (!rightFlanking || isPunctuation(before)),
    canClose: rightFlanking && (!leftFlanking || isPunctuation(after)),
  };
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
      if (next !== undefined && "\\`*_~[]".includes(next)) {
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

    if (char === "*" || char === "~" || char === "_") {
      flush();
      const length = runLength(source, i, char);
      tokens.push({
        kind: "delim",
        char,
        length,
        ...flanking(char, source[i - 1], source[i + length]),
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

/** Whether `char` writes emphasis (`*`, `_`) rather than strikethrough (`~`). */
function isEmphasisChar(char: string): boolean {
  return char === "*" || char === "_";
}

/** How many characters a closer and its opener would each give up, or 0. */
function delimiterTake(char: string, opener: number, closer: number): number {
  if (!isEmphasisChar(char)) {
    return opener >= STRONG && closer >= STRONG ? STRONG : 0;
  }
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
 * rule, so this applies to the emphasis characters only.
 *
 * The lengths are what is *left* of each run, not what it started as. A run gets
 * spent a piece at a time, and the rule is about the match being made now:
 * `**a***b**` spends two of the middle three closing the bold, and the remaining
 * one against the final two is the 1+2 the rule exists to reject.
 *
 * It only judges the *first* match between two runs — a pair that has already
 * exchanged characters is one nested construct being taken apart, and vetoing the
 * rest of it would strand delimiters as text. That waiver is conditional, though,
 * and {@link matchNesting} is what makes it conditional: it only stands if the
 * construct actually finishes.
 */
function ruleOfThreeAllows(
  char: string,
  opener: DelimToken,
  closer: DelimToken,
  openerLeft: number,
  closerLeft: number,
  paired: boolean,
): boolean {
  if (!isEmphasisChar(char)) return true;
  if (paired) return true;
  if (!closer.canOpen && !opener.canClose) return true;
  if ((openerLeft + closerLeft) % 3 !== 0) return true;
  return openerLeft % 3 === 0 && closerLeft % 3 === 0;
}

function markFor(char: string, take: number): Span["mark"] {
  if (!isEmphasisChar(char)) return "strike";
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
function matchDelimiters(
  tokens: readonly Token[],
  denied: ReadonlySet<string>,
  frozen: readonly number[],
): {
  spans: Span[];
  unclaimed: number[];
  /** The pairs that only matched because the rule of three was waived. */
  waived: Array<{ key: string; opener: number; closer: number; take: number }>;
} {
  const waived: Array<{
    key: string;
    opener: number;
    closer: number;
    take: number;
  }> = [];
  const spans: Span[] = [];
  // Frozen characters are text before matching begins: nothing may claim them,
  // and they are added back to the leftovers at the end so they still get written.
  const unclaimed = tokens.map((token, index) =>
    token.kind === "delim" ? token.length - (frozen[index] ?? 0) : 0,
  );
  /** Indexes of runs still able to open something, innermost last. */
  const openers: number[] = [];
  /** Which opener/closer pairs have already matched — see the rule of three. */
  const paired = new Set<string>();

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
      let exercisedWaiver = false;
      for (let k = openers.length - 1; k >= 0; k -= 1) {
        const j = openers[k] as number;
        const candidate = tokens[j];
        if (
          candidate === undefined ||
          candidate.kind !== "delim" ||
          candidate.char !== token.char ||
          lengthAt(j) === 0
        ) {
          continue;
        }
        // Two separate questions: would the rule of three allow this match on its
        // own, and if not, is the waiver available? Most repeat matches between one
        // pair need no waiver at all — `****a*****` matches strong twice because
        // neither run can go both ways — and recording those as waived would
        // quarantine delimiters that nothing was ever wrong with.
        const strict = ruleOfThreeAllows(
          token.char,
          candidate,
          token,
          lengthAt(j),
          lengthAt(i),
          false,
        );
        const key = `${j}:${i}`;
        const waiverOffered = paired.has(key) && !denied.has(key);
        if (!strict && !waiverOffered) continue;
        const possible = delimiterTake(token.char, lengthAt(j), lengthAt(i));
        if (possible === 0) continue;
        at = k;
        take = possible;
        exercisedWaiver = !strict;
        break;
      }
      if (at === -1) break;
      const j = openers[at] as number;
      const key = `${j}:${i}`;
      if (exercisedWaiver) waived.push({ key, opener: j, closer: i, take });
      paired.add(key);
      unclaimed[j] = lengthAt(j) - take;
      unclaimed[i] = lengthAt(i) - take;
      spans.push({ from: j + 1, to: i - 1, mark: markFor(token.char, take) });
      // Openers inside the pair just closed are unreachable now: any closer they
      // could still meet lies outside the span they would have to cover.
      openers.length = lengthAt(j) === 0 ? at : at + 1;
    }

    if (token.canOpen && lengthAt(i) > 0) openers.push(i);
  }
  return {
    spans,
    unclaimed: unclaimed.map((left, index) => left + (frozen[index] ?? 0)),
    waived,
  };
}

/**
 * Match the delimiters, and check that the licence taken to do it was earned.
 *
 * The rule of three is waived for a second match between the same two runs, so
 * that one nested construct can be taken apart — the four asterisks that close an
 * italic inside a bold and reopen the italic need it. But `a***b****c` has the
 * same shape and no later closer to finish the job, and CommonMark reads it as a
 * single strong span with three asterisks left over as text. The two are
 * indistinguishable at the moment of the match; what tells them apart is whether
 * the construct is *finished*.
 *
 * So: match with the waiver, and if either run it was granted for ends up with
 * characters nobody claimed, withdraw it — and *quarantine* what the waived match
 * had taken. Those characters become literal text for the re-match rather than
 * going back on the market.
 *
 * The quarantine is what keeps a withdrawal local. Handing the freed characters
 * back would let some *other* pair consume them, so denying one waiver could
 * silently change the marks on a construct that was perfectly well formed.
 * Freezing them leaves every other pair looking at the same characters it saw
 * before.
 *
 * Not at the same *time*, though, and that is worth being exact about: a denied
 * pair stops matching altogether, which changes how the opener stack unwinds after
 * it, so a later pair can pair up differently and need a withdrawal of its own.
 * Settling is therefore monotone rather than immediate — every round denies at
 * least one pair and no round ever grants one back, so the number of rounds is at
 * most the number of distinct pairs that exercise the waiver, *plus one* for the
 * clean round that returns. In practice that is one round whenever nothing has to
 * be withdrawn — including input whose waiver is exercised and stands, like
 * `***c****d*` — and two when one is: `****a******a*******` and `a***b****c` each
 * withdraw a single pair and return on the second round.
 *
 * A note on fidelity, since this is a reader of other people's markdown: the
 * quarantine is a rule of this implementation, chosen because it is provable, not
 * one lifted from a reference implementation. cmark could not be run in the
 * environment this was written in, so its output for these shapes is *unverified*
 * here; what the tests pin is that every character of the input survives, which is
 * the contract this reader owes its callers either way.
 */
function matchNesting(tokens: readonly Token[]): {
  spans: Span[];
  unclaimed: number[];
} {
  const denied = new Set<string>();
  const frozen = tokens.map(() => 0);
  // One round per withdrawal plus a clean one to finish; the cap is here so a
  // mistake in the reasoning above cannot become an infinite loop, not because the
  // count is expected to come near it.
  for (let pass = 0; pass < tokens.length + 2; pass += 1) {
    const attempt = matchDelimiters(tokens, denied, frozen);
    const stranded = attempt.waived.filter(
      (pair) =>
        !denied.has(pair.key) &&
        ((attempt.unclaimed[pair.opener] ?? 0) > 0 ||
          (attempt.unclaimed[pair.closer] ?? 0) > 0),
    );
    if (stranded.length === 0) return attempt;
    for (const pair of stranded) {
      denied.add(pair.key);
      frozen[pair.opener] = (frozen[pair.opener] ?? 0) + pair.take;
      frozen[pair.closer] = (frozen[pair.closer] ?? 0) + pair.take;
    }
  }
  return matchDelimiters(tokens, denied, frozen);
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
  const { spans, unclaimed } = matchNesting(tokens);
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
  type: ProseBlockType,
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
 * `- `, `* `, `+ `, `1. ` or `1) `, with whatever indentation precedes it.
 *
 * Four captures: the indentation, the marker, the run of spaces after it, and
 * the content. The gap is captured because it is part of the arithmetic — see
 * `contentColumn` in {@link importMarkdown}.
 */
const LIST_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?[ \t]*$/;

/** `> `, indented no further than a paragraph may be. */
const QUOTE_LINE = /^ {0,3}>[ \t]?(.*)$/;

/** An ATX heading, a fence of either character, an HTML comment — block *starts*. */
const HEADING_LINE = /^#{1,6}\s/;
const FENCE_LINE = /^(?:`{3,}|~{3,})/;
const COMMENT_LINE = /^<!--/;

/**
 * Whether `line` starts a block, in the sense that matters to a table: a table
 * ends where another block begins, and every one of these begins one.
 *
 * This is the reader's knowledge, not the table parser's. `parseGfmTable` knows
 * tables — to it a heading or a quote is a perfectly good one-column row — so
 * the question of what else a line could be has to be asked out here, where the
 * rest of the document's vocabulary lives. The list is exactly what the loop
 * below recognises, HTML comments included: anything this reader would take as
 * its own block after the table has to end the table, or the two disagree and
 * the comment — an exported annotation, say — is stored as a row.
 */
function startsBlock(line: string): boolean {
  const trimmed = line.trim();
  return (
    QUOTE_LINE.test(line) ||
    LIST_LINE.test(line) ||
    HEADING_LINE.test(trimmed) ||
    FENCE_LINE.test(trimmed) ||
    COMMENT_LINE.test(trimmed)
  );
}

/** How wide a tab is, counted to the next stop rather than as four columns. */
const TAB_WIDTH = 4;

/**
 * The column `text` ends at, starting from `column`.
 *
 * A tab advances to the next tab stop, which is what makes it worth a function:
 * a tab in column two is worth two columns, not four, and a list whose depth was
 * measured by expanding every tab to four spaces nests items their author wrote
 * as siblings. CommonMark counts columns, so this counts columns.
 */
function advanceColumn(text: string, column: number): number {
  let at = column;
  for (const char of text) {
    at = char === "\t" ? at + TAB_WIDTH - (at % TAB_WIDTH) : at + 1;
  }
  return at;
}

/**
 * Parse markdown into the pieces needed to build a document: title, tags, links
 * and a flat block list. Handles frontmatter, ATX headings, fenced code (with
 * language), mermaid fences, list items, block quotes and GFM tables;
 * everything else becomes a paragraph, with its inline formatting read into
 * `inline`.
 *
 * Title precedence: frontmatter `title`, else a leading level-1 heading — which
 * is then *consumed*, so the title is not duplicated as a block. Any other
 * heading stays a block.
 *
 * A list item is one line and one block: continuation lines and nested block
 * content inside an item are not read, because no flat block can hold them.
 * Consecutive `>` lines are one quote block, which is what makes a multi-line
 * quote survive the trip out and back.
 *
 * HTML comments (including exported annotation comments) are skipped.
 */
export function importMarkdown(markdown: string): ImportedDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const front = parseFrontmatter(lines);
  const blocks: ImportedBlock[] = [];

  let paragraph: string[] = [];
  let quote: string[] = [];
  const flush = (): void => {
    // Only one of the two can be open, and a quote always opened first.
    if (quote.length > 0) {
      blocks.push(proseBlock("quote", quote.join("\n")));
      quote = [];
    }
    if (paragraph.length === 0) return;
    blocks.push(proseBlock("paragraph", paragraph.join("\n")));
    paragraph = [];
  };

  /**
   * The **content column** of every list item still open, innermost last.
   *
   * Depth is never a division of the indentation: a source nesting by two
   * spaces and one nesting by four both mean "one level in". It is not the
   * relative column either, which is the trap — an item is nested only when it
   * reaches the column where the item above it *starts its content*, which is
   * that item's marker column plus its marker plus the spaces after it. So
   * `- a` followed by ` - b` is two siblings (one space does not reach column
   * two), while `1. a` followed by `   1. b` is a child (three does reach
   * three). CommonMark's rule, and the reason each open item remembers a column
   * rather than the level remembering one.
   */
  let openItems: number[] = [];
  const listLevel = (column: number, contentColumn: number): number => {
    // An item closes every open item whose content column it does not reach:
    // indented less than that, it is a sibling of one of their lists, never a
    // child of the item above it.
    while (openItems.length > 0 && column < (openItems.at(-1) ?? 0)) {
      openItems.pop();
    }
    const depth = openItems.length;
    openItems.push(contentColumn);
    return Math.min(depth, MAX_LIST_INDENT);
  };

  for (let i = front.bodyStart; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      // A blank line ends a paragraph but not a list: a blank line between
      // items is a loose list, still one list.
      flush();
      continue;
    }

    // A table is two lines before it is anything — a header row and a delimiter
    // row — so it is recognised with a lookahead, and by the same parser that
    // draws one: it is the parser that knows which pipes are structure and which
    // are somebody's `\|`. Its lines are then taken verbatim, because the block
    // stores GFM source.
    //
    // A delimiter row that is also a list line loses to the list. `- | -` is
    // both — a one-hyphen delimiter row is legal GFM — and reading it as a
    // delimiter would swallow the paragraph above it into a table nobody wrote,
    // while reading it as the list item it looks like costs the reader nothing.
    const delimiterLine = lines[i + 1] ?? "";
    if (
      parseGfmTable(`${line}\n${delimiterLine}`) !== null &&
      LIST_LINE.exec(delimiterLine) === null
    ) {
      flush();
      openItems = [];
      const table = [line, delimiterLine];
      let j = i + 2;
      // Where the table ends is two questions, and they are asked in this
      // order. First: does this line *start another block*? The parser cannot
      // answer that — it knows tables, and a heading, a quote, a fence or a
      // list item is a fact about the document around one; to `parseGfmTable`
      // every one of them is a perfectly good one-column row, so asking it
      // first swallows the rest of the document up to the next blank line.
      // Then, and only then: does the block still parse as one table? That is
      // the parser's own boundary, and asking it keeps the reader from storing
      // source it would itself read differently.
      //
      // The blank line is tested here rather than left to the parser because a
      // *trailing* one is trimmed off any source before it is parsed; inside the
      // block, the parser rejects it as the table-ender it is.
      while (
        j < lines.length &&
        (lines[j] ?? "").trim() !== "" &&
        !startsBlock(lines[j] ?? "") &&
        parseGfmTable([...table, lines[j] ?? ""].join("\n")) !== null
      ) {
        table.push(lines[j] ?? "");
        j += 1;
      }
      i = j - 1;
      blocks.push({ type: "table", text: table.join("\n") });
      continue;
    }

    const listLine = LIST_LINE.exec(line);
    if (listLine !== null) {
      flush();
      const marker = listLine[2] ?? "-";
      const column = advanceColumn(listLine[1] ?? "", 0);
      const afterMarker = column + marker.length;
      const gap = advanceColumn(listLine[3] ?? " ", afterMarker) - afterMarker;
      // Where this item's own content starts, which is what decides whether the
      // next line is inside it. Five columns or more after the marker begin an
      // indented code block instead, and the content column is then the marker
      // plus one — CommonMark again, and the one place the gap is not itself.
      const contentColumn = afterMarker + (gap > 4 ? 1 : gap);
      blocks.push({
        ...proseBlock("list-item", (listLine[4] ?? "").trim()),
        list: /^\d/.test(marker) ? "ordered" : "bullet",
        indent: listLevel(column, contentColumn),
      });
      continue;
    }
    // An HTML comment is not content, so it is not a block between two items
    // either: the run survives it, and an annotated list item exported with
    // `annotations: "html-comments"` comes back at the depth it went out at.
    // Checked before the reset below for exactly that reason.
    if (trimmed.startsWith("<!--")) {
      flush();
      if (!trimmed.includes("-->")) {
        while (i + 1 < lines.length && !(lines[i] ?? "").includes("-->")) i += 1;
      }
      continue;
    }

    // Anything else closes the list, so the next run starts at level zero.
    openItems = [];

    const quoteLine = QUOTE_LINE.exec(line);
    if (quoteLine !== null) {
      // Prose ahead of it is its own block; the quote lines that follow join
      // this one.
      if (paragraph.length > 0) flush();
      quote.push(quoteLine[1] ?? "");
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
