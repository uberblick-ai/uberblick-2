import { DECISION_STATUSES, InvalidDocumentLifecycleError, appendBlock, assignDocumentTags, canonicalDocumentUuid, decisionAnswerFailure, decisionAnswerShapeFailure, decisionDirectoryFields, getDirectoryEntry, getMeta, getMetaMap, initDoc, isDocumentStatusForKind, setDiscussion, setKind, setStatus, setTldr, upsertDirectoryEntry } from "@uberblick/schema";
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
import { operation } from "./operation.js";
import type { ToolContext } from "./context.js";
import { discussionTarget } from "./discussion.js";

const DECISION_GUIDANCE =
  "A decision title names the stable topic or question, never the answer; successors keep the title. " +
  "For decision answers, see lifecycle's Decision answers and topics section. " +
  "Answer blocks are distinct from recorded answer: {who, when, where}.";

const CREATE_DOC_LIFECYCLE_MODES: readonly ToolMode[] = [
  {
    title: `A decision document (\`kind: decision\`). ${DECISION_GUIDANCE}`,
    when: { field: "kind", is: "decision" },
  },
  {
    title: "An ordinary document",
    when: { field: "kind", present: false },
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
    title: titleArg.describe(`Display title. Identity is the document's UUID, never this. ${DECISION_GUIDANCE}`),
    description: descriptionArg,
    tldr: tldrArg.optional(),
    answer: decisionAnswerArg.optional(),
    tags: z.array(z.string().min(1)).optional(),
    kind: documentKindArg.optional(),
    status: documentStatusArg.optional(),
    related: uuidArg
      .optional()
      .describe(
        "Live, locally readable regular document UUID this decision relates to. Fixed at creation; omitted successors inherit their predecessor's page. Accepted only with `kind: decision`.",
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
);

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

export const createDocOperation = operation("create_doc", inputSchema, (context, {
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
  const { replicas, requireWritableDoc, tagCatalog, recordAnswer, documentTags, decisionAuthorityJson, blocksJson, durabilityAcross, tldrReview } = context;

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

  const relatedPage =
    related === undefined ? null : requireWritableDoc(related);
  if (relatedPage !== null && getMeta(relatedPage.doc, relatedPage.id).kind === "decision") {
    throw new ToolError(
      "related_not_regular_document",
      `Document ${related} is a decision record, so it cannot be the related page`,
      { related, kind: "decision" },
    );
  }

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

  // Refuse invalid tags before allocating an identity or writing any room.
  const tagIds = resolveTagSelectors(replicas, tags ?? []);

  // Refuse unknown groups before independently persisted room stages begin.
  const group =
    sidebar === undefined
      ? null
      : requireGroup(replicas, sidebar.group.id);

  const inputs = initialBlocks(context, { blocks, tldr, answer }, lifecycle, superseded !== null);
  const governs = relatedPage === null ? (superseded === null ? undefined : getMeta(superseded.doc, superseded.id).governs) : relatedPage.id;

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
        title,
        description,
        ...(governs === undefined ? {} : { governs }),
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
      title,
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
    title,
    description,
    tags: documentTags(replica),
    ...(lifecycle === null ? {} : lifecycle),
    ...(governs === undefined ? {} : { governs }),
    ...(lifecycle?.kind === "decision" ? { topic: getMeta(replica.doc, replica.id).topic, discussion: getMeta(replica.doc, replica.id).discussion } : {}),
    ...(supersedesUuid === null ? {} : { supersedes: supersedesUuid }),
    ...(tldr === undefined ? {} : { tldr: getMeta(replica.doc, replica.id).tldr }),
    ...decisionAuthorityJson(replica),
    blocks: blocksJson(replica),
    ...(placement === null ? {} : { sidebar: placement }),
    ...durabilityAcross(replica, completed),
    ...(inputs.length === 0 || lifecycle?.status === "decided" ? {} : tldrReview(replica)),
  };
});
