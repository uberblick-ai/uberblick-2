/**
 * The document owns metadata; its directory stub is only a cache. This is the
 * web's sole repair path for existing documents, using the shared schema diff.
 * Local metadata edits stamp immediately; content edits coarsen timestamps to
 * bound workspace-wide traffic. Hydration and peer edits repair without stamping.
 * transaction.local also includes local repairs and undo, but excludes applyUpdate.
 * Keep the greatest authored stamp despite whole-entry merge ordering, and read
 * it before writing to suppress windows another replica already stamped.
 * Future-skewed clocks can pin this hint until a greater stamp is authored.
 */

import type * as Y from "yjs";
import {
  documentDirectoryFields,
  directoryStubDiffers,
  getDirectoryEntry,
  getMeta,
  upsertDirectoryEntry,
} from "@uberblick/schema";

/**
 * At most one stamp per document per window for edits not already writing the
 * stub. Match the MCP writer's window so replicas do not restamp inside it.
 */
export const UPDATED_AT_COARSENESS_MS = 5 * 60_000;

/**
 * Unchanged stubs inside the window cause no write. Leave ordinary tombstones
 * to restoreDirectoryEntry; decision caches still repair while archived because
 * their metadata resolves the topic and their tombstone mirrors topic archive.
 */
function repairStub(docDoc: Y.Doc, dirDoc: Y.Doc, changedAt: number | null): void {
  const meta = getMeta(docDoc);
  if (meta.uuid === "") return;
  const stub = getDirectoryEntry(dirDoc, meta.uuid);
  if (stub?.deleted === true && meta.kind !== "decision") return;

  const documentFields = documentDirectoryFields(docDoc);
  const metaChanged = directoryStubDiffers(stub, meta, documentFields);
  const staleStamp =
    stub?.updatedAt === undefined ||
    (changedAt !== null &&
      changedAt - stub.updatedAt >= UPDATED_AT_COARSENESS_MS);
  const stamp = changedAt !== null && (metaChanged || staleStamp);
  if (!metaChanged && !stamp && stub?.createdAt !== undefined) return;

  upsertDirectoryEntry(dirDoc, {
    uuid: meta.uuid,
    title: meta.title,
    tags: meta.tags,
    // Supply every optional field so repair cannot retain stale metadata.
    // A not-yet-synced document can be stale too; its next update repairs again.
    description: meta.description ?? "",
    kind: meta.kind ?? "",
    status: meta.status ?? "",
    ...documentFields,
    createdAt: Date.now(),
    ...(stamp ? { updatedAt: changedAt } : {}),
  });
}

/**
 * Repair on attachment and updates; return unsubscribe. Gated repairs need both
 * admission and current directory sync, or an empty interval could overwrite
 * a tombstone that has not arrived yet.
 */
export interface StubWriteGate {
  writable(): boolean;
  /** Whether the directory has synchronized on its current connection. */
  synchronized(): boolean;
  subscribe(listener: () => void): () => void;
}

export function watchDocumentStub(
  docDoc: Y.Doc,
  dirDoc: Y.Doc,
  gate?: StubWriteGate,
): () => void {
  let pendingChangedAt: number | null = null;
  const attempt = (changed: boolean): void => {
    if (changed) pendingChangedAt = Date.now();
    if (
      gate !== undefined &&
      (!gate.writable() || !gate.synchronized())
    ) {
      return;
    }
    repairStub(docDoc, dirDoc, pendingChangedAt);
    pendingChangedAt = null;
  };
  const onUpdate = (
    _update: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ): void => attempt(transaction.local);
  attempt(false);
  docDoc.on("update", onUpdate);
  const stopGate = gate?.subscribe(() => attempt(false));
  return () => {
    docDoc.off("update", onUpdate);
    stopGate?.();
  };
}
