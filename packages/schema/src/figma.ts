import * as Y from "yjs";
import { escapeContainerLines } from "./card.js";
import { InvalidFigmaError } from "./errors.js";
import { spliceInlineText } from "./inline-edit.js";
import { applyInlineRuns, assertInlineWritable, inlinePlainText, readInlineRuns, readsAsMark } from "./marks.js";
import { parseInline, renderInline } from "./markdown.js";
import { normalizeFigmaLink } from "./providers/figma.js";
import type { FigmaFields } from "./providers/figma.js";
import { plainXmlText, TABLE_CELL_MARKS } from "./table.js";
import type { InlineRun } from "./types.js";

export interface FigmaText { url: string; title?: string; height?: number; caption: string }
export interface FigmaInline { caption: InlineRun[] }

export const FIGMA_DEFAULT_HEIGHT = 480;
export const FIGMA_MIN_HEIGHT = 240;
export const FIGMA_MAX_HEIGHT = 960;

export function parseFigmaHeight(source: string): number {
  const height = Number(source);
  if (!/^\d+$/.test(source) || height < FIGMA_MIN_HEIGHT || height > FIGMA_MAX_HEIGHT) {
    throw new InvalidFigmaError("Height must be a whole number of pixels from 240 to 960");
  }
  return height;
}

export function parseFigmaInput(source: string): FigmaText {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const values: Partial<Record<"url" | "title" | "height", string>> = {};
  let captionStart = lines.length;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      captionStart = index + 1;
      break;
    }
    const match = /^(url|title|height): ?(.*)$/.exec(line);
    if (match === null) throw new InvalidFigmaError("Header lines must use url:, title: or height:");
    const key = match[1] as "url" | "title" | "height";
    if (values[key] !== undefined) throw new InvalidFigmaError(`Duplicate header key: ${key}`);
    values[key] = match[2] ?? "";
  }
  if (values.url === undefined) throw new InvalidFigmaError("A url header is required");
  const { url } = normalizeFigmaLink(values.url);
  const height = values.height === undefined ? undefined : parseFigmaHeight(values.height);
  return {
    url,
    ...(values.title === undefined || values.title === "" ? {} : { title: values.title }),
    ...(height === undefined ? {} : { height }),
    caption: lines.slice(captionStart).join("\n"),
  };
}

/** Canonical text between delimiters; title is literal and caption is prose. */
export function writeFigmaText(parts: Readonly<FigmaText>): string {
  const header = [`url: ${parts.url}`];
  const title = parts.title?.replace(/[\r\n]/g, " ");
  if (title !== undefined && title !== "") header.push(`title: ${title}`);
  if (parts.height !== undefined) header.push(`height: ${parts.height}`);
  return `${header.join("\n")}\n\n${escapeContainerLines(parts.caption)}`;
}

export function figmaCaptionElement(element: Y.XmlElement): Y.XmlElement | null {
  return element.toArray().find((node): node is Y.XmlElement =>
    node instanceof Y.XmlElement && node.nodeName === "figmaCaption",
  ) ?? null;
}

export function figmaCaptionTexts(element: Y.XmlElement): Y.XmlText[] {
  const paragraph = figmaCaptionElement(element)?.firstChild;
  if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph") return [];
  return paragraph.toArray().filter((text): text is Y.XmlText => text instanceof Y.XmlText);
}

export function figmaInline(element: Y.XmlElement): FigmaInline {
  return { caption: figmaCaptionTexts(element).flatMap(readInlineRuns) };
}

export function figmaTextParts(element: Y.XmlElement): FigmaText {
  const title = element.getAttribute("title");
  const height = element.getAttribute("height");
  return {
    url: element.getAttribute("url") ?? "",
    ...(title === undefined || title === "" ? {} : { title }),
    ...(height === undefined ? {} : { height: Number(height) }),
    caption: renderInline(figmaInline(element).caption),
  };
}

export function figmaText(element: Y.XmlElement): string {
  return writeFigmaText(figmaTextParts(element));
}

export function figmaFields(element: Y.XmlElement): FigmaFields | undefined {
  try {
    return normalizeFigmaLink(element.getAttribute("url") ?? "").figma;
  } catch {
    return undefined;
  }
}

/** Refuse foreign attributes, nested structure and marks before any rewrite. */
export function isSupportedFigma(element: Y.XmlElement): boolean {
  if (element.nodeName !== "figma" || element.length !== 1 ||
    Object.keys(element.getAttributes()).some((key) => !["id", "url", "title", "height"].includes(key))) return false;
  try {
    const source = figmaText(element);
    if (writeFigmaText(parseFigmaInput(source)) !== source) return false;
  } catch {
    return false;
  }
  const caption = element.firstChild;
  if (!(caption instanceof Y.XmlElement) || caption.nodeName !== "figmaCaption" ||
    Object.keys(caption.getAttributes()).length !== 0 || caption.length !== 1) return false;
  const paragraph = caption.firstChild;
  if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph" ||
    Object.keys(paragraph.getAttributes()).length !== 0 || paragraph.length > 1) return false;
  return paragraph.toArray().every((text) => text instanceof Y.XmlText &&
    (text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>).every((op) =>
      typeof op.insert === "string" && Object.entries(op.attributes ?? {}).every(([key, value]) =>
        (TABLE_CELL_MARKS as readonly string[]).includes(key) && readsAsMark(key, value),
      ),
    ),
  );
}

/** Seed the caption text before its first concurrent writers. */
export function buildFigmaElement(id: string): Y.XmlElement {
  const element = new Y.XmlElement("figma");
  element.setAttribute("id", id);
  const caption = new Y.XmlElement("figmaCaption");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText()]);
  caption.insert(0, [paragraph]);
  element.insert(0, [caption]);
  return element;
}

/** Seed a newly created caption before its first concurrent writers. */
export function seedNewFigmaCaptions(transaction: Y.Transaction): void {
  if (!transaction.local) return;
  const doc = transaction.doc;
  const start = transaction.beforeState.get(doc.clientID) ?? 0;
  for (const figma of doc.getXmlFragment("blocks").toArray()) {
    if (!(figma instanceof Y.XmlElement) || figma.nodeName !== "figma") continue;
    const paragraph = figmaCaptionElement(figma)?.firstChild;
    if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph" || paragraph.length !== 0) continue;
    const id = Y.createRelativePositionFromTypeIndex(paragraph, 0).type;
    if (id?.client === doc.clientID && id.clock >= start) paragraph.insert(0, [new Y.XmlText()]);
  }
}

export function writeFigmaInline(element: Y.XmlElement, parts: Readonly<FigmaText>): void {
  element.setAttribute("url", parts.url);
  if (parts.title !== undefined) element.setAttribute("title", parts.title);
  if (parts.height !== undefined) element.setAttribute("height", String(parts.height));
  const text = figmaCaptionTexts(element)[0];
  if (text !== undefined) applyInlineRuns(text, parseInline(parts.caption));
}

export function editFigma(element: Y.XmlElement, before: Readonly<FigmaText>, after: Readonly<FigmaText>): void {
  if (!isSupportedFigma(element)) throw new InvalidFigmaError("Stored Figma shape is unsupported; it cannot be rewritten");
  const oldRuns = parseInline(before.caption);
  const newRuns = parseInline(after.caption);
  assertInlineWritable(newRuns);
  let text = figmaCaptionTexts(element)[0];
  if (before.caption !== after.caption) {
    if (plainXmlText(text ?? null) !== inlinePlainText(oldRuns)) throw new InvalidFigmaError("Stored caption text does not match its projection");
    if (text === undefined) {
      const paragraph = figmaCaptionElement(element)?.firstChild;
      if (!(paragraph instanceof Y.XmlElement)) throw new InvalidFigmaError("Stored caption is missing");
      text = new Y.XmlText();
      paragraph.insert(0, [text]);
    }
    spliceInlineText(text, oldRuns, newRuns);
  }
  for (const attribute of ["url", "title", "height"] as const) {
    if (before[attribute] === after[attribute]) continue;
    const value = after[attribute];
    if (value === undefined) element.removeAttribute(attribute);
    else element.setAttribute(attribute, String(value));
  }
}
