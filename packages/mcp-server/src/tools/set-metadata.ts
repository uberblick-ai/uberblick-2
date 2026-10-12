import {
  assignDocumentTags,
  getMeta,
  getMetaMap,
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
import { documentOperation } from "./operation.js";
import { descriptionArg, titleArg, tldrArg, uuidArg } from "./schemas.js";
import { discussionTarget } from "./discussion.js";

const fields = ["title", "description", "tldr", "tags", "links", "discussion"] as const;
const linkArg = z
  .uuid("a link is a target document UUID, never a path or a title")
  .describe("Target document UUID.");

export const inputSchema = strictInput({
  uuid: uuidArg,
  title: titleArg.optional(),
  description: descriptionArg.optional(),
  tldr: tldrArg.optional(),
  tags: z.array(z.string().min(1)).optional(),
  links: z.array(linkArg).optional(),
  discussion: uuidArg.nullable().optional().describe("RFC discussion document UUID, or null to clear. Only an open decision record accepts changes; the target must be live, locally readable and not a decision. Distinct from curated links and the recorded answer; no document is created or tagged."),
})
  .superRefine((args, ctx) => {
    if (fields.every((field) => args[field] === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "set_metadata needs at least one of `title`, `description`, `tldr`, `tags`, `links` or `discussion`",
      });
    }
  })
  .meta({ anyOf: fields.map((field) => ({ required: [field] })) });

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

export const setMetadataOperation = documentOperation("set_metadata", inputSchema, (context, args, _request, replica) => {
  const { uuid, title, description, tldr, tags, links, discussion } = args;
  const current = getMeta(replica.doc);
  if (discussion !== undefined && (current.kind !== "decision" || current.status !== "open")) {
    const code = current.kind === "decision" && current.status === "decided" ? "decision_read_only" : "discussion_not_writable";
    throw new ToolError(code, "Only an open decision record's discussion reference can change; settled references remain in history.", {
      uuid, kind: current.kind ?? null, status: current.status ?? null, field: "discussion",
    });
  }
  const discussionUuid = discussion === undefined || discussion === null ? discussion :
    forField("discussion", () => discussionTarget(context, discussion));
  // The document-level gate already ran; title and legacy TL;DR also request
  // the decided-record content lock.
  const contentField = title !== undefined ? "title" : tldr !== undefined ? "tldr" : undefined;
  if (contentField !== undefined) {
    forField(contentField, () => context.requireWritableDoc(uuid, true));
  }
  if (current.kind === "decision" && tldr !== undefined && tldr !== null) {
    throw new ToolError("decision_tldr_unsupported", "Decision records hold their answer in content blocks and cannot have a TL;DR.", { uuid, field: "tldr" });
  }
  const tagIds = tags === undefined ? undefined : forField("tags", () =>
    resolveTagSelectors(context.replicas, tags));
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
  replica.doc.transact(() => {
    if (tagIds !== undefined) assignDocumentTags(replica.doc, context.tagCatalog(), tagIds);
    if (title !== undefined) setTitle(replica.doc, title);
    if (description !== undefined) setDescription(replica.doc, description);
    if (tldr !== undefined) setTldr(replica.doc, tldr);
    if (links !== undefined) setLinks(replica.doc, links);
    if (discussionUuid !== undefined) setDiscussion(replica.doc, discussionUuid);
  });
  const meta = getMeta(replica.doc);
  return {
    uuid,
    title: meta.title,
    description: meta.description,
    tldr: meta.tldr,
    tags: context.documentTags(replica),
    links: meta.links,
    ...(meta.kind === "decision" ? { discussion: meta.discussion } : {}),
  };
});
