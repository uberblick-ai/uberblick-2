import type { IncomingMessage, ServerResponse } from "node:http";
import { OAUTH_AUTHORIZATION_SERVER_METADATA_PATH, OAUTH_SCOPES } from "@uberblick/schema/oauth";
import { replyJson } from "./http.js";

/** Discovery advertises only configured sign-in; request headers supply no URLs. */
export function handleAuthorizationServerMetadata(
  issuer: string | undefined,
  signInConfigured: boolean,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (request.url?.split("?")[0] !== OAUTH_AUTHORIZATION_SERVER_METADATA_PATH) return false;
  if (issuer === undefined || !signInConfigured) {
    response.writeHead(404);
    response.end();
    return true;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end();
    return true;
  }
  replyJson(response, 200, {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: OAUTH_SCOPES,
  });
  return true;
}
