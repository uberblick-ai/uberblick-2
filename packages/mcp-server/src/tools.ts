/**
 * Register operations through the shared adapter for result validation and
 * failure serialization. Use schema helpers for document reads and writes so
 * content stays within the web editor's supported palette.
 * Prose writes target one block and data writes validated collections; there
 * is no whole-document write or Markdown import. Permanent deletion requires archive first.
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
import { registerSetMetadata } from "./registrations/set-metadata.js";
import { registerSetStatus } from "./registrations/set-status.js";
import { registerArchiveDoc } from "./registrations/archive-doc.js";
import { registerDeleteDoc } from "./registrations/delete-doc.js";
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
  registerSetMetadata(registrar, context);
  registerSetStatus(registrar, context);
  registerArchiveDoc(registrar, context);
  registerDeleteDoc(registrar, context);
  registerRestoreDoc(registrar, context);
  registerAnnotate(registrar, context);
  registerLinkRange(registrar, context);
  registerExportMarkdown(registrar, context);
  registerSyncStatus(registrar, context);

  registerSidebarTools(registrar, context);
  registerGetHelp(registrar, context);
  return help;
}
