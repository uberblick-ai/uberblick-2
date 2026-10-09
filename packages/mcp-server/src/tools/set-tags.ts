import { assignDocumentTags } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { resolveTagSelectors } from "../tag-catalog.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg, tags: z.array(z.string().min(1)) });

export const setTagsOperation = documentOperation("set_tags", inputSchema, (context, { uuid, tags }, _request, replica) => {
  const { replicas, documentTags, tagCatalog } = context;

  const tagIds = resolveTagSelectors(
    replicas,
    tags,
    documentTags(replica),
  );
  assignDocumentTags(replica.doc, tagCatalog(), tagIds);
  return { uuid, tags: documentTags(replica), };
});
