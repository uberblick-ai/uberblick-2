import { inputSchema as annotate } from "../src/tools/annotate.js";
import { inputSchema as archive_doc } from "../src/tools/archive-doc.js";
import { inputSchema as backlinks } from "../src/tools/backlinks.js";
import { inputSchema as create_doc } from "../src/tools/create-doc.js";
import { inputSchema as delete_block } from "../src/tools/delete-block.js";
import { inputSchema as delete_doc } from "../src/tools/delete-doc.js";
import { inputSchema as edit_block } from "../src/tools/edit-block.js";
import { inputSchema as export_markdown } from "../src/tools/export-markdown.js";
import { inputSchema as find_decisions } from "../src/tools/find-decisions.js";
import { inputSchema as get_data } from "../src/tools/get-data.js";
import { inputSchema as get_doc } from "../src/tools/get-doc.js";
import { inputSchema as get_help } from "../src/tools/get-help.js";
import { inputSchema as insert_block } from "../src/tools/insert-block.js";
import { inputSchema as link_range } from "../src/tools/link-range.js";
import { inputSchema as list_docs } from "../src/tools/list-docs.js";
import { inputSchema as list_tags } from "../src/tools/list-tags.js";
import { inputSchema as restore_doc } from "../src/tools/restore-doc.js";
import { inputSchema as search } from "../src/tools/search.js";
import { inputSchema as set_metadata } from "../src/tools/set-metadata.js";
import { inputSchema as set_status } from "../src/tools/set-status.js";
import { inputSchema as sync_status } from "../src/tools/sync-status.js";
import { inputSchema as update_data } from "../src/tools/update-data.js";
import {
  getSidebarInput as get_sidebar,
  pinDocInput as pin_doc,
  unpinDocInput as unpin_doc,
  sidebarGroupInput as sidebar_group,
} from "../src/sidebar-tools.js";

/** The same strict Zod objects passed to MCP registration, without the SDK. */
export const toolInputs = {
  annotate, archive_doc, backlinks, create_doc, delete_block, delete_doc, edit_block,
  export_markdown, find_decisions, get_data, get_doc, get_help, insert_block,
  link_range, list_docs, list_tags, restore_doc, search, set_metadata, set_status,
  sync_status, update_data, get_sidebar, pin_doc, unpin_doc, sidebar_group,
};
