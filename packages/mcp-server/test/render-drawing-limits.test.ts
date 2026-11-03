import { describe, expect, it, vi } from "vitest";

const wasm = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  construct: vi.fn(),
}));
vi.mock("@resvg/resvg-wasm", () => ({ initWasm: wasm.initialize, Resvg: wasm.construct }));
vi.mock("../src/tools/render-assets.js", () => ({ renderAssets: () => ({ wasm: new Uint8Array(), fonts: [] }) }));

import { MAX_RENDER_PIXELS, renderDrawing } from "../src/tools/render-drawing.js";

describe("PNG allocation bounds", () => {
  it("rejects the valid tall gap case before constructing or initializing the rasterizer", async () => {
    await expect(renderDrawing('flow v0\ncolumns main\nbox a "A" gap=100000\nbox b "B"'))
      .rejects.toMatchObject({ code: "render_too_large", message: expect.stringContaining(MAX_RENDER_PIXELS.toLocaleString("en-US")) });
    expect(wasm.initialize).not.toHaveBeenCalled();
    expect(wasm.construct).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000])("refuses rasterizer height %s before allocating pixels", async (height) => {
    const render = vi.fn();
    const free = vi.fn();
    wasm.construct.mockImplementationOnce(function (this: { width: number; height: number; render: typeof render; free: typeof free }) {
      this.width = 1;
      this.height = height;
      this.render = render;
      this.free = free;
    });
    await expect(renderDrawing('flow v0\ncolumns main\nbox a "A"'))
      .rejects.toMatchObject({ code: "render_too_large" });
    expect(render).not.toHaveBeenCalled();
    expect(free).toHaveBeenCalledOnce();
  });

  it("turns a rasterizer failure into a declared error", async () => {
    wasm.construct.mockImplementationOnce(() => { throw new Error("Malformed SVG"); });
    await expect(renderDrawing('flow v0\ncolumns main\nbox a "A"'))
      .rejects.toMatchObject({ code: "render_failed" });
  });
});
