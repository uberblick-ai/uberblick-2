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
 * The inline reader is deliberately narrower than CommonMark, and the writer
 * escapes exactly what the reader would take back:
 *
 *   - Emphasis is asterisk-only. `_` is never a delimiter, so `snake_case`
 *     survives without escaping — and `__bold__` typed in the editor still
 *     arrives as a `bold` mark, because that is the editor's input rule, not
 *     this reader's job.
 *   - Delimiters must hug their content (`** x **` is literal), which is the
 *     rule that keeps ordinary prose from turning into emphasis.
 *   - A link is a link only when its target is an external `http(s)` URL.
 *     Doc-to-doc references are `meta.links` by UUID and never a link mark, so
 *     anything else stays literal text.
 *   - `\` escapes `` \ ` * ~ [ ``, and nothing else, in both directions.
 */

import type * as Y from "yjs";
import { getBlockInline, getBlocks } from "./blocks.js";
import { getMeta } from "./doc.js";
import { listAnnotations, resolveAnnotationRange } from "./annotations.js";
import { hasInlineMarks, inlinePlainText, pushInlineRun } from "./marks.js";
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

/** The marks that nest, outermost first. `inlineCode` is always innermost. */
const NESTING = ["link", "bold", "italic", "strike"] as const;

type NestedMark = (typeof NESTING)[number];

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

/**
 * Escape the characters the reader would take as syntax. `_` is absent on
 * purpose — it is not a delimiter here — and `~` and `[` are escaped only where
 * they would actually open something, so ordinary prose stays readable.
 */
function escapeInline(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (char === "\\" || char === "`" || char === "*") {
      out += `\\${char}`;
    } else if (char === "~" && (text[i + 1] === "~" || text[i - 1] === "~")) {
      // Only a `~~` pair is a delimiter, so a lone tilde — a home directory, a
      // version range — is left alone.
      out += "\\~";
    } else if (char === "[" && matchLink(text, i) !== null) {
      out += "\\[";
    } else {
      out += char;
    }
  }
  return out;
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

/**
 * Emphasis delimiters have to hug their content, so whitespace at the edge of an
 * emphasised run is pushed outside the emphasis. Without this, bolding "word "
 * would export as `**word **`, which is not bold in GFM and is not read back as
 * bold here either.
 */
function normalizeInlineRuns(runs: readonly InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) {
    const emphasised =
      run.marks.bold === true ||
      run.marks.italic === true ||
      run.marks.strike === true;
    if (!emphasised || run.marks.inlineCode === true) {
      pushInlineRun(out, run.text, run.marks);
      continue;
    }
    const lead = /^\s*/.exec(run.text)?.[0] ?? "";
    const rest = run.text.slice(lead.length);
    const trail = /\s*$/.exec(rest)?.[0] ?? "";
    const core = rest.slice(0, rest.length - trail.length);
    const bare: InlineMarkSet =
      run.marks.link === undefined ? {} : { link: run.marks.link };
    pushInlineRun(out, lead, bare);
    pushInlineRun(out, core, run.marks);
    pushInlineRun(out, trail, bare);
  }
  return out;
}

/**
 * Render runs as GFM, keeping the marks properly nested: a mark shared by
 * neighbouring runs stays open across them, so one bold span split by an
 * annotation boundary is still `**ab**` and never `**a****b**`.
 */
function renderInline(runs: readonly InlineRun[]): string {
  let out = "";
  /** The open marks, outermost first, with the href a `link` was opened with. */
  const open: Array<{ name: NestedMark; href: string }> = [];

  const closeDownTo = (depth: number): void => {
    for (let i = open.length - 1; i >= depth; i -= 1) {
      const entry = open[i];
      if (entry === undefined) continue;
      out += entry.name === "link" ? `](${entry.href})` : DELIMITER[entry.name];
    }
    open.length = depth;
  };

  for (const run of normalizeInlineRuns(runs)) {
    const desired = nestedMarksOf(run.marks);
    const href = run.marks.link ?? "";
    let common = 0;
    while (
      common < open.length &&
      common < desired.length &&
      open[common]?.name === desired[common] &&
      (desired[common] !== "link" || open[common]?.href === href)
    ) {
      common += 1;
    }
    closeDownTo(common);
    for (let i = common; i < desired.length; i += 1) {
      const name = desired[i];
      if (name === undefined) continue;
      out += name === "link" ? "[" : DELIMITER[name];
      open.push({ name, href });
    }
    out +=
      run.marks.inlineCode === true
        ? renderCodeSpan(run.text)
        : escapeInline(run.text);
  }
  closeDownTo(0);
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

  for (const block of getBlocks(ydoc)) {
    // Marks are read by id, which resolves the same element `getBlocks` read —
    // shadowed duplicates included. An element with no id claims no identity, so
    // it has no marks to look up and falls back to its plain text.
    const inline = getBlockInline(ydoc, block.id);
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

/** A link target the model accepts as an inline link: an external URL, only. */
const EXTERNAL_URL = /^https?:\/\/\S+$/i;

const LINK = /^\[((?:\\.|[^\\\]])*)\]\(([^\s)]*)\)/;

/** Length of the run of `char` starting at `from`. */
function runLength(source: string, from: number, char: string): number {
  let length = 0;
  while (source[from + length] === char) length += 1;
  return length;
}

/** Whether the character at `index` is backslash-escaped. */
function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * The link opening at `start`, or null — including for a target that is not an
 * external URL, which stays literal text rather than becoming a mark.
 */
function matchLink(
  source: string,
  start: number,
): { label: string; href: string; next: number } | null {
  const match = LINK.exec(source.slice(start));
  if (match === null) return null;
  const label = match[1] ?? "";
  const href = match[2] ?? "";
  if (label === "" || !EXTERNAL_URL.test(href)) return null;
  return { label, href, next: start + match[0].length };
}

/**
 * The emphasis span opening at `start` with a `need`-long run of `char`, or null.
 *
 * The closer is taken from the *end* of its delimiter run, which is what makes
 * `***both***` bold-and-italic rather than bold over a stray asterisk. Content
 * that is empty or edged with whitespace is not emphasis at all.
 */
function matchEmphasis(
  source: string,
  start: number,
  char: string,
  need: number,
): { content: string; next: number } | null {
  const from = start + need;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] !== char || isEscaped(source, i)) continue;
    const length = runLength(source, i, char);
    if (length < need) {
      i += length - 1;
      continue;
    }
    const end = i + length;
    const content = source.slice(from, end - need);
    if (content !== "" && !/^\s|\s$/.test(content)) return { content, next: end };
    i = end - 1;
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

/**
 * Read `source` into runs, adding to whatever marks are already in scope. Marked
 * spans recurse (a link label can hold emphasis and vice versa); a code span's
 * content does not, because it is literal.
 */
function scanInline(
  source: string,
  marks: InlineMarkSet,
  out: InlineRun[],
): void {
  let plain = "";
  const flush = (): void => {
    pushInlineRun(out, plain, marks);
    plain = "";
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;

    if (char === "\\") {
      const next = source[i + 1];
      if (next !== undefined && "\\`*~[".includes(next)) {
        plain += next;
        i += 2;
        continue;
      }
    }

    if (char === "`") {
      const span = matchCodeSpan(source, i);
      if (span !== null) {
        flush();
        pushInlineRun(out, span.content, { ...marks, inlineCode: true });
        i = span.next;
        continue;
      }
    }

    if (char === "[" && marks.link === undefined) {
      const link = matchLink(source, i);
      if (link !== null) {
        flush();
        scanInline(link.label, { ...marks, link: link.href }, out);
        i = link.next;
        continue;
      }
    }

    if (char === "~" && marks.strike !== true && runLength(source, i, "~") >= 2) {
      const span = matchEmphasis(source, i, "~", 2);
      if (span !== null) {
        flush();
        scanInline(span.content, { ...marks, strike: true }, out);
        i = span.next;
        continue;
      }
    }

    if (char === "*") {
      const bold = runLength(source, i, "*") >= 2;
      if (bold ? marks.bold !== true : marks.italic !== true) {
        const span = matchEmphasis(source, i, "*", bold ? 2 : 1);
        if (span !== null) {
          flush();
          const nested: InlineMarkSet = bold
            ? { ...marks, bold: true }
            : { ...marks, italic: true };
          scanInline(span.content, nested, out);
          i = span.next;
          continue;
        }
      }
    }

    plain += char;
    i += 1;
  }
  flush();
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
  scanInline(source, {}, runs);
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

    const fence = /^(`{3,}|~{3,})\s*(\S*)\s*$/.exec(trimmed);
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
