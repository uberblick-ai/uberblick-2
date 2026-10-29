import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { RevisionEntry } from "@uberblick/schema";
import { documentRevisionChecksum, DocumentHistoryError } from "../../shell/document-revisions.js";
import type { DocumentHistoryStatus, DocumentRevisionsClient } from "../../shell/document-revisions.js";
import { useStoredFlag } from "../hooks.js";
import type { RevisionView } from "../route.js";

interface Selection { index: number; entry: RevisionEntry; entries: RevisionEntry[]; before: Y.Doc | null; after: Y.Doc; comparedWith?: RevisionEntry }
interface HistoryState {
  filter: "all" | "named";
  entries: RevisionEntry[] | null;
  selection: Selection | null;
  /** History was asked for: it stays open through loading, failure and an empty list. */
  active: boolean;
  busy: boolean;
  error: string | null;
  history: DocumentHistoryStatus | null;
  downloading: boolean;
  /** Only the opted-in list supplies markers, including when snapshots are cached. */
  titles: Readonly<Record<string, string>>;
}
interface Session {
  client: DocumentRevisionsClient;
  uuid: string;
  key: string;
  requestedView: RevisionView | null;
  listing: ReturnType<DocumentRevisionsClient["list"]> | null;
  operation: number;
  signal: AbortSignal;
  documents: Map<string, Y.Doc>;
  documentChecksums: WeakMap<Y.Doc, string | undefined>;
  retryTarget: Target | null;
  retryRefresh: boolean;
  startingHash: Promise<string | Error> | null;
  acknowledgedNames: Map<string, RevisionEntry>;
  state: HistoryState;
}
const initial: HistoryState = { filter: "all", entries: null, selection: null, active: false, busy: true, error: null, history: null, downloading: false, titles: {} };
type Target = { index: number; named?: boolean } | { step: -1 | 1; named?: boolean } | { since: string | null } | { id: string; since?: string };
interface HistoryRoute { view: RevisionView | null; navigate: (view: RevisionView | null) => void }
function sameView(left: RevisionView | null, right: RevisionView | null): boolean {
  return left?.revision === right?.revision && left?.since === right?.since;
}
function displayedState(state: HistoryState, session: Session | undefined, route: HistoryRoute | undefined): HistoryState {
  if (route === undefined) return state;
  const pending = !sameView(route.view, session?.requestedView ?? null);
  const selectedId = state.selection?.entry.id;
  const matches = route.view === null || (selectedId === route.view.revision && state.selection?.comparedWith?.id === route.view.since);
  return { ...state, active: route.view !== null || (!pending && state.active),
    selection: pending || (!matches && !state.busy) ? null : state.selection,
    error: pending ? null : state.error, busy: pending || state.busy };
}
function destroyDocuments(documents: Map<string, Y.Doc>): void {
  for (const doc of documents.values()) doc.destroy();
  documents.clear();
}

/** Entering steps and named shortcuts open the newest revision. */
function targetIndex(target: Target, selection: Selection | null, entries: readonly RevisionEntry[]): number {
  if ("id" in target) return entries.findIndex(entry => entry.id === target.id);
  if ("since" in target || (selection === null && "step" in target)) return 0;
  if ("step" in target && target.named) return namedStep(entries, selection?.index ?? 0, target.step);
  return "index" in target ? target.index : (selection?.index ?? 0) + target.step;
}

function namedStep(entries: readonly RevisionEntry[], index: number, step: -1 | 1): number {
  for (let next = index + step; next >= 0 && next < entries.length; next += step) {
    if (entries[next]?.name != null) return next;
  }
  return -1;
}

function listedTitles(entries: readonly RevisionEntry[]): Record<string, string> {
  return Object.fromEntries(entries.flatMap(entry => entry.title === undefined ? [] : [[entry.id, entry.title]]));
}

/** Rename attribution always follows adjacent revisions, including named comparisons. */
export function renamedFrom(entries: readonly RevisionEntry[], titles: Readonly<Record<string, string>>, index: number): string | null {
  const title = titles[entries[index]?.id ?? ""];
  const previous = titles[entries[index + 1]?.id ?? ""];
  return title === undefined || previous === undefined || title === previous ? null : previous;
}

function replaceEntries(owner: Session, entries: RevisionEntry[]): Pick<HistoryState, "entries" | "selection" | "titles"> {
  const selection = owner.state.selection;
  const id = selection?.entry.id;
  const index = entries.findIndex(entry => entry.id === id);
  return { entries, titles: listedTitles(entries), selection: selection === null ? null : index === selection.index ? selection : { ...selection, index } };
}

function catalogEntries(owner: Session, result: Awaited<ReturnType<DocumentRevisionsClient["list"]>>, refreshed = false): RevisionEntry[] {
  if (refreshed && !result.history.refreshFailed && !result.history.offline) owner.acknowledgedNames.clear();
  for (const entry of result.revisions) {
    const acknowledged = owner.acknowledgedNames.get(entry.id);
    if (acknowledged !== undefined && JSON.stringify(entry.name ?? null) === JSON.stringify(acknowledged.name ?? null)) owner.acknowledgedNames.delete(entry.id);
  }
  if (owner.acknowledgedNames.size === 0) return result.revisions;
  const entries = result.revisions.map(entry => {
    const acknowledged = owner.acknowledgedNames.get(entry.id);
    return acknowledged === undefined ? entry : { ...entry, ...acknowledged };
  });
  for (const [id, entry] of owner.acknowledgedNames) if (!entries.some(candidate => candidate.id === id)) entries.unshift(entry);
  return entries;
}

function resolvedTarget(target: Target, entries: readonly RevisionEntry[], index: number): Target {
  const entry = entries[index];
  return "since" in target || entry === undefined ? target : { id: entry.id };
}

function namedBaseline(entries: readonly RevisionEntry[], since: string | null): RevisionEntry | undefined {
  return entries.find(entry => entry.name != null && (since === null || entry.id === since));
}

function refreshesList(target: Target, relist: boolean, active: boolean): boolean {
  return ("since" in target && !("id" in target)) || relist || !active;
}

async function getRevision(owner: Session, id: string, operation: number, documents: Map<string, Y.Doc>, entry?: RevisionEntry): Promise<Y.Doc> {
  const cached = documents.get(id);
  if (cached !== undefined && owner.documentChecksums.get(cached) === entry?.checksum) return cached;
  const doc = await owner.client.get(owner.uuid, id, owner.signal);
  if (owner.signal.aborted || owner.operation !== operation) { doc.destroy(); throw new DOMException("Cancelled", "AbortError"); }
  // A superseded snapshot may still be the comparison on screen.
  if (cached !== undefined && documents === owner.documents) documents.set(`retained:${id}:${operation}`, cached);
  documents.set(id, doc);
  owner.documentChecksums.set(doc, entry?.checksum);
  return doc;
}

async function readSelection(owner: Session, entries: RevisionEntry[], index: number, operation: number,
  documents: Map<string, Y.Doc>, comparedWith?: RevisionEntry): Promise<Selection | null> {
  const entry = entries[index];
  if (entry === undefined) return null;
  const previous = comparedWith ?? entries[index + 1];
  const [after, before] = await Promise.allSettled([getRevision(owner, entry.id, operation, documents, entry),
    previous === undefined ? Promise.resolve(null) : getRevision(owner, previous.id, operation, documents, previous)] as const);
  if (after.status === "rejected") throw after.reason;
  if (before.status === "rejected") throw before.reason;
  return { index, entry, entries, before: before.value, after: after.value, ...(comparedWith === undefined ? {} : { comparedWith }) };
}

function captureStartingPoint(owner: Session, document: Y.Doc | null, needed = true): void {
  if (!needed) return;
  owner.startingHash = document === null ? null : documentRevisionChecksum(document)
    .catch(() => new Error("Couldn't read this document's state. Refresh history and try again."));
}

type Update = (owner: Session, changes: Partial<HistoryState>) => void;
type Fail = (owner: Session, error: unknown) => void;

async function selectionEntries(owner: Session, refresh: boolean): Promise<RevisionEntry[]> {
  if (owner.listing !== null && owner.state.entries === null) {
    const result = await owner.listing;
    owner.state = { ...owner.state, history: result.history };
    return catalogEntries(owner, result);
  }
  if (!refresh) return owner.state.entries ?? [];
  const result = await owner.client.list(owner.uuid, owner.signal);
  owner.state = { ...owner.state, history: result.history };
  return catalogEntries(owner, result);
}

function comparisonBaseline(target: Target, entries: RevisionEntry[], index: number): RevisionEntry | undefined {
  if ("named" in target && target.named && entries[index]?.name != null) {
    return entries.slice(index + 1).find(entry => entry.name != null) ?? (index < entries.length - 1 ? entries.at(-1) : undefined);
  }
  if (!("since" in target)) return undefined;
  const previous = "id" in target ? entries.find(entry => entry.id === target.since) : namedBaseline(entries, target.since ?? null);
  if (previous === undefined) throw new DocumentHistoryError("revision-not-found", "History is unavailable: this revision is no longer available. Try again.");
  if (entries.indexOf(previous) <= index) throw new DocumentHistoryError("revision-not-found");
  return previous;
}

async function targetEntries(owner: Session, target: Target, refresh: boolean, operation: number,
  documents: Map<string, Y.Doc>, update: Update): Promise<RevisionEntry[]> {
  let entries: RevisionEntry[];
  try { entries = await selectionEntries(owner, refresh); }
  catch (error) {
    if (!("id" in target) || !(error instanceof DocumentHistoryError) || !["not-downloaded", "downloading"].includes(error.reason ?? "")) throw error;
    if (error.history !== undefined) update(owner, { history: error.history });
    entries = owner.state.entries ?? [];
  }
  if (!("id" in target)) return entries;
  if (entries.some(entry => entry.id === target.id) && (target.since === undefined || entries.some(entry => entry.id === target.since))) return entries;
  const ids = target.since === undefined ? [target.id] : [target.id, target.since];
  const readings = await Promise.allSettled(ids.map(id => getRevision(owner, id, operation, documents, entries.find(entry => entry.id === id))));
  const rejected = readings.find(result => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  return selectionEntries(owner, true);
}

function retainDownloadingDocuments(owner: Session, documents: Map<string, Y.Doc> | null, operation: number, error: unknown): boolean {
  if (documents === null || !(error instanceof DocumentHistoryError) || error.reason !== "downloading") return false;
  for (const [id, doc] of documents) {
    const previous = owner.documents.get(id);
    if (previous !== undefined && previous !== doc) owner.documents.set(`retained:${id}:${operation}`, previous);
    owner.documents.set(id, doc);
  }
  return true;
}

async function selectTarget(owner: Session | null, target: Target, liveDocument: Y.Doc | null,
  update: Update, fail: Fail, navigate: HistoryRoute["navigate"], relist = false, fromRoute = false): Promise<void> {
  if (owner === null || (owner.state.busy && owner.state.active && !fromRoute)) return;
  const operation = ++owner.operation;
  const refresh = refreshesList(target, relist, owner.state.active);
  const entering = !owner.state.active;
  captureStartingPoint(owner, liveDocument, refresh);
  const fresh = "since" in target && refresh ? new Map<string, Y.Doc>() : null;
  let adopted = false;
  owner.retryTarget = target;
  update(owner, { busy: true, error: null, downloading: false, active: true });
  try {
    if (entering && fresh === null) destroyDocuments(owner.documents);
    const entries = await targetEntries(owner, target, refresh, operation, fresh ?? owner.documents, update);
    if (owner.operation !== operation) return;
    if (owner.state.entries === null) update(owner, { entries, titles: listedTitles(entries) });
    const index = targetIndex(target, owner.state.selection, entries);
    if ("id" in target && index < 0) throw new DocumentHistoryError("revision-not-found");
    owner.retryTarget = resolvedTarget(target, entries, index);
    const previous = comparisonBaseline(target, entries, index);
    const entry = entries[index];
    if (entry !== undefined) {
      const address = { revision: entry.id, ...(previous === undefined ? {} : { since: previous.id }) };
      owner.retryTarget = { id: entry.id, ...(previous === undefined ? {} : { since: previous.id }) };
      owner.requestedView = address;
      if (!fromRoute) navigate(address);
    }
    const next = await readSelection(owner, entries, index, operation, fresh ?? owner.documents, previous);
    if (owner.operation !== operation) return;
    if (next === null) { update(owner, { busy: false, ...replaceEntries(owner, entries) }); return; }
    if (fresh !== null) {
      destroyDocuments(owner.documents);
      owner.documents = fresh;
      adopted = true;
    }
    owner.retryTarget = null;
    update(owner, { entries, selection: next, busy: false, downloading: false, titles: listedTitles(entries) });
  } catch (error) {
    if (owner.operation === operation) {
      adopted = retainDownloadingDocuments(owner, fresh, operation, error);
      fail(owner, error);
    }
  }
  finally { if (fresh !== null && !adopted) destroyDocuments(fresh); }
}

async function reloadSelection(owner: Session, operation: number, update: Update): Promise<void> {
  const result = await owner.client.list(owner.uuid, owner.signal, { refresh: true });
  if (owner.operation !== operation) return;
  const entries = catalogEntries(owner, result, true);
  update(owner, { history: result.history });
  const replacement = replaceEntries(owner, entries);
  let baseline: RevisionEntry | undefined;
  const target = owner.requestedView;
  if (target !== null) {
    try {
      const index = entries.findIndex(entry => entry.id === target.revision);
      if (index < 0) throw new DocumentHistoryError("revision-not-found");
      baseline = comparisonBaseline({ id: target.revision, ...(target.since === undefined ? {} : { since: target.since }) }, entries, index);
    } catch (error) { update(owner, { ...replacement, selection: null }); throw error; }
  }
  // A still-open revision can have changed since its detached copy was read.
  const fresh = new Map(owner.documents);
  for (const entry of owner.state.entries ?? []) if (entry.endedAt === null) fresh.delete(entry.id);
  let adopted = false;
  try {
    const selected = replacement.selection;
    if (selected !== null) {
      const next = await readSelection(owner, entries, selected.index, operation, fresh, baseline);
      if (owner.operation !== operation) return;
      replacement.selection = next;
    }
    for (const [id, doc] of owner.documents) if (fresh.get(id) !== doc) doc.destroy();
    owner.documents = fresh;
    adopted = true;
    update(owner, { busy: false, downloading: false, error: null, ...replacement });
  } finally {
    if (!adopted) for (const [id, doc] of fresh) if (owner.documents.get(id) !== doc) doc.destroy();
  }
}

/** Per-browser reading preferences survive document and history sessions. */
function useHistoryPreferences() {
  const [collapseUnchanged, setCollapseUnchanged] = useStoredFlag("uberblick.history.collapse-unchanged", true);
  const [inlineComparison, setInlineComparison] = useStoredFlag("uberblick.history.inline", false);
  const comparisonView: "split" | "inline" = inlineComparison ? "inline" : "split";
  const setComparisonView = (next: "split" | "inline"): void => setInlineComparison(next === "inline");
  return { collapseUnchanged, setCollapseUnchanged, comparisonView, setComparisonView };
}

type SelectionRequest = { current: (target: Target, relist?: boolean, fromRoute?: boolean) => Promise<void> };
async function continueDownload(owner: Session, select: SelectionRequest, refresh: { current: () => void }): Promise<void> {
  if (!owner.state.active || !owner.state.downloading) return;
  if (owner.retryRefresh) refresh.current();
  else if (owner.retryTarget !== null) await select.current(owner.retryTarget, false, true);
}

function useHistoryPolling(owner: Session | undefined, select: SelectionRequest,
  refresh: { current: () => void }, update: Update, fail: Fail): void {
  useEffect(() => {
    if (owner === undefined) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      const operation = owner.operation;
      try {
        if (owner.state.busy || owner.signal.aborted) return;
        if (owner.state.active && owner.state.downloading && owner.retryRefresh) { refresh.current(); return; }
        const confirmNames = owner.acknowledgedNames.size > 0 && owner.state.history?.offline === false;
        const result = await owner.client.list(owner.uuid, owner.signal, confirmNames ? { refresh: true } : undefined);
        if (stopped || owner.signal.aborted || owner.operation !== operation) return;
        const entries = catalogEntries(owner, result, confirmNames);
        update(owner, { ...replaceEntries(owner, entries), history: result.history });
        await continueDownload(owner, select, refresh);
      } catch (error) {
        if (!stopped && !owner.signal.aborted && owner.operation === operation) {
          if (owner.state.downloading) fail(owner, error);
          else if (error instanceof DocumentHistoryError && error.history !== undefined) update(owner, { history: error.history });
        }
      } finally {
        if (!stopped && !owner.signal.aborted) timer = setTimeout(() => { void poll(); }, 1000);
      }
    };
    timer = setTimeout(() => { void poll(); }, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [owner, update, select, refresh, fail]);
}

async function mutateName(owner: Session | null, write: (owner: Session) => Promise<RevisionEntry>, update: Update): Promise<void> {
  if (owner === null || owner.state.busy) return;
  const operation = ++owner.operation;
  update(owner, { busy: true });
  try {
    const revision = await write(owner);
    if (owner.operation !== operation) return;
    owner.acknowledgedNames.set(revision.id, revision);
    const entries = owner.state.entries ?? [];
    const existing = entries.some(entry => entry.id === revision.id);
    const next = existing ? entries.map(entry => entry.id === revision.id ? { ...entry, ...revision } : entry) : [revision, ...entries];
    const replacement = replaceEntries(owner, next);
    const selection = replacement.selection;
    if (selection !== null) replacement.selection = { ...selection,
      entry: selection.entry.id === revision.id ? { ...selection.entry, ...revision } : selection.entry,
      entries: selection.entries.map(entry => entry.id === revision.id ? { ...entry, ...revision } : entry),
      ...(selection.comparedWith?.id === revision.id ? { comparedWith: revision } : {}) };
    update(owner, { busy: false, ...replacement, error: null });
  } catch (error) { if (owner.operation === operation) update(owner, { busy: false }); throw error; }
}

export function useDocumentHistory(client: DocumentRevisionsClient | null, uuid: string | null, key: string, liveDocument: Y.Doc | null = null, route?: HistoryRoute) {
  const current = useRef<Session | null>(null);
  const routing = useRef(route);
  routing.current = route;
  const preferences = useHistoryPreferences();
  const [view, setView] = useState<{ session: Session; state: HistoryState } | null>(null);
  const update = useCallback((session: Session, changes: Partial<HistoryState>): void => {
    if (current.current !== session || session.signal.aborted) return;
    session.state = { ...session.state, ...changes };
    setView({ session, state: session.state });
  }, []);
  const fail = useCallback((session: Session, error: unknown): void => {
    const downloading = error instanceof DocumentHistoryError && error.reason === "downloading";
    if (!downloading) session.retryRefresh = false;
    update(session, { busy: false, error: error instanceof DocumentHistoryError ? error.message : new DocumentHistoryError("unreachable").message,
      downloading, ...(error instanceof DocumentHistoryError && error.history !== undefined ? { history: error.history } : {}) });
  }, [update]);
  // Each document visit owns its detached documents and pending requests. The
  // live room never participates in this cache or its teardown.
  useEffect(() => {
    if (client === null || uuid === null) { current.current = null; setView(null); return; }
    const controller = new AbortController();
    const listing = client.list(uuid, controller.signal);
    const session: Session = { client, uuid, key, requestedView: null, listing, operation: 0, signal: controller.signal, documents: new Map(), documentChecksums: new WeakMap(), retryTarget: null, retryRefresh: false, startingHash: null, acknowledgedNames: new Map(), state: initial };
    current.current = session;
    setView({ session, state: initial });
    void listing.then(
      (result) => { session.listing = null; if (session.operation === 0) { const entries = catalogEntries(session, result); update(session, { entries, history: result.history, titles: listedTitles(entries), busy: false }); } },
      (error: unknown) => { session.listing = null; if (session.operation === 0) fail(session, error); },
    );
    return () => {
      controller.abort();
      if (current.current === session) current.current = null;
      destroyDocuments(session.documents);
    };
  }, [client, uuid, key, update, fail]);
  const session = view?.session;
  const state = view !== null && session?.client === client && session.uuid === uuid && session.key === key && current.current === session ? view.state : initial;
  useEffect(() => {
    const owner = current.current;
    if (liveDocument !== null && state.active && owner !== null && owner.startingHash === null) captureStartingPoint(owner, liveDocument);
  }, [liveDocument, state.active]);
  const select = (target: Target, relist = false, fromRoute = false): Promise<void> => selectTarget(
    current.current, target, liveDocument, update, fail, view => routing.current?.navigate(view), relist, fromRoute);
  const mutate = (write: (owner: Session) => Promise<RevisionEntry>): Promise<void> => mutateName(current.current, write, update);
  const reload = async (owner: Session, operation: number): Promise<void> => {
    owner.retryRefresh = true;
    await reloadSelection(owner, operation, update);
    if (owner.operation === operation) owner.retryRefresh = false;
  };
  const refresh = (): void => {
    const owner = current.current;
    if (owner === null || owner.state.busy) return;
    const operation = ++owner.operation;
    captureStartingPoint(owner, liveDocument);
    update(owner, { busy: true, error: null, downloading: false });
    void reload(owner, operation).catch((error: unknown) => { if (owner.operation === operation) fail(owner, error); });
  };
  const refreshRefusedRestore = async (owner: Session, operation: number, error: unknown): Promise<void> => {
    if (owner.operation !== operation) return;
    if (error instanceof DocumentHistoryError && ["stale-state", "restore-outcome-unknown", "unreachable"].includes(error.reason ?? "")) {
      captureStartingPoint(owner, liveDocument);
      try { await reload(owner, operation); }
      catch (refreshError) { if (owner.operation === operation) fail(owner, refreshError); }
    }
    update(owner, { busy: false });
  };
  const restore = async (revisionId: string): Promise<boolean> => {
    const owner = current.current;
    if (owner === null || owner.state.busy) throw new Error("Wait for history to load and try again.");
    const startingHash = owner.startingHash;
    if (startingHash === null) throw new Error("Wait for the live document to load, then reopen history and try again.");
    const operation = ++owner.operation;
    update(owner, { busy: true, error: null });
    let applied: boolean | null = null;
    try {
      const checksum = await startingHash;
      if (checksum instanceof Error) throw checksum;
      if (owner.signal.aborted || owner.operation !== operation) throw new DOMException("Cancelled", "AbortError");
      const result = await owner.client.restore(owner.uuid, revisionId, checksum, owner.signal);
      applied = result.applied;
      captureStartingPoint(owner, liveDocument);
      await reload(owner, operation);
      return applied;
    } catch (error) {
      await refreshRefusedRestore(owner, operation, error);
      if (applied !== null) throw new Error("The document was restored, but history couldn't refresh. Refresh history to see the result.");
      throw error;
    }
  };
  const close = useCallback((fromRoute = false): void => {
    const owner = current.current;
    if (owner !== null) {
      owner.operation++;
      owner.retryTarget = null;
      owner.retryRefresh = false;
      owner.requestedView = null;
      update(owner, { selection: null, active: false, error: null, downloading: false, busy: false, filter: "all" });
    }
    if (!fromRoute) routing.current?.navigate(null);
  }, [update]);
  const selectRef = useRef(select);
  selectRef.current = select;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useHistoryPolling(session, selectRef, refreshRef, update, fail);
  const routeControlled = route !== undefined;
  const revision = route?.view?.revision;
  const since = route?.view?.since;
  useEffect(() => {
    const owner = current.current;
    if (!routeControlled || owner === null || owner.client !== client || owner.uuid !== uuid || owner.key !== key) return;
    const next = revision === undefined ? null : { revision, ...(since === undefined ? {} : { since }) };
    if (sameView(owner.requestedView, next)) return;
    owner.requestedView = next;
    if (next === null) close(true);
    else void selectRef.current({ id: next.revision, ...(next.since === undefined ? {} : { since: next.since }) }, false, true);
  }, [client, uuid, key, routeControlled, revision, since, close]);
  // A new address never displays the previous address's comparison or live editor.
  const displayed = displayedState(state, session, route);
  const { selection, entries, filter } = displayed;
  const canBack = selection !== null && (filter === "named" ? namedStep(entries ?? [], selection.index, 1) >= 0 : selection.index < (entries?.length ?? 0) - 1);
  const canForward = selection !== null && (filter === "named" ? namedStep(entries ?? [], selection.index, -1) >= 0 : true);
  const setFilter = (next: HistoryState["filter"]): void => {
    const owner = current.current;
    if (owner === null || owner.state.filter === next || owner.state.busy) return;
    update(owner, { filter: next });
    const selected = owner.state.selection;
    if (selected === null || owner.state.entries?.[selected.index]?.name == null) return;
    if (selected.index === 0 && selected.comparedWith?.name != null) return;
    void select({ index: selected.index, named: next === "named" });
  };
  return {
    ...displayed,
    setFilter,
    canBack,
    canForward,
    available: client !== null && uuid !== null,
    connected: displayed.history?.offline === false,
    ...preferences,
    entry: displayed.selection?.entry ?? null,
    back: () => { if (selection === null || canBack) void select({ step: 1, named: filter === "named" }); },
    forward: () => {
      if (!canForward) return;
      if (filter === "all" && selection?.index === 0) close();
      else void select({ step: -1, named: filter === "named" });
    },
    open: (index: number) => { void select({ index, named: filter === "named" }); },
    openSession: (index: number, since: string) => {
      const entry = entries?.[index];
      if (entry !== undefined) void select({ id: entry.id, since });
    },
    sinceLastNamed: () => { void select({ since: null }); },
    sinceNamed: (id: string) => { void select({ since: id }); },
    name: (name: string, checksum: string) => mutate(owner => owner.client.name(owner.uuid, name, checksum, owner.signal)),
    rename: (revisionId: string, name: string) => mutate(owner => owner.client.rename(owner.uuid, revisionId, name, owner.signal)),
    removeName: (revisionId: string) => mutate(owner => owner.client.removeName(owner.uuid, revisionId, owner.signal)),
    restore,
    now: () => close(),
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
