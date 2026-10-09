import { getBlock, insertBlock } from "@uberblick/schema";
import { z } from "zod";
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

  // Before the insert: an unknown reference target refuses the call with
  // nothing written.
  const input = blockInputFor({ type, text, level, language, inline });
  const blockId = insertBlock(replica.doc, after_block_id ?? null, input);
  const block = getBlock(replica.doc, blockId);
  // The caret goes after what was actually written, which is not `text`
  // when `inline` replaced it — and joined runs are usually longer.
  replicas.publishCursor(replica, blockId, block?.text.length ?? 0);
  return {
    uuid,
    block,
  };
});
