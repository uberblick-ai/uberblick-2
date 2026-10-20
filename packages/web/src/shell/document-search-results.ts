import { useEffect, useState } from "react";
import { decisionCurrentRecord, decisionTopicState, resolveDecisionTopics } from "@uberblick/schema";
import type { DecisionTopicState, DirectoryEntry, SidebarGroup } from "@uberblick/schema";
import type { DocumentSearchClient } from "./document-search.js";

export type DocumentSearchSource = Pick<DocumentSearchClient, "search"> | null;

export type DocumentSearchRow = DirectoryEntry & {
  topicState?: DecisionTopicState;
  pinned: boolean;
  groupName: string | undefined;
  recordIds: readonly string[];
};

/** Invalid Date ranges read as absent in both sorting and topic timestamps. */
export function usableDocumentStamp(at: number | undefined): number | undefined {
  if (at === undefined) return undefined;
  return Number.isFinite(new Date(at).getTime()) ? at : undefined;
}

/** Live documents and topic representatives share identities across search surfaces. */
export function documentSearchRows(entries: readonly DirectoryEntry[], groups: readonly SidebarGroup[] = []): DocumentSearchRow[] {
  const groupOf = new Map<string, string>();
  for (const group of groups) {
    for (const uuid of group.docs) if (!groupOf.has(uuid)) groupOf.set(uuid, group.name);
  }
  const documents = entries.filter((entry) => !entry.deleted && entry.kind === undefined)
    .map((entry) => ({ ...entry, pinned: groupOf.has(entry.uuid), groupName: groupOf.get(entry.uuid), recordIds: [entry.uuid] }));
  const topics = resolveDecisionTopics(entries).filter((topic) => !topic.archived).flatMap((topic) => {
    const current = decisionCurrentRecord(topic);
    if (current === null) return [];
    const stamps = topic.records.flatMap((record) => {
      const stamp = usableDocumentStamp(record.updatedAt);
      return stamp === undefined ? [] : [stamp];
    });
    const pinnedUuid = [topic.topic, ...topic.records.map((record) => record.uuid)].find((uuid) => groupOf.has(uuid));
    return [{
      uuid: topic.topic,
      title: current.title,
      tags: current.tags,
      kind: "decision" as const,
      topicState: decisionTopicState(topic),
      approvalChanged: [topic.inForce, ...topic.conflicts].some((record) => record?.approvalChanged === true),
      ...(stamps.length === 0 ? {} : { updatedAt: Math.max(...stamps) }),
      pinned: pinnedUuid !== undefined,
      groupName: pinnedUuid === undefined ? undefined : groupOf.get(pinnedUuid),
      recordIds: topic.records.map((record) => record.uuid),
    }];
  });
  return [...documents, ...topics];
}

/** A topic takes the best rank of any matching record, including its history. */
export function rankDocumentSearchRows<T extends DocumentSearchRow>(rows: readonly T[], hits: readonly string[]): T[] {
  const ranks = new Map(hits.map((uuid, rank) => [uuid, rank]));
  return rows.flatMap((entry) => {
    const recordRanks = entry.recordIds.flatMap((uuid) => { const rank = ranks.get(uuid); return rank === undefined ? [] : [rank]; });
    return recordRanks.length === 0 ? [] : [{ entry, rank: Math.min(...recordRanks) }];
  }).sort((left, right) => left.rank - right.rank).map(({ entry }) => entry);
}

export function useDocumentSearch(query: string, client: DocumentSearchSource, entries: readonly DirectoryEntry[]): { hits: readonly string[]; unavailable: boolean; pending: boolean } {
  const [result, setResult] = useState<{ query: string; client: DocumentSearchSource; entries: readonly DirectoryEntry[]; hits: string[]; unavailable: boolean } | null>(null);
  useEffect(() => {
    if (query === "" || client === null) return;
    const request = new AbortController();
    void client.search(query, request.signal).then(
      (hits) => { if (!request.signal.aborted) setResult({ query, client, entries, hits, unavailable: false }); },
      () => { if (!request.signal.aborted) setResult({ query, client, entries, hits: [], unavailable: true }); },
    );
    return () => request.abort();
  }, [query, client, entries]);
  const current = result?.query === query && result.client === client ? result : null;
  const unavailable = query !== "" && (client === null || current?.unavailable === true);
  return { hits: current?.hits ?? [], unavailable, pending: query !== "" && !unavailable && current === null };
}
