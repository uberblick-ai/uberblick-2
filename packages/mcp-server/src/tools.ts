/**
 * The v0 MCP tool set.
 *
 * Twenty-nine tools and no more: list_tags, create_doc, get_doc, get_data, update_data, list_docs, search,
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
 * tool descriptions rather than leaving the word to be read generously.
 *
 * Every handler is wrapped by `guarded` from ./failures.ts, which owns the
 * other half of that honesty: what a call answers with when it fails. The
 * failure floor — the `error` code, the `message`, what happened to the write
 * and how to recover — is stamped there rather than restated at each throw
 * site, so the tool modules' throw sites carry only what they know on top of it.
 *
 * All document reads and writes go through `@uberblick/schema`. That is not
 * politeness: the web editor destroys content outside its palette, and the
 * schema helpers are what keep this server inside it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GuidanceBriefing } from "./guidance.js";
import type { Replicas } from "./replica.js";
import { registerSidebarTools } from "./sidebar-tools.js";
import { createToolContext } from "./tools/context.js";
import { json } from "./tools/helpers.js";
import { registerListTags } from "./tools/list-tags.js";
import { registerCreateDoc } from "./tools/create-doc.js";
import { registerGetDoc } from "./tools/get-doc.js";
import { registerGetData } from "./tools/get-data.js";
import { registerUpdateData } from "./tools/update-data.js";
import { registerListDocs } from "./tools/list-docs.js";
import { registerSearch } from "./tools/search.js";
import { registerBacklinks } from "./tools/backlinks.js";
import { registerFindDecisions } from "./tools/find-decisions.js";
import { registerEditBlock } from "./tools/edit-block.js";
import { registerInsertBlock } from "./tools/insert-block.js";
import { registerDeleteBlock } from "./tools/delete-block.js";
import { registerSetTags } from "./tools/set-tags.js";
import { registerSetLinks } from "./tools/set-links.js";
import { registerSetTitle } from "./tools/set-title.js";
import { registerSetDescription } from "./tools/set-description.js";
import { registerSetTldr } from "./tools/set-tldr.js";
import { registerSetStatus } from "./tools/set-status.js";
import { registerSetChangelogSuggestion } from "./tools/set-changelog-suggestion.js";
import { registerArchiveDoc } from "./tools/archive-doc.js";
import { registerRestoreDoc } from "./tools/restore-doc.js";
import { registerAnnotate } from "./tools/annotate.js";
import { registerLinkRange } from "./tools/link-range.js";
import { registerExportMarkdown } from "./tools/export-markdown.js";
import { registerSyncStatus } from "./tools/sync-status.js";

export function registerTools(
  server: McpServer,
  replicas: Replicas,
  briefing: GuidanceBriefing,
): void {
  const context = createToolContext(replicas, briefing);

  registerListTags(server, context);
  registerCreateDoc(server, context);
  registerGetDoc(server, context);
  registerGetData(server, context);
  registerUpdateData(server, context);
  registerListDocs(server, context);
  registerSearch(server, context);
  registerBacklinks(server, context);
  registerFindDecisions(server, context);
  registerEditBlock(server, context);
  registerInsertBlock(server, context);
  registerDeleteBlock(server, context);
  registerSetTags(server, context);
  registerSetLinks(server, context);
  registerSetTitle(server, context);
  registerSetDescription(server, context);
  registerSetTldr(server, context);
  registerSetStatus(server, context);
  registerSetChangelogSuggestion(server, context);
  registerArchiveDoc(server, context);
  registerRestoreDoc(server, context);
  registerAnnotate(server, context);
  registerLinkRange(server, context);
  registerExportMarkdown(server, context);
  registerSyncStatus(server, context);

  registerSidebarTools(server, replicas, {
    requireStub: context.requireStub,
    durability: context.durability,
    json,
  });
}
