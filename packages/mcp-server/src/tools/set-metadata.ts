import {
  MAX_TLDR_LENGTH,
  CODE_CHECK_RESULTS,
  assignDocumentTags,
  getMeta,
  getMetaMap,
  normalizeCodeCheck,
  setCodeCheck,
  setDescription,
  setDiscussion,
  setLinks,
  setTitle,
  setTldr,
} from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { resolveTagSelectors } from "../tag-catalog.js";
import { operation } from "./operation.js";
import { roomStages } from "./helpers.js";
import { descriptionArg, docLinkTargetArg, titleArg, tldrArg, uuidArg } from "./schemas.js";
import { discussionTarget } from "./discussion.js";

const fields = ["title", "description", "tldr", "tags", "links", "discussion", "code_check"] as const;
const linkArg = docLinkTargetArg.describe("Target document UUID.");

// Keep malformed entries intact for the shared validator so every refusal
// carries field: code_check instead of the SDK's plain-text schema error.
const codeCheckArg = z.unknown().meta({
  type: "object",
  properties: {
    repository: { type: "string", description: "Repository as owner/name; identity ignores letter case." },
    commit: { type: "string", description: "Full 40- or 64-character hexadecimal commit id." },
    result: { type: "string", enum: CODE_CHECK_RESULTS, description: "matches: page describes this code; ahead: intended behavior is missing; drift: unintended disagreement." },
  },
  required: ["repository", "commit", "result"],
  additionalProperties: false,
});

export const inputSchema = strictInput({
  uuid: uuidArg,
  title: titleArg.optional().describe("Display title. A decision topic has one title stored on its first record; title on any live record renames the topic without changing answer approval. Successors take the topic's title."),
  description: descriptionArg.optional(),
  tldr: tldrArg.optional().describe(`Person-facing regular-document summary, at most ${MAX_TLDR_LENGTH} characters. Null clears it without changing a deliberate removal mark. On a marked page, a non-null summary requires tldr_opt_in: true. Decisions have no TL;DR; open records accept null.`),
  tldr_opt_in: z.boolean().optional().describe("Pass true with a non-null tldr to lift a person's deliberate TL;DR removal. Requires a non-null tldr; false does not lift the mark."),
  tags: z.array(z.string().min(1)).optional(),
  links: z.array(linkArg).optional(),
  discussion: uuidArg.nullable().optional().describe("RFC discussion document UUID, or null to clear. Only an open decision record accepts changes; the target must be live, locally readable and not a decision. Distinct from curated links and the recorded answer; no document is created or tagged."),
  code_check: codeCheckArg.optional().describe("Record a regular page's latest comparison for one repository, replacing only that repository's entry. The writer sets checked_at to current UTC; callers do not supply it. Content edits leave checks unchanged."),
})
  .superRefine((args, ctx) => {
    if (fields.every((field) => args[field] === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "set_metadata needs at least one of `title`, `description`, `tldr`, `tags`, `links`, `discussion` or `code_check`",
      });
    }
    if (args.tldr_opt_in !== undefined && (args.tldr === undefined || args.tldr === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["tldr_opt_in"],
        message: "tldr_opt_in requires a non-null `tldr` in the same call",
      });
    }
  })
  .meta({
    anyOf: fields.map((field) => ({ required: [field] })),
    dependencies: {
      tldr_opt_in: { required: ["tldr"], properties: { tldr: { type: "string", minLength: 1 } } },
    },
  });

/** Add field context only to field refusals, retaining their existing details. */
function forField<T>(field: typeof fields[number], validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof ToolError && (
      error.code === "decision_read_only" ||
      error.code === "invalid_tag_assignment" ||
      error.code === "doclink_target_not_known_locally" ||
      error.code === "discussion_not_regular_document" ||
      error.code === "doc_archived" ||
      error.code === "doc_not_found" ||
      error.code === "doc_not_hydrated"
    )) {
      throw new ToolError(error.code, error.message, { ...error.detail, field });
    }
    throw error;
  }
}

export const setMetadataOperation = operation("set_metadata", inputSchema, (context, args, _request) => {
  const { uuid, title, description, tldr, tldr_opt_in, tags, links, discussion, code_check } = args;
  const replica = context.requireWritableDoc(uuid);
  const current = getMeta(replica.doc, replica.id);
  // The addressed record's gate checks the topic archive. The first answer's
  // individual archive does not lock the shared topic title.
  const titleReplica = title === undefined || current.kind !== "decision" ? replica :
    forField("title", () => context.requireDoc(current.topic ?? uuid));
  const codeCheck = code_check === undefined ? undefined : normalizeCodeCheck(code_check);
  if (codeCheck === null) {
    throw new ToolError("invalid_code_check", "A code check needs a repository, full hexadecimal commit and matches, ahead or drift result; checked_at is assigned by this replica.", { uuid, field: "code_check" });
  }
  if (codeCheck !== undefined && current.kind === "decision") {
    throw new ToolError("decision_code_check_unsupported", "Code checks describe regular pages' comparison with code and cannot be written to decision records.", {
      uuid, kind: current.kind, status: current.status ?? null, field: "code_check",
    });
  }
  if (discussion !== undefined && (current.kind !== "decision" || current.status !== "open")) {
    const code = current.kind === "decision" && current.status === "decided" ? "decision_read_only" : "discussion_not_writable";
    throw new ToolError(code, "Only an open decision record's discussion reference can change; settled references remain in history.", {
      uuid, kind: current.kind ?? null, status: current.status ?? null, field: "discussion",
    });
  }
  const discussionUuid = discussion === undefined || discussion === null ? discussion :
    forField("discussion", () => discussionTarget(context, discussion));
  // The document-level gate already ran; only tldr requests the
  // decided-record content lock. Titles name the topic rather than its answer.
  if (tldr !== undefined) {
    forField("tldr", () => context.requireWritableDoc(uuid, true));
  }
  if (current.kind === "decision" && tldr !== undefined && tldr !== null) {
    throw new ToolError("decision_tldr_unsupported", "Decision records hold their answer in content blocks and cannot have a TL;DR.", { uuid, field: "tldr" });
  }
  if (current.tldrOptOut === true && tldr !== undefined && tldr !== null && tldr_opt_in !== true) {
    throw new ToolError("tldr_opted_out", "A person removed this page's TL;DR on purpose.", { uuid, field: "tldr" });
  }
  const tagIds = tags === undefined ? undefined : forField("tags", () =>
    resolveTagSelectors(context.replicas, tags, context.documentTags(replica)));
  if (links !== undefined) {
    // getMeta also adds decision-derived edges; only the stored curated set
    // can preserve an unknown target without creating a new curated reference.
    const stored = getMetaMap(replica.doc).get("links");
    const existing = new Set<string>(Array.isArray(stored) ? stored : []);
    forField("links", () => {
      for (const target of links) {
        if (!existing.has(target)) context.linkTitle(target);
      }
    });
  }

  // No validation awaits or writes separate these checks from the transaction.
  // Tag assignment revalidates before its own first write, so it runs first;
  // the remaining setters accept the already-parsed values without refusals.
  const writeMetadata = () => replica.doc.transact(() => {
    if (tagIds !== undefined) assignDocumentTags(replica.doc, context.tagCatalog(), tagIds);
    if (title !== undefined && titleReplica === replica) setTitle(replica.doc, title);
    if (description !== undefined) setDescription(replica.doc, description);
    if (tldr !== undefined) setTldr(replica.doc, tldr);
    if (links !== undefined) setLinks(replica.doc, links);
    if (discussionUuid !== undefined) setDiscussion(replica.doc, discussionUuid);
    if (codeCheck !== undefined) setCodeCheck(replica.doc, codeCheck);
  });
  let durability: Record<string, unknown>;
  if (titleReplica === replica) {
    writeMetadata();
    durability = context.durability(replica);
  } else {
    const directory = context.replicas.directory();
    const { completed, stage } = roomStages(
      context.replicas, "set_metadata", uuid,
      room => room === replica.room ? "document" : room === titleReplica.room ? "topic" : room === directory.room ? "directory" : "other",
      () => "Restart the MCP server, then re-read the addressed record and its topic with get_doc before repeating set_metadata. Completed rooms are durable; no writes were rolled back.",
    );
    if (fields.some(field => field !== "title" && args[field] !== undefined)) stage("document", replica, writeMetadata);
    if (title !== undefined) stage("topic", titleReplica, () => setTitle(titleReplica.doc, title));
    stage("directory", directory, () => {});
    durability = context.durabilityAcross(replica, completed);
  }
  const meta = getMeta(replica.doc, replica.id);
  return {
    uuid,
    title: context.titleFor(uuid, context.requireStub(uuid)),
    description: meta.description,
    tldr: meta.tldr,
    tags: context.documentTags(replica),
    links: meta.links,
    ...(meta.kind === "decision" ? { discussion: meta.discussion } : {}),
    ...(meta.kind === "decision" ? {} : { code_check: meta.code_check }),
    ...durability,
  };
});
