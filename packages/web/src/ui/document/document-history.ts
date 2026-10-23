import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { getMeta } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import { DocumentHistoryError } from "../../shell/document-revisions.js";
import type { DocumentRevisionsClient } from "../../shell/document-revisions.js";

interface Selection { index: number; before: Y.Doc | null; after: Y.Doc; comparedWith?: RevisionEntry }
interface HistoryState {
  entries: RevisionEntry[] | null;
  selection: Selection | null;
  /** History was asked for: it stays open through loading, failure and an empty list. */
  active: boolean;
  busy: boolean;
  error: string | null;
  /** Titles of the revisions read so far; the list itself carries none. */
  titles: Readonly<Record<string, string>>;
}
interface Session {
  client: DocumentRevisionsClient;
  uuid: string;
  path: string;
  operation: number;
  signal: AbortSignal;
  documents: Map<string, Y.Doc>;
  retryTarget: Target | null;
  state: HistoryState;
}
const initial: HistoryState = { entries: null, selection: null, active: false, busy: true, error: null, titles: {} };
type Target = { index: number } | { step: -1 | 1 } | { since: string | null } | { id: string };
function destroyDocuments(documents: Map<string, Y.Doc>): void {
  for (const doc of documents.values()) doc.destroy();
  documents.clear();
}

/** Entering steps open the newest revision; a comparison always shows the newest. */
function targetIndex(target: Target, selection: Selection | null, entries: readonly RevisionEntry[]): number {
  if ("id" in target) return entries.findIndex(entry => entry.id === target.id);
  if ("since" in target || (selection === null && "step" in target)) return 0;
  return "index" in target ? target.index : (selection?.index ?? 0) + target.step;
}

function knownTitles(documents: Map<string, Y.Doc>): Record<string, string> {
  return Object.fromEntries([...documents].map(([id, doc]) => [id, getMeta(doc).title]));
}

/** The predecessor's title when this revision changed it, once both have been read. */
export function renamedFrom(entries: readonly RevisionEntry[], titles: Readonly<Record<string, string>>, index: number): string | null {
  const title = titles[entries[index]?.id ?? ""];
  const previous = titles[entries[index + 1]?.id ?? ""];
  return title === undefined || previous === undefined || title === previous ? null : previous;
}

function replaceEntries(owner: Session, entries: RevisionEntry[]): Pick<HistoryState, "entries" | "selection"> {
  const selection = owner.state.selection;
  const id = selection === null ? undefined : owner.state.entries?.[selection.index]?.id;
  const index = entries.findIndex(entry => entry.id === id);
  return { entries, selection: selection === null || index < 0 ? null : index === selection.index ? selection : { ...selection, index } };
}

function resolvedTarget(target: Target, entries: readonly RevisionEntry[], index: number): Target {
  const entry = entries[index];
  return "since" in target || entry === undefined ? target : { id: entry.id };
}

function namedBaseline(entries: readonly RevisionEntry[], since: string | null): RevisionEntry | undefined {
  return entries.find(entry => entry.name != null && (since === null || entry.id === since));
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
  // Each route visit owns its detached documents and pending requests. The
  // live room never participates in this cache or its teardown.
  useEffect(() => {
    if (client === null || uuid === null) { current.current = null; setView(null); return; }
    const controller = new AbortController();
    const session: Session = { client, uuid, path, operation: 0, signal: controller.signal, documents: new Map(), retryTarget: null, state: initial };
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
  const select = async (target: Target, relist = false): Promise<void> => {
    const owner = current.current;
    if (owner === null || owner.state.busy) return;
    const operation = ++owner.operation;
    const named = "since" in target;
    const fresh = named ? new Map<string, Y.Doc>() : null;
    let adopted = false;
    owner.retryTarget = target;
    update(owner, { busy: true, error: null, active: true });
    try {
      const selection = owner.state.selection;
      const entries = named || relist || selection === null ? await owner.client.list(owner.uuid, owner.signal) : owner.state.entries ?? [];
      if (owner.operation !== operation) return;
      if (selection === null && fresh === null) { destroyDocuments(owner.documents); update(owner, { titles: {} }); }
      const index = targetIndex(target, selection, entries);
      if ("id" in target && index < 0) throw new DocumentHistoryError("revision-not-found");
      owner.retryTarget = resolvedTarget(target, entries, index);
      const previous = named ? namedBaseline(entries, target.since) : undefined;
      if (named && previous === undefined) { update(owner, { busy: false, ...replaceEntries(owner, entries), error: "This named revision is no longer available. Try again." }); return; }
      const next = await readSelection(owner, entries, index, operation, fresh ?? owner.documents, previous);
      if (owner.operation !== operation) return;
      if (next === null) { update(owner, { busy: false, ...replaceEntries(owner, entries) }); return; }
      if (fresh !== null) {
        destroyDocuments(owner.documents);
        owner.documents = fresh;
        adopted = true;
      }
      owner.retryTarget = null;
      update(owner, { entries, selection: next, busy: false, titles: knownTitles(owner.documents) });
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
      const replacement = replaceEntries(owner, next);
      const selection = replacement.selection;
      update(owner, { busy: false, ...replacement,
        ...(selection?.comparedWith?.id === revision.id ? (revision.name == null ? { selection: null, active: false } : { selection: { ...selection, comparedWith: revision } }) : {}) });
    } catch (error) { if (owner.operation === operation) update(owner, { busy: false }); throw error; }
  };
  const refresh = (): void => {
    const owner = current.current;
    if (owner === null || owner.state.busy) return;
    const operation = ++owner.operation;
    update(owner, { busy: true, error: null });
    void owner.client.list(owner.uuid, owner.signal).then((entries) => {
      if (owner.operation === operation) update(owner, { busy: false, ...replaceEntries(owner, entries) });
    }, (error: unknown) => { if (owner.operation === operation) fail(owner, error); });
  };
  return {
    ...state,
    available: client !== null && uuid !== null,
    entry: state.selection === null ? null : state.entries?.[state.selection.index] ?? null,
    back: () => { void select({ step: 1 }); },
    forward: () => { void select({ step: -1 }); },
    open: (index: number) => { void select({ index }); },
    sinceLastNamed: () => { void select({ since: null }); },
    sinceNamed: (id: string) => { void select({ since: id }); },
    name: (name: string, checksum: string) => mutate(owner => owner.client.name(owner.uuid, name, checksum, owner.signal)),
    rename: (revisionId: string, name: string) => mutate(owner => owner.client.rename(owner.uuid, revisionId, name, owner.signal)),
    removeName: (revisionId: string) => mutate(owner => owner.client.removeName(owner.uuid, revisionId, owner.signal)),
    now: () => {
      const owner = current.current;
      if (owner !== null) { owner.operation++; owner.retryTarget = null; update(owner, { selection: null, active: false, error: null, busy: false }); }
    },
    /** A failed read retains its target even when newer revisions arrive. */
    retry: () => {
      const owner = current.current;
      if (owner === null) return;
      if (owner.retryTarget !== null) void select(owner.retryTarget, true);
      else if (owner.state.selection === null) void select({ index: 0 });
      else refresh();
    },
    refresh,
  };
}
export type DocumentHistory = ReturnType<typeof useDocumentHistory>;
