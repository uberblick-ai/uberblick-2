import { getMeta, readDocData } from "@uberblick/schema";
import { readDocumentRevision } from "../revision-client.js";
import { strictInput } from "../inputs.js";
import { dataSummary } from "./get-data.js";
import { revisionArg, uuidArg } from "./schemas.js";
import { READ, operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg, revision: revisionArg });

export const getRevisionOperation = operation(READ, inputSchema, async (context, { uuid, revision }) => {
  context.requireKnownDoc(uuid);
  const { doc, history } = await readDocumentRevision(context.replicas, uuid, revision);
  try {
    return {
      uuid, revision, history, title: getMeta(doc).title,
      blocks: context.blocksJson({ doc }).map(({ rev: _rev, column_widths: _widths, ...block }) => block),
      data: dataSummary(readDocData(doc)),
    };
  } finally {
    doc.destroy();
  }
});
