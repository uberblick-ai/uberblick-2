/** Refresh login/logout without retaining an account after a failed reading. */
import { useEffect, useState } from "react";
import type { AccountClient, AccountIdentity } from "../shell/account.js";
import { SERVING_STATUS_POLL_MS, SERVING_STATUS_TIMEOUT_MS } from "./serving-status.js";

const UNAVAILABLE: AccountIdentity = { state: "unavailable" };

export function useServingAccount(client: AccountClient | null): AccountIdentity {
  const [answer, setAnswer] = useState<{ client: AccountClient; account: AccountIdentity } | null>(null);

  useEffect(() => {
    if (client === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | null = null;
    const poll = async (): Promise<void> => {
      const request = new AbortController();
      inFlight = request;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            request.abort();
            reject(new Error("Account request timed out"));
          }, SERVING_STATUS_TIMEOUT_MS);
        });
        const account = await Promise.race([client(request.signal), expired]);
        if (active) setAnswer({ client, account });
      } catch {
        if (active) setAnswer({ client, account: UNAVAILABLE });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (inFlight === request) inFlight = null;
      }
      if (active) timer = setTimeout(() => void poll(), SERVING_STATUS_POLL_MS);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      inFlight?.abort();
    };
  }, [client]);

  return client !== null && answer?.client === client ? answer.account : UNAVAILABLE;
}
