/**
 * Test-side colour mechanics shared by the token table and rendered readings.
 * Culori owns CSS colour parsing, conversion, source-over composition and the
 * WCAG/OKLab maths. Keep floating-point channels until measurement: a canvas
 * would round each composite to eight bits at the tight contrast floors.
 */
import {
  blend,
  clampRgb,
  converter,
  differenceEuclidean,
  parse,
  wcagContrast,
} from "culori";
import type { Color, Rgb } from "culori";

type Pixel = [number, number, number];
const toRgb = converter("rgb");
const toLab = converter("oklab");
const distance = differenceEuclidean("oklab");

function colour(value: string): Color {
  // CSS function and unit names are case-insensitive. Culori 4.0.2's parser
  // expects lower case; all supported inputs here are colour values, not URLs
  // or custom-property names whose case could carry meaning.
  const result = parse(value.trim().toLowerCase());
  if (result === undefined) throw new Error(`unreadable colour: ${value}`);
  return result;
}

function rgb(value: string): Rgb {
  const result = toRgb(clampRgb(colour(value)));
  if (result === undefined || ![result.r, result.g, result.b].every(Number.isFinite)) {
    throw new Error(`unreadable sRGB colour: ${value}`);
  }
  return { ...result, alpha: result.alpha ?? 1 };
}

export function oklab(value: string): {
  L: number; a: number; b: number; chroma: number; alpha: number;
} {
  const result = toLab(colour(value));
  if (result === undefined || ![result.l, result.a, result.b].every(Number.isFinite)) {
    throw new Error(`unreadable OKLab colour: ${value}`);
  }
  return {
    L: result.l, a: result.a, b: result.b,
    chroma: Math.hypot(result.a, result.b), alpha: result.alpha ?? 1,
  };
}

/** sRGB is the comparison gamut used by the existing browser measurements. */
export function srgb(value: string): Pixel {
  const result = rgb(value);
  return [result.r, result.g, result.b];
}

/** Recognize a browser's RGB serialization without classifying other inks. */
export function legacySrgb(value: string): Pixel | null {
  return /^rgba?\(/i.test(value.trim()) ? srgb(value) : null;
}

export function alphaOf(value: string): number {
  return colour(value).alpha ?? 1;
}

function opaque(value: string): Rgb {
  const result = rgb(value);
  if (result.alpha !== 1) throw new Error(`cannot establish a translucent ground: ${value}`);
  return result;
}

/** A fill's own alpha and the enclosing CSS opacity both affect its paint. */
export function composite(fill: string, ground: string, opacity = 1): string {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error(`invalid CSS opacity: ${opacity}`);
  }
  const source = rgb(fill);
  const painted = blend([
    opaque(ground),
    { ...source, alpha: (source.alpha ?? 1) * opacity },
  ], "normal", "rgb");
  if (painted === undefined) throw new Error("unreadable composite colour");
  const result = toRgb(painted);
  if (result === undefined) throw new Error("unreadable composite sRGB colour");
  return `rgb(${result.r * 255} ${result.g * 255} ${result.b * 255})`;
}

/** WCAG ratio after colour alpha; CSS opacity groups are composed by the caller. */
export function contrast(ink: string, ground: string): number {
  return wcagContrast(colour(composite(ink, ground)), opaque(ground));
}

/** The visible OKLab step of a fill, with translucent fills on their ground. */
export function separation(fill: string, ground: string): number {
  opaque(ground);
  // An opaque OKLab token keeps its declared precision. Only a translucent
  // fill needs a trip through the comparison gamut for source-over painting.
  const painted = alphaOf(fill) === 1 ? fill : composite(fill, ground);
  return distance(colour(painted), colour(ground));
}

/** Light neutral ink's brightest lightness that still clears its ground. */
export function lightnessLimit(ground: string, floor = 4.5): number {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 30; step += 1) {
    const middle = (low + high) / 2;
    if (contrast(`oklch(${middle} 0 0)`, ground) >= floor) low = middle;
    else high = middle;
  }
  return low;
}

/** Split CSS arguments without mistaking a colour function's commas for stops. */
export function splitCssList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
    if (depth < 0) throw new Error(`unbalanced CSS value: ${value}`);
  }
  if (depth !== 0) throw new Error(`unbalanced CSS value: ${value}`);
  parts.push(value.slice(start).trim());
  return parts;
}

/** Extract one stop's colour; positions and gradient directions are not colours. */
function stopColour(stop: string): string | null {
  let end = stop.indexOf(" ");
  const open = stop.indexOf("(");
  if (open >= 0 && (end < 0 || open < end)) {
    let depth = 0;
    end = -1;
    for (let index = open; index < stop.length; index += 1) {
      if (stop[index] === "(") depth += 1;
      else if (stop[index] === ")") depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
    if (end < 0) throw new Error(`unbalanced gradient stop: ${stop}`);
  }
  const candidate = end < 0 ? stop : stop.slice(0, end);
  return parse(candidate.trim().toLowerCase()) === undefined ? null : candidate;
}

/** Both gradient stops must be measured: axe cannot establish this ground. */
export function pageGrounds(backgroundImage: string, backgroundColour: string): string[] {
  if (backgroundImage === "none") {
    opaque(backgroundColour);
    return [backgroundColour];
  }
  const image = /^(?:radial|linear)-gradient\((.*)\)$/.exec(backgroundImage);
  if (image === null) throw new Error("cannot establish the ground through a painted image");
  const arguments_ = splitCssList(image[1] ?? "");
  const stops = arguments_.flatMap((stop, index) => {
    const candidate = stopColour(stop);
    if (candidate === null) {
      const direction = /^(?:at\s|circle(?:\s|$)|ellipse(?:\s|$)|(?:closest|farthest)-(?:side|corner)(?:\s|$)|to\s|[-+\d.]+(?:deg|grad|rad|turn)(?:\s|$))/;
      if (index === 0 && direction.test(stop)) return [];
      throw new Error(`unreadable gradient stop: ${stop}`);
    }
    opaque(candidate);
    return [candidate];
  });
  if (stops.length < 2) throw new Error("no readable page gradient stops");
  return stops;
}
