/** Only selected public account identity crosses the local browser boundary. */
import { mintHubAuthMessage } from "../collab/rooms.js";
import { localSessionHeaders } from "../collab/local-session.js";
import { isGithubAccountId, isGithubUsername } from "@uberblick/schema/github-identity";
import { isUuid } from "@uberblick/schema";

export type AccountIdentity =
  | { state: "signed-in"; handle: string; principalId?: string; accountId?: string }
  | { state: "signed-out" | "unavailable" };

export type AccountClient = (signal: AbortSignal) => Promise<AccountIdentity>;

function account(value: unknown, includeAccountId: boolean): AccountIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid account answer");
  }
  const body = value as Record<string, unknown>;
  if (body.state === "signed-in" && isGithubUsername(body.handle)) {
    const accountId = includeAccountId ? body.accountId : undefined;
    const principalId = includeAccountId ? undefined : body.principalId;
    if (accountId !== undefined && !isGithubAccountId(accountId)) {
      throw new Error("Invalid account answer");
    }
    if (principalId !== undefined && !isUuid(principalId)) {
      throw new Error("Invalid account answer");
    }
    return { state: body.state, handle: body.handle,
      ...(principalId === undefined ? {} : { principalId }),
      ...(accountId === undefined ? {} : { accountId }) };
  }
  if (body.state === "signed-out" || body.state === "unavailable") {
    return { state: body.state };
  }
  throw new Error("Invalid account answer");
}

function createIdentityClient(
  path: string,
  workspace: string,
  subject: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AccountClient {
  return async (signal) => {
    const response = await fetchImpl(path, {
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${await mintHubAuthMessage(workspace, subject)}`,
        ...await localSessionHeaders(),
      },
      signal,
    });
    if (!response.ok) throw new Error("Account unavailable");
    return account(await response.json(), path === "/api/device-login");
  };
}

export function createAccountClient(
  workspace: string,
  subject: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AccountClient {
  return createIdentityClient("/api/account", workspace, subject, fetchImpl);
}

/** Local stored sign-in stays readable while live management requests wait. */
export function createDeviceLoginClient(
  workspace: string,
  subject: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AccountClient {
  return createIdentityClient("/api/device-login", workspace, subject, fetchImpl);
}
