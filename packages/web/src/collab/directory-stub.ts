/**
 * The open document's directory stub: repaired on connect and on write, and
 * stamped with `updatedAt` when this replica is the one that changed something.
 *
 * The stub is a cache and `meta.title` in the document is authoritative, so
 * something has to carry the document's own metadata back into the directory.
 * The MCP server does it from its replica observers
 * (`packages/mcp-server/src/replica.ts`, `repairStub`); a browser has no
 * replica layer, so it does it from the room it has open. Same rule, same
 * schema op — {@link upsertDirectoryEntry} — and deliberately the only place
 * the web writes a stub for a document it did not just create.
 *
 * The rule, in the order it matters:
 *
 * - **A change this replica made stamps `updatedAt`.** Title, tags or lifecycle
 *   metadata stamp immediately — that write is happening anyway, because the
 *   stub caches them. A content change stamps at most once per
 *   {@link UPDATED_AT_COARSENESS_MS}, because the directory is broadcast to
 *   every client in the workspace and a stamp per keystroke would turn one
 *   person typing into traffic for everyone.
 * - **An update that merely arrived stamps nothing.** Opening a document
 *   hydrates it from its server, and hydration is not a change;
 *   neither is a peer's edit, which that peer stamps for itself. Those still
 *   *repair* a stub that disagrees with the document ("repaired on connect"),
 *   they just never claim the document changed now.
 *
 * Local and arrived are told apart by `transaction.local`, which Yjs sets false
 * for everything applied through `applyUpdate` — including the Hocuspocus
 * provider — and true for every write made through
 * `doc.transact`, which is every edit made here: the editor's, this app's own
 * schema calls, a repair this app performs after receiving state, and an undo.
 * The repair is a document write this replica actually made; receiving the
 * state that prompted it is not.
 *
 * Two replicas stamping the same entry — this one and an MCP server — keep the
 * greater stamp through the shared schema operation even when its whole-entry
 * write loses Yjs ordering. Each also reads the resolved stamp before writing,
 * so a window already stamped by the other suppresses this one's write too. A
 * future-skewed clock can pin this cache-quality hint until a later authored
 * stamp exceeds it.
 */

import type * as Y from "yjs";
import {
  getDirectoryEntry,
  getMeta,
  upsertDirectoryEntry,
} from "@uberblick/schema";

/**
 * At most one `updatedAt` bump per document per this window, for changes that
 * are not already writing the stub.
 *
 * The MCP server's `updatedAtCoarsenessMs` (`packages/mcp-server/src/config.ts`)
 * by construction: two writers on one field want one window, or the coarser of
 * the two would keep re-stamping inside the finer one's quiet period.
 */
export const UPDATED_AT_COARSENESS_MS = 5 * 60_000;

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  for (const value of b) {
    if (!left.has(value)) return false;
  }
  return true;
}

/**
 * Bring one document's stub in line with the document, stamping it when
 * `changedAt` says when this replica authored what it is reacting to.
 *
 * Writes nothing when there is nothing to say: an unchanged stub inside its
 * window costs the workspace no directory update at all. A tombstone is left
 * alone — `upsertDirectoryEntry` keeps it sticky, but rewriting it on every
 * observed update would churn the directory to no end, and un-archiving is
 * `restoreDirectoryEntry`'s business.
 */
function repairStub(docDoc: Y.Doc, dirDoc: Y.Doc, changedAt: number | null): void {
  const meta = getMeta(docDoc);
  if (meta.uuid === "") return;
  const stub = getDirectoryEntry(dirDoc, meta.uuid);
  if (stub?.deleted === true) return;

  const metaChanged =
    stub === null ||
    stub.title !== meta.title ||
    stub.kind !== meta.kind ||
    stub.status !== meta.status ||
    !sameSet(stub.tags, meta.tags);
  const staleStamp =
    stub?.updatedAt === undefined ||
    (changedAt !== null &&
      changedAt - stub.updatedAt >= UPDATED_AT_COARSENESS_MS);
  const stamp = changedAt !== null && (metaChanged || staleStamp);
  if (!metaChanged && !stamp) return;

  upsertDirectoryEntry(dirDoc, {
    uuid: meta.uuid,
    title: meta.title,
    tags: meta.tags,
    // State every optional field owned by the document, so repairing lifecycle
    // metadata cannot carry an unrelated stale description through the stub.
    // Like title, this replica's copy can itself be stale until document sync
    // arrives; the next observed document update repairs the cache again.
    description: meta.description ?? "",
    kind: meta.kind ?? "",
    status: meta.status ?? "",
    ...(stamp ? { updatedAt: changedAt } : {}),
  });
}

/**
 * Keep `docDoc`'s stub in `dirDoc` repaired and stamped for as long as the
 * document is open. Returns the unsubscribe.
 *
 * Repairs once up front, for the case where the document is already hydrated
 * when this attaches, and then on every update the document takes.
 */
export interface StubWriteGate {
  writable(): boolean;
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
    if (gate !== undefined && !gate.writable()) return;
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
