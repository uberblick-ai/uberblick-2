import { listDirectory, readDirectoryTags, resolveDecisionTopics } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { pinnedUuids } from "../sidebar.js";
import { resolveTagFilter } from "../tag-catalog.js";
import { documentKindArg, documentStatusArg } from "./schemas.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({
  tag: z.string().min(1).optional().describe("Only documents carrying this tag."),
  kind: documentKindArg.optional().describe("Only documents of this kind."),
  status: documentStatusArg.optional().describe("Only documents at this lifecycle state."),
  include_deleted: z.boolean().optional(),
  include_superseded: z.boolean().optional().describe("Return every decision record instead of one row per topic."),
});

export const listDocsOperation = operation("list_docs", inputSchema, (context, { tag, kind, status, include_deleted, include_superseded }, _request) => {
  const { replicas, tagCatalog, topicJson } = context;

  const hasPredicate = tag !== undefined || kind !== undefined || status !== undefined;
  const catalog = tagCatalog();
  const tagId = tag === undefined ? null : resolveTagFilter(replicas, tag);
  const directory = replicas.directory().doc;
  const entries = listDirectory(directory, { includeDeleted: true });
  const matches = (entry: DirectoryEntry): boolean => {
    const assignments = readDirectoryTags(entry, catalog);
    return (tagId === null || assignments.some((assignment) => assignment.id === tagId)) &&
      (kind === undefined || entry.kind === kind) &&
      (status === undefined || entry.status === status);
  };
  const documents = entries.filter(entry => entry.kind !== "decision" &&
    (include_deleted || !entry.deleted) && matches(entry));
  const topics = resolveDecisionTopics(entries);
  const decisionRows = !hasPredicate ? [] : include_superseded
    ? topics.filter(topic => include_deleted || !topic.archived)
      .flatMap(topic => topic.records.filter(matches).map(entry => ({ ...entry, deleted: topic.archived })))
    : topics.filter(topic => {
      if ((!include_deleted && topic.archived) || (kind !== undefined && kind !== "decision")) return false;
      const live = topic.records.filter(entry => entry.status !== "rejected" && entry.status !== "withdrawn");
      return (status === undefined || live.some(entry => entry.status === status)) &&
        (tagId === null || live.some(entry => readDirectoryTags(entry, catalog).some(assignment => assignment.id === tagId)));
    })
      .map(topic => ({ ...topic.representative, deleted: topic.archived, ...topicJson(topic) }));
  // Derived, never stored: the sidebar doc is the one place a pin lives.
  const pinned = pinnedUuids(replicas);
  return {
    workspace: replicas.config.workspaceId,
    docs: [...documents, ...decisionRows]
      .sort((a, b) => a.title < b.title ? -1 : a.title > b.title ? 1 : a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0)
      .map((entry) => ({
      ...entry,
      tags: readDirectoryTags(entry, catalog),
      // Always present, null when absent: an agent scanning this listing
      // should read one shape, not test for a missing key.
      description: entry.description ?? null,
      pinned: pinned.has(entry.uuid),
    })),
    hub: replicas.sync.state(),
  };
});
