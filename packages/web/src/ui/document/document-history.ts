import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { RevisionEntry } from "@uberblick/schema";
import { DocumentHistoryError } from "../../shell/document-revisions.js";
import type { DocumentRevisionsClient } from "../../shell/document-revisions.js";

interface Selection { index: number; before: Y.Doc | null; after: Y.Doc; comparedWith?: RevisionEntry }
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
function destroyDocuments(documents: Map<string, Y.Doc>): void {
  for (const doc of documents.values()) doc.destroy();
  documents.clear();
}

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
      destroyDocuments(session.documents);
    };
  }, [client, uuid, path, update, fail]);
  const session = view?.session;
  const state = view !== null && session?.client === client && session.uuid === uuid && session.path === path && current.current === session ? view.state : initial;
  const get = async (owner: Session, id: string, operation: number, documents = owner.documents): Promise<Y.Doc> => {
    const cached = documents.get(id);
    if (cached !== undefined) return cached;
    const doc = await owner.client.get(owner.uuid, id, owner.signal);
    if (owner.signal.aborted || owner.operation !== operation) { doc.destroy(); throw new DOMException("Cancelled", "AbortError"); }
    documents.set(id, doc);
    return doc;
  };
  const readSelection = async (owner: Session, entries: RevisionEntry[], index: number, operation: number,
    documents: Map<string, Y.Doc>, comparedWith?: RevisionEntry): Promise<Selection | null> => {
    const entry = entries[index];
    if (entry === undefined) return null;
    const previous = comparedWith ?? entries[index + 1];
    const after = await get(owner, entry.id, operation, documents);
    const before = previous === undefined ? null : await get(owner, previous.id, operation, documents);
    return { index, before, after, ...(comparedWith === undefined ? {} : { comparedWith }) };
  };
  const select = async (direction: -1 | 1 | "named"): Promise<void> => {
    const owner = current.current;
    if (owner === null || owner.state.busy) return;
    const operation = ++owner.operation;
    const fresh = direction === "named" ? new Map<string, Y.Doc>() : null;
    let adopted = false;
    update(owner, { busy: true, error: null });
    try {
      const selection = owner.state.selection;
      const entries = direction === "named" ? await owner.client.list(owner.uuid, owner.signal)
        : selection === null ? await list(owner, operation) : owner.state.entries ?? [];
      if (owner.operation !== operation) return;
      if (selection === null && fresh === null) destroyDocuments(owner.documents);
      const index = selection === null || direction === "named" ? 0 : selection.index + direction;
      const previous = direction === "named" ? entries.find(entry => entry.name != null) : undefined;
      if (direction === "named" && previous === undefined) { update(owner, { busy: false, error: "No named revision is available. Return to now and refresh history." }); return; }
      const next = await readSelection(owner, entries, index, operation, fresh ?? owner.documents, previous);
      if (owner.operation !== operation) return;
      if (next === null) { update(owner, { busy: false }); return; }
      if (fresh !== null) {
        destroyDocuments(owner.documents);
        owner.documents = fresh;
        adopted = true;
      }
      update(owner, { entries, selection: next, busy: false });
    } catch (error) { if (owner.operation === operation) fail(owner, error); }
    finally { if (fresh !== null && !adopted) destroyDocuments(fresh); }
  };
  const mutate = async (write: (owner: Session) => Promise<RevisionEntry>): Promise<void> => {
    const owner = current.current;
    if (owner === null || owner.state.busy) return;
    const operation = ++owner.operation;
    update(owner, { busy: true });
    try {
      const revision = await write(owner);
      if (owner.operation !== operation) return;
      const entries = owner.state.entries ?? [];
      const existing = entries.some(entry => entry.id === revision.id);
      const next = existing ? entries.map(entry => entry.id === revision.id ? revision : entry) : [revision, ...entries];
      const selection = owner.state.selection;
      update(owner, { busy: false, entries: next,
        ...(selection?.comparedWith?.id === revision.id ? { selection: revision.name == null ? null : { ...selection, comparedWith: revision } } : {}) });
    } catch (error) { if (owner.operation === operation) update(owner, { busy: false }); throw error; }
  };
  return {
    ...state,
    available: client !== null && uuid !== null,
    active: state.selection !== null,
    entry: state.selection === null ? null : state.entries?.[state.selection.index] ?? null,
    back: () => { void select(1); },
    forward: () => { void select(-1); },
    sinceLastNamed: () => { void select("named"); },
    name: (name: string, checksum: string) => mutate(owner => owner.client.name(owner.uuid, name, checksum, owner.signal)),
    rename: (revisionId: string, name: string) => mutate(owner => owner.client.rename(owner.uuid, revisionId, name, owner.signal)),
    removeName: (revisionId: string) => mutate(owner => owner.client.removeName(owner.uuid, revisionId, owner.signal)),
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
