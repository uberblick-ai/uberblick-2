import * as Y from "yjs";
import { escapeContainerLines } from "./card.js";
import { InvalidFigmaError } from "./errors.js";
import { parseContainerHeader } from "./container-header.js";
import { spliceInlineText } from "./inline-edit.js";
import { buildInlinePart, ensureInlinePartText, inlinePartElement, inlinePartTexts, isSupportedInlinePart, plainXmlText, seedNewInlinePartsOfKind } from "./inline-parts.js";
import { applyInlineRuns, assertInlineWritable, inlinePlainText, readInlineRuns } from "./marks.js";
import { parseInline, renderInline } from "./markdown.js";
import { normalizeFigmaLink } from "./providers/figma.js";
import type { FigmaFields } from "./providers/figma.js";
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
  const values: Partial<Record<"url" | "title" | "height", string>> = {};
  const { body } = parseContainerHeader(source, {
    keys: ["url", "title", "height"] as const,
    invalidHeader: "Header lines must use url:, title: or height:",
    error: (message) => new InvalidFigmaError(message),
    accept: (key, value) => { values[key] = value; },
  });
  if (values.url === undefined) throw new InvalidFigmaError("A url header is required");
  const { url } = normalizeFigmaLink(values.url);
  const height = values.height === undefined ? undefined : parseFigmaHeight(values.height);
  return {
    url,
    ...(values.title === undefined || values.title === "" ? {} : { title: values.title }),
    ...(height === undefined ? {} : { height }),
    caption: body,
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
  return inlinePartElement(element, "figmaCaption");
}

export function figmaCaptionTexts(element: Y.XmlElement): Y.XmlText[] {
  return inlinePartTexts(figmaCaptionElement(element));
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
    Object.keys(caption.getAttributes()).length !== 0) return false;
  return isSupportedInlinePart(caption, true);
}

/** Seed the caption text before its first concurrent writers. */
export function buildFigmaElement(id: string): Y.XmlElement {
  const element = new Y.XmlElement("figma");
  element.setAttribute("id", id);
  element.insert(0, [buildInlinePart("figmaCaption")]);
  return element;
}

/** Seed a newly created caption before its first concurrent writers. */
export function seedNewFigmaCaptions(transaction: Y.Transaction): void {
  seedNewInlinePartsOfKind(transaction, "figma");
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
      text = ensureInlinePartText(figmaCaptionElement(element)) ?? undefined;
      if (text === undefined) throw new InvalidFigmaError("Stored caption is missing");
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
