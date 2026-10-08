import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { PaneNotice } from "./EditorPane.js";

export const CLAIM_STATE_POLL_MS = 15_000;
export const CLAIM_STATE_TIMEOUT_MS = 5_000;

interface ClaimState {
  unclaimed: boolean;
  canClaim: boolean;
}

/** Only this public two-field answer establishes claim eligibility. */
async function readClaimState(signal: AbortSignal): Promise<ClaimState | null> {
  // Caddy's auth routes reach its co-located hub, even when WEB_HUB_URL points
  // the websocket elsewhere. The commands must name the hub that answered.
  const response = await fetch(new URL("/auth/claim-state", window.location.origin).href, {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) return null;
  const answer: unknown = await response.json();
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return null;
  const fields = Object.keys(answer);
  if (fields.length !== 2 || !fields.includes("unclaimed") || !fields.includes("canClaim")) return null;
  const state = answer as Record<string, unknown>;
  if (typeof state.unclaimed !== "boolean" || typeof state.canClaim !== "boolean" ||
    (state.canClaim && !state.unclaimed)) return null;
  return { unclaimed: state.unclaimed, canClaim: state.canClaim };
}

/** This component is mounted only behind the remote page's closed room gate. */
export function RemoteHubGuide(): ReactElement {
  const [state, setState] = useState<ClaimState | null | "checking">("checking");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | null = null;
    const poll = async (): Promise<void> => {
      const request = new AbortController();
      inFlight = request;
      let answer: ClaimState | null = null;
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            request.abort();
            reject(new Error("Hub claim-state request timed out"));
          }, CLAIM_STATE_TIMEOUT_MS);
        });
        answer = await Promise.race([readClaimState(request.signal), expired]);
      } catch {
        // A failed read, including the SPA fallback or an older hub's answer,
        // must remove a previously claimable reading rather than guess.
      } finally {
        clearTimeout(deadline);
        inFlight = null;
      }
      if (!active) return;
      setState(answer);
      // Claiming closes permanently. Otherwise wait after the completed read;
      // requests never overlap and an open tab learns a claim without reload.
      if (answer === null || answer.unclaimed) {
        timer = setTimeout(() => void poll(), CLAIM_STATE_POLL_MS);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(deadline);
      inFlight?.abort();
    };
  }, []);

  const claimable = state !== null && state !== "checking" && state.canClaim;
  const closed = state !== null && state !== "checking" && !state.unclaimed;
  const origin = window.location.origin;
  const commandClass = "mt-2 block select-text break-all rounded-md bg-(--muted) p-3 font-mono text-sm text-(--foreground)";
  return (
    <PaneNotice>
      <section className="mx-auto w-full max-w-xl p-6 text-(--foreground)" aria-label="Hub setup guide">
        <div role="status">
          <h1 className="m-0 text-xl font-semibold">
            {state === "checking" ? "Checking this hub’s setup state…" :
              state === null ? "This hub’s setup state could not be confirmed" :
                closed ? "This hub can no longer be claimed" :
                  claimable ? "This hub is unclaimed" :
                    "GitHub sign-in is not configured on this hub"}
          </h1>
          {claimable && (
            <p className="mt-3">
              The first GitHub approval completed through the claim command below
              makes that account the first member and administrator of this hub’s
              default workspace. Claiming happens once.
            </p>
          )}
          {state !== null && state !== "checking" && state.unclaimed && !state.canClaim && (
            <p className="mt-3">This hub is unclaimed but cannot accept a claim.</p>
          )}
          {state === null && (
            <p className="mt-3">The hub did not return a confirmed setup state. This page will check again.</p>
          )}
        </div>
        <p className="mt-3">
          This browser is not signed in. Browser sign-in is not available yet.
          This page has no document access.
        </p>
        {(claimable || closed) && (
          <>
            <h2 className="mt-6 text-base font-semibold">
              {claimable ? "Claim from your computer" : "Work from your computer"}
            </h2>
            <p className="mt-2">
              Use the <code>ub</code> command line on a computer that can reach this hub.
              {closed && " You must already be a member of one of its workspaces. Signing in grants no membership."}
            </p>
            <ol className="mt-4 list-decimal space-y-4 pl-5">
              <li>
                {claimable ? "Run the claim command and complete its GitHub approval:" : "Sign in on that computer:"}
                <code className={commandClass}>{`ub auth login '${origin}'`}</code>
              </li>
              <li>
                {claimable ? "Join the default workspace. Replace <workspace-id> with the workspace UUID reported by the claiming login:" :
                  "If this computer is not already bound to the workspace, join it. Replace <workspace-id> with its UUID from the claiming login’s report or a workspace administrator:"}
                <code className={commandClass}>{`ub workspace join '${origin}/<workspace-id>'`}</code>
              </li>
              <li>
                Open the browser served by that computer to read and edit its local copy:
                <code className={commandClass}>ub open</code>
              </li>
            </ol>
            <p className="mt-4 text-sm text-(--muted-foreground)">
              These steps do not sign this browser in or open documents to visitors here.
            </p>
          </>
        )}
      </section>
    </PaneNotice>
  );
}
