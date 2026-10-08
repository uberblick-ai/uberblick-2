import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMeta, listAnnotations, readDecisions } from "@uberblick/schema";
import { failureContract, guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolContext } from "./context.js";
import { DECISION_AUTHORITY, DECISION_EDGES, LIFECYCLE_RECORDS_STATE } from "./descriptions.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

export function registerGetDoc(server: McpServer, context: ToolContext): void {
  const {
    replicas,
    requireDoc,
    decisionAuthorityJson,
    documentTags,
    decisionEntryJson,
    topicJson,
    decisionReadJson,
    blocksJson,
    annotationJson,
    briefing,
  } = context;

  server.registerTool(
    "get_doc",
    {
      title: "Read a document",
      description:
        "Read a document's metadata — including `description` and the person-facing `tldr`, each null when nobody " +
        "has written one — its blocks " +
        "and its annotation threads. Lifecycle documents include `kind` and their compatible `status`; ordinary " +
        "documents omit both. " +
        LIFECYCLE_RECORDS_STATE +
        "\n\n" +
        DECISION_EDGES +
        "\n\n" +
        DECISION_AUTHORITY +
        "\n\n" +
        "Every block carries a `rev` content hash — pass it back to edit_block to assert nothing changed since this read.\n\n" +
        "For a table, `text` is canonical GFM with cell formatting as inline markdown, literal punctuation and pipes " +
        "escaped, and every row padded to the widest row; `rev` includes that formatting. For other blocks `text` " +
        "is plain text and `rev` ignores marks. A prose block that carries inline references to other " +
        "documents also carries `doc_links`: `[{start, end, docId}]` in characters, the same offsets annotate and " +
        "link_range speak in, and absent where there are none. Table cell links count toward backlinks but do not " +
        "have block-level `doc_links` ranges.\n\n" +
        "Reading eligible guidance with get_doc counts toward this process’s briefing. The last required read " +
        "starts a ten-minute lease; expiry requires fresh reads. This best-effort memory never fails the read " +
        "or writes usage to a room or update log, and is lost on restart." +
        failureContract("get_doc"),
      inputSchema: strictInput({ uuid: uuidArg }),
    },
    guarded("get_doc", async ({ uuid }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      const meta = getMeta(replica.doc);
      const result = json({
        ...meta,
        ...decisionAuthorityJson(replica),
        tags: documentTags(replica),
        room: replica.room,
        decisions: readDecisions(replica.doc, replicas.directory().doc).map(topic => ({ ...decisionEntryJson(topic.representative), ...topicJson(topic) })),
        ...(meta.kind === "decision" ? decisionReadJson(uuid) : {}),
        blocks: blocksJson(replica),
        annotations: listAnnotations(replica.doc).map((annotation) =>
          annotationJson(replica, annotation),
        ),
      });
      briefing.recordRead(uuid);
      return result;
    }),
  );
}
