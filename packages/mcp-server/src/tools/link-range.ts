import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBlockRev, setInlineLink } from "@uberblick/schema";
import { z } from "zod";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolContext } from "./context.js";
import {
  ARCHIVED_IS_READ_ONLY,
  DECIDED_IS_READ_ONLY,
  SYNCED_IS_ACKNOWLEDGED,
} from "./descriptions.js";
import { json } from "./helpers.js";
import { docLinkTargetArg, uuidArg } from "./schemas.js";

export function registerLinkRange(server: McpServer, context: ToolContext): void {
  const { toolContract, replicas, briefing, requireWritableDoc, linkTitle, durability } = context;

  server.registerTool(
    "link_range",
    {
      title: "Link a range of a block to another document",
      description:
        "Turn a range of a block's text into an inline reference to another document. The range's own characters " +
        "are the label — this tool writes a mark and never a character, so the block's `text` and `rev` come back " +
        "exactly as get_doc gave them. `annotate` anchors a comment to a range the same way; this is that " +
        "operation with a document uuid instead of a thread.\n\n" +
        "`start` and `end` are character offsets into the block's text, and `rev` is REQUIRED: offsets mean " +
        "nothing without the text they were measured against. A stale `rev` refuses with `stale_block`, carrying " +
        "`currentText` and `currentRev` to re-measure against. Indices are clamped to the text and swapped if " +
        "reversed; a range that clamps to nothing is refused.\n\n" +
        "A range that is already a reference is RETARGETED. A range that is already an external link is refused — " +
        "one range cannot be both — and so is a code, mermaid, table, terminal or chart block, which holds source text. " +
        "The answer carries the target's current `title` for information; the label in the document is the text " +
        "you linked, and it does not follow a later rename.\n\n" +
        "The target must be a document this replica's directory knows, or the call refuses with " +
        "`doclink_target_not_known_locally` and writes nothing. An archived target is accepted.\n\n" +
        "The edge shows up in backlinks without touching `meta.links`, which stays the curated doc-level list " +
        "set_links owns.\n\n" +
        DECIDED_IS_READ_ONLY +
        "\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("link_range"),
      inputSchema: strictInput({
        uuid: uuidArg,
        block_id: z.string().min(1),
        start: z.number().int().min(0).describe("Range start, in characters."),
        end: z.number().int().min(0).describe("Range end, exclusive."),
        doc_id: docLinkTargetArg.describe("Target document UUID."),
        rev: z
          .string()
          .min(1)
          .describe("The block's `rev` from get_doc. Required, and asserted."),
      }),
    },
    guarded("link_range", async ({ uuid, block_id, start, end, doc_id, rev }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid, true);
      // Before the mark: an unknown target refuses with nothing written.
      const title = linkTitle(doc_id);
      setInlineLink(replica.doc, block_id, { start, end }, doc_id, { rev });
      return json({
        uuid,
        blockId: block_id,
        docId: doc_id,
        title,
        // Unchanged by construction — marks are not part of a rev — and
        // answered with so the next call needs no re-read.
        rev: getBlockRev(replica.doc, block_id),
        ...durability(replica),
      });
    }),
  );
}
