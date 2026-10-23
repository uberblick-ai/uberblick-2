import { listDocumentRevisions } from "../revision-client.js";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { READ, operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg });

export const listRevisionsOperation = operation(READ, inputSchema, async (context, { uuid }) => {
  context.requireKnownDoc(uuid);
  const revisions = await listDocumentRevisions(context.replicas, uuid, { includeNames: true });
  return { uuid, revisions: revisions.map(entry => ({ ...entry, name: entry.name ?? null })) };
});
