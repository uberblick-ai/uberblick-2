import type { DocumentHistory } from "./document-history.js";

export function newestHistoryLabel(history: DocumentHistory): string {
  const cache = history.history;
  return cache != null && (cache.offline || !cache.complete || cache.refreshFailed)
    ? "Newest downloaded state" : "Current version";
}

export function historyCacheMessage(history: DocumentHistory): string | null {
  const cache = history.history;
  if (cache == null) return null;
  const messages: string[] = [];
  if (cache.offline) messages.push(cache.lastRefresh === null && cache.newestDownloadedRevision === null ? "Offline." : "Offline. Showing downloaded history.");
  if (cache.refreshFailed) messages.push("Last history refresh failed.");
  if (!cache.complete) messages.push(cache.offline || cache.refreshFailed ? "History is not fully downloaded." : "History is still downloading…");
  return messages.length === 0 ? null : messages.join(" ");
}
