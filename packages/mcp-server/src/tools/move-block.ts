import { decisionAnswerShapeFailure, getBlock, getBlocks, getMeta, moveBlocks } from "@uberblick/schema";
import * as Y from "yjs";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { documentOperation } from "./operation.js";
import { uuidArg } from "./schemas.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  block_ids: z.array(z.string().min(1)).min(1).describe("Distinct block ids, in their destination order."),
  after_block_id: z.string().min(1).nullish().describe("Move after this block. Omit or null to move first."),
});

export const moveBlockOperation = documentOperation({ content: true, contentDurability: true }, inputSchema, (context, { uuid, block_ids, after_block_id }, _request, replica) => {
  const draft = new Y.Doc();
  try {
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(replica.doc));
    const before = Y.encodeStateVector(draft);
    const changed = moveBlocks(draft, block_ids, after_block_id ?? null);
    if (getMeta(draft, replica.id).kind === "decision") {
      const failure = decisionAnswerShapeFailure(getBlocks(draft));
      if (failure !== null) {
        throw new ToolError(failure, "The resulting decision answer must use at most three paragraphs, code blocks, tables or lists. Nothing was written.", { uuid });
      }
    }

    // One validated update keeps peers from observing the old and new copies separately.
    if (changed) Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(draft, before));
    const moved = block_ids.map(id => {
      const block = getBlock(replica.doc, id);
      if (block === null) throw new Error(`Moved block ${id} is missing`);
      return block;
    });
    const last = moved[moved.length - 1];
    if (last === undefined) throw new Error("Validated move selection is empty");
    if (changed) context.replicas.publishCursor(replica, last.id, last.text.length);
    return { uuid, blocks: moved.map(({ id, rev }) => ({ id, rev })) };
  } finally {
    draft.destroy();
  }
});
