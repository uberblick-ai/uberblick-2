import { getMeta, listAnnotations, readDecisions, summarizeDocData } from "@uberblick/schema";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg });

export const getDocOperation = operation("get_doc", inputSchema, (context, { uuid }, _request) => {
  const { replicas, requireDoc, decisionAuthorityJson, documentTags, decisionEntryJson, topicJson, decisionReadJson, blocksJson, annotationJson, briefing } = context;

  const replica = requireDoc(uuid);
  const meta = getMeta(replica.doc);
  const collections = summarizeDocData(replica.doc);
  const result = {
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
    ...(collections === null ? {} : { data: { collections, readWith: "get_data" } }),
  };
  briefing.recordRead(uuid);
  return result;
});
