import { deleteBlock } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg, block_id: z.string().min(1) });

export const deleteBlockOperation = documentOperation("delete_block", inputSchema, (_context, { uuid, block_id }, _request, replica) => {
  deleteBlock(replica.doc, block_id);
  return { uuid, blockId: block_id, };
});
