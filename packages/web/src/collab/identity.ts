/**
 * Awareness identity: a fun name and a colour, one per tab.
 *
 * The colour is a *default*, not the last word: a reader who picks one in the
 * user menu (#74) stores it, and `rooms.ts` publishes the stored one over this
 * for every room. The name has no such override — nothing has asked for one.
 *
 * Self-asserted for now. Identity can later be derived from authenticated token
 * claims — which is why `AwarenessUser` is a value passed into the
 * provider rather than something the provider invents.
 */

/**
 * The two values of the `client` awareness field: what a session says it is.
 *
 * A web tab publishes `WEB_CLIENT` (#74) and an MCP session publishes
 * `AGENT_CLIENT` (#494) — both positively, beside the `user` they belong to, so
 * a session is read *as an agent* only from the agent marker it publishes,
 * never from what it omits. (Omission still has a meaning, just not that one: a
 * session claiming nothing is drawn as a person, `ui/doc-chrome.ts`.)
 * The old absence test ("not a web client, therefore an agent") counted a
 * browser tab running a bundle from before the marker as an MCP connection for
 * as long as that tab stayed open, and held a closed tab's caret over the prose
 * for the whole of `editor/collaboration.ts`'s agent grace (#564).
 *
 * They live here, with the rest of the awareness identity, because the readers
 * that classify a peer are presentation code: routing them through `rooms.ts`
 * for one string would pull the provider, the local replica and the token mint
 * into a chrome test that needs none of them.
 *
 * `AGENT_CLIENT` is the agent's own constant, held as a literal rather than
 * imported: this package does not depend on `@uberblick/mcp-server`, and an
 * awareness field is a wire format either way. Its other end is
 * `packages/mcp-server/src/replica.ts`.
 */
export const WEB_CLIENT = "web";
export const AGENT_CLIENT = "agent";

/**
 * y-prosemirror only accepts 6-digit hex colours — `cursor-plugin.js` tests
 * against `/^#[0-9a-fA-F]{6}$/` and warns on anything else. No shorthand, no
 * `rgb()`, no alpha. This is the one place in the app where a colour is a
 * literal rather than a CSS token: the theme cannot reach inside the inline
 * styles the cursor plugin writes.
 *
 * Because the app is painted in either scheme — the system's preference, or the
 * appearance the reader chose — each colour has to work on both grounds. All eight sit near luminance 0.18: ≥4.1:1 against the dark
 * background, ≥4.1:1 against the light one, and ≥4.69:1 against the white
 * cursor-label text (`--cursor-label-foreground`).
 *
 * Named, because the presence picker (#74) draws them as swatches and a swatch
 * needs a word for the reader who cannot see it. The names describe the hue and
 * nothing else — they are labels, not identifiers, and nothing is stored by
 * them.
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

/** One swatch on the presence picker: a hue, and what to call it. */
export interface PresenceColor {
  name: string;
  /** 6-digit hex, `#rrggbb`. */
  hex: string;
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
