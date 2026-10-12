import {
  BLOCK_TYPES,
  DECISION_STATUSES,
  DOCUMENT_KINDS,
  MAX_DESCRIPTION_LENGTH,
  MAX_TLDR_LENGTH,
  canonicalDocumentUuid,
} from "@uberblick/schema";
import { z } from "zod";

// Refuse identities that cannot resolve as document UUIDs.
export const uuidArg = z.uuid().describe("Document UUID.");

/**
 * Trim before measuring and storing; whitespace must not satisfy the minimum
 * or silence the missing-description nudge.
 */
export const descriptionArg = z
  .string({
    error:
      "create_doc requires `description`, and set_metadata accepts it: one or two sentences saying what the document " +
      "is for, so agents can judge it from list_docs and search without opening it.",
  })
  .trim()
  .min(1, "a description cannot be empty or whitespace")
  .max(
    MAX_DESCRIPTION_LENGTH,
    `a description is at most ${MAX_DESCRIPTION_LENGTH} characters — one or two sentences, not a summary`,
  )
  .describe("Agent-facing description used to choose whether to open the document.");

export const tldrArg = z
  .string({
    error:
      "A `tldr` is one or two sentences of plain English for a person, or null to clear it.",
  })
  .trim()
  .min(1, "a TL;DR cannot be empty or whitespace; pass null to clear it")
  .max(
    MAX_TLDR_LENGTH,
    `a TL;DR is at most ${MAX_TLDR_LENGTH} characters — one or two sentences`,
  )
  .nullable()
  .describe(
    `One or two sentences of plain English for a person opening the document. At most ${MAX_TLDR_LENGTH} characters; null clears it.`,
  );

export const decisionAnswerArg = z.object({
  who: z.string().trim().min(1).describe("Person who gave the answer."),
  when: z.string().trim().min(1).describe("When the person gave the answer, preferably an ISO date-time."),
  where: z.string().trim().min(1).describe("Where the answer was given, such as a conversation or review URL."),
}).strict().describe("Record a person's answer, not the agent's own approval. MCP does not verify its provenance.");

export type DecisionAnswer = z.infer<typeof decisionAnswerArg>;

/**
 * create_doc and set_metadata share one title rule: trim before measuring,
 * refuse emptiness and impose no length bound.
 */
export const titleArg = z
  .string()
  .trim()
  .min(1, "a title cannot be empty or whitespace")
  .describe("Display title. Identity is the document's UUID, never this.");

export const documentKindArg = z.enum(DOCUMENT_KINDS).describe(
  "The document's record kind. Omit it for an ordinary working document.",
);

export const documentStatusArg = z
  .enum(DECISION_STATUSES)
  .describe("The recorded lifecycle state. Its kind owns the legal values.");

const INLINE_RUNS =
  "Formatted content for a PROSE block (paragraph, heading, list-item, quote), as runs of equally-marked text: " +
  "`[{text, marks}]`, where marks are `bold`, `italic`, `strike`, `inlineCode`, `link` (an external http(s) URL) " +
  "and `docLink` (another document's UUID — the inline way to cite one). When present it REPLACES `text`, so the " +
  "run texts joined together are the block's text. Code, mermaid, terminal and chart hold source text and ignore it; " +
  "tables and cards also ignore it and read inline Markdown through `text`: exactly one GFM table or the content between :::card and :::.\n\n" +
  "A `docLink` run with an EMPTY `text` is filled in for you with the target's current title, so `{text: \"\", " +
  "marks: {docLink: \"<uuid>\"}}` is how you cite a document without looking its title up first. A target this " +
  "replica's directory has never heard of fails the call with `doclink_target_not_known_locally` and writes " +
  "nothing; an archived target is fine.";

/**
 * Match the model's isExternalHref at the input boundary, before any writes.
 */
const EXTERNAL_HREF = /^https?:\/\/\S+$/i;

/**
 * Canonicalize through the model before lookups and writes: case-sensitive
 * room keys must not split one UUID into multiple rooms.
 */
export const docLinkTargetArg = z
  .uuid("a document reference is a target document UUID, never a path or a title")
  .transform((value, ctx) => {
    const docId = canonicalDocumentUuid(value);
    if (docId === null) {
      ctx.addIssue({ code: "custom", message: "not a document UUID" });
      return z.NEVER;
    }
    return docId;
  });

export const inlineArg = z
  .array(
    z
      .object({
        text: z.string(),
        marks: z
          .object({
            bold: z.boolean().optional(),
            italic: z.boolean().optional(),
            strike: z.boolean().optional(),
            inlineCode: z.boolean().optional(),
            link: z
              .string()
              .regex(EXTERNAL_HREF, "a link is an external http(s) URL")
              .optional(),
            docLink: docLinkTargetArg.optional(),
          })
          .strict()
          // Both link marks are invalid input; rereading cannot repair the call.
          .refine(
            (marks) => marks.link === undefined || marks.docLink === undefined,
            "a run is an external link or a document reference, never both",
          ),
      })
      .strict(),
  )
  .optional()
  .describe(INLINE_RUNS);

export const blockShape = {
  type: z.enum([...BLOCK_TYPES]),
  text: z.string().optional().describe(
    "Block text. A table takes exactly one GFM table with inline Markdown cell formatting; alignment is not stored. A card takes the content between exact :::card and ::: lines: lowercase label, title, footer and optional button keys at most once, a required nonempty title, then a blank line and optional prose body. Prose header values are one-line inline Markdown, not YAML; quotes stay literal. A button is exactly [Text](destination): nonempty plain text and an https URL or claude://code/new, claude-cli://open or codex://new, alone or followed by ?query. Invalid buttons, unknown, duplicate or non-key headers refuse with invalid_card. All four prose parts support code, bold, italic, strike, external and document links. Export orders label, title, footer, button and omits empty prose keys, folds header newlines to spaces, and escapes prose lines starting :::.",
  ),
  level: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe("Heading level. Headings only."),
  language: z
    .string()
    .optional()
    .describe("Code language, e.g. \"ts\". Code blocks only."),
  inline: inlineArg,
};

// create_doc's nested seeds must refuse unknown keys as insert_block's root does.
export const blockInputSchema = z.object(blockShape).strict();
