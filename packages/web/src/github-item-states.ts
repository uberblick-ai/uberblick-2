import { githubItemKey, githubItemStateTtl } from "@uberblick/schema";
import type { GitHubItem, GitHubItemState } from "@uberblick/schema";
import type { GitHubItemStateReader, GitHubItemStateReadings } from "./shell/github-item-states.js";

export interface GitHubItemStates {
  get(item: GitHubItem): GitHubItemState | null;
  subscribe(items: readonly GitHubItem[], listener: () => void): () => void;
}

interface Subscription {
  items: ReadonlyMap<string, GitHubItem>;
  listener: () => void;
}

/** A workspace's transient readings, shared by all pills on the rendered page. */
export function createGitHubItemStates(read: GitHubItemStateReader): GitHubItemStates {
  const cache = new Map<string, { state: GitHubItemState | null; expires: number }>();
  const subscriptions = new Set<Subscription>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: AbortController | null = null;

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
    if (pending !== null) return;
    const active = activeItems();
    if (active.size === 0) return;
    let expires = Infinity;
    for (const key of active.keys()) expires = Math.min(expires, cache.get(key)?.expires ?? 0);
    // The next turn collects editor, comments and comparison subscriptions together.
    timer = setTimeout(() => { timer = null; void refresh(); }, Math.max(0, expires - Date.now()));
  };
  const refresh = async (): Promise<void> => {
    const items = activeItems();
    if (items.size === 0 || pending !== null) return;
    const controller = new AbortController();
    pending = controller;
    let answer: GitHubItemStateReadings = { states: {} };
    try { answer = await read([...items.values()], controller.signal); }
    catch { /* A failed optional reading has the same presentation as no answer. */ }
    if (pending !== controller) return;
    pending = null;
    const changed = new Set<string>();
    for (const key of items.keys()) {
      const state = answer.states[key] ?? null;
      const previous = cache.get(key);
      if ((previous?.state ?? null) !== state) changed.add(key);
      const remaining = answer.refreshAfterMs?.[key];
      const expires = remaining !== undefined
        ? Date.now() + remaining
        : previous?.state === state && previous.expires > Date.now()
          ? previous.expires : Date.now() + githubItemStateTtl(state);
      cache.set(key, { state, expires });
    }
    for (const subscription of [...subscriptions]) {
      if ([...subscription.items.keys()].some((key) => changed.has(key))) subscription.listener();
    }
    schedule();
  };

  return {
    get: (item) => cache.get(githubItemKey(item))?.state ?? null,
    subscribe: (items, listener) => {
      if (items.length === 0) return () => {};
      const subscription = { items: new Map(items.map((item) => [githubItemKey(item), item])), listener };
      subscriptions.add(subscription);
      schedule();
      return () => {
        subscriptions.delete(subscription);
        if (subscriptions.size === 0) {
          cancelTimer();
          pending?.abort();
          pending = null;
        } else schedule();
      };
    },
  };
}
