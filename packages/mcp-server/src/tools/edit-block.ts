import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editBlock, getBlock } from "@uberblick/schema";
import { z } from "zod";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "./context.js";
import {
  ARCHIVED_IS_READ_ONLY,
  DECIDED_IS_READ_ONLY,
  SYNCED_MEANS,
  TLDR_AFTER_CONTENT_CHANGE,
} from "./descriptions.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

/**
 * What a splice costs the marks already in a block — the boundary that is
 * mechanically fine and semantically wrong, so it has to be said rather than
 * left to be discovered in a damaged document.
 */
const MARKS_ANCHOR_TO_POSITIONS =
  "Marks anchor to positions in the block's text, not to the words they cover, and this tool writes text " +
  "without ever writing a mark. A splice strictly inside unmarked text leaves every mark — inline formatting " +
  "and annotation anchors alike — exactly where it was. A splice that touches a mark's edge re-anchors it: " +
  "rewrite a bolded term, or the separator between two marked ones, and the mark can open mid-word, swallow " +
  "the punctuation beside it, or spread over text nobody formatted. The marks survived; the formatting is now " +
  "wrong, and nothing here detects that.\n\n" +
  "So edit a block that carries formatting only where the changed range lies strictly inside unmarked text. " +
  "For anything else — a marked span itself, or a range whose edges touch one — delete_block plus insert_block " +
  "is the repair: it writes plain text, losing the formatting instead of corrupting it. Check the result with " +
  "export_markdown, where a mark whose edges are whitespace, or that has swallowed a `, ` or an ` and `, is the " +
  "damage showing.";

export function registerEditBlock(server: McpServer, context: ToolContext): void {
  const {
    toolContract,
    replicas,
    briefing,
    requireWritableDoc,
    validateTableTargets,
    contentDurability,
  } = context;

  server.registerTool(
    "edit_block",
    {
      title: "Edit one block",
      description:
        "Replace one block's text by diff-and-splice: only the characters that actually changed are touched, " +
        "so a concurrent human edit elsewhere in the block survives.\n\n" +
        MARKS_ANCHOR_TO_POSITIONS +
        "\n\n" +
        "`old_text` and `new_text` are the block text get_doc returns. For a table this is GFM: each must be " +
        "exactly one table, or `invalid_table` refuses the write. Alignment markers are accepted but not stored; " +
        "inline markdown writes cell formatting and escaped punctuation stays literal. Newly added cell document targets must be known " +
        "to this replica's directory or `doclink_target_not_known_locally` refuses before writing. Existing targets in " +
        "surviving cells remain editable. A table no-op " +
        "keeps every stored character and mark, including those GFM cannot express. Table edits splice only changed " +
        "characters and mark keys in changed cells. Without `table_mapping`, " +
        "only a parsed no-op or exactly one positional cell change at unchanged dimensions is accepted. " +
        "Structural and multi-cell edits require `table_mapping`, including an identity mapping for a positional batch; " +
        "otherwise `table_mapping_required` refuses before any mutation.\n\n" +
        "`table_mapping` applies only to tables and has both `rows` and `columns` arrays. Each new position names " +
        "its surviving old zero-based GFM projection index, or null for a new row or column; omitted old indices " +
        "are deleted. Rows include the header, and `rows[0]` must be 0. Array lengths must match the new table; " +
        "non-null indices must be safe non-negative integers in old bounds, unique and strictly increasing. " +
        "Body rows cannot reuse the header. If a retained ragged row selects only virtual empty padding, " +
        "one fresh empty cell keeps that row editable; other padding stays virtual. Reordering is not supported. " +
        "Untouched surviving shared cells keep their identity, " +
        "formatting and delayed collaborator edits; null entries create fresh shared cells. An explicit nonidentity " +
        "mapping executes even when the GFM text is unchanged. A semantically invalid mapping returns " +
        "`invalid_table_mapping`; both mapping refusals have manual recovery and `applied: false`, " +
        "`partial: false`, `synced: false`. Stale assertions retain precedence and invalid GFM remains `invalid_table`. " +
        "Malformed input shapes are refused by the MCP input schema before the handler. Previously accepted " +
        "structural and multi-cell table calls must now supply mappings as part of the coordinated table cutover. " +
        "Other blocks use plain text with no markdown and reject `table_mapping`. " +
        "In other blocks, spliced-in text inherits the formatting of the character to its left, and `rev` " +
        "ignores marks. A table's `rev` includes its projected formatting. Inserting a read table's GFM preserves " +
        "representable cells and marks, subject to trimmed cell-edge whitespace and renderInline's marked whitespace " +
        "and meeting code-span limits; after one round trip the text is stable.\n\n" +
        "Pass `old_text` (and the `rev` from get_doc) to assert what you are editing. A mismatched asserted rev " +
        "refuses with `stale_block`. When the rev is current but `old_text` is wrong, the refusal is " +
        "`old_text_mismatch`; without a rev, a text mismatch remains `stale_block` because the server cannot tell " +
        "a bad argument from a stale read. Both errors carry `currentText` and `currentRev` to re-diff against.\n\n" +
        "Scope of that guarantee, stated plainly: it is a check against THIS replica at the moment of the call. " +
        "There is no cross-replica compare-and-swap — an edit made elsewhere that has not reached this replica yet " +
        "cannot be detected, and the window widens the longer this server stays offline.\n\n" +
        DECIDED_IS_READ_ONLY +
        "\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_MEANS +
        "\n\n" +
        TLDR_AFTER_CONTENT_CHANGE +
        toolContract("edit_block"),
      outputSchema: outputSchemas.edit_block,
      inputSchema: strictInput({
        uuid: uuidArg,
        block_id: z.string().min(1),
        old_text: z.string().describe("The block text you read. Asserted before the splice."),
        new_text: z.string(),
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
      }),
    },
    guarded("edit_block", async ({ uuid, block_id, old_text, new_text, rev, table_mapping }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid, true);
      const current = getBlock(replica.doc, block_id);
      // Keep stale assertions ahead of content validation, as editBlock does.
      // Validate before its transaction: a Yjs write cannot be rolled back.
      if (current?.type === "table" && current.text === old_text &&
          (rev === undefined || current.rev === rev)) validateTableTargets(new_text, old_text, table_mapping);
      editBlock(replica.doc, block_id, old_text, new_text, {
        ...(rev === undefined ? {} : { rev }),
        ...(table_mapping === undefined ? {} : { tableMapping: table_mapping }),
      });
      replicas.publishCursor(replica, block_id, new_text.length);
      return json({
        uuid,
        block: getBlock(replica.doc, block_id),
        ...contentDurability(replica),
      });
    }, context.work),
  );
}
