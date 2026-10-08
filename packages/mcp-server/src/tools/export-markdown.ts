import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exportMarkdown } from "@uberblick/schema";
import { z } from "zod";
import { failureContract, guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolContext } from "./context.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

export function registerExportMarkdown(server: McpServer, context: ToolContext): void {
  const { replicas, requireDoc, tagCatalog } = context;

  server.registerTool(
    "export_markdown",
    {
      title: "Export a document as markdown",
      description:
        "Render the document as markdown, including fenced code, mermaid and terminal blocks. Tables export as " +
        "GFM padded to their widest row, with cell formatting as inline markdown and literal cell punctuation escaped. " +
        "Export only: markdown is never the storage format, and there is no import tool." +
        failureContract("export_markdown"),
      inputSchema: strictInput({
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
      }),
    },
    guarded("export_markdown", async ({ uuid, frontmatter, annotations }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      return json({
        uuid,
        markdown: exportMarkdown(replica.doc, {
          tagCatalog: tagCatalog(),
          directory: replicas.directory().doc,
          ...(frontmatter === undefined ? {} : { frontmatter }),
          ...(annotations === undefined ? {} : { annotations }),
        }),
      });
    }),
  );
}
