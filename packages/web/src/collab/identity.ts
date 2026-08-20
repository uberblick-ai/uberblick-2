/**
 * Awareness identity: a fun name and a colour, one per tab.
 *
 * Self-asserted for now. CLAUDE.md's hosted future derives identity from token
 * claims instead — which is why `AwarenessUser` is a value passed into the
 * provider rather than something the provider invents.
 */

/**
 * y-prosemirror only accepts 6-digit hex colours — `cursor-plugin.js` tests
 * against `/^#[0-9a-fA-F]{6}$/` and warns on anything else. No shorthand, no
 * `rgb()`, no alpha. This is the one place in the app where a colour is a
 * literal rather than a CSS token: the theme cannot reach inside the inline
 * styles the cursor plugin writes.
 *
 * Because the theme follows `prefers-color-scheme`, each colour has to work on
 * both grounds. All eight sit near luminance 0.18: ≥4.1:1 against the dark
 * background, ≥4.1:1 against the light one, and ≥4.6:1 against the white
 * cursor-label text.
 */
const COLORS = [
  "#e30c4e",
  "#ac6008",
  "#837401",
  "#0c853d",
  "#0e8085",
  "#0675c9",
  "#8c4bf7",
  "#cb26b4",
] as const;

/** Used when a peer publishes awareness without a colour. Same contrast budget. */
const FALLBACK_COLOR = "#787878";

const ADJECTIVES = [
  "loitering",
  "sequential",
  "unbothered",
  "recursive",
  "adjacent",
  "nocturnal",
  "spelunking",
  "unhurried",
  "opinionated",
  "amphibious",
] as const;

const NOUNS = [
  "otter",
  "heron",
  "pangolin",
  "marmot",
  "cormorant",
  "axolotl",
  "wombat",
  "ibex",
  "narwhal",
  "capybara",
] as const;

export interface AwarenessUser {
  name: string;
  /** 6-digit hex, `#rrggbb`. */
  color: string;
}

function pick<T>(values: readonly T[]): T {
  const index = Math.floor(Math.random() * values.length);
  // noUncheckedIndexedAccess: the index is always in range, but prove it.
  return values[index] ?? (values[0] as T);
}

/** A fresh identity for this tab. Called once per page load. */
export function randomIdentity(): AwarenessUser {
  return {
    name: `${pick(ADJECTIVES)} ${pick(NOUNS)}`,
    color: pick(COLORS),
  };
}

export { COLORS as AWARENESS_COLORS, FALLBACK_COLOR as AWARENESS_FALLBACK_COLOR };
