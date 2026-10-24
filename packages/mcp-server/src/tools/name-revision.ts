import { z } from "zod";
import { validRevisionName } from "@uberblick/schema";
import { strictInput } from "../inputs.js";
import { documentRevisionChecksum, mutateDocumentRevision, requireDocumentHistory } from "../revision-client.js";
import { revisionOutput } from "../revision-output.js";
import { DOCUMENT_WRITE, operation } from "./operation.js";
import { uuidArg } from "./schemas.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  name: z.string().refine(validRevisionName,
    "A revision name must contain 1 to 100 characters on one line.")
    .describe("The name the person requested, from 1 to 100 characters on one line."),
});

export const nameRevisionOperation = operation(DOCUMENT_WRITE, inputSchema, async (context, { uuid, name }) => {
  context.requireKnownDoc(uuid);
  requireDocumentHistory(context.replicas, uuid);
  const replica = context.requireWritableDoc(uuid);
  const revision = await mutateDocumentRevision(context.replicas, uuid, {
    operation: "name", name, checksum: documentRevisionChecksum(replica.doc),
    surface: context.replicas.createUpdateOrigin().surface ?? { kind: "mcp", name: "unknown MCP client" },
  });
  return { uuid, revision: revisionOutput(revision), applied: true, synced: true, hub: context.replicas.sync.state() };
});
