import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDirectoryEntry } from "@uberblick/schema";
import { z } from "zod";
import { ToolError, failureContract, guarded } from "../failures.js";
import { githubReference } from "../github-reference.js";
import { strictInput } from "../inputs.js";
import type { ToolContext } from "./context.js";
import { json } from "./helpers.js";

export function registerFindDecisions(server: McpServer, context: ToolContext): void {
  const { replicas } = context;

  server.registerTool(
    "find_decisions",
    {
      title: "Find decisions linking a GitHub item",
      description:
        "Find every live decision record whose prose links one GitHub issue or pull request. " +
        "This replica-local derived index reads only external link hrefs in decision prose; display labels, " +
        "unlinked text, source blocks and non-decision documents do not contribute references. " +
        "It reflects updates this replica has observed and indexed and may lag unseen or unindexed content. " +
        "The lookup opens no decision document room and makes no GitHub API call.\n\n" +
        "Pass `github_ref` as owner/repo#n or an http(s) github.com URL with /issues/n or /pull/n. " +
        "Owner and repository case, the issue/PR path spelling, and further path, query or fragment after the " +
        "number all identify the same item. The answer returns its normalized owner/repo#n identity. " +
        "A value that identifies no single GitHub issue or pull request is refused with " +
        "`invalid_github_reference`; bare #n and other GitHub hosts are not accepted.\n\n" +
        "`decisions` contains each matching record once, with uuid, title and directory-cached status " +
        "(null where absent). Archived records are omitted. Every live matching record is returned, without " +
        "resolving a topic's current answer. Order is title ascending under SQLite binary collation, then UUID " +
        "ascending. There is no pagination or truncation; an empty array means no indexed live decision links " +
        "this item, not proof that the replica is complete." +
        failureContract("find_decisions"),
      inputSchema: strictInput({
        github_ref: z.string().describe("One GitHub issue or pull request, as owner/repo#n or its github.com URL."),
      }),
    },
    guarded("find_decisions", async ({ github_ref }) => {
      await replicas.settle();
      const reference = githubReference(github_ref);
      if (reference === null) {
        throw new ToolError(
          "invalid_github_reference",
          "github_ref must identify one GitHub issue or pull request as owner/repo#n or its github.com URL.",
          { github_ref },
        );
      }
      const directory = replicas.directory().doc;
      return json({
        github_ref: reference,
        decisions: replicas.store.decisionsForGithub(reference).map((record) => ({
          ...record,
          status: getDirectoryEntry(directory, record.uuid)?.status ?? null,
        })),
      });
    }),
  );
}
