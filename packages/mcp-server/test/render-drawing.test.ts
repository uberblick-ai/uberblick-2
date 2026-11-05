import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { renderDrawing } from "../src/tools/render-drawing.js";

const source = `flow v0
columns main
pill draft "Draft"
box review "Review" tone=agent
end done "Done" tone=done
draft --> review
review --> done`;

/** Decode the rasterizer's 8-bit RGBA PNG to inspect actual paint and opacity. */
function pixels(png: Buffer): { width: number; height: number; rgba: Buffer } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(6);
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const filtered = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x < 4 ? 0 : rgba.readUInt8(y * stride + x - 4);
      const up = y === 0 ? 0 : rgba.readUInt8((y - 1) * stride + x);
      const upperLeft = x < 4 || y === 0 ? 0 : rgba.readUInt8((y - 1) * stride + x - 4);
      const p = left + up - upperLeft;
      const a = Math.abs(p - left);
      const b = Math.abs(p - up);
      const c = Math.abs(p - upperLeft);
      const paeth = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][filter ?? -1];
      if (predictor === undefined) throw new Error("Unexpected PNG filter");
      rgba[y * stride + x] = (filtered.readUInt8(y * (stride + 1) + x + 1) + predictor) & 255;
    }
  }
  return { width, height, rgba };
}

describe("browserless Ablauf rendering", () => {
  it.each([
    'fan-out v0\nstep "Check"\noutcome "Approved" reason="Ready" destination="Start" tone="done"',
    'sequence v0\nparticipant A "Agent" tone=agent\nparticipant H "Hub" tone=system\nsection "Claim"\nA --> H: Claim workspace\nH -.-> A: Challenge\nnote over A, H: Challenge expires soon\nalt Verified\nH -.-> A: Granted\nelse Expired\nH -.-> A: Retry\nend',
  ])("renders the other Ablauf diagram grammars (%#)", async (text) => {
    const result = await renderDrawing(text, "svg");
    expect(result.drawing).toEqual({ status: "clean", diagnostics: [] });
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    if (result.format !== "svg") throw new Error("Expected SVG");
    expect(result.svg).not.toContain("var(");
    expect(result.svg).not.toContain("<text");
  });

  it("paints opaque light colors, strokes, labels and arrowheads at the requested width", async () => {
    const drawing = await renderDrawing(source);
    expect(drawing).toMatchObject({ format: "png", width: 1000, height: 972, drawing: { status: "clean", diagnostics: [] } });
    if (drawing.format !== "png") throw new Error("Expected PNG");
    const decoded = pixels(Buffer.from(drawing.data, "base64"));
    expect(decoded.width).toBe(drawing.width);
    expect(decoded.height).toBe(drawing.height);
    expect([...decoded.rgba.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    const colors = new Set<string>();
    for (let offset = 0; offset < decoded.rgba.length; offset += 4) {
      if (decoded.rgba[offset + 3] !== 255) throw new Error("PNG contains a transparent pixel");
      colors.add(decoded.rgba.subarray(offset, offset + 3).toString("hex"));
    }
    expect(colors).toContain("e7eeed");
    expect(colors).toContain("3e6563");
    expect(colors).toContain("17202c");
    expect(colors).not.toContain("000000");
    // The arrowhead extends left of the narrow vertical edge before the second node.
    const arrow = (Math.round(74 / 206 * drawing.height) * drawing.width + Math.round(104 / 212 * drawing.width)) * 4;
    expect([...decoded.rgba.subarray(arrow, arrow + 3)]).toEqual([90, 101, 117]);
    const smaller = await renderDrawing(source, "png", 200);
    expect(smaller).toMatchObject({ width: 200, height: 194 });
  });

  it("returns a self-contained SVG with light paint and both font weights converted to paths", async () => {
    const drawing = await renderDrawing(source, "svg", 2000);
    expect(drawing).toMatchObject({ format: "svg", width: 212, height: 206 });
    if (drawing.format !== "svg") throw new Error("Expected SVG");
    expect(drawing.svg).toContain('fill="#ffffff"');
    expect(drawing.svg).toContain('fill="#e7eeed" stroke="#3e6563"');
    expect(drawing.svg).toContain('clip-path="url(#clipPath1)"');
    expect(drawing.svg).not.toContain("var(");
    expect(drawing.svg).not.toContain("<text");
    expect(drawing.svg).not.toContain("font-family");
    expect(drawing.svg.match(/<path/g)?.length).toBeGreaterThan(10);
    const literal = await renderDrawing('flow v0\ncolumns main\npill a "var(--bg)"', "svg");
    const color = await renderDrawing('flow v0\ncolumns main\npill a "#ffffff"', "svg");
    expect(literal).not.toEqual(color);
  });

  it("keeps the complete drawing before playback and reports source diagnostics", async () => {
    const baseline = await renderDrawing(source);
    const playback = await renderDrawing(`${source}\n\nplay "Review"\n  step draft\n  step review`);
    expect(playback).toEqual(baseline);
    const invalid = await renderDrawing(`${source}\nunknown statement`, "svg");
    expect(invalid.drawing).toMatchObject({ status: "errors", diagnostics: [{ line: 8, severity: "error", message: expect.any(String) }] });
    const capped = await renderDrawing(`${source}\n${Array.from({ length: 25 }, () => "unknown statement").join("\n")}`, "svg");
    if (capped.drawing.status === "unchecked") throw new Error("Expected diagnostics");
    expect(capped.drawing.diagnostics).toHaveLength(20);
    expect(capped.drawing.diagnosticCount).toBe(25);
  });
});
