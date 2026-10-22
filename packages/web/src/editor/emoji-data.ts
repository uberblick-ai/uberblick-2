import { INLINE_ICONS } from "@uberblick/schema";
import type { InlineIconName } from "@uberblick/schema";
import type { Gemoji } from "gemoji";

export interface EmojiEntry {
  id: string;
  label: string;
  text: string;
  icon?: InlineIconName;
}

let data: readonly Gemoji[] | null = null;
let pending: Promise<readonly Gemoji[]> | null = null;

/** The data chunk is fetched on the first typed trigger, never at editor startup. */
export function loadEmojiData(): Promise<readonly Gemoji[]> {
  pending ??= import("gemoji").then((module) => {
    data = module.gemoji;
    return data;
  }).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

export function loadedEmojiData(): readonly Gemoji[] | null {
  return data;
}

export function emojiForName(entries: readonly Gemoji[], name: string): string | undefined {
  return entries.find((entry) => entry.names.includes(name.toLowerCase()))?.emoji;
}

/** Name prefixes precede keywords; data order breaks ties consistently. */
export function filterEmoji(entries: readonly Gemoji[], query: string): EmojiEntry[] {
  const needle = query.toLowerCase();
  const names: EmojiEntry[] = [];
  const keywords: EmojiEntry[] = [];
  for (const entry of entries) {
    const name = entry.names.find((name) => name.startsWith(needle));
    const option = { id: entry.emoji, label: name ?? entry.names[0] ?? "", text: entry.emoji };
    if (name !== undefined) names.push(option);
    else if (entry.tags.some((tag) => tag.startsWith(needle))) keywords.push(option);
  }
  for (const icon of Object.keys(INLINE_ICONS) as InlineIconName[]) {
    const label = INLINE_ICONS[icon].label;
    if (icon.startsWith(needle) || label.toLowerCase().startsWith(needle)) {
      names.push({ id: icon, label, text: `:${icon}:`, icon });
    }
  }
  return [...names, ...keywords].slice(0, 8);
}
