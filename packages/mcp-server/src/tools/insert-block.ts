import { BlockNotFoundError, decisionAnswerShapeFailure, getBlock, getBlocks, getMeta, insertBlock } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { blockShape, uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  after_block_id: z
    .string()
    .min(1)
    .nullish()
    .describe("Insert after this block. Omit or null to insert first."),
  ...blockShape,
});

export const insertBlockOperation = documentOperation("insert_block", inputSchema, (context, { uuid, after_block_id, type, text, level, language, inline }, _request, replica) => {
  const { replicas, blockInputFor } = context;

  if (getMeta(replica.doc).kind === "decision") {
    const blocks = getBlocks(replica.doc);
    const after = after_block_id == null ? -1 : blocks.findIndex(block => block.id === after_block_id);
    if (after_block_id != null && after === -1) throw new BlockNotFoundError(after_block_id);
    const failure = decisionAnswerShapeFailure([...blocks.slice(0, after + 1), { type }, ...blocks.slice(after + 1)]);
    if (failure !== null) throw new ToolError(failure, "Decision answers use at most three paragraphs, code blocks, tables or lists.", { uuid });
  }

  // Resolve targets before inserting so refusals leave nothing written.
  const input = blockInputFor({ type, text, level, language, inline });
  const blockId = insertBlock(replica.doc, after_block_id ?? null, input);
  const block = getBlock(replica.doc, blockId);
  // Use stored text length: inline runs can replace the supplied text.
  replicas.publishCursor(replica, blockId, block?.text.length ?? 0);
  return {
    uuid,
    block,
  };
});
