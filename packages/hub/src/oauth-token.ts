import type { IncomingMessage, ServerResponse } from "node:http";
import { replyJson } from "./http.js";
import type { OAuthAuthorizations } from "./oauth-authorizations.js";

const MAX_TOKEN_REQUEST_BYTES = 16_384;

function refuse(response: ServerResponse, error: string, status = 400, headers: Record<string, string> = {}): void {
  replyJson(response, status, { error }, { Pragma: "no-cache", ...headers });
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  let size = 0;
  const chunks: Buffer[] = [];
  // Keep the socket available for the OAuth error when the bounded read stops early.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_TOKEN_REQUEST_BYTES) {
      request.resume();
      throw new Error();
    }
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export async function handleOAuthToken(
  issuer: string | undefined, signInConfigured: boolean, authorizations: OAuthAuthorizations | undefined,
  request: IncomingMessage, response: ServerResponse,
): Promise<boolean> {
  if (request.url?.split("?")[0] !== "/oauth/token") return false;
  if (issuer === undefined || !signInConfigured || authorizations === undefined) {
    response.writeHead(404, { "Cache-Control": "no-store", Pragma: "no-cache" });
    response.end();
    return true;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store", Pragma: "no-cache" });
    response.end();
    return true;
  }
  if (request.headers.authorization !== undefined) {
    // Only the authentication scheme enters the challenge, never its credentials.
    const scheme = request.headers.authorization.match(/^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)[ \t]+\S/)?.[1] ?? "Basic";
    refuse(response, "invalid_client", 401, { "WWW-Authenticate": `${scheme} realm="oauth"` });
    return true;
  }
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    refuse(response, "invalid_request");
    return true;
  }
  let parameters: URLSearchParams;
  try { parameters = await readForm(request); }
  catch {
    refuse(response, "invalid_request");
    return true;
  }
  if ([...parameters.keys()].some(key => parameters.getAll(key).length !== 1) || !parameters.get("grant_type")) {
    refuse(response, "invalid_request");
    return true;
  }
  if (parameters.get("grant_type") !== "authorization_code") {
    refuse(response, "unsupported_grant_type");
    return true;
  }
  const code = parameters.get("code");
  const codeVerifier = parameters.get("code_verifier");
  const clientId = parameters.get("client_id");
  const redirectUri = parameters.get("redirect_uri");
  if (!code || !codeVerifier || !clientId || !redirectUri) {
    refuse(response, "invalid_request");
    return true;
  }
  const resource = parameters.get("resource");
  try {
    const result = authorizations.exchange({ code, codeVerifier, clientId, redirectUri,
      ...(resource ? { resource } : {}) });
    if (result.status !== "issued") refuse(response, result.status);
    else replyJson(response, 200, { access_token: result.accessToken, token_type: "Bearer", expires_in: 3600,
      scope: result.scope }, { Pragma: "no-cache" });
  } catch { refuse(response, "server_error", 500); }
  return true;
}
