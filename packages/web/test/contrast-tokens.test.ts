// @vitest-environment node

/**
 * The palette is cheapest to defend at its source. This table reads the actual
 * declarations, including light-dark(), aliases, both page-gradient stops and
 * every framed block tint. No DOM or browser participates.
 *
 * Consumer wiring, later cascade rules, opacity groups and positioned sibling
 * grounds remain browser obligations: a good palette does not prove good paint.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { composite, contrast, separation, splitCssList } from "./colour.js";
import { cardHighlightFloor } from "./contrast-contract.js";

type Appearance = "light" | "dark";
type Tokens = Map<string, string>;

const stylesheet = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");

function declarations(source: string): Tokens {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens: Tokens = new Map();
  for (const [selector, pattern] of [
    [":root", /(?:^|\n):root\s*\{([^}]*)\}/g],
  ] as const) {
    const blocks = [...clean.matchAll(pattern)];
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

const tableHeaderGrounds = ["--background", "--card", "--brand-subtle", "--page-ground[0]", "--page-ground[1]"];

const pairs: Pair[] = [
  ...tableHeaderGrounds.map((ground) => text("table header ink", "--table-header-foreground", ground)),
  // Sidebar column and its anchored menus. Alpha belongs to the ink,
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
  // Document-panel highlights retain dark's >.02 floor.
  // Rendered checks retain the relative sidebar-step floor.
  { name: "panel highlight remains distinct", ink: "--sidebar-accent", ground: "--sidebar", measure: "separation", floor: Number.EPSILON },
  { name: "dark tag-panel highlight step", ink: "--sidebar-accent", ground: "--sidebar", measure: "separation", floor: 0.02, appearance: "dark" },
  // The one card highlight. The table cannot know which
  // consumer receives it; the rendered proof holds that separate clause.
  { name: "card highlight", ink: "--card-accent", ground: "--card", measure: "separation", floor: cardHighlightFloor },
  text("block-menu selected entry ink", "--accent-foreground", "--card-accent"),
  text("threads/composer/resolved-chip ink", "--secondary-foreground", "--card-accent"),
  text("resting orphaned chip ink", "--foreground", "--status-warning-subtle", "--card"),
  text("focused orphaned chip ink", "--brand-foreground", "--status-warning", "--brand-subtle"),
  // Links retain AA on page, card, annotated-range and inline-code grounds.
  ...["--background", "--card", "--card-accent", "--sidebar", "--sidebar-accent", "--brand-subtle", "--muted", "--page-ground[0]", "--page-ground[1]"]
    .map((ground) => text("neutral link ink", "--foreground", ground)),
  ...["--background", "--card", "--accent", "--page-ground[0]", "--page-ground[1]"]
    .map((ground) => text("neutral kind badge ink", "--muted-foreground", ground)),
  text("archived pill ink", "--muted-foreground", "--muted"),
  ...["--foreground", "--destructive-ink"].map((ink) => text("archived banner ink", ink, "--archived-background")),
  text("archived Restore ink", "--secondary-foreground", "--secondary"),
  ...["--foreground", "--card-foreground"].map((ink) => text("neutral submit emphasis ink", ink, "--card-accent")),
  ...["--background", "--card", "--page-ground[0]", "--page-ground[1]"]
    .map((ground): Pair => ({ name: "table drop indicator", ink: "--foreground", ground, floor: 3 })),
  // Selected list switches and the current workspace entry still use amber.
  ...["--brand-subtle", "--sidebar", "--sidebar-accent"]
    .map((ground) => text("retained functional brand ink", "--brand-ink", ground)),
  text("TL;DR tab label ink", "--brand-ink", "--card"),
  // Global muted ink is not the sidebar's muted ink. These are its actual
  // light grounds, including code/source chrome, focused threads and stops.
  ...["--background", "--card", "--card-accent", "--muted", "--secondary", "--brand-subtle", "--status-warning-subtle", "--destructive-subtle", "--page-ground[0]", "--page-ground[1]"]
    .map((ground): Pair => ({ ...text("full-strength light muted ink", "--muted-foreground", ground), appearance: "light" })),
  // These are enabled consumers, so card text must still clear AA at full
  // strength. CSS opacity and real backing remain browser obligations.
  ...["--card", "--brand-subtle"].flatMap((ground) => ["--card-foreground", "--foreground", "--muted-foreground"].map((ink) => text("enabled conversation ink", ink, ground))),
  text("source copy ink", "--muted-foreground", "--muted"),
  // Retained avatar initials and their dashed rings use full-strength muted
  // ink on the title cluster and the overflow row, including its hover fill.
  ...["--background", "--card", "--card-accent"]
    .map((ground) => text("departed avatar ink", "--muted-foreground", ground)),
  ...["slate", "rose", "green", "blue"].flatMap((hue) =>
    ["--muted-foreground", "--foreground", "--prose-text"].map((ink) =>
      text("framed caption, actions and content", ink, `--block-${hue}-tint`))),
  // Revision comparison: prose and captions on row tints and word highlights,
  // and the gutter marks on the page.
  ...["--revision-added-row", "--revision-removed-row", "--revision-added-background", "--revision-removed-background"]
    .flatMap((ground) => ["--foreground", "--prose-text"].map((ink) => text("revision comparison text", ink, ground))),
  ...["--revision-added-row", "--revision-removed-row"].map((ground) => text("revision caption ink", "--muted-foreground", ground)),
  text("revision word highlight on its row", "--foreground", "--revision-added-background", "--revision-added-row"),
  ...["--revision-added-ink", "--revision-removed-ink"].flatMap((ink) =>
    ["--background", "--page-ground[0]", "--page-ground[1]"].map((ground) => text("revision gutter mark", ink, ground))),
  ...["comment", "keyword", "name", "string", "number"].map((syntax) =>
    text("syntax on code tint", `--syntax-${syntax}`, "--block-slate-tint")),
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

it.each(["light", "dark"] as const)("source-token contrast — %s", (scheme) => {
  const failures: string[] = [];
  for (const pair of pairs.filter((pair) => pair.appearance === undefined || pair.appearance === scheme)) {
    const name = `${pair.name}: ${pair.ink} on ${pair.ground}`;
    try {
      const { value, floor } = reading(pair, tokens, scheme);
      if (!(value >= floor)) failures.push(`${name}: ${value} < ${floor}`);
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    }
  }

  try {
    const header = resolve(tokens, "--table-header-foreground", scheme);
    const muted = resolve(tokens, "--muted-foreground", scheme);
    const step = separation(header, muted);
    if (!(step > 0 && step <= 0.02)) failures.push(`table header step: ${step} outside (0, 0.02]`);
    const other = scheme === "light" ? "dark" : "light";
    const otherStep = separation(resolve(tokens, "--table-header-foreground", other), resolve(tokens, "--muted-foreground", other));
    if (!(Math.abs(step - otherStep) <= 0.002)) failures.push(`table header appearance steps differ: ${step} vs ${otherStep}`);
    for (const ground of tableHeaderGrounds) {
      const backing = resolve(tokens, ground, scheme);
      if (!(contrast(header, backing) < contrast(muted, backing))) failures.push(`table header ink is not quieter than muted ink on ${ground}`);
    }
  } catch (error) {
    failures.push(`table header relation: ${String(error)}`);
  }

  try {
    const focused = separation(resolve(tokens, "--status-warning", scheme), resolve(tokens, "--brand-subtle", scheme));
    const resting = separation(resolve(tokens, "--status-warning-subtle", scheme), resolve(tokens, "--card", scheme));
    if (!(focused >= resting)) failures.push(`focused orphaned chip step: ${focused} < resting ${resting}`);
  } catch (error) {
    failures.push(`orphaned chip relation: ${String(error)}`);
  }
  expect(failures, failures.join("\n")).toEqual([]);
});
