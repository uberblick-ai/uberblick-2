import { exportMarkdown } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  frontmatter: z
    .boolean()
    .optional()
    .describe(
      "Emit a YAML frontmatter block with uuid, title, tags and — when present — description, kind and " +
        "status. The lifecycle fields record state; they do not authorize execution. Default true.",
    ),
  annotations: z
    .enum(["html-comments", "drop"])
    .optional()
    .describe("How to render annotation threads. Default drop."),
});

export const exportMarkdownOperation = operation("export_markdown", inputSchema, (context, { uuid, frontmatter, annotations }, _request) => {
  const { replicas, requireDoc, tagCatalog } = context;

  const replica = requireDoc(uuid);
  return {
    uuid,
    markdown: exportMarkdown(replica.doc, {
      tagCatalog: tagCatalog(),
      directory: replicas.directory().doc,
      ...(frontmatter === undefined ? {} : { frontmatter }),
      ...(annotations === undefined ? {} : { annotations }),
    }),
  };
});
