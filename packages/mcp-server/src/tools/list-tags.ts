import { strictInput } from "../inputs.js";
import { activeTagCatalog, tagCatalogComplete } from "../tag-catalog.js";
import { READ, operation } from "./operation.js";

export const inputSchema = strictInput({});

const LOCAL_CATALOG_HINT =
  "This local workspace's hub is not running, so tags added in Workspace settings may not have reached this " +
  "replica; `ub open` syncs them. Assign only tags listed here.";
const HUB_CATALOG_HINT =
  "The hub has not delivered the tag catalog to this replica yet, so tags may be missing; sync_status says " +
  "whether it can still arrive. Assign only tags listed here.";

export const listTagsOperation = operation(READ, inputSchema, (context, _args, _request) => {
  const { replicas, tagCatalog } = context;

  const complete = tagCatalogComplete(replicas);
  const hub = replicas.hubState();
  return {
    workspace: replicas.config.workspaceId,
    complete,
    ...(complete ? {} : { catalogHint: hub.status === "local" ? LOCAL_CATALOG_HINT : HUB_CATALOG_HINT }),
    tags: activeTagCatalog(tagCatalog()),
    hub,
  };
});
