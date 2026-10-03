/** Renew device authority without GitHub approval or any membership mutation. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { authReply, readAuthBody } from "./auth-http.js";
import type { CredentialRegistry } from "./credentials.js";
import type { MembershipRegistry } from "./memberships.js";
import { readAuthEnvelope } from "./protocol.js";
import { readTokenKeyId } from "./token.js";

export async function handleCredentialRenewal(
  credentials: CredentialRegistry | undefined,
  memberships: MembershipRegistry | undefined,
  protocolVersion: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (request.url !== "/auth/credential/renew") return false;
  const reply = (status: number, body: unknown) => authReply(response, status, body);
  if (credentials === undefined || memberships === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  let envelope: ReturnType<typeof readAuthEnvelope>;
  try {
    const body = await readAuthBody(request);
    if (Object.keys(body).length !== 2) throw new Error();
    envelope = readAuthEnvelope(JSON.stringify(body));
    if (envelope === null) throw new Error();
  } catch {
    reply(400, { status: "invalid-request" });
    return true;
  }
  // Version skew must be explained before any credential proof is read.
  if (envelope.protocolVersion !== protocolVersion) {
    reply(409, { status: "protocol-mismatch", protocolVersion });
    return true;
  }
  try {
    const result = await credentials.renew(envelope.token, memberships);
    if (result.status === "complete") {
      // A revocation can also land between renewal's resolution and this
      // continuation. Check again at the HTTP delivery boundary, with no await
      // between this authority read and sending the only copy of the new key.
      const presented = readTokenKeyId(envelope.token);
      if ("failure" in presented || presented.kid === null ||
          credentials.get(presented.kid)?.revokedAt !== null) {
        credentials.revoke(result.credential.record.id);
        reply(401, { status: "sign-in-required" });
        return true;
      }
      reply(200, { status: "complete", credential: { record: result.credential.record,
        key: Buffer.from(result.credential.keyBytes).toString("base64url") } });
    } else {
      reply(result.status === "sign-in-required" ? 401 : 409, result);
    }
  } catch {
    // Persistence or closure failure is not a malformed request. Never expose
    // an exception, a proof or a key in an answer or a log.
    reply(500, { status: "failed" });
  }
  return true;
}
