/**
 * The v0 MCP tool set.
 *
 * Thirty tools: get_help, list_tags, create_doc, get_doc, get_data, update_data, list_docs, search,
 * backlinks, find_decisions, edit_block, insert_block, delete_block, set_tags, set_links,
 * set_title, set_description, set_tldr, set_status, set_changelog_suggestion,
 * archive_doc,
 * restore_doc, annotate, link_range,
 * export_markdown, sync_status, the four sidebar tools registered from
 * ./sidebar-tools.ts — get_sidebar, pin_doc, unpin_doc, sidebar_group. There is
 * deliberately no whole-document write — every
 * prose change names one block and data changes use validated collection operations — no markdown-import tool, because markdown
 * is an export format, and no hard delete: archive_doc tombstones the
 * directory stub and leaves every byte of the document where it was. An
 * archived document is read-only rather than gone — every mutator goes through
 * `requireWritableDoc` in ./tools/context.ts, which refuses one and names restore_doc.
 *
 * Document handlers start with `replicas.settle()`: replay the log tail (another
 * MCP instance may have written since the last call) and, on boot or after a
 * reconnect, wait briefly for the hub. Every mutating handler ends with
 * `{applied, synced}` plus the hub's state, because "applied locally" is not
 * "synced" and an agent deserves to know which one it got — and `synced` is not
 * "stored by the hub" either, which is why `SYNCED_MEANS` in ./tools/descriptions.ts says so in the
 * tool descriptions and bundled help rather than leaving the word to be read generously.
 *
 * Every registration calls its operation through ./tool-adapter.ts, which
 * validates the payload and serializes the MCP answer. ./failures.ts stamps
 * the failure floor — the error, message, write state and recovery — so throw
 * sites carry only what they know on top of it.
 *
 * All document reads and writes go through `@uberblick/schema`. That is not
 * politeness: the web editor destroys content outside its palette, and the
 * schema helpers are what keep this server inside it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GuidanceBriefing } from "./guidance.js";
import type { Replicas } from "./replica.js";
import type { ServerWork } from "./server-work.js";
import { HelpCatalog } from "./help.js";
import { createToolRegistrar } from "./help-resources.js";
import { registerSidebarTools } from "./registrations/sidebar-tools.js";
import { createToolContext } from "./tools/context.js";
import { registerListTags } from "./registrations/list-tags.js";
import { registerCreateDoc } from "./registrations/create-doc.js";
import { registerGetDoc } from "./registrations/get-doc.js";
import { registerGetData } from "./registrations/get-data.js";
import { registerUpdateData } from "./registrations/update-data.js";
import { registerListDocs } from "./registrations/list-docs.js";
import { registerSearch } from "./registrations/search.js";
import { registerBacklinks } from "./registrations/backlinks.js";
import { registerFindDecisions } from "./registrations/find-decisions.js";
import { registerEditBlock } from "./registrations/edit-block.js";
import { registerInsertBlock } from "./registrations/insert-block.js";
import { registerDeleteBlock } from "./registrations/delete-block.js";
import { registerSetTags } from "./registrations/set-tags.js";
import { registerSetLinks } from "./registrations/set-links.js";
import { registerSetTitle } from "./registrations/set-title.js";
import { registerSetDescription } from "./registrations/set-description.js";
import { registerSetTldr } from "./registrations/set-tldr.js";
import { registerSetStatus } from "./registrations/set-status.js";
import { registerSetChangelogSuggestion } from "./registrations/set-changelog-suggestion.js";
import { registerArchiveDoc } from "./registrations/archive-doc.js";
import { registerRestoreDoc } from "./registrations/restore-doc.js";
import { registerAnnotate } from "./registrations/annotate.js";
import { registerLinkRange } from "./registrations/link-range.js";
import { registerExportMarkdown } from "./registrations/export-markdown.js";
import { registerSyncStatus } from "./registrations/sync-status.js";
import { registerGetHelp } from "./registrations/get-help.js";

export function registerTools(
  server: McpServer,
  replicas: Replicas,
  briefing: GuidanceBriefing,
  work: ServerWork,
): HelpCatalog {
  const help = new HelpCatalog();
  const context = createToolContext(replicas, briefing, work, help);
  const registrar = createToolRegistrar(server, help);

  registerListTags(registrar, context);
  registerCreateDoc(registrar, context);
  registerGetDoc(registrar, context);
  registerGetData(registrar, context);
  registerUpdateData(registrar, context);
  registerListDocs(registrar, context);
  registerSearch(registrar, context);
  registerBacklinks(registrar, context);
  registerFindDecisions(registrar, context);
  registerEditBlock(registrar, context);
  registerInsertBlock(registrar, context);
  registerDeleteBlock(registrar, context);
  registerSetTags(registrar, context);
  registerSetLinks(registrar, context);
  registerSetTitle(registrar, context);
  registerSetDescription(registrar, context);
  registerSetTldr(registrar, context);
  registerSetStatus(registrar, context);
  registerSetChangelogSuggestion(registrar, context);
  registerArchiveDoc(registrar, context);
  registerRestoreDoc(registrar, context);
  registerAnnotate(registrar, context);
  registerLinkRange(registrar, context);
  registerExportMarkdown(registrar, context);
  registerSyncStatus(registrar, context);

  registerSidebarTools(registrar, context);
  registerGetHelp(registrar, context);
  return help;
}
