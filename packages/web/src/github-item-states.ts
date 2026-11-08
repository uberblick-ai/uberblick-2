import { githubItemKey, githubItemStateTtl, readGitHubItemObservations } from "@uberblick/schema";
import type { GitHubItem, GitHubItemState, GitHubItemObservation } from "@uberblick/schema";
import type * as Y from "yjs";
import type { GitHubItemStateReader, GitHubItemStateReadings } from "./shell/github-item-states.js";

export interface GitHubItemStates {
  get(item: GitHubItem): GitHubItemState | null;
  /** Present only for the workspace's fallback, never a fresh personal reading. */
  seenAt?(item: GitHubItem): number | null;
  subscribe(items: readonly GitHubItem[], listener: () => void): () => void;
}

interface Subscription {
  items: ReadonlyMap<string, GitHubItem>;
  listener: () => void;
  shown: Map<string, string>;
}

/** Fresh personal readings over the live workspace fallback, shared by every pill. */
export function createGitHubItemStates(read: GitHubItemStateReader | null, shared: Y.Doc | null = null): GitHubItemStates {
  const cache = new Map<string, { state: GitHubItemState | null; expires: number }>();
  const subscriptions = new Set<Subscription>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: AbortController | null = null;
  let clock: ReturnType<typeof setInterval> | null = null;
  let recorded = shared === null ? new Map<string, GitHubItemObservation>() : readGitHubItemObservations(shared);

  const reading = (key: string): { state: GitHubItemState | null; seenAt: number | null } => {
    if (shared !== null && subscriptions.size === 0) recorded = readGitHubItemObservations(shared);
    const own = cache.get(key);
    if (own?.state != null && own.expires > Date.now()) return { state: own.state, seenAt: null };
    const fallback = recorded.get(key);
    return { state: fallback?.state ?? null, seenAt: fallback?.seenAt ?? null };
  };
  const signature = (key: string): string => {
    const { state, seenAt } = reading(key);
    return JSON.stringify([state, seenAt, seenAt === null ? null : Math.floor(Math.max(0, Date.now() - seenAt) / 60_000)]);
  };
  const notify = (): void => {
    for (const subscription of [...subscriptions]) {
      let changed = false;
      for (const key of subscription.items.keys()) {
        const next = signature(key);
        if (subscription.shown.get(key) !== next) changed = true;
        subscription.shown.set(key, next);
      }
      if (changed) subscription.listener();
    }
  };
  const sharedChanged = (): void => {
    if (shared !== null) recorded = readGitHubItemObservations(shared);
    notify();
  };

  const activeItems = (): Map<string, GitHubItem> => {
    const active = new Map<string, GitHubItem>();
    for (const subscription of subscriptions) {
      for (const [key, item] of subscription.items) active.set(key, item);
    }
    return active;
  };
  const cancelTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (): void => {
    cancelTimer();
    if (pending !== null || read === null) return;
    const active = activeItems();
    if (active.size === 0) return;
    let expires = Infinity;
    for (const key of active.keys()) expires = Math.min(expires, cache.get(key)?.expires ?? 0);
    // The next turn collects editor, comments and comparison subscriptions together.
    timer = setTimeout(() => { timer = null; void refresh(); }, Math.max(0, expires - Date.now()));
  };
  const refresh = async (): Promise<void> => {
    const items = activeItems();
    if (items.size === 0 || pending !== null || read === null) return;
    notify();
    const controller = new AbortController();
    pending = controller;
    let answer: GitHubItemStateReadings = { states: {} };
    try { answer = await read([...items.values()], controller.signal); }
    catch { /* A failed optional reading has the same presentation as no answer. */ }
    if (pending !== controller) return;
    pending = null;
    for (const key of items.keys()) {
      const state = answer.states[key] ?? null;
      const previous = cache.get(key);
      const remaining = answer.refreshAfterMs?.[key];
      const expires = remaining !== undefined
        ? Date.now() + remaining
        : previous?.state === state && previous.expires > Date.now()
          ? previous.expires : Date.now() + githubItemStateTtl(state);
      cache.set(key, { state, expires });
    }
    notify();
    schedule();
  };

  return {
    get: (item) => reading(githubItemKey(item)).state,
    seenAt: (item) => reading(githubItemKey(item)).seenAt,
    subscribe: (items, listener) => {
      if (items.length === 0) return () => {};
      if (subscriptions.size === 0 && shared !== null) {
        recorded = readGitHubItemObservations(shared);
        shared.on("update", sharedChanged);
        clock = setInterval(notify, 60_000);
      }
      const subscription = { items: new Map(items.map((item) => [githubItemKey(item), item])), listener,
        shown: new Map(items.map((item) => [githubItemKey(item), signature(githubItemKey(item))])) };
      subscriptions.add(subscription);
      schedule();
      return () => {
        subscriptions.delete(subscription);
        if (subscriptions.size === 0) {
          cancelTimer();
          pending?.abort();
          pending = null;
          shared?.off("update", sharedChanged);
          if (clock !== null) clearInterval(clock);
          clock = null;
        } else schedule();
      };
    },
  };
}
