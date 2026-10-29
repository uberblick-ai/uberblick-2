import { isLoopbackHost } from "@uberblick/schema/loopback";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { PaneNotice } from "../document/EditorPane.js";
import { Button } from "../shadcn/button.js";
import { NativeSelect } from "../shadcn/native-select.js";
import { BrowserHubSignInControls, postBrowser, useBrowserSignIn } from "./BrowserHubSignIn.js";

type AccessLevel = "read-only" | "read-write";
interface PendingRequest {
  clientName: string;
  redirectHost: string;
  workspaceId: string;
  workspaceName: string | null;
  accessLevels: AccessLevel[];
}
type Reading = { status: "pending"; request: PendingRequest } |
  { status: "checking" | "unknown-request" | "not-a-member" | "failed" | "redirecting" };

const START_AGAIN = "This request is no longer available. Start again from the agent.";
const NO_CLAIM = (): void => {};

function pendingRequest(body: Record<string, unknown>): PendingRequest {
  if (body.status !== "pending" || typeof body.clientName !== "string" ||
      typeof body.redirectHost !== "string" || typeof body.workspaceId !== "string" ||
      (body.workspaceName !== null && typeof body.workspaceName !== "string") ||
      !Array.isArray(body.accessLevels) || body.accessLevels[0] !== "read-only" ||
      !(body.accessLevels.length === 1 || (body.accessLevels.length === 2 && body.accessLevels[1] === "read-write"))) throw new Error();
  return { clientName: body.clientName, redirectHost: body.redirectHost,
    workspaceId: body.workspaceId, workspaceName: body.workspaceName, accessLevels: body.accessLevels };
}

function ConsentRequest({ requestId, token, signedOut, onBusy }: {
  requestId: string;
  token: string;
  signedOut: (token: string, message: string) => void;
  onBusy: (busy: boolean) => void;
}): ReactElement {
  const [reading, setReading] = useState<Reading>({ status: "checking" });
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("read-only");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const submitting = useRef(false);
  const active = useRef(false);
  const requests = useRef(new Set<AbortController>());

  const refusal = useCallback((response: Response, body: Record<string, unknown>): boolean => {
    if (response.status === 401 && body.status === "signed-out") {
      signedOut(token, "Your browser session has ended. Sign in again.");
    } else if (response.status === 404 && body.status === "unknown-request") {
      setReading({ status: "unknown-request" });
    } else if (response.status === 403 && body.status === "not-a-member") {
      setReading({ status: "not-a-member" });
    } else return false;
    return true;
  }, [signedOut, token]);

  const read = useCallback(async (): Promise<void> => {
    const inFlight = requests.current;
    setReading({ status: "checking" });
    try {
      const { response, body } = await postBrowser(inFlight, "/oauth/consent/read", { requestId }, token);
      if (!active.current || inFlight !== requests.current) return;
      if (refusal(response, body)) return;
      if (!response.ok) throw new Error();
      setReading({ status: "pending", request: pendingRequest(body) });
    } catch {
      if (active.current && inFlight === requests.current) setReading({ status: "failed" });
    }
  }, [requestId, token, refusal]);

  useEffect(() => {
    active.current = true;
    void read();
    return () => {
      active.current = false;
      for (const request of requests.current) request.abort();
      requests.current = new Set();
    };
  }, [read]);

  async function submit(decision: "approve" | "deny"): Promise<void> {
    if (submitting.current || reading.status !== "pending") return;
    submitting.current = true;
    setBusy(true);
    onBusy(true);
    setSubmitError(false);
    try {
      const { response, body } = await postBrowser(requests.current, "/oauth/consent/submit",
        decision === "approve" ? { requestId, decision, accessLevel } : { requestId, decision }, token);
      if (!active.current) return;
      if (refusal(response, body)) return;
      if (!response.ok || body.status !== (decision === "approve" ? "approved" : "denied") ||
          typeof body.redirectUrl !== "string") throw new Error();
      setReading({ status: "redirecting" });
      window.location.assign(body.redirectUrl);
    } catch {
      if (active.current) setSubmitError(true);
    } finally {
      submitting.current = false;
      if (active.current) { setBusy(false); onBusy(false); }
    }
  }

  if (reading.status === "checking") return <p role="status">Checking the agent’s request…</p>;
  if (reading.status === "unknown-request") return <p role="status">{START_AGAIN}</p>;
  if (reading.status === "not-a-member") return <p role="status">You are not a member of this workspace. Sign out to sign in with another GitHub account.</p>;
  if (reading.status === "failed") return <>
    <p role="alert">The hub could not read this request.</p>
    <Button variant="outline" onClick={() => void read()}>Try again</Button>
  </>;
  if (reading.status !== "pending") return <p role="status">Returning to the agent…</p>;
  const request = reading.request;
  const loopback = isLoopbackHost(new URL(`http://${request.redirectHost}`).hostname);
  return <section className="mt-6 space-y-4" aria-label="Agent request">
    <dl className="space-y-3">
      <div><dt className="font-semibold">Agent</dt><dd className="break-all">{request.clientName}</dd></div>
      <div><dt className="font-semibold">Browser returns to</dt><dd className="break-all">{request.redirectHost}</dd></div>
      <div><dt className="font-semibold">Workspace</dt><dd className="break-all">{request.workspaceName ?? request.workspaceId}</dd></div>
    </dl>
    {loopback && <p>The browser returns to an app on this computer. Approve only if you started this from an agent on this computer.</p>}
    <div className="space-y-2">
      <label className="block font-semibold" htmlFor="agent-access">Access</label>
      <NativeSelect id="agent-access" value={accessLevel} disabled={busy}
        onChange={event => setAccessLevel(event.target.value as AccessLevel)}>
        <option value="read-only">Read only</option>
        {request.accessLevels.includes("read-write") && <option value="read-write">Read and write</option>}
      </NativeSelect>
    </div>
    <p>Approving connects this agent to this workspace. Denying grants nothing.</p>
    {submitError && <p role="alert">The hub could not confirm your decision. Try again.</p>}
    <div className="flex gap-3">
      <Button disabled={busy} onClick={() => void submit("approve")}>Approve</Button>
      <Button variant="outline" disabled={busy} onClick={() => void submit("deny")}>Deny</Button>
    </div>
  </section>;
}

function ConnectSignIn({ requestId }: { requestId: string }): ReactElement {
  const signIn = useBrowserSignIn(NO_CLAIM);
  const [busy, setBusy] = useState(false);
  const token = signIn.session?.token;
  useEffect(() => { if (token === undefined) setBusy(false); }, [token]);
  return <>
    <BrowserHubSignInControls signIn={signIn} claimStateKnown={false} claimable={false} disabled={busy} showClaimResult={false} />
    {signIn.session !== null && <ConsentRequest key={`${requestId}:${signIn.session.token}`} requestId={requestId}
      token={signIn.session.token} signedOut={signIn.signedOut} onBusy={setBusy} />}
  </>;
}

export function ConnectAgent(): ReactElement {
  const requestId = new URLSearchParams(window.location.search).get("request");
  return <PaneNotice>
    <section className="mx-auto w-full max-w-xl p-6 text-(--foreground)" aria-label="Connect an agent">
      <h1 className="m-0 ub-type-h2 font-semibold">Connect an agent</h1>
      {window.top !== window.self ? <p className="mt-4">
        <a className="underline" href={window.location.href} target="_blank" rel="noopener noreferrer">Open this hub in its own browser tab</a>{" "}to connect an agent.
      </p> : !requestId ? <p className="mt-4" role="status">{START_AGAIN}</p> : <ConnectSignIn requestId={requestId} />}
    </section>
  </PaneNotice>;
}
