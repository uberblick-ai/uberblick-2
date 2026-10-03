/** Public sign-in identifies a person and issues a credential, never membership. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialRecord, CredentialRegistry } from "./credentials.js";
import { GithubDeviceFlow, type DeviceFlowCollection, type GithubSignInConfig } from "./github-device-flow.js";
import { type HubLogger, stderrLogger } from "./log.js";
import type { MembershipRegistry } from "./memberships.js";
import type { PrincipalRecord, PrincipalRegistry } from "./principals.js";

export type { GithubSignInConfig } from "./github-device-flow.js";
interface SignInResult {
  identity: PrincipalRecord;
  credential: { record: CredentialRecord; key: string };
}
export type SignInCollection = DeviceFlowCollection<SignInResult>;

export class GithubSignIn extends GithubDeviceFlow<SignInResult> {
  constructor(config: GithubSignInConfig, principals: PrincipalRegistry,
    credentials: CredentialRegistry, memberships: MembershipRegistry, log: HubLogger = stderrLogger) {
    super(config, ({ accountId, username }) => {
      const identity = principals.identify(accountId, username);
      const issued = credentials.issue({ principalId: identity.id, deviceId: crypto.randomUUID(),
        workspaces: memberships.workspacesFor(identity.id) });
      return { identity, credential: { record: issued.record, key: Buffer.from(issued.keyBytes).toString("base64url") } };
    }, log);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

/** HTTP bodies carry secrets; URLs, logs and browser configuration never do. */
export async function handleGithubSignIn(
  signIn: GithubSignIn | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const path = request.url ?? "";
  if (!path.startsWith("/auth/")) return false;
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (!["/auth/github/start", "/auth/github/collect", "/auth/github/cancel"].includes(path)) {
    reply(404, { status: "unknown-request" });
    return true;
  }
  if (signIn === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  if (request.method !== "POST" || request.headers.authorization !== undefined ||
      request.headers["content-type"]?.split(";")[0] !== "application/json") {
    reply(400, { status: "invalid-request" });
    return true;
  }
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 4096) throw new Error();
      chunks.push(bytes);
    }
    const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (path === "/auth/github/start") {
      if (Object.keys(body).length !== 0) throw new Error();
      const result = await signIn.start();
      reply(result.status === "failed" ? 502 : result.status === "busy" ? 429 : 200, result);
    } else {
      if (Object.keys(body).length !== 2 || typeof body.requestId !== "string" ||
          typeof body.collectionSecret !== "string") throw new Error();
      const result = path.endsWith("/cancel")
        ? signIn.cancel(body.requestId, body.collectionSecret)
        : await signIn.collect(body.requestId, body.collectionSecret);
      reply(result.status === "unknown-request" ? 404 : 200, result);
    }
  } catch {
    reply(400, { status: "invalid-request" });
  }
  return true;
}
