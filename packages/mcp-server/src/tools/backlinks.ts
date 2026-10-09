import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg });

export const backlinksOperation = operation("backlinks", inputSchema, (context, { uuid }, _request) => {
  const { replicas } = context;

  return { uuid, backlinks: replicas.store.backlinks(uuid) };
});
