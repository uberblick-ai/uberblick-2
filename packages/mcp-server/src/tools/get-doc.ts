import { decisionTopicTitle, docRev, getMeta, listAnnotations, readDecisions, resolveDecisionTopics, summarizeDocData } from "@uberblick/schema";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg });

export const getDocOperation = operation("get_doc", inputSchema, (context, { uuid }, _request) => {
  const { replicas, requireDoc, decisionAuthorityJson, documentTags, decisionEntryJson, topicJson, decisionReadJson, blocksJson, annotationJson, briefing } = context;

  const replica = requireDoc(uuid);
  const meta = getMeta(replica.doc, replica.id);
  const collections = summarizeDocData(replica.doc);
  const directory = replicas.directory().doc;
  const related = readDecisions(replica.doc, directory, replica.id);
  const relatedTopics = new Set(related.map(topic => topic.topic));
  const backlinks = meta.kind === "decision" ? new Set<string>() :
    new Set(replicas.store.backlinks(uuid).map(entry => entry.uuid));
  const linked = meta.kind === "decision" ? [] : resolveDecisionTopics(directory).filter(topic =>
    !topic.archived && !relatedTopics.has(topic.topic) && topic.records.some(record => backlinks.has(record.uuid)));
  const result = {
    ...meta,
    rev: docRev(replica.doc),
    ...decisionAuthorityJson(replica),
    tags: documentTags(replica),
    room: replica.room,
    decisions: [
      ...related.map(topic => ({ ...decisionEntryJson(topic.representative, decisionTopicTitle(topic), topic.archived), ...topicJson(topic), relation: "related" })),
      ...linked.map(topic => ({ ...decisionEntryJson(topic.representative, decisionTopicTitle(topic), topic.archived), ...topicJson(topic), relation: "linked" })),
    ],
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
