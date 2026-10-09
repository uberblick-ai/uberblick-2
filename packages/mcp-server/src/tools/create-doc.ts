import { DECISION_STATUSES, InvalidDocumentLifecycleError, REQUIREMENT_STATUSES, appendBlock, assignDocumentTags, canonicalDocumentUuid, decisionDirectoryFields, getDirectoryEntry, getMeta, getMetaMap, initDoc, isDocumentStatusForKind, setKind, setStatus, setTldr, upsertDirectoryEntry } from "@uberblick/schema";
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

const CREATE_DOC_LIFECYCLE_MODES: readonly ToolMode[] = [
  {
    title: "A decision document (`kind: decision`)",
    when: { field: "kind", is: "decision" },
  },
  {
    title: "A requirement document (`kind: requirement`)",
    when: { field: "kind", is: "requirement" },
    forbids: ["governs", "supersedes", "answer"],
  },
  {
    title: "An ordinary document",
    when: { field: "kind", present: false },
    forbids: ["status", "governs", "supersedes", "answer"],
  },
];

function firstStatus(kind: DocumentKind): DocumentStatus {
  return kind === "requirement"
    ? REQUIREMENT_STATUSES[0]
    : DECISION_STATUSES[0];
}

/**
 * Where a new document goes in the sidebar — optional, and the whole of it.
 *
 * Placement implies pinning, so there is no `pinned` boolean and no `state`
 * enum: a contradictory pair like `{pinned: false, group: …}` is not a state
 * this input can express. Both objects are `.strict()`, so a caller reaching
 * for either is told rather than having it silently dropped — and the group is
 * an object with an id rather than a bare name, because creating a group is
 * pin_doc's job and must not happen as a side effect of creating a document.
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

// `{sidebar: {...}, pinned: true}` must be refused wherever the redundant
// key sits, so the nested placement object is strict too — see
// {@link sidebarPlacementArg}. The top level is strict like every tool's.
export const inputSchema = strictInput(
  {
    title: titleArg,
    description: descriptionArg,
    tldr: tldrArg.optional(),
    answer: decisionAnswerArg.optional(),
    tags: z.array(z.string().min(1)).optional(),
    kind: documentKindArg.optional(),
    status: documentStatusArg.optional(),
    governs: uuidArg
      .optional()
      .describe(
        "Requirement UUID this decision governs, stored on the decision. Accepted only with `kind: decision`.",
      ),
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

export const createDocOperation = operation("create_doc", inputSchema, (context, {
      title,
      description,
      tldr,
      answer,
      tags,
      kind,
      status,
      governs,
      supersedes,
      blocks,
      sidebar,
    }, _request) => {
  const { replicas, requireWritableDoc, blockInputFor, tagCatalog, recordAnswer, documentTags, decisionAuthorityJson, blocksJson, durabilityAcross, tldrReview } = context;

  const lifecycle =
    kind === undefined ? null : { kind, status: status ?? firstStatus(kind) };
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

  const requirement =
    governs === undefined ? null : requireWritableDoc(governs);
  const requirementKind =
    requirement === null ? null : (getMeta(requirement.doc).kind ?? null);
  if (requirement !== null && requirementKind !== "requirement") {
    throw new ToolError(
      "governs_not_requirement",
      `Document ${governs} is not a requirement, so this decision cannot govern it`,
      { governs, kind: requirementKind },
    );
  }

  const supersedesUuid =
    supersedes === undefined
      ? null
      : canonicalDocumentUuid(supersedes);
  const superseded =
    supersedesUuid === null ? null : requireWritableDoc(supersedesUuid);
  const supersededKind =
    superseded === null ? null : (getMeta(superseded.doc).kind ?? null);
  if (superseded !== null && supersededKind !== "decision") {
    throw new ToolError(
      "supersedes_not_decision",
      `Document ${supersedesUuid} is not a decision, so a new decision cannot supersede it`,
      { supersedes: supersedesUuid, kind: supersededKind },
    );
  }

  // Before allocating a document uuid: an invalid tag selection is an
  // all-or-nothing refusal, not the first stage of a partial create.
  const tagIds = resolveTagSelectors(replicas, tags ?? []);

  // Resolved before a uuid exists, because this is the one part of the call
  // that can still be all-or-nothing: an unknown group must fail having
  // created nothing. Everything after it is three independently persisted
  // rooms, reported one by one.
  const group =
    sidebar === undefined
      ? null
      : requireGroup(replicas, sidebar.group.id);

  // Same reason, same place: an inline reference to a target this replica
  // does not know refuses the whole call before there is a document.
  const inputs = (blocks ?? []).map(blockInputFor);

  if (lifecycle?.kind === "decision") {
    if (lifecycle.status !== "open" && lifecycle.status !== "decided") {
      throw new ToolError("decision_transition_invalid", "Create a decision as open or decided; reject or withdraw an existing proposal.", lifecycle);
    }
    if (answer !== undefined && lifecycle.status !== "decided") {
      throw new ToolError("decision_transition_invalid", "An answer at creation approves a decided decision record.", lifecycle);
    }
    if (lifecycle.status === "decided" && superseded !== null && answer === undefined) {
      throw new ToolError("decision_answer_required", "Deciding a successor requires recording a person's answer (who, when, where). Nothing was created.", lifecycle);
    }
  }

  const uuid = randomUUID();
  const replica = replicas.replica(uuid);
  // The one write that opens its room directly instead of through
  // `requireWritableDoc`, and it is working in the document like any other.
  replicas.touch(replica);
  const directory = replicas.directory();
  const sidebarReplica = replicas.sidebar();

  /** Which of this call's rooms a failed append names. */
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
    // One transaction, so the document's room is ONE append: without it the
    // metadata and each initial block are separate updates, and a refusal
    // on the third block would leave the first two — and the directory stub
    // the observer repaired from them — durable, under an error that says
    // nothing survived. The stage boundary this call reports is only true
    // if the write underneath it is atomic in the log.
    replica.doc.transact(() => {
      initDoc(replica.doc, {
        uuid,
        title,
        description,
        ...(governs === undefined ? {} : { governs }),
        ...(lifecycle?.kind === "decision"
          ? { topic: superseded === null ? uuid : (getMeta(superseded.doc).topic ?? getMeta(superseded.doc).uuid) }
          : {}),
        ...(supersedesUuid === null ? {} : { supersedes: supersedesUuid }),
      });
      // The same schema-owned catalog boundary set_tags uses. Validation
      // already ran before identity allocation; this writes the canonical
      // assignment representation inside the document's one update.
      assignDocumentTags(replica.doc, tagCatalog(), tagIds);
      if (lifecycle !== null) {
        setKind(replica.doc, lifecycle.kind);
        setStatus(replica.doc, lifecycle.status);
      }
      if (tldr !== undefined) setTldr(replica.doc, tldr);
      for (const input of inputs) {
        appendBlock(replica.doc, input);
      }
      if (lifecycle?.kind === "decision" && lifecycle.status === "decided") {
        if (answer === undefined) getMetaMap(replica.doc).set("agentStance", true);
        else recordAnswer(replica, answer);
      }
    });
  });

  // Observing the document's own update repairs the stub, but a brand-new
  // document must be discoverable because create_doc said so, not because
  // a side effect happened to fire.
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
      // The same pin operation pin_doc runs — see placeInGroup. A brand-new
      // uuid is pinned rather than moved, so it can only appear once.
      try {
        const { position } = placeInGroup(
          replicas,
          group.id,
          uuid,
          sidebar.group.position,
        );
        placement = { group: { id: group.id, name: group.name }, position };
      } catch (error) {
        // A concurrent sidebar_group delete, landing between the lookup at
        // the top of this call and this write. pin_doc answers that with
        // its own `group_not_found` and nothing else to say; here the
        // document and its stub are already durable, so the caller has to
        // hear that before it retries a create it does not need.
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
    ...(lifecycle?.kind === "decision" ? { topic: getMeta(replica.doc).topic } : {}),
    ...(supersedesUuid === null ? {} : { supersedes: supersedesUuid }),
    ...(tldr === undefined ? {} : { tldr: getMeta(replica.doc).tldr }),
    ...decisionAuthorityJson(replica),
    blocks: blocksJson(replica),
    ...(placement === null ? {} : { sidebar: placement }),
    ...durabilityAcross(replica, completed),
    ...(inputs.length === 0 || lifecycle?.status === "decided" ? {} : tldrReview(replica)),
  };
});
