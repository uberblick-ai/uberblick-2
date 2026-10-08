import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MAX_DESCRIPTION_LENGTH, setChangelogSuggestion } from "@uberblick/schema";
import { z } from "zod";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "./context.js";
import { ARCHIVED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "./descriptions.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

/**
 * What a changelog suggestion is, and how its three states are asked for.
 *
 * The same trim-then-measure discipline descriptionArg in ./schemas.ts has, and the
 * same ceiling: document metadata has one length to remember. The field is
 * required, so each state is a value rather than an absence — omitting it would
 * be a fourth, unstated answer.
 */
const changelogSuggestionArg = z
  .string({
    error:
      "set_changelog_suggestion requires a `suggestion`: the sentence, null for a change that deliberately " +
      "needs no user-facing entry, or the empty string to take back whatever is stored.",
  })
  .trim()
  .max(
    MAX_DESCRIPTION_LENGTH,
    `a changelog suggestion is at most ${MAX_DESCRIPTION_LENGTH} characters — one sentence of release-note copy`,
  )
  .nullable()
  .describe(
    "One sentence of draft release-note copy in simple English, about what a user can now do rather than how it " +
      "was built. `null` records that this work deliberately needs no user-facing entry; the empty string — or " +
      "only whitespace, which trims to it — takes back whatever is stored, leaving the document as one nobody " +
      "has written a suggestion for. " +
      `At most ${MAX_DESCRIPTION_LENGTH} characters.`,
  );

export function registerSetChangelogSuggestion(server: McpServer, context: ToolContext): void {
  const { toolContract, replicas, briefing, requireWritableDoc, durability } = context;

  server.registerTool(
    "set_changelog_suggestion",
    {
      title: "Set a document's changelog suggestion",
      description:
        "Record one sentence of draft release-note copy for the work this document describes — what a reader of a " +
        "changelog would want to know, in simple English about the user-visible outcome. Write it when delivered " +
        "work makes you update the document; nothing generates, publishes or asks for one, and nothing renders it " +
        "yet.\n\n" +
        "It is document metadata beside the description, not prose in the document: writing it leaves the title, " +
        "description, tags, links, kind and status exactly where they were, and get_doc answers with it as " +
        "`changelogSuggestion`.\n\n" +
        "Three states, and they are different answers. No `changelogSuggestion` at all means nobody has written " +
        "one. `null` means this work deliberately needs no user-facing entry — say it, so an internal-only change " +
        "does not read as unfinished. A non-empty string is the suggestion itself. The empty string — or any " +
        "string that is only whitespace, since the argument is trimmed first — is not a fourth state: it takes " +
        "the stored value back to the first one.\n\n" +
        "That clear is the one answer whose concurrency guarantee is weaker, and it is local: it takes back only " +
        "the value this replica has already seen, so a concurrent `null` or sentence from another writer outlives " +
        "it and the field converges on theirs. Writing `null` or a sentence competes normally — concurrent " +
        "writers converge on one of the two. If a clear must stick, read the document back with get_doc.\n\n" +
        "The directory stub does not cache it and the search index does not carry it, so list_docs and search " +
        "neither answer with it nor match on it.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("set_changelog_suggestion"),
      outputSchema: outputSchemas.set_changelog_suggestion,
      inputSchema: strictInput({
        uuid: uuidArg,
        suggestion: changelogSuggestionArg,
      }),
    },
    guarded("set_changelog_suggestion", async ({ uuid, suggestion }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid);
      setChangelogSuggestion(replica.doc, suggestion);
      return json({
        uuid,
        // The answer carries the state the document now holds, in the shape
        // get_doc reads it back in: the key is absent exactly when nobody has
        // written a suggestion.
        ...(suggestion === "" ? {} : { changelogSuggestion: suggestion }),
        ...durability(replica),
      });
    }),
  );
}
