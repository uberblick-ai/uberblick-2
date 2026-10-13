import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Button } from "../shadcn/button.js";

export const BROWSER_SESSION_STORAGE_KEY = "uberblick.browser-session";
export const BROWSER_SESSION_POLL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 25_000;
const SESSION_STATUS_ERROR = "The hub could not confirm this browser’s session status. Try again.";

interface BrowserSession {
  token: string;
  username: string;
  expiresAt: number;
}

interface Approval {
  requestId: string;
  collectionSecret: string;
  verificationUri: string;
  userCode: string;
  interval: number;
  expiresAt: number;
}

interface Answer {
  response: Response;
  body: Record<string, unknown>;
}

function storedToken(): string | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY) ?? "null");
    if (saved !== null && typeof saved === "object" && "token" in saved &&
        typeof saved.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(saved.token)) return saved.token;
  } catch { /* Storage may be unavailable; this page can still sign in. */ }
  return null;
}

function forgetToken(token: string): void {
  try {
    if (storedToken() === token) localStorage.removeItem(BROWSER_SESSION_STORAGE_KEY);
  } catch { /* A retained token is refused by the hub after revocation or expiry. */ }
}

function sessionFields(value: unknown): { username: string; expiresAt: number } | null {
  if (value === null || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  return typeof fields.username === "string" && fields.username !== "" &&
    typeof fields.expiresAt === "number" && Number.isSafeInteger(fields.expiresAt) && fields.expiresAt > 0
    ? { username: fields.username, expiresAt: fields.expiresAt } : null;
}

async function postBrowser(requests: Set<AbortController>, path: string, body: object, token: string | undefined, timeoutMs: number): Promise<Answer> {
  const request = new AbortController();
  requests.add(request);
  const deadline = setTimeout(() => request.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(`/auth/browser/${path}`, window.location.origin).href, {
      method: "POST", credentials: "omit", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", Accept: "application/json",
        ...(token === undefined ? {} : { "X-Uberblick-Session": token }) },
      body: JSON.stringify(body), signal: request.signal,
    });
    const answer: unknown = await response.json();
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) throw new Error();
    return { response, body: answer as Record<string, unknown> };
  } finally {
    clearTimeout(deadline);
    requests.delete(request);
  }
}

function useSessionPolling(session: BrowserSession | null, busy: { current: boolean }, checkSession: (token: string) => Promise<void>): void {
  useEffect(() => {
    if (session === null) return;
    const expiry = setTimeout(() => void checkSession(session.token), Math.max(0, session.expiresAt - Date.now()));
    const poll = setInterval(() => { if (!busy.current) void checkSession(session.token); }, BROWSER_SESSION_POLL_MS);
    return () => { clearTimeout(expiry); clearInterval(poll); };
  }, [session, busy, checkSession]);
}

function useBrowserSignIn(onClaim: () => void) {
  const [availability, setAvailability] = useState<"checking" | "configured" | "not-configured" | "unavailable">("checking");
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [claimedWorkspaceId, setClaimedWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const mounted = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const onClaimRef = useRef(onClaim);
  onClaimRef.current = onClaim;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const post = useCallback((path: string, body: object = {}, token?: string, timeoutMs = REQUEST_TIMEOUT_MS) =>
    postBrowser(requests.current, path, body, token, timeoutMs), []);

  const signedOut = useCallback((token: string, message: string | null = null): void => {
    if (tokenRef.current !== token) return;
    tokenRef.current = null;
    forgetToken(token);
    setSession(null);
    setClaimedWorkspaceId(null);
    setError(message);
  }, []);

  const checkSession = useCallback(async (token: string | null): Promise<void> => {
    try {
      const { response, body } = await post("session", {}, token ?? undefined, 5_000);
      if (!mounted.current || tokenRef.current !== token) return;
      if (response.status === 503 && body.status === "not-configured") {
        setAvailability("not-configured");
        return;
      }
      if (response.status === 401 && body.status === "signed-out") {
        setAvailability("configured");
        if (token !== null) signedOut(token, "Your browser session has ended. Sign in again.");
        return;
      }
      const fields = sessionFields(body);
      if (!response.ok || body.status !== "signed-in" || token === null || fields === null) throw new Error();
      setAvailability("configured");
      setError((current) => current === SESSION_STATUS_ERROR ? null : current);
      setSession((previous) => previous?.token === token && previous.username === fields.username && previous.expiresAt === fields.expiresAt
        ? previous : { token, ...fields });
    } catch {
      if (!mounted.current || tokenRef.current !== token) return;
      if (token === null || sessionRef.current === null) setAvailability("unavailable");
      setError(SESSION_STATUS_ERROR);
    }
  }, [post, signedOut]);

  useEffect(() => {
    mounted.current = true;
    tokenRef.current = storedToken();
    void checkSession(tokenRef.current);
    return () => {
      mounted.current = false;
      for (const request of requests.current) request.abort();
    };
  }, [checkSession]);

  useSessionPolling(session, busyRef, checkSession);

  const consumeCollection = useCallback(({ response, body }: Answer): number | null => {
    if (response.ok && body.status === "pending" && typeof body.interval === "number" && body.interval > 0) {
      setError(null);
      return body.interval;
    }
    if (response.ok && body.status === "complete") {
      const fields = sessionFields(body.session);
      const issued = body.session as Record<string, unknown> | undefined;
      if (fields === null || typeof issued?.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(issued.token)) throw new Error();
      const next = { token: issued.token, ...fields };
      tokenRef.current = next.token;
      setSession(next);
      setApproval(null);
      setError(null);
      try { localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(next)); }
      catch { setError("Signed in for this page, but this browser could not keep the session for reload."); }
      if (typeof body.claimedWorkspaceId === "string") {
        setClaimedWorkspaceId(body.claimedWorkspaceId);
        onClaimRef.current();
      }
      return null;
    }
    if (["denied", "expired", "abandoned", "failed", "collected", "unknown-request"].includes(String(body.status))) {
      setApproval(null);
      setError(body.status === "denied" ? "GitHub approval was denied. Sign in again when ready." :
        body.status === "expired" ? "The GitHub approval code has expired. Sign in again." :
          "GitHub sign-in did not complete. Sign in again.");
      return null;
    }
    throw new Error();
  }, []);

  useEffect(() => {
    if (approval === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let interval = approval.interval;
    const poll = async (): Promise<void> => {
      if (!active) return;
      if (Date.now() >= approval.expiresAt) {
        setApproval(null);
        setError("The GitHub approval code has expired. Sign in again.");
        return;
      }
      if (busyRef.current) { timer = setTimeout(() => void poll(), interval * 1000); return; }
      busyRef.current = true;
      setBusy("collect");
      try {
        const answer = await post("collect", {
          requestId: approval.requestId, collectionSecret: approval.collectionSecret,
        });
        if (!active || !mounted.current) return;
        const nextInterval = consumeCollection(answer);
        if (nextInterval === null) return;
        interval = nextInterval;
      } catch {
        if (active && mounted.current) setError("The hub could not confirm GitHub approval. This page will try again.");
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy("");
      }
      if (active) timer = setTimeout(() => void poll(), interval * 1000);
    };
    timer = setTimeout(() => void poll(), interval * 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [approval, post, consumeCollection]);

  async function start(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("start");
    setError(null);
    try {
      const { response, body } = await post("start");
      if (!mounted.current) return;
      if (response.status === 503 && body.status === "not-configured") { setAvailability("not-configured"); return; }
      if (!response.ok || body.status !== "pending" || typeof body.requestId !== "string" ||
          typeof body.collectionSecret !== "string" || body.verificationUri !== "https://github.com/login/device" ||
          typeof body.userCode !== "string" || typeof body.interval !== "number" || body.interval <= 0 ||
          typeof body.expiresIn !== "number" || body.expiresIn <= 0) throw new Error();
      setApproval({ requestId: body.requestId, collectionSecret: body.collectionSecret,
        verificationUri: body.verificationUri, userCode: body.userCode, interval: body.interval,
        expiresAt: Date.now() + body.expiresIn * 1000 });
    } catch {
      if (mounted.current) setError("GitHub sign-in could not start. Try again.");
    } finally { busyRef.current = false; if (mounted.current) setBusy(""); }
  }

  async function cancel(): Promise<void> {
    if (busyRef.current || approval === null) return;
    busyRef.current = true;
    setBusy("cancel");
    try {
      const { response, body } = await post("cancel", { requestId: approval.requestId, collectionSecret: approval.collectionSecret });
      if (!mounted.current) return;
      if (!response.ok || !["abandoned", "expired", "denied", "failed"].includes(String(body.status))) throw new Error();
      setApproval(null);
      setError(null);
    } catch {
      if (mounted.current) setError("The hub could not confirm cancellation. GitHub sign-in may still finish. Try again.");
    } finally { busyRef.current = false; if (mounted.current) setBusy(""); }
  }

  async function signOut(): Promise<void> {
    if (busyRef.current || session === null) return;
    busyRef.current = true;
    setBusy("sign-out");
    try {
      const { response, body } = await post("sign-out", {}, session.token);
      if (!mounted.current) return;
      if ((!response.ok && response.status !== 401) || body.status !== "signed-out") throw new Error();
      signedOut(session.token);
    } catch {
      if (mounted.current) setError("The hub could not confirm sign-out. Your session may still be active. Try again.");
    } finally { busyRef.current = false; if (mounted.current) setBusy(""); }
  }

  function retry(): void {
    setAvailability("checking");
    setError(null);
    tokenRef.current = storedToken();
    void checkSession(tokenRef.current);
  }

  return { availability, session, approval, claimedWorkspaceId, error, busy, start, cancel, signOut, retry };
}

/** The session is sent only to this page's origin, never to a configured websocket hub. */
export function BrowserHubSignIn({ claimStateKnown, claimable, onClaim }: {
  claimStateKnown: boolean;
  claimable: boolean;
  onClaim: () => void;
}): ReactElement {
  const { availability, session, approval, claimedWorkspaceId, error, busy, start, cancel, signOut, retry } = useBrowserSignIn(onClaim);
  return (
    <section className="mt-4 space-y-3" aria-label="Browser sign-in">
      <div role="status">
        {session !== null ? <>
          <p>Signed in as <strong>{session.username}</strong>.</p>
          {claimedWorkspaceId !== null && <p className="mt-2">Claimed this hub: you are a hub administrator and administrator of the default workspace (<code>{claimedWorkspaceId}</code>).</p>}
        </> : <p>{availability === "checking" ? "Checking this browser’s sign-in…" : "This browser is not signed in."}</p>}
      </div>
      <p>This page has no document access. Browser sessions last 24 hours, with no automatic renewal.</p>
      {availability === "not-configured" && <p>Browser sign-in is not configured on this hub.</p>}
      {error !== null && <p role="alert">{error}</p>}
      {session !== null ? <Button variant="outline" disabled={busy !== ""} onClick={() => void signOut()}>
        {busy === "sign-out" ? "Signing out…" : "Sign out"}
      </Button> : approval !== null ? <>
        <p>Open <a className="underline" href={approval.verificationUri} target="_blank" rel="noopener noreferrer">{approval.verificationUri}</a> and enter this code:</p>
        <p className="select-text font-mono text-xl"><code>{approval.userCode}</code></p>
        <p role="status">Waiting for GitHub approval…</p>
        <Button variant="outline" disabled={busy !== ""} onClick={() => void cancel()}>Cancel sign-in</Button>
      </> : availability === "configured" ? <>
        {!claimStateKnown && <p>If this hub is unclaimed, the first GitHub account to finish approval claims it and becomes hub administrator and administrator of its default workspace.</p>}
        {!claimable && claimStateKnown && <p>Signing in grants no role or workspace membership.</p>}
        <Button disabled={busy !== ""} onClick={() => void start()}>{busy === "start" ? "Starting sign-in…" : "Sign in with GitHub"}</Button>
      </> : availability === "unavailable" && <Button variant="outline" onClick={retry}>Check sign-in again</Button>}
    </section>
  );
}
