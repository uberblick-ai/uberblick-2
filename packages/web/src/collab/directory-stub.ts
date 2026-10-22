/**
 * The document owns metadata; its directory stub is only a cache. This is the
 * web's sole repair path for existing documents, using the shared schema repair.
 * Local metadata edits stamp immediately; content edits coarsen timestamps to
 * bound workspace-wide traffic. Hydration and peer edits repair without stamping.
 * transaction.local also includes local repairs and undo, but excludes applyUpdate.
 * Keep the greatest authored stamp despite whole-entry merge ordering, and read
 * it before writing to suppress windows another replica already stamped.
 * Future-skewed clocks can pin this hint until a greater stamp is authored.
 */

import type * as Y from "yjs";
import {
  repairDirectoryStub,
  UPDATED_AT_COARSENESS_MS,
} from "@uberblick/schema";

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
  uuid: string,
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
    repairDirectoryStub(docDoc, dirDoc, uuid, {
      now: Date.now(),
      changedAt: pendingChangedAt,
      coarsenessMs: UPDATED_AT_COARSENESS_MS,
    });
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
