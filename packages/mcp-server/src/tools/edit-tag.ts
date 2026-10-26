import { getTagCatalogEntry, setTagCatalogDescription } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { settingsOperation } from "./operation.js";

export const inputSchema = strictInput({
  id: z.string().describe("Existing catalog tag id from list_tags; aliases resolve to the canonical entry."),
  description: z.string().nullable().describe("Guidance for LLMs on when to apply the tag: one line, at most 300 characters after trimming; null or blank clears it."),
});

export const editTagOperation = settingsOperation(inputSchema, (_context, args, _request, settings) => {
  if (getTagCatalogEntry(settings.doc, args.id) === null) {
    throw new ToolError("invalid_tag_identity", "Unknown or deleted catalog tag id.", { id: args.id });
  }
  setTagCatalogDescription(settings.doc, args.id, args.description);
  const entry = getTagCatalogEntry(settings.doc, args.id);
  if (entry === null) throw new Error("Edited tag missing from the catalog.");
  return entry;
});
