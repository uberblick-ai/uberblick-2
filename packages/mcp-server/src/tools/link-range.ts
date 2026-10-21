import { getBlockRev, setInlineLink } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { docLinkTargetArg, uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  block_id: z.string().min(1),
  start: z.number().int().min(0).describe("Range start, in characters."),
  end: z.number().int().min(0).describe("Range end, exclusive."),
  doc_id: docLinkTargetArg.describe("Target document UUID."),
  rev: z
    .string()
    .min(1)
    .describe("The block's `rev` from get_doc. Required, and asserted."),
});

export const linkRangeOperation = documentOperation({ content: true, contentDurability: false }, inputSchema, (context, { uuid, block_id, start, end, doc_id, rev }, _request, replica) => {
  const { linkTitle } = context;

  // Before the mark: an unknown target refuses with nothing written.
  const title = linkTitle(doc_id);
  setInlineLink(replica.doc, block_id, { start, end }, doc_id, { rev });
  return {
    uuid,
    blockId: block_id,
    docId: doc_id,
    title,
    // Marks leave rev unchanged; return it so the next call needs no reread.
    rev: getBlockRev(replica.doc, block_id),
  };
});
