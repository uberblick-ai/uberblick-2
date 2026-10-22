/** The explicit shared-document controls use the editor's workspace catalog. */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { writeDocument } from "../collab/document-write.js";

const catalogs = new WeakMap<Editor, { catalog: Y.Doc | null; canCleanup: (() => boolean) | undefined }>();

export function setEditorTagCatalog(editor: Editor, catalog: Y.Doc | null, canCleanup?: () => boolean): void {
  catalogs.set(editor, { catalog, canCleanup });
}

export function writeEditorDocument<T>(editor: Editor, doc: Y.Doc, write: () => T, origin?: unknown): T {
  const binding = catalogs.get(editor);
  return writeDocument(doc, binding?.canCleanup?.() === false ? null : binding?.catalog ?? null, write, origin);
}
