import * as Y from "yjs";
import { InvalidCardError } from "./errors.js";
import { spliceInlineText } from "./inline-edit.js";
import { applyInlineRuns, assertInlineWritable, inlinePlainText, readInlineRuns, readsAsMark } from "./marks.js";
import { parseInline, parseMarkdownLinkPrefix, renderInline, renderMarkdownLink } from "./markdown.js";
import { plainXmlText, TABLE_CELL_MARKS } from "./table.js";
import type { InlineRun } from "./types.js";

export const CARD_PARTS = ["label", "title", "body", "footer"] as const;
export type CardPart = (typeof CARD_PARTS)[number];
export const CARD_BUTTON_STYLES = ["outline", "filled"] as const;
export const CARD_BUTTON_COLORS = ["neutral", "blue", "green", "violet"] as const;
export type CardButtonStyle = (typeof CARD_BUTTON_STYLES)[number];
export type CardButtonColor = (typeof CARD_BUTTON_COLORS)[number];
export interface CardButton { text: string; href: string; style?: CardButtonStyle; color?: CardButtonColor }
export type CardText = Record<CardPart, string> & { buttons?: CardButton[] };
export type CardInline = Record<CardPart, InlineRun[]>;

export const CARD_NODE_NAMES: Record<CardPart, string> = {
  label: "cardLabel", title: "cardTitle", body: "cardBody", footer: "cardFooter",
};

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

export function cardButton(element: Y.XmlElement): CardButton | undefined {
  const buttons = cardButtons(element);
  return buttons.length === 1 ? buttons[0] : undefined;
}

/** The container header is inline Markdown, never a YAML mapping. */
export function parseCardInput(source: string, requireTitle = true): CardText {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const result: CardText = { label: "", title: "", body: "", footer: "" };
  const seen = new Set<string>();
  let bodyStart = lines.length;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      bodyStart = index + 1;
      break;
    }
    const match = /^(label|title|footer|button): ?(.*)$/.exec(line);
    if (match === null) throw new InvalidCardError("Header lines must use label:, title:, footer: or button:");
    const key = match[1] as "label" | "title" | "footer" | "button";
    if (key !== "button" && seen.has(key)) throw new InvalidCardError(`Duplicate header key: ${key}`);
    seen.add(key);
    if (key === "button") {
      result.buttons ??= [];
      result.buttons.push(parseCardButton(match[2] ?? ""));
    } else result[key] = match[2] ?? "";
  }
  if (requireTitle && (!seen.has("title") || inlinePlainText(parseInline(result.title)).trim() === "")) throw new InvalidCardError();
  result.body = lines.slice(bodyStart).join("\n");
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
  return element.toArray().find((node): node is Y.XmlElement =>
    node instanceof Y.XmlElement && node.nodeName === CARD_NODE_NAMES[part],
  ) ?? null;
}

export function cardPartTexts(element: Y.XmlElement, part: CardPart): Y.XmlText[] {
  const paragraph = cardPartElement(element, part)?.firstChild;
  if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph") return [];
  return paragraph.toArray().filter((text): text is Y.XmlText => text instanceof Y.XmlText);
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
      Object.keys(node.getAttributes()).length !== 0 || node.length !== 1) return false;
    const paragraph = node.firstChild;
    if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph" ||
      Object.keys(paragraph.getAttributes()).length !== 0 || paragraph.length > 1) return false;
    return paragraph.toArray().every((text) => text instanceof Y.XmlText &&
      (text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>).every((op) =>
        typeof op.insert === "string" && Object.entries(op.attributes ?? {}).every(([key, value]) =>
          (TABLE_CELL_MARKS as readonly string[]).includes(key) && readsAsMark(key, value),
        ),
      ),
    );
  });
}

/** Seed all four parts before their first concurrent writers. */
export function buildCardElement(id: string): Y.XmlElement {
  const element = new Y.XmlElement("card");
  element.setAttribute("id", id);
  element.insert(0, CARD_PARTS.map((part) => {
    const node = new Y.XmlElement(CARD_NODE_NAMES[part]);
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText()]);
    node.insert(0, [paragraph]);
    return node;
  }));
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
  if (!transaction.local) return;
  const doc = transaction.doc;
  const start = transaction.beforeState.get(doc.clientID) ?? 0;
  for (const card of doc.getXmlFragment("blocks").toArray()) {
    if (!(card instanceof Y.XmlElement) || card.nodeName !== "card") continue;
    for (const part of CARD_PARTS) {
      const paragraph = cardPartElement(card, part)?.firstChild;
      if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph" || paragraph.length !== 0) continue;
      const id = Y.createRelativePositionFromTypeIndex(paragraph, 0).type;
      if (id?.client === doc.clientID && id.clock >= start) paragraph.insert(0, [new Y.XmlText()]);
    }
  }
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
    let text = edit.text;
    if (text === undefined) {
      const paragraph = cardPartElement(element, edit.part)?.firstChild;
      if (!(paragraph instanceof Y.XmlElement)) throw new InvalidCardError("Stored card part is missing");
      text = new Y.XmlText();
      paragraph.insert(0, [text]);
    }
    spliceInlineText(text, edit.oldRuns, edit.newRuns, edit.offset);
  }
  if (beforeButtons !== buttons) {
    if (buttons === "") element.removeAttribute("button");
    else element.setAttribute("button", buttons);
  }
}
