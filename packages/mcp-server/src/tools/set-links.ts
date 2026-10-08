import { setLinks } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

const linkArg = z
  .uuid("a link is a target document UUID, never a path or a title")
  .describe("Target document UUID.");

export const inputSchema = strictInput({ uuid: uuidArg, links: z.array(linkArg) });

export const setLinksOperation = documentOperation("set_links", inputSchema, (_context, { uuid, links }, _request, replica) => {
  setLinks(replica.doc, links);
  return { uuid, links, };
});
