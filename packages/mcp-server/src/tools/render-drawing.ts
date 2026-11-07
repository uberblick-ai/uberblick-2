import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { LIGHT, render } from "@uberblick/ablauf";
import type { FontOptions } from "@uberblick/ablauf";
import type { DrawingWriteSummary } from "../outputs.js";
import { summarizeDrawing } from "./drawing-check.js";
import { renderAssets } from "./render-assets.js";

export const DEFAULT_RENDER_WIDTH = 1000;
export const MIN_RENDER_WIDTH = 100;
export const MAX_RENDER_WIDTH = 2000;
export const MAX_RENDER_PIXELS = 4_000_000;

export class RenderDrawingError extends Error {
  constructor(readonly code: "render_too_large" | "render_failed", message: string) {
    super(message);
    this.name = "RenderDrawingError";
  }
}

type DrawingDimensions = { width: number; height: number; drawing: DrawingWriteSummary };
export type RenderedDrawing = DrawingDimensions & (
  { format: "png"; data: string } | { format: "svg"; svg: string }
);

// known limit: sans-role labels use Geist Mono and can be wider than the web; revisit when more faces are approved.
// Both bundled static faces use a 600/1000-em monospace advance. Counting
// code points also reserves space for combining marks rather than clipping.
const font: FontOptions = {
  family: "Geist Mono",
  measureText: (text, { fontSize }) => [...text].length * fontSize * 0.6,
};

let initialized: Promise<void> | undefined;

function tooLarge(): never {
  throw new RenderDrawingError("render_too_large",
    `The PNG must have finite positive dimensions and at most ${MAX_RENDER_PIXELS.toLocaleString("en-US")} pixels; use a smaller width or format: "svg".`);
}

function checkPixels(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width * height > MAX_RENDER_PIXELS) tooLarge();
}

/** Resolve only the renderer's own light palette; resvg does not evaluate CSS variables. */
function lightSvg(svg: string): string {
  // known limit: these light hues can differ from web theme tokens; revisit when palette parity is in scope.
  return svg.replace(/<style>([\s\S]*?)<\/style>/g, (_style, css: string) => `<style>${css.replace(
    /var\(--(?:ab-)?([\w-]+)(?:,([^)]*))?\)/g,
    (original, token: string, fallback: string | undefined) => LIGHT[token as keyof typeof LIGHT] ?? fallback ?? original,
  )}</style>`)
    // resvg otherwise omits markers on a path with neither stroke nor fill.
    .replace(".ab .arrow{fill:none;stroke:none}", ".ab .arrow{fill:none;stroke:transparent}")
    // The renderer uses only marker-end; auto is equivalent and supported by resvg.
    .replaceAll('orient="auto-start-reverse"', 'orient="auto"');
}

/** Render the complete, pre-playback flow without a DOM or document writes. */
export async function renderDrawing(source: string, format: "png" | "svg" = "png",
  width = DEFAULT_RENDER_WIDTH): Promise<RenderedDrawing> {
  try {
    const drawing = render(source, { scheme: "light", fonts: { mono: font, text: font } });
    const naturalWidth = drawing.layout.width;
    const naturalHeight = drawing.layout.height;
    if (!Number.isFinite(naturalWidth) || naturalWidth <= 0 || !Number.isFinite(naturalHeight) || naturalHeight <= 0) {
      throw new RenderDrawingError("render_failed", "The drawing has invalid dimensions; fix the source and retry.");
    }
    if (format === "png") checkPixels(width, Math.round(naturalHeight * width / naturalWidth));
    const assets = renderAssets();
    initialized ??= initWasm(assets.wasm);
    await initialized;
    const svg = lightSvg(drawing.svg).replace(/(<svg\b[^>]*>)/, `$1<rect width="100%" height="100%" fill="${LIGHT.bg}"/>`);
    const raster = new Resvg(svg, {
      font: { fontBuffers: assets.fonts, defaultFontFamily: font.family },
      background: LIGHT.bg,
      ...(format === "png" ? { fitTo: { mode: "width" as const, value: width } } : {}),
    });
    try {
      const summary = summarizeDrawing(drawing.diagnostics);
      if (format === "svg") {
        // resvg writes glyphs as paths, so this SVG needs neither system fonts nor a fetch.
        return { format, svg: raster.toString(), width: naturalWidth, height: naturalHeight, drawing: summary };
      }
      // Match resvg's f32 fit-to arithmetic and check again before render allocates its pixmap.
      const scale = Math.fround(width / Math.fround(raster.width));
      const pixelWidth = Math.round(Math.fround(Math.fround(raster.width) * scale));
      const pixelHeight = Math.round(Math.fround(Math.fround(raster.height) * scale));
      checkPixels(pixelWidth, pixelHeight);
      const image = raster.render();
      try {
        return { format, data: Buffer.from(image.asPng()).toString("base64"),
          width: image.width, height: image.height, drawing: summary };
      } finally {
        image.free();
      }
    } finally {
      raster.free();
    }
  } catch (error) {
    if (error instanceof RenderDrawingError) throw error;
    throw new RenderDrawingError("render_failed", "The drawing could not be rendered; fix the source or retry.");
  }
}
