/**
 * Markdown is an interchange projection, never the document's storage format.
 * Reader and writer share delimiter and escape rules to preserve inline runs.
 */

import type * as Y from "yjs";
import { getBlocksWithInline } from "./blocks.js";
import { getMeta } from "./doc.js";
import { hasDocData } from "./data.js";
import { decisionRelations, decisionTopicTitle, readDecisions } from "./decisions.js";
import { listAnnotations, resolveAnnotationRange } from "./annotations.js";
import {
  hasInlineMarks,
  inlineLinkTarget,
  inlinePlainText,
  isExternalHref,
  pushInlineRun,
  sameInlineMarks,
} from "./marks.js";
import { canonicalDocumentUuid } from "./rooms.js";
import { listNumbers } from "./lists.js";
import { parseGfmTable, writeGfmTable } from "./table.js";
import { escapeContainerLines, parseCardInput, writeCardText } from "./card.js";
import { parseFigmaInput, writeFigmaText } from "./figma.js";
import { resolveTagAssignments } from "./tags.js";
import { MAX_LIST_INDENT } from "./types.js";
import type {
  Block,
  BlockType,
  DecisionReference,
  HeadingLevel,
  InlineMarkSet,
  InlineRun,
  ListStyle,
  ProseBlockType,
} from "./types.js";

export interface ExportMarkdownOptions {
  /** The document room's identity, when the caller has it. */
  uuid?: string;
  /**
   * Default true: emit uuid, title and tags, plus description/kind/status only
   * when present, within a --- frontmatter block.
   */
  frontmatter?: boolean;
  /**
   * Default drop; html-comments places each thread immediately after its block.
   */
  annotations?: "html-comments" | "drop";
  /**
   * Project current names, including retired assignments; omit unknown IDs and
   * provisional strings. Without a catalog, export stored assignments.
   */
  tagCatalog?: Y.Doc;
  /**
   * Resolve decision titles and state; absent directory data leaves bare UUIDs.
   */
  directory?: Y.Doc;
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

/**
 * Code is always innermost. Both link marks share one stack entry because their
 * target shape distinguishes them within the same [label](target) syntax.
 */
const NESTING = ["link", "bold", "italic", "strike"] as const;

type NestedMark = (typeof NESTING)[number];

/**
 * Fixed spellings keep export stable: whether an underscore can close depends
 * on distant run structure that the first export may normalize.
 */
const DELIMITER: Record<Exclude<NestedMark, "link">, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
};

function nestedMarksOf(marks: InlineMarkSet): NestedMark[] {
  const out: NestedMark[] = [];
  if (inlineLinkTarget(marks) !== undefined) out.push("link");
  if (marks.bold === true) out.push("bold");
  if (marks.italic === true) out.push("italic");
  if (marks.strike === true) out.push("strike");
  return out;
}

interface EscapeContext {
  /** Tables also escape pipes, HTML/autolink openers and entity ampersands. */
  table?: boolean;
  /**
   * The first unescaped ] ends a link label and must be escaped inside it.
   */
  insideLabel: boolean;
  /**
   * A neighboring emitted ~~ can absorb a lone ~ across a run boundary.
   */
  hugged: boolean;
}

/**
 * Escape backslash, backtick, * and [; plus ] in labels, delimiting ~/_ and table
 * punctuation. Always escape [: a later run can supply its ](target). Missing
 * neighbors may delimit, and the tokenizer must undo this same vocabulary.
 */
function escapeInline(text: string, context: EscapeContext): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (char === "\\" || char === "`" || char === "*" || char === "[" || (context.table === true && ["<", ">", "&", "!", "]"].includes(char))) {
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
 * Intraword _ cannot delimit emphasis. Missing run-local neighbors could be
 * anything after joining runs, so they do not qualify for this exemption.
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
 * Preserve target bytes: balanced parentheses may stay bare; unbalanced ones
 * and angle brackets require <…> with escapes that matchAngleTarget undoes.
 */
function renderTarget(target: string, angleWhitespace = false): string {
  if (parensBalanced(target) && !/[<>]/.test(target) && (!angleWhitespace || !/\s/.test(target))) return target;
  return `<${target.replace(/[\\<>]/g, (char) => `\\${char}`)}>`;
}

/** A plain label and an opaque destination, using the inline writer's escapes. */
export function renderMarkdownLink(text: string, href: string): string {
  return `[${escapeInline(text, { insideLabel: true, hugged: false })}](${renderTarget(href, true)})`;
}

/**
 * Code content is literal. Use a longer backtick fence and pad edges that the
 * reader would otherwise unpad.
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
 * Coalesce equal-mark runs before export, matching document reads so arbitrary
 * delta splits cannot change the bytes on re-import and re-export.
 */
function merged(runs: readonly InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) pushInlineRun(out, run.text, run.marks);
  return out;
}

/**
 * Whitespace-only runs cannot open or close emphasis. Keep marks present on
 * both neighbors, or a later export would strip valid interior whitespace marks.
 * Code spans are exempt because emphasis hugs their fence.
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
  const target = inlineLinkTarget(a);
  if (target !== undefined && target === inlineLinkTarget(b)) {
    if (a.docLink === target) marks.docLink = target;
    else marks.link = target;
  }
  return marks;
}

/**
 * Touching code fences merge into one unreadable delimiter run. Equal marks
 * coalesce losslessly; differing marks normally separate fences. Whitespace-only
 * code cannot carry that separator, so preserve text and keep only shared marks.
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
    // Dropping separator marks can force a further merge with the preceding run.
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
  /** For a link, what goes in its `(…)`: an external URL or a document uuid. */
  target: string;
  /** The spelling this mark was opened with; a closer must match it. */
  spelling: string;
  /** Where the opener starts, so a link emptied by whitespace hugging can go. */
  start: number;
}

/**
 * Earliest-start/latest-end marks go outside shorter spans, avoiding needless
 * close/reopen pairs across words. Two passes per mark keep the work O(runs).
 */
function markOrders(runs: readonly InlineRun[]): NestedMark[][] {
  const starts = new Map<NestedMark, number[]>();
  const ends = new Map<NestedMark, number[]>();
  const target = (index: number): string | undefined => {
    const marks = runs[index]?.marks;
    return marks === undefined ? undefined : inlineLinkTarget(marks);
  };

  for (const mark of NESTING) {
    const start: number[] = [];
    const end: number[] = [];
    const carries = (index: number): boolean => {
      const marks = runs[index]?.marks;
      if (marks === undefined) return false;
      return mark === "link" ? target(index) !== undefined : marks[mark] === true;
    };
    const same = (a: number, b: number): boolean =>
      mark === "link" ? target(a) === target(b) : carries(a) && carries(b);

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
 * Close/open a stack so crossing marks become nested pieces with identical
 * per-character marks. Table mode escapes HTML punctuation; writeGfmTable owns
 * all pipe escaping, including inside code and targets.
 * Text is preserved; marks and bytes stabilize after the first re-read. The
 * first export preserves marks except unwritable edge whitespace and touching
 * code spans without a writable separator.
 */
export function renderInline(source: readonly InlineRun[], table = false): string {
  let out = "";
  const open: OpenMark[] = [];

  const runs: InlineRun[] = whitespaceSafe(coalesceCodeRuns(merged(source)));
  // A single unmarked run has no delimiter anywhere near it; anything else might.
  const hugged = runs.length > 1 || hasInlineMarks(runs[0]?.marks ?? {});
  const orders = markOrders(runs);

  /**
   * Put held whitespace outside the last closing emphasis but inside continuing
   * marks. An inner link ending with that emphasis loses the whitespace mark;
   * retaining it would make the next export differ.
   */
  const closeDownTo = (depth: number, held = ""): void => {
    const lastEmphasis = open.findIndex(
      (entry, index) => index >= depth && entry.name !== "link",
    );
    for (let i = open.length - 1; i >= depth; i -= 1) {
      const entry = open[i];
      if (entry === undefined) continue;
      if (entry.name === "link" && out.length === entry.start + 1) {
        // Whitespace hugging can empty a link label. Drop its opener so the
        // reader sees no literal empty-link syntax; held text remains outside.
        out = out.slice(0, entry.start);
      } else {
        out +=
          entry.name === "link" ? `](${renderTarget(entry.target)})` : entry.spelling;
      }
      if (i === lastEmphasis) out += held;
    }
    if (lastEmphasis === -1) out += held;
    open.length = depth;
  };

  for (const [index, run] of runs.entries()) {
    const marks = run.marks;
    const desired = orders[index] ?? [];
    const target = inlineLinkTarget(marks) ?? "";
    let common = 0;
    while (
      common < open.length &&
      common < desired.length &&
      open[common]?.name === desired[common] &&
      (desired[common] !== "link" || open[common]?.target === target)
    ) {
      common += 1;
    }

    // Emphasis cannot close against whitespace; restore it after the closer.
    let held = "";
    if (open.slice(common).some((entry) => entry.name !== "link")) {
      held = trailingWhitespace(out);
      out = out.slice(0, out.length - held.length);
    }
    closeDownTo(common, held);

    // Hoist leading whitespace before emphasis but inside an outer link.
    // Crossings can reopen a continuing mark on blank text; omit that opener
    // rather than emptying the run or emitting unwritable emphasis.
    let text = run.text;
    // Code emphasis hugs its fence, so whitespace code is not blank here.
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
      const start = out.length;
      out += spelling;
      open.push({ name, target, spelling, start });
    }


    out +=
      marks.inlineCode === true
        ? renderCodeSpan(text)
        : escapeInline(text, {
            insideLabel: open.some((entry) => entry.name === "link"),
            hugged,
            table,
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
 * Four spaces clear bullet/ordered content columns while staying below the
 * parent's content column plus four, where indented code would begin.
 */
const LIST_INDENT_UNIT = "    ";

/**
 * Use listNumbers so export and editor display agree on ordered markers.
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
    case "terminal": {
      // The info string preserves terminal type instead of importing as code.
      const fence = fenceFor(block.text);
      return `${fence}terminal\n${block.text}\n${fence}`;
    }
    case "chart": {
      const fence = fenceFor(block.text);
      return `${fence}chart\n${block.text}\n${fence}`;
    }
    case "list-item": {
      // Flat items cannot represent continuation blocks; fold to one line.
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
      // Unnormalized tables have no structured marked cells to render.
      return block.text;
    case "card":
      return `:::card\n${block.text}\n:::`;
    case "figma":
      return `:::figma\n${block.text}\n:::`;
    case "paragraph":
      return escapeContainerLines(renderInline(inline));
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

const DECISIONS_HEADING = "## Decisions";

/** The log is derived; Markdown never restores directory relationships. */
const DECISIONS_NOTE =
  "<!-- decisions: one row per topic, oldest first. " +
  "Importing this file does not restore them. -->";

function renderDecision(reference: DecisionReference): string {
  const title = escapeInline(decisionTopicTitle(reference).replace(/[\r\n]+/g, " "),
    { insideLabel: false, hugged: false });
  const answer = reference.inForce === null ? "nothing in force" : `in force: ${reference.inForce.uuid}`;
  const pending = reference.pending.length === 0 ? "" : `; pending: ${reference.pending.map((entry) => entry.uuid).join(", ")}`;
  const conflict = reference.conflicts.length === 0 ? "" : `; conflict: ${reference.conflicts.map((entry) => entry.uuid).join(", ")}`;
  return `- ${reference.topic} — ${title} — ${answer}${pending}${conflict}`;
}

/**
 * Keep adjacent items tight with single newlines; other sections need blank
 * lines. Emit the derived decision log oldest-topic-first only when nonempty.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function predates the complexity limit.
export function exportMarkdown(
  ydoc: Y.Doc,
  options: ExportMarkdownOptions = {},
): string {
  const withFrontmatter = options.frontmatter ?? true;
  const annotationMode = options.annotations ?? "drop";

  // Annotation sections inside items must also keep the list's tight spacing.
  const sections: Array<{ text: string; listItem: boolean }> = [];
  const push = (text: string, listItem = false): void => {
    sections.push({ text, listItem });
  };

  if (withFrontmatter) {
    const meta = getMeta(ydoc, options.uuid);
    const topic = meta.kind === "decision" && options.directory !== undefined
      ? decisionRelations(options.directory, meta.uuid).resolution : null;
    const tags =
      options.tagCatalog === undefined
        ? meta.tags
        : resolveTagAssignments(options.tagCatalog, meta.tags).flatMap(
            (entry) => entry.name === null ? [] : [entry.name],
          );
    const lines = [
      "---",
      `uuid: ${emitScalar(meta.uuid)}`,
      `title: ${emitScalar(topic === null ? meta.title : decisionTopicTitle(topic))}`,
      // Absence must remain distinct from an empty metadata value.
      ...(meta.description === null
        ? []
        : [`description: ${emitScalar(meta.description)}`]),
      ...(meta.kind === undefined ? [] : [`kind: ${emitScalar(meta.kind)}`]),
      ...(meta.status === undefined
        ? []
        : [`status: ${emitScalar(meta.status)}`]),
      `tags: [${tags.map(emitScalar).join(", ")}]`,
      "---",
    ];
    push(lines.join("\n"));
  }

  const annotationsByBlock = new Map<string, string[]>();
  if (annotationMode === "html-comments") {
    for (const annotation of listAnnotations(ydoc)) {
      const range = resolveAnnotationRange(ydoc, annotation.id);
      // An unresolved anchor has no exported text to point at.
      if (range === null) continue;
      const body = annotation.comments
        .map((comment) => `${comment.author}: ${JSON.stringify(comment.text)}`)
        .join(" | ");
      const line = renderAnnotationComment(
        annotation.id,
        `${range.part === undefined ? "" : `part=${range.part} `}${range.row === undefined ? "" : `row=${range.row} column=${range.column} `}range=${range.start}-${range.end}`,
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

  // Read blocks and marks together to avoid rescanning the fragment per block.
  const entries = getBlocksWithInline(ydoc);
  const numbers = listNumbers(entries.map((entry) => entry.block));

  // Annotation comments carry thread IDs, not block IDs: place them after their
  // own item and indent within it so another reader does not end the list.
  for (const [index, { block, inline, table }] of entries.entries()) {
    const listItem = block.type === "list-item";
    const marker = listItem ? listMarker(block, numbers[index] ?? null) : "";
    push(
      block.type === "table" && table !== undefined && table.length > 0
        ? writeGfmTable(table.map((row) => row.map((cell) => renderInline(cell, true))))
        : renderBlock(
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
    // Match the full content column: even 100. needs five spaces after indent.
    const inside = " ".repeat(marker.length);
    push(comments.map((line) => `${inside}${line}`).join("\n"), true);
  }

  const decisions = readDecisions(ydoc, options.directory, options.uuid);
  if (decisions.length > 0) {
    push(DECISIONS_HEADING);
    push(DECISIONS_NOTE);
    push(
      decisions
        .map((reference) => renderDecision(reference))
        .join("\n"),
    );
  }

  if (hasDocData(ydoc)) {
    push("> Structured document data is omitted from this Markdown export.");
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
   * Present only for formatted source; pass to block writers to retain marks.
   */
  inline?: InlineRun[];
}

export interface ImportedDoc {
  title: string;
  tags: string[];
  /** Present only when the source carried a uuid in its frontmatter. */
  uuid?: string;
  /**
   * Blank frontmatter descriptions read as absent, matching document metadata.
   */
  description?: string;
  /**
   * Present only for a links key; targets are UUIDs, never title/path resolution.
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
  description?: string;
  tags?: string[];
  links?: string[];
  /** Index of the first body line after the frontmatter block. */
  bodyStart: number;
}

/**
 * Accept inline lists, following - lines or a bare scalar; report the last
 * consumed line so frontmatter parsing does not revisit list entries.
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
    } else if (key === "description") {
      const description = parseScalar(value);
      if (description !== "") result.description = description;
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
 * Only nonempty labels with http(s) or UUID targets become marks; unsupported
 * targets and shorthand remain literal. Directory-dependent titles belong to
 * callers. Accept balanced bare parentheses and the writer's <…> target form.
 */
function matchLink(
  source: string,
  start: number,
): { label: string; marks: InlineMarkSet; next: number } | null {
  const link = matchLinkSyntax(source, start);
  if (link === null) return null;
  const docId = canonicalDocumentUuid(link.href);
  if (docId !== null) return { label: link.label, marks: { docLink: docId }, next: link.next };
  if (!isExternalHref(link.href)) return null;
  return { label: link.label, marks: { link: link.href }, next: link.next };
}

/** Read a leading link so container grammars can validate their own suffix. */
export function parseMarkdownLinkPrefix(source: string): { label: string; href: string; next: number } | null {
  return matchLinkSyntax(source, 0);
}

function matchLinkSyntax(
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
    // A ] inside code is literal and cannot close the surrounding link label.
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
  if (target === null || label === "") return null;
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
 * End at the first unescaped >; undo only the writer's backslash/angle escapes
 * so literal backslashes in targets survive unchanged.
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
 * * and ~ flank by whitespace alone so escaped punctuation can precede closers.
 * Underscores need strict punctuation flanking to leave intraword _ literal.
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

/** Resolve escapes, literal code and recursive link labels before emphasis. */
function tokenizeInline(source: string, marks: InlineMarkSet, table = false): Token[] {
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
      if (next !== undefined && ("\\`*_~[]:".includes(next) || (table && "<>&!".includes(next)))) {
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

    if (char === "[" && inlineLinkTarget(marks) === undefined) {
      const link = matchLink(source, i);
      if (link !== null) {
        flush();
        tokens.push(...tokenizeInline(link.label, { ...marks, ...link.marks }, table));
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
 * Apply the rule of three to remaining emphasis lengths, never strike. It stops
 * a dual-purpose opener from closing the wrong span. Repeat matches of one pair
 * may waive it only when matchNesting confirms the construct finished.
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
 * Match nearest compatible openers, splitting long runs across matches.
 * Unclaimed delimiter characters stay literal text.
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
  // Frozen characters cannot match and must return as literal leftovers.
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
      // Skip unusable openers: ~~a~b~~ must match past the lone ~.
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
        // Record only exercised waivers; tagging strict matches would quarantine
        // valid delimiters if a later match leaves this pair unfinished.
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
      // Inner unmatched openers cannot pair outside the span just closed.
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
 * Withdraw waivers whose runs remain unfinished and freeze their characters as
 * literal text; reusing them could change unrelated spans. Denials only grow,
 * but changed stack unwinding can require further passes. This local quarantine
 * preserves input characters; it is not a claim of reference-parser equivalence.
 */
function matchNesting(tokens: readonly Token[]): {
  spans: Span[];
  unclaimed: number[];
} {
  const denied = new Set<string>();
  const frozen = tokens.map(() => 0);
  // Bound retries defensively; each settling pass must add a denial.
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
 * Union tokenizer scope with covering spans; unclaimed delimiters remain text.
 */
function scanInline(source: string, out: InlineRun[], table = false): void {
  const tokens = tokenizeInline(source, {}, table);
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

/** The prose inline reader; table mode also undoes its escaped HTML punctuation. */
export function parseInline(source: string, table = false): InlineRun[] {
  const runs: InlineRun[] = [];
  scanInline(source, runs, table);
  return runs;
}

/**
 * Omit inline for unformatted source so callers receive plain blocks.
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
 * Capture indentation, marker, following gap and content separately: depth uses
 * the content column, not a fixed indentation unit.
 */
const LIST_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?[ \t]*$/;

/** `> `, indented no further than a paragraph may be. */
const QUOTE_LINE = /^ {0,3}>[ \t]?(.*)$/;

/** An ATX heading, a fence of either character, an HTML comment — block *starts*. */
const HEADING_LINE = /^#{1,6}\s/;
const FENCE_LINE = /^(?:`{3,}|~{3,})/;
const COMMENT_LINE = /^<!--/;

/**
 * Keep this vocabulary aligned with the import loop. The table parser accepts
 * headings, lists and annotation comments as one-column rows unless stopped here.
 */
function startsBlock(line: string): boolean {
  const trimmed = line.trim();
  return (
    QUOTE_LINE.test(line) ||
    LIST_LINE.test(line) ||
    HEADING_LINE.test(trimmed) ||
    FENCE_LINE.test(trimmed) ||
    COMMENT_LINE.test(trimmed)
    || line === ":::card" || line === ":::figma"
  );
}

/** How wide a tab is, counted to the next stop rather than as four columns. */
const TAB_WIDTH = 4;

/** A line-exact container reader; headers and body are interpreted by its owner. */
function readContainer(lines: readonly string[], start: number): { source: string; last: number; closed: boolean } {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index] === ":::") return { source: lines.slice(start + 1, index).join("\n"), last: index, closed: true };
  }
  return { source: lines.slice(start + 1).join("\n"), last: lines.length - 1, closed: false };
}

/**
 * Advance tabs to the next stop, not by four columns: fixed expansion would
 * turn some list siblings into children.
 */
function advanceColumn(text: string, column: number): number {
  let at = column;
  for (const char of text) {
    at = char === "\t" ? at + TAB_WIDTH - (at % TAB_WIDTH) : at + 1;
  }
  return at;
}

/**
 * Frontmatter title wins; otherwise consume a leading H1 as title. Other
 * headings stay blocks. Flat list items cannot contain continuation/nested blocks;
 * consecutive quote lines share one block. Unknown block syntax becomes prose,
 * and HTML comments are skipped rather than restoring annotations.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function predates the complexity limit.
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
   * Open content columns, innermost last. Children must reach the parent's
   * marker-plus-gap column; depth is neither indent/unit nor relative indent.
   */
  let openItems: number[] = [];
  const listLevel = (column: number, contentColumn: number): number => {
    // Below a parent's content column this item is a sibling, not its child.
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
      // Blank lines end paragraphs, but a loose list remains the same list.
      flush();
      continue;
    }

    if (line === ":::card" || line === ":::figma") {
      flush();
      openItems = [];
      const container = readContainer(lines, i);
      try {
        if (!container.closed) throw new Error("Unclosed container");
        blocks.push(line === ":::card"
          ? { type: "card", text: writeCardText(parseCardInput(container.source)) }
          : { type: "figma", text: writeFigmaText(parseFigmaInput(container.source)) });
      } catch {
        // Invalid containers are literal prose, including syntax that would
        // otherwise start headings, code blocks or comments and lose source.
        const text = lines.slice(i, container.last + 1).join("\n");
        blocks.push({ type: "paragraph", text, inline: [{ text, marks: {} }] });
      }
      i = container.last;
      continue;
    }

    // The shared table parser distinguishes structural from escaped pipes.
    // Prefer lists for ambiguous delimiter lines such as - | -, or the preceding
    // paragraph would be swallowed into an unintended table.
    const delimiterLine = lines[i + 1] ?? "";
    if (
      parseGfmTable(`${line}\n${delimiterLine}`) !== null &&
      LIST_LINE.exec(delimiterLine) === null
    ) {
      flush();
      openItems = [];
      const table = [line, delimiterLine];
      let j = i + 2;
      // Stop at blanks/new blocks before asking the table parser, which accepts
      // one-column block syntax and trims trailing blanks. Revalidate each row
      // with the write-boundary parser to keep imported cells consistent.
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
      // Gaps above four columns imply indented code; nesting then uses a one-space
      // gap rather than the full gap, matching CommonMark content columns.
      const contentColumn = afterMarker + (gap > 4 ? 1 : gap);
      blocks.push({
        ...proseBlock("list-item", (listLine[4] ?? "").trim()),
        list: /^\d/.test(marker) ? "ordered" : "bullet",
        indent: listLevel(column, contentColumn),
      });
      continue;
    }
    // Skip comments before resetting list depth, or exported annotated items
    // would return at depth zero.
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
      // Preceding prose is separate; consecutive quote lines join.
      if (paragraph.length > 0) flush();
      quote.push(quoteLine[1] ?? "");
      continue;
    }

    // Backtick info strings forbid backticks so an exported paragraph beginning
    // with a long code-span fence stays prose. Tilde info strings allow them.
    const fence =
      /^(`{3,})\s*([^`\s]*)\s*$/.exec(trimmed) ??
      /^(~{3,})\s*(\S*)\s*$/.exec(trimmed);
    if (fence !== null) {
      flush();
      const marker = fence[1] ?? "```";
      const closeRe = marker.startsWith("~") ? /^~+$/ : /^`+$/;
      const info = (fence[2] ?? "").toLowerCase();
      const body: string[] = [];
      let closed = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = (lines[j] ?? "").trim();
        if (candidate.length >= marker.length && closeRe.test(candidate)) {
          i = j;
          closed = true;
          break;
        }
        body.push(lines[j] ?? "");
      }
      if (!closed) {
        i = lines.length;
        // An unclosed fence consumes EOF; remove only trailing empty lines.
        while (body.length > 0 && body[body.length - 1] === "") body.pop();
      }
      const text = body.join("\n");
      if (info === "terminal") {
        blocks.push({ type: "terminal", text });
      } else if (info === "chart") {
        blocks.push({ type: "chart", text });
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

  // Preserve absent versus explicit empty identity/link fields for callers.
  const result: ImportedDoc = { title, tags: front.tags ?? [], blocks };
  if (front.uuid !== undefined) result.uuid = front.uuid;
  if (front.description !== undefined) result.description = front.description;
  if (front.links !== undefined) result.links = front.links;
  return result;
}
