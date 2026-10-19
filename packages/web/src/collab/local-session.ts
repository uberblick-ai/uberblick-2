/**
 * `ub open` prints its address with a one-time launch secret in the fragment,
 * which the browser never sends. The page trades it once for a session kept in
 * origin storage, so every tab and a restarted `ub open` share it, and asks for
 * short-lived room tokens with that session. Workspace keys never reach the page.
 */

const LAUNCH = /^#launch=([A-Za-z0-9_-]{43})$/;
export const LOCAL_SESSION_KEY = "uberblick:ub-open-session";
const SESSION_HEADER = "X-Uberblick-Session";

let exchange: Promise<void> = Promise.resolve();
let missing = false;
const listeners = new Set<() => void>();

function stored(): string | null {
  try { return globalThis.localStorage?.getItem(LOCAL_SESSION_KEY) ?? null; }
  catch { return null; }
}

function store(session: string | null): void {
  try {
    if (session === null) globalThis.localStorage?.removeItem(LOCAL_SESSION_KEY);
    else globalThis.localStorage?.setItem(LOCAL_SESSION_KEY, session);
  } catch { /* the session then lasts only for this page */ }
}

function setMissing(value: boolean): void {
  if (missing === value) return;
  missing = value;
  for (const listener of listeners) listener();
}

/** Read and remove the launch secret before routing rewrites the address. */
export function takeLaunchSecret(location: Location = window.location, history: History = window.history): void {
  const launch = LAUNCH.exec(location.hash)?.[1];
  if (launch === undefined) return;
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  exchange = (async () => {
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ launch }),
      });
      const body: unknown = response.ok ? await response.json() : null;
      const session = (body as { session?: unknown } | null)?.session;
      if (typeof session === "string") store(session);
    } catch {
      // A refused or failed exchange leaves any earlier session in place.
    }
  })();
}

/** The page's session after any launch exchange; null marks it missing. */
export async function localSession(): Promise<string | null> {
  await exchange;
  const session = stored();
  setMissing(session === null);
  return session;
}

/** Same-origin API requests to `ub open` name the page's session. */
export async function localSessionHeaders(): Promise<Record<string, string>> {
  const session = await localSession();
  return session === null ? {} : { [SESSION_HEADER]: session };
}

/** A room token from `ub open`, or null when this page has no valid session. */
export async function localRoomToken(workspace: string, subject: string): Promise<string | null> {
  const session = await localSession();
  if (session === null) return null;
  const response = await fetch("/api/room-token", {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json", "Content-Type": "application/json", [SESSION_HEADER]: session },
    body: JSON.stringify({ workspace, subject }),
  });
  if (response.status === 401) {
    if (stored() === session) store(null);
    setMissing(true);
    return null;
  }
  const token = response.ok ? ((await response.json()) as { token?: unknown } | null)?.token : undefined;
  if (typeof token !== "string") throw new Error(`uberblick web: ub open refused a room token (${response.status})`);
  return token;
}

/** True once this page is known to have no session `ub open` accepts. */
export function localSessionMissing(): boolean {
  return missing;
}

export function subscribeLocalSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
