import { createTagCatalogEntry, isTagName } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { settingsOperation } from "./operation.js";

export const inputSchema = strictInput({
  name: z.string().describe("Trimmed and lowercased before validation: at most 30 lowercase letters/digits with single hyphens between groups."),
  description: z.string().optional().describe("Guidance for LLMs on when to apply the tag: one line, at most 300 characters after trimming."),
});

export const createTagOperation = settingsOperation(inputSchema, (_context, args, _request, settings) => {
  const name = args.name.trim().toLowerCase();
  if (!isTagName(name)) throw new ToolError("invalid_tag_name", "Invalid tag name after trimming and lowercasing.");
  return createTagCatalogEntry(settings.doc, name, undefined, args.description);
});
