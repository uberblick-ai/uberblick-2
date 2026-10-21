/** Public renewal exchanges a device's key, without an identity-provider call. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialRegistry } from "./credentials.js";
import type { HubLogger } from "./log.js";
import type { MembershipRegistry } from "./memberships.js";
import { type AuthEnvelope, protocolMismatchReason, readAuthEnvelope } from "@uberblick/schema/protocol";
import { addWorkspaceNames, type WorkspaceNameReader } from "./workspace-names.js";
import { isCredentialPublicKey } from "@uberblick/schema/token";
import { isJsonPost, readJsonRequest, replyJson } from "./http.js";

export async function handleCredentialRenewal(
  credentials: CredentialRegistry | undefined,
  memberships: MembershipRegistry | undefined,
  protocolVersion: number,
  log: HubLogger,
  request: IncomingMessage,
  response: ServerResponse,
  workspaceNames?: WorkspaceNameReader,
): Promise<boolean> {
  if (request.url !== "/auth/credential/renew") return false;
  const reply = (status: number, body: unknown): void => replyJson(response, status, body);
  if (credentials === undefined || memberships === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  if (!isJsonPost(request)) {
    reply(400, { status: "invalid-request" });
    return true;
  }
  let envelope: AuthEnvelope;
  let ifWorkspacesChanged = false;
  let publicKey = "";
  let rawPublicKey: unknown;
  try {
    const { text, body: fields } = await readJsonRequest(request);
    const parsed = readAuthEnvelope(text);
    if (parsed === null) throw new Error();
    if (Object.keys(fields).some(key => !["protocolVersion", "token", "publicKey", "ifWorkspacesChanged"].includes(key)) ||
      (fields.ifWorkspacesChanged !== undefined && fields.ifWorkspacesChanged !== true)) throw new Error();
    rawPublicKey = fields.publicKey;
    ifWorkspacesChanged = fields.ifWorkspacesChanged === true;
    envelope = parsed;
  } catch {
    reply(400, { status: "invalid-request" });
    return true;
  }
  if (envelope.protocolVersion !== protocolVersion) {
    reply(409, { status: "protocol-mismatch", reason: protocolMismatchReason(protocolVersion) });
    return true;
  }
  // Keep the credential-free protocol probe stable across upgrades.
  if ((envelope.token !== "" && !isCredentialPublicKey(rawPublicKey)) ||
    (rawPublicKey !== undefined && !isCredentialPublicKey(rawPublicKey))) {
    reply(400, { status: "invalid-request" });
    return true;
  }
  publicKey = typeof rawPublicKey === "string" ? rawPublicKey : "";
  try {
    const result = await credentials.renew(envelope.token, memberships, { publicKey, ifWorkspacesChanged });
    reply(result.status === "renewed" || result.status === "unchanged" ? 200 : 401,
      result.status === "renewed" && workspaceNames !== undefined ? addWorkspaceNames(result, workspaceNames) : result);
  } catch {
    // Storage or connection closure failed, rather than an invalid request.
    // Neither the input, key, crypto exception nor database error is logged.
    log({ event: "hub.credential.renewal.failed" });
    reply(500, { status: "failed" });
  }
  return true;
}
