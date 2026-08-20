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
 * `rgb()`, no alpha.
 */
const COLORS = [
  "#e0567c",
  "#f08c33",
  "#c9a227",
  "#4caf7d",
  "#2f9fb0",
  "#3f7fd0",
  "#7b5ec7",
  "#b4529a",
] as const;

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

export { COLORS as AWARENESS_COLORS };
