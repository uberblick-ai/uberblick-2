import { strictInput } from "../inputs.js";
import { isDirectoryEntryDeleted } from "@uberblick/schema";
import { uuidArg } from "./schemas.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg });

export const backlinksOperation = operation("backlinks", inputSchema, (context, { uuid }, _request) => {
  const { replicas } = context;
  context.requireNotDeleted(uuid);

  return { uuid, backlinks: replicas.store.backlinks(uuid).filter(entry => !isDirectoryEntryDeleted(replicas.directory().doc, entry.uuid)) };
});
