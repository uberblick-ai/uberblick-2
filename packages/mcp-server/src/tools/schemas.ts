import {
  BLOCK_TYPES,
  DECISION_STATUSES,
  DOCUMENT_KINDS,
  EXTERNAL_HREF,
  LIST_STYLES,
  MAX_DESCRIPTION_LENGTH,
  MAX_LIST_INDENT,
  MAX_TLDR_LENGTH,
  canonicalDocumentUuid,
} from "@uberblick/schema";
import { z } from "zod";

// Refuse identities that cannot resolve as document UUIDs.
export const uuidArg = z.uuid().transform((value, ctx) => {
  const uuid = canonicalDocumentUuid(value);
  if (uuid === null) {
    ctx.addIssue({ code: "custom", message: "not a document UUID" });
    return z.NEVER;
  }
  return uuid;
}).describe("Document UUID.");

export const revisionArg = z.string().min(1).max(256)
  .describe("Hub revision ID from list_revisions for this document; distinct from get_doc's page and block rev hashes.");

/**
 * Trim before measuring and storing; whitespace must not satisfy the minimum
 * or silence the missing-description nudge.
 */
export const descriptionArg = z
  .string({
    error:
      "create_doc requires `description`, and set_metadata accepts it: read only by agents, it is whatever best helps an " +
      "agent find the document with list_docs and search and decide whether to open it. A keyword list is fine.",
  })
  .trim()
  .min(1, "a description cannot be empty or whitespace")
  .max(
    MAX_DESCRIPTION_LENGTH,
    `a description is at most ${MAX_DESCRIPTION_LENGTH} characters — keep the terms that best help an agent find it`,
  )
  .describe("Read only by agents, never shown to people: whatever best helps an agent find this document with list_docs and search and decide whether to open it. A keyword list is fine.");

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
    `One or two sentences of plain English for a person opening a regular document. At most ${MAX_TLDR_LENGTH} characters; null clears it. Decisions have no TL;DR.`,
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
  "run texts joined together are the block's text. Code, terminal and chart hold source text and ignore it; " +
  "tables, cards and figma also ignore it and read inline Markdown through `text`: exactly one GFM table or the content between :::card/:::figma and :::.\n\n" +
  "A `docLink` run with an EMPTY `text` is filled in for you with the target's current title, so `{text: \"\", " +
  "marks: {docLink: \"<uuid>\"}}` is how you cite a document without looking its title up first. A target this " +
  "replica's directory has never heard of fails the call with `doclink_target_not_known_locally` and writes " +
  "nothing; an archived target is fine.";

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

export const listStyleArg = z.enum(LIST_STYLES);
export const listIndentArg = z.number().int().min(0).max(MAX_LIST_INDENT);

export const blockShape = {
  type: z.enum([...BLOCK_TYPES]),
  text: z.string().optional().describe(
    "Block text. Prose blocks take plain text; use `inline` for formatting. Code, terminal and chart take " +
      "literal source. A table takes exactly one GFM table with inline Markdown in its cells. A card or figma " +
      "block takes the content between its opening `:::card` or `:::figma` line and the closing `:::`; " +
      "markdown help gives their keys, buttons and accepted links, and invalid content refuses with " +
      "invalid_card or invalid_figma before writing.",
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
    .describe("Code language, e.g. \"ts\". Code blocks only. Drawings are code blocks too, with language \"ablauf\" or \"wireframe\"."),
  list: listStyleArg.optional().describe("List style. List items only; omitted means bullet."),
  indent: listIndentArg.optional().describe("List depth, an integer from 0 to 3. List items only; omitted means 0."),
  inline: inlineArg,
};

// Document seeds and inserted entries share the same strict shape.
export const blockInputSchema = z.object(blockShape).strict();
