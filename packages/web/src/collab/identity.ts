/** Random, self-asserted per-tab defaults; ub open supplies the name and settings republish live. */

/**
 * Positively classify agents by AGENT_CLIENT; omission renders as a person and
 * must not activate the agent cursor grace period. Keep markers independent of
 * rooms so presentation readers need no provider, replica or token imports.
 * AGENT_CLIENT is shared wire spelling with mcp-server/src/replica.ts; importing
 * that replica for one marker would pull in its Node-only runtime.
 */
export const WEB_CLIENT = "web";
export const AGENT_CLIENT = "agent";

/**
 * y-prosemirror requires six-digit hex: no shorthand, rgb() or alpha. Cursor
 * inline styles need literal colors, not theme tokens. Keep all eight readable
 * on both grounds: luminance near 0.18, at least 4.1:1 against each background
 * and 4.69:1 against white cursor-label text. Hue names label swatches, never
 * identify persisted settings.
 */
const COLORS = [
  { name: "crimson", hex: "#e30c4e" },
  { name: "amber", hex: "#ac6008" },
  { name: "olive", hex: "#837401" },
  { name: "green", hex: "#0c853d" },
  { name: "teal", hex: "#0e8085" },
  { name: "blue", hex: "#0675c9" },
  { name: "violet", hex: "#8c4bf7" },
  { name: "magenta", hex: "#cb26b4" },
] as const;

/**
 * Used when a peer publishes awareness without a colour. Same budget: 5.02:1
 * against the white label text, 3.9:1 / 4.5:1 against the two grounds.
 */
const FALLBACK_COLOR = "#6f6f6f";

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
    color: pick(COLORS).hex,
  };
}

export {
  COLORS as AWARENESS_COLORS,
  FALLBACK_COLOR as AWARENESS_FALLBACK_COLOR,
};
