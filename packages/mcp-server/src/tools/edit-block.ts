import { editBlock, getBlock } from "@uberblick/schema";
import type { CalloutVariant, ListIndent } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { listIndentArg, listStyleArg, uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";
import { preservingOpenAnchors } from "./anchor-protection.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  block_id: z.string().min(1),
  old_text: z.string().describe("The block text you read. Asserted before the splice."),
  new_text: z.string().describe("Replacement text. Repeat old_text to change only list style, depth, callout variant or icon."),
  list: listStyleArg.optional().describe("New list style on an existing list item; omitted keeps its style. Refused on other block types."),
  indent: listIndentArg.optional().describe("New list depth, an integer from 0 to 3, on an existing list item; omitted keeps its depth. Refused on other block types."),
  variant: z.string().optional().describe("New callout variant: note, tip, important, warning or caution; omitted keeps it. Refused on other block types."),
  icon: z.string().optional().describe("New callout icon: one emoji character or a curated :name: icon; an empty value restores the default. Omitted keeps it. Refused on other block types."),
  rev: z
    .string()
    .min(1)
    .optional()
    .describe("The block's `rev` from get_doc. Asserted alongside old_text."),
  table_mapping: z.object({
    rows: z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable())
      .describe("For each new row, its old projection index or null; includes header row 0."),
    columns: z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable())
      .describe("For each new column, its old projection index or null."),
  }).strict().optional().describe("Explicit surviving table positions. Both arrays are required; omitted old positions are deleted."),
});

export const editBlockOperation = documentOperation({ content: true, contentDurability: true }, inputSchema, (context, { uuid, block_id, old_text, new_text, list, indent, variant, icon, rev, table_mapping }, _request, replica) => {
  const { replicas, validateBlockTargets } = context;

  const current = getBlock(replica.doc, block_id);
  // Keep stale assertions ahead of content validation, as editBlock does.
  // Validate before its transaction: a Yjs write cannot be rolled back.
  if (current !== null && current.text === old_text &&
      (rev === undefined || current.rev === rev)) validateBlockTargets(current.type, new_text, old_text, table_mapping);
  preservingOpenAnchors(replica.doc, block_id, draft => editBlock(draft, block_id, old_text, new_text, {
    ...(rev === undefined ? {} : { rev }),
    ...(list === undefined ? {} : { list }),
    ...(indent === undefined ? {} : { indent: indent as ListIndent }),
    ...(variant === undefined ? {} : { variant: variant as CalloutVariant }),
    ...(icon === undefined ? {} : { icon }),
    ...(table_mapping === undefined ? {} : { tableMapping: table_mapping }),
  }));
  replicas.publishCursor(replica, block_id, new_text.length);
  const edited = getBlock(replica.doc, block_id);
  return {
    uuid,
    block: edited === null ? null : { id: edited.id, rev: edited.rev },
  };
});
