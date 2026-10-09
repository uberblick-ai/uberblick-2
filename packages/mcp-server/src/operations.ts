import { annotateOperation } from "./tools/annotate.js";
import { archiveDocOperation } from "./tools/archive-doc.js";
import { backlinksOperation } from "./tools/backlinks.js";
import { createDocOperation } from "./tools/create-doc.js";
import { deleteBlockOperation } from "./tools/delete-block.js";
import { editBlockOperation } from "./tools/edit-block.js";
import { exportMarkdownOperation } from "./tools/export-markdown.js";
import { findDecisionsOperation } from "./tools/find-decisions.js";
import { getDataOperation } from "./tools/get-data.js";
import { getDocOperation } from "./tools/get-doc.js";
import { getHelpOperation } from "./tools/get-help.js";
import { insertBlockOperation } from "./tools/insert-block.js";
import { linkRangeOperation } from "./tools/link-range.js";
import { listDocsOperation } from "./tools/list-docs.js";
import { listTagsOperation } from "./tools/list-tags.js";
import { restoreDocOperation } from "./tools/restore-doc.js";
import { searchOperation } from "./tools/search.js";
import { setChangelogSuggestionOperation } from "./tools/set-changelog-suggestion.js";
import { setDescriptionOperation } from "./tools/set-description.js";
import { setLinksOperation } from "./tools/set-links.js";
import { setStatusOperation } from "./tools/set-status.js";
import { setTagsOperation } from "./tools/set-tags.js";
import { setTitleOperation } from "./tools/set-title.js";
import { setTldrOperation } from "./tools/set-tldr.js";
import { syncStatusOperation } from "./tools/sync-status.js";
import { updateDataOperation } from "./tools/update-data.js";
import { getSidebarOperation, pinDocOperation, unpinDocOperation, sidebarGroupOperation } from "./sidebar-tools.js";

/** SDK-free entry points; no CLI exports or new transports. */
export const operations = {
  get_help: getHelpOperation,
  annotate: annotateOperation,
  archive_doc: archiveDocOperation,
  backlinks: backlinksOperation,
  create_doc: createDocOperation,
  delete_block: deleteBlockOperation,
  edit_block: editBlockOperation,
  export_markdown: exportMarkdownOperation,
  find_decisions: findDecisionsOperation,
  get_data: getDataOperation,
  get_doc: getDocOperation,
  insert_block: insertBlockOperation,
  link_range: linkRangeOperation,
  list_docs: listDocsOperation,
  list_tags: listTagsOperation,
  restore_doc: restoreDocOperation,
  search: searchOperation,
  set_changelog_suggestion: setChangelogSuggestionOperation,
  set_description: setDescriptionOperation,
  set_links: setLinksOperation,
  set_status: setStatusOperation,
  set_tags: setTagsOperation,
  set_title: setTitleOperation,
  set_tldr: setTldrOperation,
  sync_status: syncStatusOperation,
  update_data: updateDataOperation,
  get_sidebar: getSidebarOperation,
  pin_doc: pinDocOperation,
  unpin_doc: unpinDocOperation,
  sidebar_group: sidebarGroupOperation,
};
