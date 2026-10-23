import { compareDirectoryEntries, decisionTopicTitle, listDirectory, readDirectoryTags, resolveDecisionTopics } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { pinnedUuids } from "../sidebar.js";
import { resolveTagFilter } from "../tag-catalog.js";
import { documentKindArg, documentStatusArg } from "./schemas.js";
import type { TopicRowEntry } from "./context.js";
import { READ, operation } from "./operation.js";

export const inputSchema = strictInput({
  tag: z.string().min(1).optional().describe("Only documents carrying this tag."),
  kind: documentKindArg.optional().describe("Only documents of this kind."),
  status: documentStatusArg.optional().describe("Only documents at this lifecycle state."),
  has_open_threads: z.literal(true).optional().describe("Only documents with a known positive openThreadCount; topic rows match any live record. False refuses."),
  include_deleted: z.boolean().optional().describe("Include archived documents. Permanently deleted UUIDs are always excluded."),
  include_superseded: z.boolean().optional().describe("Return every decision record instead of one row per topic."),
});

const DIRECTORY_HINT =
  "The hub has not delivered the document directory to this replica yet, so documents may be missing; " +
  "sync_status says whether it can still arrive.";

export const listDocsOperation = operation(READ, inputSchema, (context, { tag, kind, status, has_open_threads, include_deleted, include_superseded }, _request) => {
  const { replicas, tagCatalog, topicRow, directoryRowJson } = context;

  const hasPredicate = tag !== undefined || kind !== undefined || status !== undefined || has_open_threads === true;
  const catalog = tagCatalog();
  const tagId = tag === undefined ? null : resolveTagFilter(replicas, tag);
  const directory = replicas.directory().doc;
  const entries = listDirectory(directory, { includeDeleted: true });
  const matches = (entry: DirectoryEntry): boolean => {
    const assignments = readDirectoryTags(entry, catalog);
    return (tagId === null || assignments.some((assignment) => assignment.id === tagId)) &&
      (kind === undefined || entry.kind === kind) &&
      (status === undefined || entry.status === status) &&
      (has_open_threads !== true || (entry.openThreadCount ?? 0) > 0);
  };
  const documents = entries.filter(entry => entry.kind !== "decision" &&
    (include_deleted || !entry.deleted) && matches(entry));
  const topics = resolveDecisionTopics(entries);
  const decisionRows = !hasPredicate ? [] : include_superseded
    ? topics.filter(topic => include_deleted || !topic.archived)
      .flatMap(topic => (include_deleted ? topic.allRecords : topic.records)
        .filter(matches).map(entry => ({ ...entry, title: decisionTopicTitle(topic), deleted: topic.archived || entry.recordArchived === true })))
    : topics.filter(topic => {
      if ((!include_deleted && topic.archived) || (kind !== undefined && kind !== "decision")) return false;
      const live = topic.records.filter(entry => entry.status !== "rejected" && entry.status !== "withdrawn");
      return (status === undefined || live.some(entry => entry.status === status)) &&
        (tagId === null || live.some(entry => readDirectoryTags(entry, catalog).some(assignment => assignment.id === tagId))) &&
        (has_open_threads !== true || live.some(entry => (entry.openThreadCount ?? 0) > 0));
    })
      .map(topicRow);
  // Derived, never stored: the sidebar doc is the one place a pin lives.
  const pinned = pinnedUuids(replicas);
  const complete = replicas.roomComplete(replicas.directory().room);
  return {
    workspace: replicas.config.workspaceId,
    complete,
    ...(complete ? {} : { directoryHint: DIRECTORY_HINT }),
    docs: [...documents, ...decisionRows]
      .sort(compareDirectoryEntries)
      .map((entry: TopicRowEntry) => directoryRowJson(entry, pinned.has(entry.uuid))),
    hub: replicas.hubState(),
  };
});
