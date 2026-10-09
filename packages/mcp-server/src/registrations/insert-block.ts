import type { ToolRegistrar } from "../help-resources.js";
import { BLOCK_TYPES } from "@uberblick/schema";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, DECIDED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED, TLDR_AFTER_CONTENT_CHANGE } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, insertBlockOperation } from "../tools/insert-block.js";

export function registerInsertBlock(server: ToolRegistrar, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("insert_block", {
    title: "Insert a block",
    description:
      "Insert one block after `after_block_id`, or at the top of the document when it is omitted. " +
      `Block types are the closed set the schema owns — ${BLOCK_TYPES.join(", ")} — which is the editor's ` +
      "whole palette too. A list is a run of adjacent list-item blocks. A table's `text` must be exactly one " +
      "GFM table, or `invalid_table` refuses the write; its rows and cells are stored structurally. Alignment " +
      "markers are accepted but not stored. Inline markdown stores cell formatting and escaped punctuation stays " +
      "literal. Document-link targets must be known to this replica's directory, otherwise " +
      "`doclink_target_not_known_locally` refuses before any write. A terminal's text is " +
      "a transcript in which a line beginning `$ ` is a command " +
      "typed out and every other line is output shown whole — the format has no escape, so an output line " +
      "that itself begins `$ ` cannot be written. A chart's text is a JSON mapping, for example " +
      "`{\"version\":1,\"type\":\"line\",\"collection\":\"observations\",\"x\":{\"field\":\"day\",\"type\":\"date\"}," +
      "\"y\":[{\"field\":\"count\"}]}`. It names top-level record fields: x type is number or date, " +
      "and y has one to eight numeric series. Optional x and y labels, y units, title and " +
      "missing (gap or connect, default gap) control presentation. A data table also uses a chart block, " +
      "for example `{\"version\":1,\"type\":\"table\",\"collection\":\"observations\",\"columns\":[{\"field\":\"day\",\"format\":\"date\"}," +
      "{\"field\":\"count\",\"label\":\"Count\",\"format\":\"number\"}],\"sort\":{\"field\":\"day\",\"direction\":\"desc\"},\"pageSize\":25}`. " +
      "Its one to thirty ordered columns name fields, optional labels and formats text (default), number, date or link. " +
      "Only number accepts unit (a suffix) and decimals (an integer from zero to ten). Optional title, " +
      "sort (one column field, direction asc or desc) and pageSize (one to one hundred, default twenty-five) " +
      "control the read-only view. Unknown mapping keys and options are invalid. Both views only " +
      "read their document's collection and contain no record values; use update_data to write records. Invalid mappings stay " +
      "editable source and show a problem message. Every block has one text an agent can edit.\n\n" +
      DECIDED_IS_READ_ONLY +
      "\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      "\n\n" +
      TLDR_AFTER_CONTENT_CHANGE +
      toolContract("insert_block"),
    outputSchema: outputSchemas.insert_block,
    inputSchema,
  }, guarded("insert_block", context, insertBlockOperation));
}
