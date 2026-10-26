import { INLINE_ICONS } from "@uberblick/schema";
import type { InlineIconName } from "@uberblick/schema";

export interface InlineIconToken {
  from: number;
  to: number;
  name: InlineIconName;
}

export function inlineIconTokens(text: string): InlineIconToken[] {
  return [...text.matchAll(/:([a-z][a-z0-9]*(?:-[a-z0-9]+)*):/g)].flatMap((match) => {
    const name = match[1];
    return name !== undefined && Object.hasOwn(INLINE_ICONS, name)
      ? [{ from: match.index, to: match.index + match[0].length, name: name as InlineIconName }]
      : [];
  });
}

/** Artwork is bundled, never derived from authored text. IDs are local to each SVG. */
export function inlineIconSvg(name: InlineIconName, prefix: string): string {
  return INLINE_ICONS[name].svg
    .replace(/id="([^"]+)"/g, `id="${prefix}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`);
}

/** Read rendered text without inheriting nested comment controls' accessible names. */
export function inlineIconAnchorLabel(anchor: HTMLElement): string | null {
  if (anchor.querySelector(".ub-inline-icon-text, .ub-inline-icon, .ub-person-mention-text, .ub-person-pill") === null) return null;
  const visibleText = (node: Node): string => {
    if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node instanceof Element && node.getAttribute("role") === "img") return node.getAttribute("aria-label") ?? "";
    return [...node.childNodes].map(visibleText).join("");
  };
  return [...anchor.childNodes].map(visibleText).join("").replace(/\s+/g, " ").trim();
}
