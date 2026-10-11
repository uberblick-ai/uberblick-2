/**
 * Store per-device preferences here; this module has no document, export or
 * hub write path. Consumers explicitly publish presence values.
 * Keep this module independent of synchronization. One versioned localStorage
 * key holds JSON; an incompatible shape uses a new key without migration.
 * Read through storage on each call. Unavailable/corrupt storage and invalid
 * field types fall back safely. Subscribers observe only this tab's setSetting
 * calls; there is no cross-tab storage listener.
 */

/** The one key. Namespaced, and versioned by name — see the file comment. */
export const SETTINGS_KEY = "uberblick.settings.v1";

/** Browser override or system preference for the token set. */
export type Appearance = "system" | "light" | "dark";

/** Add settings and defaults here; consumers do not write localStorage directly. */
export interface Settings {
  /** Published six-digit hex color; null uses the tab's random default. */
  presenceColor: string | null;
  /** Published in awareness and on new comments; null uses the serving default. */
  presenceName: string | null;
  /** Null follows the system's appearance preference. */
  appearance: Appearance | null;
}

/** What every field reads as when storage holds nothing usable for it. */
const DEFAULTS: Readonly<Settings> = {
  presenceColor: null,
  presenceName: null,
  appearance: null,
};

type Listener = () => void;

const listeners = new Set<Listener>();

/** Validate published colors as six-digit hex so peers never receive broken cursors. */
function storedColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

/** Blank names restore the default; a token subject must never be blank. */
function storedName(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

/** A stored appearance, or null — which reads as "follow the system". */
function storedAppearance(value: unknown): Appearance | null {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

/** Unavailable storage, invalid JSON and non-object blobs all return defaults. */
function readAll(): Settings {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    return { ...DEFAULTS };
  }
  if (raw === null) return { ...DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULTS };
  }
  const stored = parsed as Record<string, unknown>;
  return {
    presenceColor: storedColor(stored.presenceColor),
    presenceName: storedName(stored.presenceName),
    appearance: storedAppearance(stored.appearance),
  };
}

/** Read one setting. Never throws; corrupt storage reads as the default. */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return readAll()[key];
}

/**
 * Null removes the field; no retained fields removes the key. Notify even after
 * storage rejects a write so subscribers reread the value actually retained.
 */
export function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): void {
  const next: Settings = { ...readAll(), [key]: value };
  next.presenceName = storedName(next.presenceName);
  const kept = Object.entries(next).filter(([, held]) => held !== null);
  try {
    if (kept.length === 0) localStorage.removeItem(SETTINGS_KEY);
    else localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage refused the write; this tab's readers still get the truth below.
  }
  for (const listener of [...listeners]) listener();
}

/** Watch for changes made in this tab. Returns the unsubscribe. */
export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
