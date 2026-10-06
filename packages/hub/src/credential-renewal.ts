/** Public renewal exchanges a device's key, without an identity-provider call. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialRegistry } from "./credentials.js";
import type { HubLogger } from "./log.js";
import type { MembershipRegistry } from "./memberships.js";
import { type AuthEnvelope, protocolMismatchReason, readAuthEnvelope } from "./protocol.js";
import { addWorkspaceNames, type WorkspaceNameReader } from "./workspace-names.js";

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
  const reply = (status: number, body: unknown): void => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (credentials === undefined || memberships === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  if (request.method !== "POST" || request.headers.authorization !== undefined ||
    request.headers["content-type"]?.split(";")[0] !== "application/json") {
    reply(400, { status: "invalid-request" });
    return true;
  }
  let envelope: AuthEnvelope;
  let ifWorkspacesChanged = false;
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 4096) throw new Error();
      chunks.push(bytes);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const body: unknown = JSON.parse(raw);
    const parsed = readAuthEnvelope(raw);
    if (body === null || typeof body !== "object" || Array.isArray(body) || parsed === null) throw new Error();
    const fields = body as Record<string, unknown>;
    if (Object.keys(fields).some(key => !["protocolVersion", "token", "ifWorkspacesChanged"].includes(key)) ||
      (fields.ifWorkspacesChanged !== undefined && fields.ifWorkspacesChanged !== true)) throw new Error();
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
  try {
    const result = await credentials.renew(envelope.token, memberships, { ifWorkspacesChanged });
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
