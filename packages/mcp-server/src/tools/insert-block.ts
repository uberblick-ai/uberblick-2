import { BlockNotFoundError, decisionAnswerShapeFailure, getBlock, getBlocks, getMeta, insertBlock } from "@uberblick/schema";
import * as Y from "yjs";
import { z } from "zod";
import { ToolError, toFailure } from "../failures.js";
import { strictInput } from "../inputs.js";
import { blockInputSchema, uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  after_block_id: z
    .string()
    .min(1)
    .nullish()
    .describe("Insert after this block. Omit or null to insert first."),
  blocks: z.array(blockInputSchema).min(1).describe("Blocks to insert consecutively, in order. A single block is a one-entry array."),
});

export const insertBlockOperation = documentOperation({ content: true, contentDurability: true }, inputSchema, (context, { uuid, after_block_id, blocks }, _request, replica) => {
  const { replicas, blockInputFor } = context;
  const existing = getBlocks(replica.doc);
  const after = after_block_id == null ? -1 : existing.findIndex(block => block.id === after_block_id);
  if (after_block_id != null && after === -1) throw new BlockNotFoundError(after_block_id);
  const decision = getMeta(replica.doc, replica.id).kind === "decision";

  // Yjs cannot roll back. Build the entire update off-replica before applying it
  // once, so a later refusal never reaches the log, observers or peers.
  const draft = new Y.Doc();
  try {
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(replica.doc));
    const before = Y.encodeStateVector(draft);
    const ids: string[] = [];
    let anchor = after_block_id ?? null;
    for (const [index, entry] of blocks.entries()) {
      try {
        if (decision) {
          const failure = decisionAnswerShapeFailure([
            ...existing.slice(0, after + 1), ...blocks.slice(0, index + 1), ...existing.slice(after + 1),
          ]);
          if (failure !== null) throw new ToolError(failure, "Decision answers use at most three paragraphs, code blocks, tables or lists.", { uuid });
        }
        anchor = insertBlock(draft, anchor, blockInputFor(entry));
        ids.push(anchor);
      } catch (error) {
        const { error: code, message, ...detail } = toFailure({ name: "insert_block", writes: "document" }, error).payload;
        if (code === "internal_error") throw error;
        throw new ToolError(String(code), `Entry ${index + 1}: ${message}`, { ...detail, entry_index: index + 1 });
      }
    }

    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(draft, before));
    const inserted = ids.map(id => {
      const block = getBlock(replica.doc, id);
      if (block === null) throw new Error(`Inserted block ${id} is missing`);
      return block;
    });
    const last = inserted[inserted.length - 1];
    if (last === undefined) throw new Error("Validated insert batch is empty");
    // Use stored text length: inline runs can replace the supplied text.
    replicas.publishCursor(replica, last.id, last.text.length);
    return { uuid, blocks: inserted };
  } finally {
    draft.destroy();
  }
});
