import { DECISION_STATUSES, InvalidDocumentLifecycleError, appendBlock, assignDocumentTags, canonicalDocumentUuid, decisionAnswerFailure, decisionAnswerShapeFailure, decisionDirectoryFields, getBlocks, getDirectoryEntry, getMeta, getMetaMap, initDoc, isDocumentStatusForKind, setDiscussion, setKind, setStatus, setTldr, upsertDirectoryEntry } from "@uberblick/schema";
import type { DocumentKind, DocumentStatus } from "@uberblick/schema";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolMode } from "../inputs.js";
import { placeInGroup, requireGroup } from "../sidebar.js";
import type { SidebarPlacement } from "../sidebar.js";
import { resolveTagSelectors } from "../tag-catalog.js";
import { roomStages, stoppedPartWay } from "./helpers.js";
import { blockInputSchema, decisionAnswerArg, descriptionArg, documentKindArg, documentStatusArg, titleArg, tldrArg, uuidArg } from "./schemas.js";
import { DOCUMENT_WRITE, operation } from "./operation.js";
import type { ToolContext } from "./context.js";
import { discussionTarget } from "./discussion.js";

const CREATE_DOC_LIFECYCLE_MODES: readonly ToolMode[] = [
  {
    title: "A decision document (`kind: decision`). Decisions help covers topics, titles and answers.",
    when: { field: "kind", is: "decision" },
  },
  {
    title: "An ordinary document",
    when: { field: "kind", present: false },
    requires: ["title"],
    forbids: ["status", "related", "supersedes", "answer", "discussion"],
  },
];

/**
 * Placement implies pinning and names an existing group ID. Document creation
 * must not create groups or accept contradictory pin/state fields.
 */
const sidebarPlacementArg = z
  .object({
    group: z
      .object({
        id: z
          .string()
          .min(1)
          .describe(
            "An EXISTING group's id, as get_sidebar returns it. Never a name: an unknown id fails the call.",
          ),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Position in the group, clamped into range. Omitted means last."),
      })
      .strict(),
  })
  .strict()
  .optional()
  .describe(
    "Optional sidebar placement. Omitted, the document is created unpinned — alive and reachable, simply not an " +
      "entry point.",
  );

const RECOVERY: Record<string, string> & { other: string } = {
  document:
    "Nothing survived: the refused write is the document's own room, and neither the directory stub nor the " +
    "sidebar was touched. Restart the MCP server — the failure is sticky and every tool refuses until then — " +
    "then call create_doc again.",
  directory:
    "The document's own room is durable, but it has no directory stub, so list_docs and search will not show it. " +
    "Restart the MCP server, then get_doc with this uuid: hydrating the document republishes its stub. Add " +
    "pin_doc afterwards if you wanted the sidebar placement.",
  sidebar:
    "The document and its directory stub are durable; only the sidebar placement is missing. Restart the MCP " +
    "server, then pin_doc with this uuid and the same group id to finish it.",
  other:
    "The log refused a write to a room this call does not own — another document syncing while it ran. Restart " +
    "the MCP server, then check with list_docs — for a decision, with a matching `kind`, `status` or `tag` " +
    "predicate — and get_sidebar what the rooms in `completed` left behind.",
};

// Refuse unknown keys at the root and throughout nested placement objects.
export const inputSchema = strictInput(
  {
    title: titleArg.optional().describe(
      "Display title; identity is the document's UUID, never this. Required except on a decision successor. " +
        "A decision topic has one title, stored on its first record and naming the question rather than the " +
        "answer; a successor omits title or repeats that exact title.",
    ),
    description: descriptionArg,
    tldr: tldrArg.optional(),
    answer: decisionAnswerArg.optional(),
    tags: z.array(z.string().min(1)).optional().describe(
      "Existing catalog tag ids or names, case ignored. An unknown or deleted tag refuses before anything is created.",
    ),
    kind: documentKindArg.optional(),
    status: documentStatusArg.optional(),
    related: z.union([uuidArg, z.array(uuidArg).min(1)])
      .optional()
      .describe(
        "One live, locally readable regular document UUID or a non-empty list of them. The related set is fixed at creation. Omitted successors inherit their predecessor's whole set; supplying related replaces it. Accepted only with `kind: decision`.",
      ),
    discussion: uuidArg
      .optional()
      .describe("Live, locally readable regular document UUID holding this record's RFC discussion. Accepted only with `kind: decision`; never inherited. Correct or clear with set_metadata only while open; fixed after leaving open. Does not create or tag a document."),
    supersedes: uuidArg
      .optional()
      .describe(
        "Earlier decision UUID this new decision replaces. Immutable and accepted only with `kind: decision`.",
      ),
    blocks: z
      .array(blockInputSchema)
      .optional()
      .describe("Initial blocks, in order."),
    sidebar: sidebarPlacementArg,
  },
  CREATE_DOC_LIFECYCLE_MODES,
).superRefine((args, ctx) => {
  if (args.kind === "decision" && args.supersedes === undefined && args.title === undefined) {
    ctx.addIssue({ code: "custom", path: ["title"], message: "A topic's first record needs `title`" });
  }
}).meta({
  dependencies: { kind: { anyOf: [{ required: ["title"] }, { required: ["supersedes"] }] } },
});

function initialBlocks(
  context: ToolContext,
  { blocks, tldr, answer }: Pick<z.infer<typeof inputSchema>, "blocks" | "tldr" | "answer">,
  lifecycle: { kind: DocumentKind; status: DocumentStatus } | null,
  hasPredecessor: boolean,
) {
  if (lifecycle?.kind === "decision") {
    if (lifecycle.status !== "open" && lifecycle.status !== "decided") {
      throw new ToolError("decision_transition_invalid", "Create a decision as open or decided; reject or withdraw an existing proposal.", lifecycle);
    }
    if (answer !== undefined && lifecycle.status !== "decided") {
      throw new ToolError("decision_transition_invalid", "An answer at creation approves a decided decision record.", lifecycle);
    }
    if (lifecycle.status === "decided" && hasPredecessor && answer === undefined) {
      throw new ToolError("decision_answer_required", "Deciding a successor requires recording a person's answer (who, when, where). Nothing was created.", lifecycle);
    }
    if (tldr !== undefined && tldr !== null) {
      throw new ToolError("decision_tldr_unsupported", "Decision records hold their answer in content blocks and cannot have a TL;DR.", lifecycle);
    }
    const failure = decisionAnswerShapeFailure(blocks ?? []);
    if (failure !== null) throw new ToolError(failure, "Decision answers use at most three paragraphs, code blocks, tables or lists.", lifecycle);
  }
  // Resolve all seed targets before creating a document.
  const inputs = (blocks ?? []).map(context.blockInputFor);
  if (lifecycle?.kind === "decision" && lifecycle.status === "decided") {
    const failure = decisionAnswerFailure(inputs, tldr === undefined ? {} : { tldr });
    if (failure !== null) throw new ToolError(failure, "A decided record needs a non-empty answer in one to three supported content blocks.", lifecycle);
  }
  return inputs;
}

export const createDocOperation = operation(DOCUMENT_WRITE, inputSchema, (context, {
      title,
      description,
      tldr,
      answer,
      tags,
      kind,
      status,
      related,
      discussion,
      supersedes,
      blocks,
      sidebar,
    }, _request) => {
  const { replicas, requireWritableDoc, tagCatalog, recordAnswer, documentTags, decisionAuthorityJson, durabilityAcross, tldrReview } = context;

  const lifecycle =
    kind === undefined ? null : { kind, status: status ?? DECISION_STATUSES[0] };
  if (
    lifecycle !== null &&
    !isDocumentStatusForKind(lifecycle.kind, lifecycle.status)
  ) {
    const error = new InvalidDocumentLifecycleError(
      lifecycle.kind,
      lifecycle.status,
    );
    throw new ToolError("invalid_document_lifecycle", error.message, {
      kind: lifecycle.kind,
      status: lifecycle.status,
      recoveryClass: "manual",
      recovery:
        `Choose a status in the ${lifecycle.kind} lifecycle and call create_doc again. ` +
        "Nothing was created by this refused call.",
    });
  }

  const relatedPages = related === undefined ? undefined :
    [...new Set(typeof related === "string" ? [related] : related)].map(uuid => {
      const page = requireWritableDoc(uuid);
      if (getMeta(page.doc, page.id).kind === "decision") {
        throw new ToolError(
          "related_not_regular_document",
          `Document ${uuid} is a decision record, so it cannot be a related page`,
          { related: uuid, kind: "decision" },
        );
      }
      return page.id;
    });

  const discussionUuid = discussion === undefined ? null : discussionTarget(context, discussion);

  const supersedesUuid =
    supersedes === undefined
      ? null
      : canonicalDocumentUuid(supersedes);
  const superseded =
    supersedesUuid === null ? null : requireWritableDoc(supersedesUuid);
  const supersededKind =
    superseded === null ? null : (getMeta(superseded.doc, superseded.id).kind ?? null);
  if (superseded !== null && supersededKind !== "decision") {
    throw new ToolError(
      "supersedes_not_decision",
      `Document ${supersedesUuid} is not a decision, so a new decision cannot supersede it`,
      { supersedes: supersedesUuid, kind: supersededKind },
    );
  }
  const inheritedTitle = superseded === null ? undefined : context.titleFor(superseded.id, context.requireStub(superseded.id));
  if (inheritedTitle !== undefined && title !== undefined && title !== inheritedTitle) {
    throw new ToolError("decision_title_mismatch", "A successor takes its topic's title; omit title or supply the topic's current title. Nothing was created.", {
      field: "title", supersedes: supersedesUuid, title: inheritedTitle,
    });
  }
  const documentTitle = inheritedTitle ?? title;
  if (documentTitle === undefined) throw new Error("Validated create_doc title is missing");

  // Refuse invalid tags before allocating an identity or writing any room.
  const tagIds = resolveTagSelectors(replicas, tags ?? []);

  // Refuse unknown groups before independently persisted room stages begin.
  const group =
    sidebar === undefined
      ? null
      : requireGroup(replicas, sidebar.group.id);

  const inputs = initialBlocks(context, { blocks, tldr, answer }, lifecycle, superseded !== null);
  const relatedSet = relatedPages ?? (superseded === null ? undefined : getMeta(superseded.doc, superseded.id).related);

  const uuid = randomUUID();
  const replica = replicas.replica(uuid);
  // Creation bypasses requireWritableDoc, so announce document activity here.
  replicas.touch(replica);
  const directory = replicas.directory();
  const sidebarReplica = replicas.sidebar();

  const purposeOf = (room: string): string => {
    if (room === replica.room) return "document";
    if (room === directory.room) return "directory";
    if (room === sidebarReplica.room) return "sidebar";
    return "other";
  };

  const { completed, stage } = roomStages(
    replicas,
    "create_doc",
    uuid,
    purposeOf,
    (_purpose, failedAt) => RECOVERY[failedAt] ?? RECOVERY.other,
  );

  stage("document", replica, () => {
    // Keep metadata and seeds in one logged update; a later seed append must
    // not fail after earlier blocks survived under a "nothing survived" refusal.
    replica.doc.transact(() => {
      initDoc(replica.doc, {
        uuid,
        title: documentTitle,
        description,
        ...(relatedSet === undefined ? {} : { related: relatedSet }),
        ...(lifecycle?.kind === "decision"
          ? { topic: superseded === null ? uuid : (getMeta(superseded.doc, superseded.id).topic ?? superseded.id) }
          : {}),
        ...(supersedesUuid === null ? {} : { supersedes: supersedesUuid }),
      });
      // Store validated canonical tags inside the document's single update.
      assignDocumentTags(replica.doc, tagCatalog(), tagIds);
      if (lifecycle !== null) {
        setKind(replica.doc, lifecycle.kind);
        setStatus(replica.doc, lifecycle.status);
      }
      if (tldr !== undefined) setTldr(replica.doc, tldr);
      if (discussionUuid !== null) setDiscussion(replica.doc, discussionUuid);
      for (const input of inputs) {
        appendBlock(replica.doc, input);
      }
      if (lifecycle?.kind === "decision" && lifecycle.status === "decided") {
        if (answer === undefined) getMetaMap(replica.doc).set("agentStance", true);
        else recordAnswer(replica, answer);
      }
    });
  });

  // Guarantee discoverability even if the document observer did not publish a stub.
  stage("directory", directory, () => {
    if (getDirectoryEntry(directory.doc, uuid) !== null) return;
    const now = Date.now();
    upsertDirectoryEntry(directory.doc, {
      uuid,
      title: documentTitle,
      description,
      ...(tags === undefined ? {} : { tags: tagIds }),
      ...(lifecycle === null ? {} : lifecycle),
      ...decisionDirectoryFields(replica.doc),
      createdAt: now,
      updatedAt: now,
    });
  });

  let placement: SidebarPlacement | null = null;
  if (group !== null && sidebar !== undefined) {
    stage("sidebar", sidebarReplica, () => {
      // Share pin_doc's placement primitive so the new UUID appears only once.
      try {
        const { position } = placeInGroup(
          replicas,
          group.id,
          uuid,
          sidebar.group.position,
        );
        placement = { group: { id: group.id, name: group.name }, position };
      } catch (error) {
        // A concurrent group deletion leaves the document and stub durable;
        // report partial success so the caller does not create a duplicate.
        if (
          !(error instanceof ToolError) ||
          error.code !== "group_not_found"
        ) {
          throw error;
        }
        throw stoppedPartWay({
          code: "group_not_found",
          message:
            `Document ${uuid} was created, but sidebar group ${group.id} disappeared before it ` +
            "could be pinned there. Nothing was rolled back: the document and its directory " +
            "stub are durable, and only the placement is missing.",
          uuid,
          completed,
          failed: { purpose: "sidebar", room: sidebarReplica.room },
          recovery:
            `The document exists — do NOT create it again. Call pin_doc with uuid ${uuid} and a ` +
            "group that exists (get_sidebar lists them; pin_doc creates one by name).",
          extra: { group: group.id },
        });
      }
    });
  }

  return {
    uuid,
    room: replica.room,
    title: documentTitle,
    description,
    tags: documentTags(replica),
    ...(lifecycle === null ? {} : lifecycle),
    ...(relatedSet === undefined ? {} : { related: relatedSet }),
    ...(lifecycle?.kind === "decision" ? { topic: getMeta(replica.doc, replica.id).topic, discussion: getMeta(replica.doc, replica.id).discussion } : {}),
    ...(supersedesUuid === null ? {} : { supersedes: supersedesUuid }),
    ...(tldr === undefined ? {} : { tldr: getMeta(replica.doc, replica.id).tldr }),
    ...decisionAuthorityJson(replica),
    blocks: getBlocks(replica.doc).map(({ id, rev }) => ({ id, rev })),
    ...(placement === null ? {} : { sidebar: placement }),
    ...durabilityAcross(replica, completed),
    // A TL;DR written with the content needs no review prompt.
    ...(inputs.length === 0 || tldr !== undefined || lifecycle?.status === "decided" ? {} : tldrReview(replica)),
  };
});
