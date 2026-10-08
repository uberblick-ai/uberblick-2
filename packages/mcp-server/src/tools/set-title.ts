import { setTitle } from "@uberblick/schema";
import { strictInput } from "../inputs.js";
import { titleArg, uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg, title: titleArg });

export const setTitleOperation = documentOperation("set_title", inputSchema, (_context, { uuid, title }, _request, replica) => {
  setTitle(replica.doc, title);
  return { uuid, title, };
});
