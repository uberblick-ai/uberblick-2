import { deleteBlock } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";
import { preservingOpenAnchors } from "./anchor-protection.js";

export const inputSchema = strictInput({ uuid: uuidArg, block_id: z.string().min(1) });

export const deleteBlockOperation = documentOperation({ content: true, contentDurability: true }, inputSchema, (_context, { uuid, block_id }, _request, replica) => {
  preservingOpenAnchors(replica.doc, block_id, draft => deleteBlock(draft, block_id));
  return { uuid, blockId: block_id, };
});
