import { MAX_DESCRIPTION_LENGTH, setChangelogSuggestion } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

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

export const inputSchema = strictInput({
  uuid: uuidArg,
  suggestion: changelogSuggestionArg,
});

export const setChangelogSuggestionOperation = documentOperation("set_changelog_suggestion", inputSchema, (_context, { uuid, suggestion }, _request, replica) => {
  setChangelogSuggestion(replica.doc, suggestion);
  return {
    uuid,
    // The answer carries the state the document now holds, in the shape
    // get_doc reads it back in: the key is absent exactly when nobody has
    // written a suggestion.
    ...(suggestion === "" ? {} : { changelogSuggestion: suggestion }),
  };
});
