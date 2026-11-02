import * as Y from "yjs";

export type AcceptUndo = (before: Y.Doc, after: Y.Doc) => boolean;

/** Preview Yjs history before its mutation can reach the bound document. */
export function guardUndoManager(
  manager: Y.UndoManager,
  fragment: Y.XmlFragment,
  canEdit: () => boolean,
  acceptUndo?: AcceptUndo,
  needsUndoCheck: () => boolean = () => true,
): void {
  const undo = manager.undo.bind(manager);
  const redo = manager.redo.bind(manager);
  const apply = (direction: "undo" | "redo") => {
    if (!canEdit()) return null;
    if (acceptUndo !== undefined && needsUndoCheck()) {
      const preview = new Y.Doc({ gc: false });
      try {
        const previewFragment = preview.getXmlFragment(Y.findRootTypeKey(fragment));
        Y.applyUpdate(preview, Y.encodeStateAsUpdate(manager.doc));
        preview.clientID = manager.doc.clientID;
        // Update encoding omits local redo links. Restore their exact ranges
        // before previewing repeated undo/redo against the copied stacks.
        preview.transact((transaction) => {
          for (const structs of manager.doc.store.clients.values()) {
            for (const struct of structs) {
              if (!(struct instanceof Y.Item) || struct.redone === null) continue;
              const item = Y.getItemCleanStart(transaction, struct.id);
              Y.getItemCleanEnd(transaction, preview.store, struct.lastId);
              item.redone = struct.redone;
            }
          }
        });
        const history = new Y.UndoManager(previewFragment, {
          deleteFilter: manager.deleteFilter,
          ignoreRemoteMapChanges: manager.ignoreRemoteMapChanges,
        });
        history.undoStack = manager.undoStack.slice();
        history.redoStack = manager.redoStack.slice();
        history[direction]();
        if (!acceptUndo(manager.doc, preview)) return null;
      } finally {
        preview.destroy();
      }
    }
    return direction === "undo" ? undo() : redo();
  };
  manager.undo = () => apply("undo");
  manager.redo = () => apply("redo");
}
