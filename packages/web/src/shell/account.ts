/** Only the served account's public handle crosses the local browser boundary. */
import { mintHubAuthMessage } from "../collab/rooms.js";

export type AccountIdentity =
  | { state: "signed-in"; handle: string }
  | { state: "signed-out" | "unavailable" };

export type AccountClient = (signal: AbortSignal) => Promise<AccountIdentity>;

function account(value: unknown): AccountIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid account answer");
  }
  const body = value as Record<string, unknown>;
  if (body.state === "signed-in" && typeof body.handle === "string" &&
    body.handle.length <= 39 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(body.handle)) {
    return { state: body.state, handle: body.handle };
  }
  if (body.state === "signed-out" || body.state === "unavailable") {
    return { state: body.state };
  }
  throw new Error("Invalid account answer");
}

export function createAccountClient(
  workspace: string,
  subject: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AccountClient {
  return async (signal) => {
    const response = await fetchImpl("/api/account", {
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${await mintHubAuthMessage(workspace, subject)}`,
      },
      signal,
    });
    if (!response.ok) throw new Error("Account unavailable");
    return account(await response.json());
  };
}
