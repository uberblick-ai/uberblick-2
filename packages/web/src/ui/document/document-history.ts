import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { RevisionEntry } from "@uberblick/schema";
import { DocumentHistoryError } from "../../shell/document-revisions.js";
import type { DocumentRevisionsClient } from "../../shell/document-revisions.js";

interface Selection { index: number; before: Y.Doc | null; after: Y.Doc }
interface HistoryState {
  entries: RevisionEntry[] | null;
  selection: Selection | null;
  busy: boolean;
  error: string | null;
}
interface Session {
  client: DocumentRevisionsClient;
  uuid: string;
  path: string;
  operation: number;
  signal: AbortSignal;
  documents: Map<string, Y.Doc>;
  state: HistoryState;
}
const initial: HistoryState = { entries: null, selection: null, busy: true, error: null };

export function useDocumentHistory(client: DocumentRevisionsClient | null, uuid: string | null, path: string) {
  const current = useRef<Session | null>(null);
  const [view, setView] = useState<{ session: Session; state: HistoryState } | null>(null);
  const update = useCallback((session: Session, changes: Partial<HistoryState>): void => {
    if (current.current !== session || session.signal.aborted) return;
    session.state = { ...session.state, ...changes };
    setView({ session, state: session.state });
  }, []);
  const fail = useCallback((session: Session, error: unknown): void => update(session, {
    busy: false, error: error instanceof DocumentHistoryError ? error.message : new DocumentHistoryError("unreachable").message,
  }), [update]);
  const list = async (session: Session, operation: number): Promise<RevisionEntry[]> => {
    const entries = await session.client.list(session.uuid, session.signal);
    if (session.operation === operation) update(session, { entries });
    return entries;
  };
  // Each route visit owns its detached documents and pending requests. The
  // live room never participates in this cache or its teardown.
  useEffect(() => {
    if (client === null || uuid === null) { current.current = null; setView(null); return; }
    const controller = new AbortController();
    const session: Session = { client, uuid, path, operation: 0, signal: controller.signal, documents: new Map(), state: initial };
    current.current = session;
    setView({ session, state: initial });
    void client.list(uuid, controller.signal).then(
      (entries) => update(session, { entries, busy: false }),
      (error: unknown) => fail(session, error),
    );
    return () => {
      controller.abort();
      if (current.current === session) current.current = null;
      for (const doc of session.documents.values()) doc.destroy();
    };
  }, [client, uuid, path, update, fail]);
  const session = view?.session;
  const state = view !== null && session?.client === client && session.uuid === uuid && session.path === path && current.current === session ? view.state : initial;
  const get = async (owner: Session, id: string, operation: number): Promise<Y.Doc> => {
    const cached = owner.documents.get(id);
    if (cached !== undefined) return cached;
    const doc = await owner.client.get(owner.uuid, id, owner.signal);
    if (owner.signal.aborted || owner.operation !== operation) { doc.destroy(); throw new DOMException("Cancelled", "AbortError"); }
    owner.documents.set(id, doc);
    return doc;
  };
  const select = async (direction: -1 | 1): Promise<void> => {
    const owner = current.current;
    if (owner === null || owner.state.busy) return;
    const operation = ++owner.operation;
    update(owner, { busy: true, error: null });
    try {
      const selection = owner.state.selection;
      const entries = selection === null ? await list(owner, operation) : owner.state.entries ?? [];
      if (owner.operation !== operation) return;
      if (selection === null) {
        for (const doc of owner.documents.values()) doc.destroy();
        owner.documents.clear();
      }
      const index = selection === null ? 0 : selection.index + direction;
      const entry = entries[index];
      if (entry === undefined) { update(owner, { busy: false }); return; }
      const after = await get(owner, entry.id, operation);
      if (owner.operation !== operation) return;
      const previous = entries[index + 1];
      const before = previous === undefined ? null : await get(owner, previous.id, operation);
      if (owner.operation !== operation) return;
      update(owner, { selection: { index, before, after }, busy: false });
    } catch (error) { if (owner.operation === operation) fail(owner, error); }
  };
  return {
    ...state,
    available: client !== null && uuid !== null,
    active: state.selection !== null,
    entry: state.selection === null ? null : state.entries?.[state.selection.index] ?? null,
    back: () => { void select(1); },
    forward: () => { void select(-1); },
    now: () => {
      const owner = current.current;
      if (owner !== null) { owner.operation++; update(owner, { selection: null, error: null, busy: false }); }
    },
    refresh: () => {
      const owner = current.current;
      if (owner === null || owner.state.busy) return;
      const operation = ++owner.operation;
      update(owner, { busy: true, error: null });
      void list(owner, operation).then(() => {
        if (owner.operation === operation) update(owner, { busy: false });
      }, (error: unknown) => { if (owner.operation === operation) fail(owner, error); });
    },
  };
}
export type DocumentHistory = ReturnType<typeof useDocumentHistory>;
