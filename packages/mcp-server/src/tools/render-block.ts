import { BlockNotFoundError, getBlock } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { READ, operation } from "./operation.js";
import { ImageResult } from "./image-result.js";
import { DEFAULT_RENDER_WIDTH, MAX_RENDER_PIXELS, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH, RenderDrawingError, renderDrawing } from "./render-drawing.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  block_id: z.string().min(1).describe("An ablauf code block's id from get_doc."),
  // Keep invalid render options for named failures, as column_widths does.
  format: z.unknown().meta({ type: "string", enum: ["png", "svg"] }).optional()
    .describe("PNG image content by default; svg returns standalone SVG text instead."),
  width: z.unknown().meta({ type: "integer", minimum: MIN_RENDER_WIDTH, maximum: MAX_RENDER_WIDTH }).optional()
    .describe(`PNG pixel width, ${MIN_RENDER_WIDTH}–${MAX_RENDER_WIDTH}; default ${DEFAULT_RENDER_WIDTH}. SVG keeps its natural size.`),
});

export const renderBlockOperation = operation(READ, inputSchema, async (context, { uuid, block_id, format, width }, _request) => {
  if (format !== undefined && format !== "png" && format !== "svg") {
    throw new ToolError("invalid_render_options", "format must be png or svg.", { field: "format" });
  }
  if (width !== undefined && (typeof width !== "number" || !Number.isInteger(width)
    || width < MIN_RENDER_WIDTH || width > MAX_RENDER_WIDTH)) {
    throw new ToolError("invalid_render_options", `width must be an integer from ${MIN_RENDER_WIDTH} to ${MAX_RENDER_WIDTH}.`, { field: "width" });
  }
  const replica = context.requireDoc(uuid);
  const block = getBlock(replica.doc, block_id);
  if (block === null) throw new BlockNotFoundError(block_id);
  if (block.type !== "code" || block.language !== "ablauf") {
    throw new ToolError("unsupported_block_type", "render_block supports only code blocks with language ablauf.", { uuid, block_id });
  }
  try {
    const drawing = await renderDrawing(block.text, format ?? "png", width ?? DEFAULT_RENDER_WIDTH);
    if (drawing.format === "svg") return { uuid, block_id, ...drawing };
    const { data, ...payload } = drawing;
    return new ImageResult({ uuid, block_id, ...payload }, { data, mimeType: "image/png" });
  } catch (error) {
    if (!(error instanceof RenderDrawingError)) throw error;
    throw new ToolError(error.code, error.message, {
      uuid, block_id,
      ...(error.code === "render_too_large" ? { maxPixels: MAX_RENDER_PIXELS } : {}),
    });
  }
});
