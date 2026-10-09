import { toolHelpDetails } from "./help-details.js";

/** Examples and shared-contract links for the tools registered by this server. */
export interface ToolHelpEntry {
  example: Record<string, unknown>;
  details?: string;
  related: readonly string[];
}

const uuid = "11111111-1111-4111-8111-111111111111";
const targetUuid = "11111111-1111-4111-8111-111111111112";
const documentContracts = ["workspaces", "lifecycle", "tool-contracts"];
const proseContracts = [...documentContracts, "markdown"];
const dataContracts = [...documentContracts, "data"];

export const toolHelpEntries: Record<string, ToolHelpEntry> = {
  list_tags: {
    example: {},
    related: ["workspaces", "tool-contracts"],
  },
  create_doc: {
    details: toolHelpDetails.create_doc,
    example: {
      title: "Release checklist",
      description: "The steps and checks used to prepare a product release.",
      blocks: [{ type: "paragraph", text: "Review the release notes before publishing." }],
    },
    related: proseContracts,
  },
  get_doc: {
    details: toolHelpDetails.get_doc,
    example: { uuid },
    related: [...proseContracts, "data"],
  },
  get_data: {
    details: toolHelpDetails.get_data,
    example: { uuid, collection: "tasks", limit: 20 },
    related: dataContracts,
  },
  update_data: {
    example: {
      uuid,
      operations: [{
        collection: "tasks",
        schema: {
          version: 1,
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              done: { type: "boolean" },
            },
            required: ["title", "done"],
            additionalProperties: false,
          },
        },
        upsert: [{ id: "review-notes", value: { title: "Review release notes", done: false } }],
      }],
    },
    related: dataContracts,
  },
  list_docs: {
    details: toolHelpDetails.list_docs,
    example: { kind: "requirement", status: "planned" },
    related: documentContracts,
  },
  search: {
    details: toolHelpDetails.search,
    example: { query: "release checklist", limit: 10 },
    related: documentContracts,
  },
  backlinks: {
    example: { uuid },
    related: documentContracts,
  },
  find_decisions: {
    details: toolHelpDetails.find_decisions,
    example: { github_ref: "example/project#42" },
    related: documentContracts,
  },
  edit_block: {
    details: toolHelpDetails.edit_block,
    example: {
      uuid,
      block_id: "paragraph-1",
      old_text: "Review the release notes before publishing.",
      new_text: "Review and approve the release notes before publishing.",
      rev: "revision-from-get_doc",
    },
    related: proseContracts,
  },
  insert_block: {
    details: toolHelpDetails.insert_block,
    example: {
      uuid,
      after_block_id: "paragraph-1",
      type: "paragraph",
      text: "Confirm the final checks passed.",
    },
    related: proseContracts,
  },
  delete_block: {
    example: { uuid, block_id: "paragraph-1" },
    related: proseContracts,
  },
  set_tags: {
    example: { uuid, tags: ["Release"] },
    related: documentContracts,
  },
  set_links: {
    example: { uuid, links: [targetUuid] },
    related: documentContracts,
  },
  set_title: {
    example: { uuid, title: "Release preparation checklist" },
    related: documentContracts,
  },
  set_description: {
    example: {
      uuid,
      description: "The release preparation steps, checks and responsibilities for the team.",
    },
    related: documentContracts,
  },
  set_tldr: {
    example: { uuid, tldr: "Review the release notes and confirm all checks before publishing." },
    related: documentContracts,
  },
  set_status: {
    example: { uuid, status: "planned" },
    related: documentContracts,
  },
  archive_doc: {
    details: toolHelpDetails.archive_doc,
    example: { uuid },
    related: documentContracts,
  },
  restore_doc: {
    details: toolHelpDetails.restore_doc,
    example: { uuid },
    related: documentContracts,
  },
  annotate: {
    details: toolHelpDetails.annotate,
    example: {
      uuid,
      block_id: "paragraph-1",
      start: 0,
      end: 6,
      text: "Who will review the release notes?",
    },
    related: proseContracts,
  },
  link_range: {
    details: toolHelpDetails.link_range,
    example: {
      uuid,
      block_id: "paragraph-1",
      start: 11,
      end: 24,
      doc_id: targetUuid,
      rev: "revision-from-get_doc",
    },
    related: proseContracts,
  },
  export_markdown: {
    example: { uuid, frontmatter: true, annotations: "drop" },
    related: [...proseContracts, "data"],
  },
  sync_status: {
    details: toolHelpDetails.sync_status,
    example: {},
    related: ["workspaces", "tool-contracts"],
  },
  get_sidebar: {
    example: {},
    related: documentContracts,
  },
  pin_doc: {
    example: { uuid, group: "Release", index: 0 },
    related: documentContracts,
  },
  unpin_doc: {
    example: { uuid },
    related: documentContracts,
  },
  sidebar_group: {
    example: { action: "rename", group: "Release", name: "Release preparation" },
    related: documentContracts,
  },
  get_help: {
    example: { topic: "get_doc" },
    related: ["orientation", "tools", "tool-contracts"],
  },
};
