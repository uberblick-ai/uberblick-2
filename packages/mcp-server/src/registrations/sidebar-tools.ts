import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import { guarded } from "../tool-adapter.js";
import type { ToolContext } from "../tools/context.js";
import { getSidebarInput, getSidebarOperation, pinDocInput, pinDocOperation, unpinDocInput, unpinDocOperation, sidebarGroupInput, sidebarGroupOperation } from "../sidebar-tools.js";

export function registerSidebarTools(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("get_sidebar", {
    title: "Read the sidebar",
    description:
      "The workspace's curated navigation: named groups of pinned documents, in the order they are stored. This " +
      "is not the corpus — unpinned documents are fully alive and reachable through list_docs, search, links " +
      "and backlinks. Unpinned documents are simply not entry points." +
      helpPointer("get_sidebar"),
    outputSchema: outputSchemas.get_sidebar,
    inputSchema: getSidebarInput,
  }, guarded("get_sidebar", context, getSidebarOperation));
  server.registerTool("pin_doc", {
    title: "Pin a document into a sidebar group",
    description:
      "Pin a document into a group, creating the group when no group carries that name. `index` places it; omit " +
      "it to append.\n\n" +
      "One pin per document across the whole sidebar, so this is also how a pinned document is moved or " +
      "reordered: pinning one that is already pinned moves it to `index` in the named group — carrying the pin " +
      "as it stands rather than re-pinning it, so a concurrent unpin still wins — and `index` then counts " +
      "positions in the target group after the document has been taken out of it." +
      helpPointer("pin_doc"),
    outputSchema: outputSchemas.pin_doc,
    inputSchema: pinDocInput,
  }, guarded("pin_doc", context, pinDocOperation));
  server.registerTool("unpin_doc", {
    title: "Unpin a document",
    description:
      "Remove a document from the sidebar, wherever it sits. The document itself is untouched: unpinning is a " +
      "navigation act, not a delete — archive_doc is the one that tombstones a document.\n\n" +
      "An unpin beats a move made concurrently on another replica, so a document does not reappear because " +
      "somebody was dragging it at the time. It takes no group: one pin per document means there is only ever " +
      "one place to remove it from. `unpinned` is false when the document was not pinned to begin with." +
      helpPointer("unpin_doc"),
    outputSchema: outputSchemas.unpin_doc,
    inputSchema: unpinDocInput,
  }, guarded("unpin_doc", context, unpinDocOperation));
  server.registerTool("sidebar_group", {
    title: "Rename, delete or move a sidebar group",
    description:
      "Manage the groups themselves. `delete` removes the group and its pins — the documents are untouched, " +
      "because the group only ever held their uuids, and they stay reachable through list_docs and search.\n\n" +
      "`action` picks one of three shapes and each takes only its own field: `rename` needs `name` and refuses " +
      "`index`, `move` takes `index` (omitted: last) and refuses `name`, `delete` takes neither. A field " +
      "belonging to another action is refused at the input boundary before the sidebar is touched, rather than " +
      "ignored — so a call that says two things is a failure you can see, not a silent half-success.\n\n" +
      "There is no create action: pin_doc creates a group by naming one that does not exist, which is how a " +
      "group comes into being with something in it rather than empty." +
      helpPointer("sidebar_group"),
    outputSchema: outputSchemas.sidebar_group,
    inputSchema: sidebarGroupInput,
  }, guarded("sidebar_group", context, sidebarGroupOperation));
}
