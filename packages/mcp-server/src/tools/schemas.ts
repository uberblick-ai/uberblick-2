import {
  BLOCK_TYPES,
  DECISION_STATUSES,
  DOCUMENT_KINDS,
  MAX_DESCRIPTION_LENGTH,
  MAX_TLDR_LENGTH,
  REQUIREMENT_STATUSES,
  canonicalDocumentUuid,
} from "@uberblick/schema";
import { z } from "zod";
import { DESCRIPTION_IS_FOR_CHOOSING } from "./descriptions.js";

// Identity is UUIDs, so the boundary checks for one. A tool that accepted any
// string would let an agent persist an identity nothing can ever resolve.
export const uuidArg = z.uuid().describe("Document UUID.");

/**
 * `trim` before the length checks, and the order is the point: it makes both
 * bounds measure the description rather than the whitespace around it. Without
 * it `"   "` is a legal description — it would pass `min(1)`, be stored in the
 * document and the stub, and silence the very nudge that exists to get a real
 * one written. The parsed value is the trimmed one, so what is stored is what
 * was checked.
 */
export const descriptionArg = z
  .string({
    error:
      "create_doc and set_description require a `description`: one or two sentences saying what the document " +
      "is for, so agents can judge it from list_docs and search without opening it.",
  })
  .trim()
  .min(1, "a description cannot be empty or whitespace")
  .max(
    MAX_DESCRIPTION_LENGTH,
    `a description is at most ${MAX_DESCRIPTION_LENGTH} characters — one or two sentences, not a summary`,
  )
  .describe(DESCRIPTION_IS_FOR_CHOOSING);

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
 * A title, trimmed before it is measured — the same discipline
 * {@link descriptionArg} has, and for the same reason: `"   "` would otherwise
 * be a legal title, stored in the document, cached in the stub, and answered
 * with by every discovery surface. Length is not bounded, because nothing
 * bounds a title anywhere else; emptiness is the only thing that makes a
 * document unfindable in a listing.
 *
 * `create_doc` and `set_title` share it so the MCP surface has one rule for
 * titles: neither tool can put a document into a state the other refuses to
 * leave it in.
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
  .enum([...REQUIREMENT_STATUSES, ...DECISION_STATUSES])
  .describe("The recorded lifecycle state. Its kind owns the legal values.");

/** What `inline` is for, in the words an agent reads. */
const INLINE_RUNS =
  "Formatted content for a PROSE block (paragraph, heading, list-item, quote), as runs of equally-marked text: " +
  "`[{text, marks}]`, where marks are `bold`, `italic`, `strike`, `inlineCode`, `link` (an external http(s) URL) " +
  "and `docLink` (another document's UUID — the inline way to cite one). When present it REPLACES `text`, so the " +
  "run texts joined together are the block's text. Code, mermaid, terminal and chart hold source text and ignore it; " +
  "tables also ignore it and take exactly one GFM table through `text`.\n\n" +
  "A `docLink` run with an EMPTY `text` is filled in for you with the target's current title, so `{text: \"\", " +
  "marks: {docLink: \"<uuid>\"}}` is how you cite a document without looking its title up first. A target this " +
  "replica's directory has never heard of fails the call with `doclink_target_not_known_locally` and writes " +
  "nothing; an archived target is fine.";

/**
 * `link`'s boundary check, kept identical to the schema's `isExternalHref`.
 *
 * At the input boundary rather than in the handler on purpose: a target the
 * model refuses is a wrong argument, and the MCP layer rejects those before a
 * handler runs and therefore before anything durable could change.
 */
const EXTERNAL_HREF = /^https?:\/\/\S+$/i;

/**
 * A document reference's target, canonicalised at the boundary.
 *
 * One document has one spelling. An upper-cased uuid names the same document —
 * room names are case-sensitive keys, so `A…` and `a…` would be two rooms
 * holding one document — and the schema canonicalises it down at the write. Do
 * it here instead, once, so the directory lookup, the label, the write and the
 * answer all speak the id the model stores rather than the one the caller
 * happened to type. The refusal branch is `z.uuid`'s leftovers: this is the
 * model's own rule, not a second one.
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
          // Refused as the wrong argument it is, not as a range conflict: one
          // run carrying both link marks has no honest rendering, and there is
          // nothing to re-read that would make the call valid.
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
    "Block text. For a table, exactly one GFM table with inline markdown cell formatting (code, bold, italic, strike, external and document links). Alignment markers are accepted but not stored; escaped punctuation stays literal.",
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

// Strict, like the sibling placement object: `create_doc`'s guarantee has to
// reach inside the array, or a block carrying a key the schema never declared
// is created with the key discarded. `insert_block` spreads the same shape at
// its top level, where strictInput already applies the rule.
export const blockInputSchema = z.object(blockShape).strict();
