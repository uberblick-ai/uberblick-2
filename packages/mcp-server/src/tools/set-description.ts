import { setDescription } from "@uberblick/schema";
import { strictInput } from "../inputs.js";
import { descriptionArg, uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg, description: descriptionArg });

export const setDescriptionOperation = documentOperation("set_description", inputSchema, (_context, { uuid, description }, _request, replica) => {
  setDescription(replica.doc, description);
  return { uuid, description, };
});
