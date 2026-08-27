/**
 * Local settings: this machine, this browser, and nowhere else (#176).
 *
 * "Local" is the whole point. What lives here is what *cannot* be synced —
 * per-device preferences — so this module deliberately imports nothing from the
 * collab layer and holds no reference to a Y.Doc. A settings value has no path
 * to a document, an export, or the hub: the only way one could get there is if
 * some other module read it and wrote it on, which is a review question rather
 * than an accident waiting in this file.
 *
 * One namespaced, versioned key holds one JSON object. The version is in the
 * key itself, so a future shape is a new key and the old blob is simply never
 * read again — no migration branch, no half-understood object.
 *
 * Reads are read-through rather than cached: localStorage is the state, and a
 * cache would be a second copy to keep honest across tabs. Every read is
 * defensive — an unparseable blob, a JSON array, a field of the wrong type all
 * degrade to the default for that field. Corrupt storage returns defaults; it
 * never throws, because the alternative is a user menu that cannot open to fix
 * the thing that broke it.
 *
 * The subscription is same-tab only: `setSetting` notifies, so open UI reacts.
 * A write in another tab is not observed (no `storage` listener) — nobody has
 * needed it, and inventing it would be a contract to maintain for nothing.
 */

/** The one key. Namespaced, and versioned by name — see the file comment. */
export const SETTINGS_KEY = "uberblick.settings.v1";

/**
 * How the app picks its token set: the system's preference, or the override
 * this browser was told to keep (#74).
 */
export type Appearance = "system" | "light" | "dark";

/**
 * Every local setting there is. New consumers add a field here and a default
 * below; nothing else in the app may reach for localStorage to store one.
 */
export interface Settings {
  /**
   * The presence colour this browser picked, `#rrggbb`, or null for the random
   * one the tab was given (#74).
   *
   * The one field here that leaves the machine, and deliberately: it is
   * published in awareness, because a colour peers cannot see is not a presence
   * colour. Nothing else here may grow that property without saying so.
   */
  presenceColor: string | null;
  /** The appearance override, or null to follow the system's preference (#74). */
  appearance: Appearance | null;
}

/** What every field reads as when storage holds nothing usable for it. */
const DEFAULTS: Readonly<Settings> = {
  presenceColor: null,
  appearance: null,
};

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * A stored presence colour, or null for anything else.
 *
 * Validated rather than merely typed, because this is the field that gets
 * *published*: y-prosemirror accepts `#rrggbb` and warns on everything else, so
 * a hand-edited blob must not become a peer's broken cursor.
 */
function storedColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

/** A stored appearance, or null — which reads as "follow the system". */
function storedAppearance(value: unknown): Appearance | null {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

/**
 * The whole settings object as it currently reads.
 *
 * Every failure mode lands on the same answer — the defaults — because there is
 * nothing better to say: unavailable storage (a browser with site data blocked,
 * a private window), a blob that is not JSON, JSON that is not an object.
 */
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
    appearance: storedAppearance(stored.appearance),
  };
}

/** Read one setting. Never throws; corrupt storage reads as the default. */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return readAll()[key];
}

/**
 * Write one setting and notify subscribers.
 *
 * Null is erasure, not a stored null: fields at their default are dropped from
 * the serialised object, and an object with nothing left in it removes the key
 * entirely. Clearing a setting therefore leaves no residue to find in
 * localStorage afterwards.
 *
 * Subscribers are notified even when the write itself failed. They re-read, so
 * what they see is the truth either way, and a UI frozen on a value storage
 * rejected would be the worse of the two lies.
 */
export function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): void {
  const next: Settings = { ...readAll(), [key]: value };
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
