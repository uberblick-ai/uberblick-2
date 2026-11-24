import { listDirectory } from "@uberblick/schema";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { isoTimestamp } from "../timestamps.js";
import { READ, operation } from "./operation.js";
import { memoryAgentArg, memoryRepositoryArg, normalizedMemoryScope } from "./schemas.js";

export const inputSchema = strictInput({
  agent: memoryAgentArg.optional().describe("The lowercase agent name to include, together with memories naming no agent. Omit to leave agents unfiltered."),
  repository: memoryRepositoryArg.optional().describe("The owner/name repository to include, together with memories naming no repository. Case is ignored. Omit to leave repositories unfiltered."),
});

export const getMemoriesOperation = operation(READ, inputSchema, (context, { agent, repository }, _request) => {
  const name = agent === undefined ? undefined : normalizedMemoryScope("agent", agent);
  if (name === "") {
    throw new ToolError("invalid_memory_agent", "agent must name a lowercase agent without leading or trailing whitespace; omit it to leave agents unfiltered.", { agent });
  }
  const repo = repository === undefined ? undefined : normalizedMemoryScope("repository", repository);
  if (repo === "") {
    throw new ToolError("invalid_memory_repository", "repository must name one repository as owner/name; omit it to leave repositories unfiltered.", { repository });
  }

  const { replicas } = context;
  const directory = replicas.directory();
  const complete = replicas.roomComplete(directory.room);
  return {
    workspace: replicas.config.workspaceId,
    complete,
    ...(complete ? {} : {
      directoryHint: "The hub has not delivered the document directory to this replica yet, so memories may be missing; " +
        "sync_status says whether it can still arrive.",
    }),
    memories: listDirectory(directory.doc)
      .filter(entry => entry.kind === "memory" &&
        (name === undefined || entry.agent === undefined || entry.agent === name) &&
        (repo === undefined || entry.repository === undefined || entry.repository === repo))
      .map(entry => {
        const updatedAt = isoTimestamp(entry.updatedAt);
        return {
          uuid: entry.uuid,
          title: entry.title,
          description: entry.description ?? null,
          ...(entry.agent === undefined ? {} : { agent: entry.agent }),
          ...(entry.repository === undefined ? {} : { repository: entry.repository }),
          ...(updatedAt === undefined ? {} : { updatedAt }),
        };
      }),
    hub: replicas.hubState(),
  };
});
