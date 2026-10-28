import { z } from "zod";
import { readDocumentHistory } from "../revision-client.js";
import { revisionOutput } from "../revision-output.js";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { READ, operation } from "./operation.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  refresh: z.literal(true).optional().describe("Revalidate the catalog through the hub before answering; use after an unknown naming or restore outcome. Requires a connection."),
});

export const listRevisionsOperation = operation(READ, inputSchema, async (context, { uuid, refresh }) => {
  context.requireKnownDoc(uuid);
  const { revisions, history } = await readDocumentHistory(context.replicas, uuid, refresh === true ? { refresh: true } : {});
  return { uuid, revisions: revisions.map(revisionOutput), history };
});
