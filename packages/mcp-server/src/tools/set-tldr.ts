import { setTldr } from "@uberblick/schema";
import { strictInput } from "../inputs.js";
import { tldrArg, uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg, tldr: tldrArg });

export const setTldrOperation = documentOperation("set_tldr", inputSchema, (_context, { uuid, tldr }, _request, replica) => {
  setTldr(replica.doc, tldr);
  return { uuid, tldr, };
});
