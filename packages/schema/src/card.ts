import * as Y from "yjs";
import { InvalidCardError } from "./errors.js";
import { parseContainerHeader } from "./container-header.js";
import { spliceInlineText } from "./inline-edit.js";
import { buildInlinePart, CARD_NODE_NAMES, CARD_PARTS, ensureInlinePartText, inlinePartElement, inlinePartTexts, isSupportedInlinePart, plainXmlText, seedNewInlinePartsOfKind } from "./inline-parts.js";
import type { CardPart } from "./inline-parts.js";
import { applyInlineRuns, assertInlineWritable, inlinePlainText, readInlineRuns } from "./marks.js";
import { parseInline, parseMarkdownLinkPrefix, renderInline, renderMarkdownLink } from "./markdown.js";
import type { InlineRun } from "./types.js";

export { CARD_NODE_NAMES, CARD_PARTS } from "./inline-parts.js";
export type { CardPart } from "./inline-parts.js";
export const CARD_BUTTON_STYLES = ["outline", "filled"] as const;
export const CARD_BUTTON_COLORS = ["neutral", "blue", "green", "violet"] as const;
export type CardButtonStyle = (typeof CARD_BUTTON_STYLES)[number];
export type CardButtonColor = (typeof CARD_BUTTON_COLORS)[number];
export interface CardButton { text: string; href: string; style?: CardButtonStyle; color?: CardButtonColor }
export type CardText = Record<CardPart, string> & { buttons?: CardButton[] };
export type CardInline = Record<CardPart, InlineRun[]>;

const CARD_APP_ROUTES = ["claude://code/new", "claude-cli://open", "codex://new"] as const;

/** Queries are opaque; only the app route itself is allowed to select an action. */
export function isCardButtonHref(href: unknown): href is string {
  if (typeof href !== "string" || /[\r\n]/.test(href) || href.includes("\u0000")) return false;
  if (CARD_APP_ROUTES.some((route) => href === route || href.startsWith(`${route}?`))) return true;
  if (!href.startsWith("https://")) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

export function parseCardButton(source: string): CardButton {
  const link = parseMarkdownLinkPrefix(source);
  if (link === null || !isCardButtonHref(link.href)) {
    throw new InvalidCardError("The button must be one link to https://, claude://code/new, claude-cli://open or codex://new, optionally followed by style and color");
  }
  const runs = parseInline(link.label);
  const text = inlinePlainText(runs);
  if (text.trim() === "" || /[\r\n]/.test(text) || runs.some((run) => Object.keys(run.marks).length !== 0)) {
    throw new InvalidCardError("The button text must be nonempty plain text, without formatting or document links");
  }
  const suffix = source.slice(link.next);
  if (suffix !== "" && (!/^[ \t]/.test(suffix) || /[\r\n]/.test(suffix))) {
    throw new InvalidCardError("Only style and color words may follow a button link");
  }
  let style: CardButtonStyle | undefined;
  let color: CardButtonColor | undefined;
  for (const word of suffix.trim() === "" ? [] : suffix.trim().split(/[ \t]+/)) {
    if ((CARD_BUTTON_STYLES as readonly string[]).includes(word) && style === undefined) style = word as CardButtonStyle;
    else if ((CARD_BUTTON_COLORS as readonly string[]).includes(word) && color === undefined) color = word as CardButtonColor;
    else throw new InvalidCardError("Buttons accept at most one style (outline or filled) and one color (neutral, blue, green or violet)");
  }
  return { text, href: link.href, ...(style !== undefined && style !== "outline" ? { style } : {}), ...(color !== undefined && color !== "neutral" ? { color } : {}) };
}

export function writeCardButton(button: Readonly<CardButton>): string {
  if ((button.style !== undefined && !(CARD_BUTTON_STYLES as readonly string[]).includes(button.style)) ||
    (button.color !== undefined && !(CARD_BUTTON_COLORS as readonly string[]).includes(button.color))) {
    throw new InvalidCardError("Button style and color must each be one supported value");
  }
  const source = [renderMarkdownLink(button.text, button.href),
    ...(button.style === undefined || button.style === "outline" ? [] : [button.style]),
    ...(button.color === undefined || button.color === "neutral" ? [] : [button.color]),
  ].join(" ");
  parseCardButton(source);
  return source;
}

export function parseCardButtons(source: string): CardButton[] {
  return source.split("\n").map(parseCardButton);
}

export function writeCardButtons(buttons: readonly CardButton[]): string {
  return buttons.map(writeCardButton).join("\n");
}

/** Invalid foreign attributes are never usable destinations. */
export function cardButtons(element: Y.XmlElement): CardButton[] {
  const source = element.getAttribute("button");
  if (typeof source !== "string") return [];
  try {
    return parseCardButtons(source);
  } catch {
    return [];
  }
}

/** The container header is inline Markdown, never a YAML mapping. */
export function parseCardInput(source: string, requireTitle = true): CardText {
  const result: CardText = { label: "", title: "", body: "", footer: "" };
  const { seen, body } = parseContainerHeader(source, {
    keys: ["label", "title", "footer", "button"] as const,
    repeatable: ["button"],
    invalidHeader: "Header lines must use label:, title:, footer: or button:",
    error: (message) => new InvalidCardError(message),
    accept: (key, value) => {
      if (key === "button") {
        result.buttons ??= [];
        result.buttons.push(parseCardButton(value));
      } else result[key] = value;
    },
  });
  if (requireTitle && (!seen.has("title") || inlinePlainText(parseInline(result.title)).trim() === "")) throw new InvalidCardError();
  result.body = body;
  return result;
}

/** Escape prose lines so none can become a structural container delimiter. */
export function escapeContainerLines(source: string): string {
  return source.replace(/^:::/gm, "\\:::");
}

/** Canonical text between delimiters; the body remains one prose part. */
export function writeCardText(parts: Readonly<CardText>): string {
  const header = (["label", "title", "footer"] as const).flatMap((part) => {
    const value = parts[part].replace(/[\r\n]/g, " ");
    return value === "" ? [] : [`${part}: ${value}`];
  });
  for (const button of parts.buttons ?? []) header.push(`button: ${writeCardButton(button)}`);
  return `${header.join("\n")}\n\n${escapeContainerLines(parts.body)}`;
}

export function cardPartElement(element: Y.XmlElement, part: CardPart): Y.XmlElement | null {
  return inlinePartElement(element, CARD_NODE_NAMES[part]);
}

export function cardPartTexts(element: Y.XmlElement, part: CardPart): Y.XmlText[] {
  return inlinePartTexts(cardPartElement(element, part));
}

export function cardInline(element: Y.XmlElement): CardInline {
  return Object.fromEntries(CARD_PARTS.map((part) => [part, cardPartTexts(element, part).flatMap(readInlineRuns)])) as CardInline;
}

export function cardText(element: Y.XmlElement): string {
  return writeCardText(cardTextParts(element));
}

export function cardTextParts(element: Y.XmlElement): CardText {
  const inline = cardInline(element);
  const parts: CardText = Object.fromEntries(CARD_PARTS.map((part) => [part,
    renderInline(inline[part].map((run) => ({ ...run, text: part === "body" ? run.text : run.text.replace(/[\r\n]/g, " ") }))),
  ])) as Record<CardPart, string>;
  const buttons = cardButtons(element);
  if (buttons.length > 0) parts.buttons = buttons;
  return parts;
}

/** Reject unknown structure before editor binding or an MCP rewrite. */
export function isSupportedCard(element: Y.XmlElement): boolean {
  if (element.nodeName !== "card" || element.length !== CARD_PARTS.length ||
    Object.keys(element.getAttributes()).some((key) => key !== "id" && key !== "button") ||
    (element.getAttribute("button") !== undefined && cardButtons(element).length === 0)) return false;
  return element.toArray().every((node, index) => {
    const part = CARD_PARTS[index];
    if (part === undefined || !(node instanceof Y.XmlElement) || node.nodeName !== CARD_NODE_NAMES[part] ||
      Object.keys(node.getAttributes()).length !== 0) return false;
    return isSupportedInlinePart(node, true);
  });
}

/** Seed all four parts before their first concurrent writers. */
export function buildCardElement(id: string): Y.XmlElement {
  const element = new Y.XmlElement("card");
  element.setAttribute("id", id);
  element.insert(0, CARD_PARTS.map((part) => buildInlinePart(CARD_NODE_NAMES[part])));
  return element;
}

export function writeCardInline(element: Y.XmlElement, parts: Readonly<CardText>): void {
  const buttons = writeCardButtons(parts.buttons ?? []);
  if (buttons !== "") element.setAttribute("button", buttons);
  for (const part of CARD_PARTS) {
    const text = cardPartTexts(element, part)[0];
    if (text !== undefined) applyInlineRuns(text, parseInline(parts[part]));
  }
}

export function seedNewCardParts(transaction: Y.Transaction): void {
  seedNewInlinePartsOfKind(transaction, "card");
}

export function editCard(element: Y.XmlElement, before: Readonly<CardText>, after: Readonly<CardText>): void {
  if (!isSupportedCard(element)) throw new InvalidCardError("Stored card shape is unsupported; it cannot be rewritten");
  const buttons = writeCardButtons(after.buttons ?? []);
  const beforeButtons = writeCardButtons(before.buttons ?? []);
  const edits = CARD_PARTS.filter((part) => before[part] !== after[part]).map((part) => {
    const text = cardPartTexts(element, part)[0];
    const oldRuns = parseInline(before[part]);
    const newRuns = parseInline(after[part]);
    assertInlineWritable(newRuns);
    const stored = plainXmlText(text ?? null);
    const projected = part === "body" ? stored : stored.replace(/[\r\n]/g, " ");
    const offset = text === undefined ? 0 : projected.indexOf(inlinePlainText(oldRuns));
    if (offset < 0) throw new InvalidCardError("Stored card text does not match its projection");
    return { part, text, oldRuns, newRuns, offset };
  });
  // Yjs transactions cannot roll back, so every part is validated before writing.
  for (const edit of edits) {
    const text = edit.text ?? ensureInlinePartText(cardPartElement(element, edit.part));
    if (text === null) throw new InvalidCardError("Stored card part is missing");
    spliceInlineText(text, edit.oldRuns, edit.newRuns, edit.offset);
  }
  if (beforeButtons !== buttons) {
    if (buttons === "") element.removeAttribute("button");
    else element.setAttribute("button", buttons);
  }
}
