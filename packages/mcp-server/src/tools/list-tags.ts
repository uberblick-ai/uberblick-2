import { strictInput } from "../inputs.js";
import { activeTagCatalog, tagCatalogComplete } from "../tag-catalog.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({});

export const listTagsOperation = operation("list_tags", inputSchema, (context, _args, _request) => {
  const { replicas, tagCatalog } = context;

  return {
    workspace: replicas.config.workspaceId,
    complete: tagCatalogComplete(replicas),
    tags: activeTagCatalog(tagCatalog()).map(({ id, name }) => ({ id, name })),
    hub: replicas.sync.state(),
  };
});
