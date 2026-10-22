import { listDocumentRevisions } from "../revision-client.js";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { READ, operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg });

export const listRevisionsOperation = operation(READ, inputSchema, async (context, { uuid }) => {
  context.requireKnownDoc(uuid);
  return { uuid, revisions: await listDocumentRevisions(context.replicas, uuid) };
});
