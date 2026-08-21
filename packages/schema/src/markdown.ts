/**
 * Markdown is an export format, never the storage format.
 *
 * `exportMarkdown` is the one-way road out of the document model.
 * `importMarkdown` is the opposite direction and deliberately weaker: it is a
 * dependency-free, line-based reader used to bring seed documents in once. It
 * does not round-trip inline formatting, because the block model does not store
 * inline formatting.
 */

import type * as Y from "yjs";
import { getBlocks } from "./blocks.js";
import { getMeta } from "./doc.js";
import { listAnnotations, resolveAnnotationRange } from "./annotations.js";
import type { Block, BlockType, HeadingLevel } from "./types.js";

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

/** Longest run of backticks in `text`, so a fence can always be made longer. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "heading": {
      const level = block.level ?? 1;
      // Headings are single-line by definition; fold any stray newlines.
      const text = block.text.replace(/\s*\n\s*/g, " ").trim();
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
      return block.text;
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
    sections.push(renderBlock(block));
    const comments = annotationsByBlock.get(block.id);
    if (comments !== undefined) sections.push(comments.join("\n"));
  }

  return sections.length === 0 ? "" : `${sections.join("\n\n")}\n`;
}

export interface ImportedBlock {
  type: BlockType;
  text: string;
  level?: HeadingLevel;
  language?: string;
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

/**
 * Parse markdown into the pieces needed to build a document: title, tags, links
 * and a flat block list. Handles frontmatter, ATX headings, fenced code (with
 * language) and mermaid fences; everything else becomes a paragraph.
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
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
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
      blocks.push({ type: "heading", text: (heading[2] ?? "").trim(), level });
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
