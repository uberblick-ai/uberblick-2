import { InvalidCalloutError } from "./errors.js";
import { INLINE_ICONS } from "./inline-icons.js";
import { CALLOUT_VARIANTS } from "./types.js";
import type { CalloutVariant } from "./types.js";

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
// biome-ignore lint/complexity/useRegexLiterals: The ES2023 TypeScript target rejects v literals; supported runtimes provide Unicode emoji sequences.
const emojiSequence = new RegExp("^\\p{RGI_Emoji}$", "v");
const emojiCharacter = /^\p{Emoji}$/u;
const pictograph = /^\p{Extended_Pictographic}$/u;

export function isCalloutVariant(value: unknown): value is CalloutVariant {
  return CALLOUT_VARIANTS.some((variant) => variant === value);
}

/** Curated shortcodes or one emoji grapheme, including modifier and joiner sequences. */
export function isCalloutIcon(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (value.startsWith(":") && value.endsWith(":")) {
    return Object.hasOwn(INLINE_ICONS, value.slice(1, -1));
  }
  const segments = graphemes.segment(value)[Symbol.iterator]();
  if (segments.next().done || !segments.next().done) return false;
  return emojiSequence.test(value) || (emojiCharacter.test(value) && pictograph.test(value));
}

/** Validate before touching Yjs: its transactions cannot roll back writes. */
export function validateCalloutAttributes(attributes: { variant?: unknown; icon?: unknown }, allowEmptyIcon = false): void {
  if (attributes.variant !== undefined && !isCalloutVariant(attributes.variant)) {
    throw new InvalidCalloutError("variant must be note, tip, important, warning or caution");
  }
  if (attributes.icon !== undefined && !(allowEmptyIcon && attributes.icon === "") && !isCalloutIcon(attributes.icon)) {
    throw new InvalidCalloutError("icon must be one emoji or a curated :name: icon");
  }
}
