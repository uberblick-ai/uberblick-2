import { strictInput } from "../inputs.js";
import { getDirectoryEntry, isDirectoryEntryArchived, isDirectoryEntryDeleted, resolveDecisionTopics } from "@uberblick/schema";
import { uuidArg } from "./schemas.js";
import { READ, operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg });

export const backlinksOperation = operation(READ, inputSchema, (context, { uuid }, _request) => {
  const { replicas, titleFor } = context;
  context.requireNotDeleted(uuid);

  const directory = replicas.directory().doc;
  const topics = new Map(resolveDecisionTopics(directory).map(topic => [topic.topic, topic]));
  return { uuid, backlinks: replicas.store.backlinks(uuid).filter(entry =>
    !isDirectoryEntryDeleted(directory, entry.uuid) && !isDirectoryEntryArchived(directory, entry.uuid)).map(entry => {
    const stub = getDirectoryEntry(directory, entry.uuid);
    return { ...entry, title: stub === null ? entry.title : titleFor(entry.uuid, stub, topics) };
  }) };
});
