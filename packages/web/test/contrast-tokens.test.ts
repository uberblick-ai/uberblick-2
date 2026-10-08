// @vitest-environment node

/**
 * The palette is cheapest to defend at its source. This table reads the actual
 * declarations, including light-dark(), aliases, both page-gradient stops and
 * the terminal's local palette. No DOM or browser participates.
 *
 * Consumer wiring, later cascade rules, opacity groups and positioned sibling
 * grounds remain browser obligations: a good palette does not prove good paint.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composite, contrast, separation, splitCssList } from "./colour.js";
import { cardHighlightFloor, focusedOrphanedChipFloor } from "./contrast-contract.js";

type Appearance = "light" | "dark";
type Tokens = Map<string, string>;

const stylesheet = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");

function declarations(source: string): Tokens {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens: Tokens = new Map();
  for (const selector of [":root", ".ub-terminal"]) {
    const blocks = [...clean.matchAll(new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`, "g"))];
    if (blocks.length === 0) throw new Error(`missing token source ${selector}`);
    for (const block of blocks) {
      for (const match of (block[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        const [, name, value] = match;
        if (name !== undefined && value !== undefined) {
          if (tokens.has(name)) throw new Error(`multiple source declarations for ${name}; establish its appearance scope before measuring it`);
          tokens.set(name, value.trim());
        }
      }
    }
  }
  return tokens;
}

/** Change a real declaration in memory; never edit production appearance. */
function seedToken(name: string, value: string): Tokens {
  const declaration = new RegExp(`(${name}\\s*:\\s*)[^;]+;`);
  if (!declaration.test(stylesheet)) throw new Error(`no declaration to seed: ${name}`);
  return declarations(stylesheet.replace(declaration, (_match, prefix: string) => `${prefix}${value};`));
}

function resolve(tokens: Tokens, name: string, scheme: Appearance, path: string[] = []): string {
  if (path.includes(name)) throw new Error(`cyclic token alias: ${[...path, name].join(" -> ")}`);
  const indexed = /^(--page-ground)\[(\d)\]$/.exec(name);
  if (indexed !== null) {
    const gradient = tokens.get("--page-ground");
    if (gradient === undefined || !gradient.startsWith("radial-gradient(")) {
      throw new Error("missing radial page-ground token");
    }
    const stops = splitCssList(gradient.slice("radial-gradient(".length, -1));
    if (stops.length !== 3 || !stops[0]?.startsWith("at ")) {
      throw new Error("page-ground changed; the token table must cover every gradient stop");
    }
    const stop = stops[Number(indexed[2]) + 1];
    if (stop === undefined) throw new Error(`missing page ground ${name}`);
    return resolveValue(stop);
  }
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`missing colour token ${name}`);
  return resolveValue(value);

  function resolveValue(value: string): string {
    if (value.startsWith("light-dark(")) {
      const halves = splitCssList(value.slice("light-dark(".length, -1));
      if (halves.length !== 2) throw new Error(`not two appearances: ${value}`);
      return resolveValue(halves[scheme === "light" ? 0 : 1] ?? "");
    }
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    return alias === null ? value : resolve(tokens, alias[1] ?? "", scheme, [...path, name]);
  }
}

type Pair = {
  name: string;
  ink: string;
  ground: string;
  /** The ground's own backing, for fills that carry colour alpha. */
  under?: string;
  measure?: "separation" | "stroke";
  floor?: number | Record<Appearance, number>;
  appearance?: Appearance;
  opacity?: number;
};

const text = (name: string, ink: string, ground: string, under?: string): Pair => ({
  name, ink, ground, floor: 4.5, ...(under === undefined ? {} : { under }),
});

const pairs: Pair[] = [
  // Sidebar column and its anchored menus (#515). Alpha belongs to the ink,
  // so ratios composite it over each ground rather than discarding the alpha.
  ...["--sidebar-foreground", "--sidebar-row-icon", "--sidebar-muted-foreground"]
    .flatMap((ink) => ["--sidebar", "--sidebar-accent"].map((ground) => text("sidebar and anchored-menu ink", ink, ground))),
  ...["--sidebar-row-foreground", "--sidebar-group-label"].map((ink) => text("resting sidebar row/label ink", ink, "--sidebar")),
  text("highlighted menu ink", "--accent-foreground", "--sidebar-accent"),
  text("hovered group action ink", "--foreground", "--sidebar-accent"),
  text("selected appearance ink", "--sidebar-foreground", "--brand-subtle"),
  text("menu field ink", "--foreground", "--background"),
  text("menu placeholder ink", "--sidebar-muted-foreground", "--background"),
  { name: "sidebar outer light edge", ink: "--sidebar-border", ground: "--sidebar", measure: "separation", floor: 0.04, appearance: "light" },
  { name: "sidebar rename field edge", ink: "--sidebar-input", ground: "--background", measure: "stroke" },
  ...["--sidebar", "--sidebar-accent"].map((ground): Pair => ({
    name: "tag checkbox neutral stroke", ink: "--sidebar-muted-foreground", ground, measure: "stroke",
  })),
  // Document-panel highlights (#1062); dark's >.02 was already held by the
  // tag-picker proof. Rendered checks retain the relative sidebar-step floor.
  { name: "panel highlight remains distinct", ink: "--sidebar-accent", ground: "--sidebar", measure: "separation", floor: Number.EPSILON },
  { name: "dark tag-panel highlight step", ink: "--sidebar-accent", ground: "--sidebar", measure: "separation", floor: 0.02, appearance: "dark" },
  // The one card highlight (#516, #567, #572). The table cannot know which
  // consumer receives it; the rendered proof holds that separate clause.
  { name: "card highlight", ink: "--card-accent", ground: "--card", measure: "separation", floor: cardHighlightFloor },
  text("block-menu selected entry ink", "--accent-foreground", "--card-accent"),
  text("threads/composer/resolved-chip ink", "--secondary-foreground", "--card-accent"),
  text("resting orphaned chip ink", "--foreground", "--status-warning-subtle", "--card"),
  text("focused orphaned chip ink", "--brand-foreground", "--status-warning", "--brand-subtle"),
  { name: "focused orphaned chip step", ink: "--status-warning", ground: "--brand-subtle", measure: "separation", floor: focusedOrphanedChipFloor },
  // Functional brand ink (#569): flat chrome, the page gradient, annotated
  // ranges and inline-code grounds. Dark --brand-ink aliases --brand.
  ...["--background", "--card", "--card-accent", "--sidebar", "--sidebar-accent", "--brand-subtle", "--muted", "--page-ground[0]", "--page-ground[1]"]
    .map((ground) => text("functional brand ink", "--brand-ink", ground)),
  // Global muted ink is not the sidebar's muted ink. These are its actual
  // light grounds, including code/source chrome, focused threads and stops.
  ...["--background", "--card", "--card-accent", "--muted", "--secondary", "--brand-subtle", "--status-warning-subtle", "--destructive-subtle", "--page-ground[0]", "--page-ground[1]"]
    .map((ground): Pair => ({ ...text("full-strength light muted ink", "--muted-foreground", ground), appearance: "light" })),
  // These are enabled consumers, so card text must still clear AA at full
  // strength (#1062). CSS opacity and real backing remain browser obligations.
  ...["--card", "--brand-subtle"].flatMap((ground) => ["--card-foreground", "--foreground", "--muted-foreground"].map((ink) => text("enabled conversation ink", ink, ground))),
  text("source copy ink", "--muted-foreground", "--muted"),
  // Terminal controls have their existing stricter floors, not generic AA.
  { name: "terminal toggle at rest", ink: "--terminal-control-ink", ground: "--terminal-screen", floor: 7.054520 },
  { name: "terminal copy at rest", ink: "--terminal-control-ink", ground: "--terminal-screen", opacity: 0.6, floor: 3.317915 },
  { name: "terminal controls hovered/focused", ink: "--terminal-control-hover-ink", ground: "--terminal-screen", floor: 17.521906 },
];

const tokens = declarations(stylesheet);

function reading(pair: Pair, source: Tokens, scheme: Appearance): { value: number; floor: number } {
  const ink = resolve(source, pair.ink, scheme);
  const base = resolve(source, pair.ground, scheme);
  const ground = pair.under === undefined ? base : composite(base, resolve(source, pair.under, scheme));
  const value = pair.measure === "separation" || (pair.measure === "stroke" && scheme === "light")
    ? separation(ink, ground)
    : contrast(pair.opacity === undefined ? ink : composite(ink, ground, pair.opacity), ground);
  // Dark's sidebar edge has no absolute floor in its contract. Interior
  // strokes must reach that actual edge; light also holds the absolute .04.
  const reference = pair.measure === "stroke"
    ? scheme === "light" ? separation(resolve(source, "--sidebar-border", scheme), resolve(source, "--sidebar", scheme))
      : contrast(resolve(source, "--sidebar-border", scheme), resolve(source, "--sidebar", scheme))
    : 0;
  const floor = pair.floor === undefined ? reference
    : typeof pair.floor === "number" ? pair.floor : pair.floor[scheme];
  return { value, floor };
}

describe.each(["light", "dark"] as const)("source-token contrast — %s", (scheme) => {
  for (const pair of pairs.filter((pair) => pair.appearance === undefined || pair.appearance === scheme)) {
    const name = `${pair.name}: ${pair.ink} on ${pair.ground}`;
    it(name, () => {
      const { value, floor } = reading(pair, tokens, scheme);
      expect(value, name).toBeGreaterThanOrEqual(floor);
    });
  }

  it("focused orphaned chips separate no less than resting chips", () => {
    const focused = separation(resolve(tokens, "--status-warning", scheme), resolve(tokens, "--brand-subtle", scheme));
    const resting = separation(resolve(tokens, "--status-warning-subtle", scheme), resolve(tokens, "--card", scheme));
    expect(focused).toBeGreaterThanOrEqual(resting);
    const regressed = seedToken("--status-warning", "var(--brand-subtle)");
    expect(separation(resolve(regressed, "--status-warning", scheme), resolve(regressed, "--brand-subtle", scheme))).toBeLessThan(resting);
  });
});
