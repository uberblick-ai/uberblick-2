import { getDirectoryEntry, githubReference, isDirectoryEntryArchived, isDirectoryEntryDeleted, resolveDecisionTopics } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({
  github_ref: z.string().describe("One GitHub issue or pull request, as owner/repo#n or its github.com URL."),
});

export const findDecisionsOperation = operation("find_decisions", inputSchema, (context, { github_ref }, _request) => {
  const { replicas, titleFor } = context;

  const reference = githubReference(github_ref);
  if (reference === null) {
    throw new ToolError(
      "invalid_github_reference",
      "github_ref must identify one GitHub issue or pull request as owner/repo#n or its github.com URL.",
      { github_ref },
    );
  }
  const directory = replicas.directory().doc;
  const topics = new Map(resolveDecisionTopics(directory).map(topic => [topic.topic, topic]));
  return {
    github_ref: reference,
    decisions: replicas.store.decisionsForGithub(reference).filter(record =>
      !isDirectoryEntryDeleted(directory, record.uuid) && !isDirectoryEntryArchived(directory, record.uuid)).map((record) => {
      const stub = getDirectoryEntry(directory, record.uuid);
      return { ...record, title: stub === null ? record.title : titleFor(record.uuid, stub, topics), status: stub?.status ?? null };
    }),
  };
});
