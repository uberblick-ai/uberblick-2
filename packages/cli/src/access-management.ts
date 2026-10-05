/** Signed access requests share transport, never command-specific authority. */
import type { StoredHubLogin } from "@uberblick/hub/auth-store";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { importCredentialKey, mintRequestProof, type RequestAction } from "@uberblick/hub/token";

export type ManagementAction = Exclude<RequestAction, { operation: "renew-credential" }>;

export class ManagementResponseError extends Error {
  constructor(readonly updateRequired = false) {
    super("hub returned an invalid management response");
  }
}

/** Bound headers and body together; proofs go only to the selected origin. */
export async function manageRequest(
  origin: string,
  action: ManagementAction,
  login: StoredHubLogin,
  options: { signal?: AbortSignal; maxResponseBytes?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = await mintRequestProof(await importCredentialKey(Buffer.from(login.credential.key, "base64url")), {
    ...action, kid: login.credential.record.id, lifetimeSeconds: 60,
  });
  const response = await fetch(`${origin}/auth/manage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...action, token, protocolVersion: SYNC_PROTOCOL_VERSION }),
    redirect: "error",
    signal: AbortSignal.any([...(options.signal === undefined ? [] : [options.signal]), AbortSignal.timeout(10_000)]),
  });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ManagementResponseError(true);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > (options.maxResponseBytes ?? 65_536)) throw new ManagementResponseError();
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ManagementResponseError(true); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ManagementResponseError();
  return { status: response.status, body: body as Record<string, unknown> };
}
