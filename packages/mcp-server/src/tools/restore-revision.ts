import { z } from "zod";
import { strictInput } from "../inputs.js";
import { documentRevisionChecksum, restoreDocumentRevision } from "../revision-client.js";
import { revisionOutput } from "../revision-output.js";
import { DOCUMENT_WRITE, operation } from "./operation.js";
import { uuidArg } from "./schemas.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  revision: z.string().min(1).max(256).describe("A hub revision id from list_revisions."),
});

export const restoreRevisionOperation = operation(DOCUMENT_WRITE, inputSchema, async (context, { uuid, revision }) => {
  const replica = context.requireWritableDoc(uuid, true);
  const result = await restoreDocumentRevision(context.replicas, uuid, {
    operation: "restore", revisionId: revision, checksum: documentRevisionChecksum(replica.doc),
    surface: context.replicas.createUpdateOrigin().surface ?? { kind: "mcp", name: "unknown MCP client" },
  });
  return { uuid, revision: revisionOutput(result.revision), applied: result.applied,
    synced: true, hub: context.replicas.sync.state() };
});
