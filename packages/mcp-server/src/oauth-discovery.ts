import type { IncomingMessage, ServerResponse } from "node:http";
import { isUuid } from "@uberblick/schema";
import {
  OAUTH_PROTECTED_RESOURCE_METADATA_PREFIX,
  OAUTH_SCOPES,
  protectedResourceMetadataUrl,
  workspaceResourceUrl,
} from "@uberblick/schema/oauth";

/** Public discovery needs only a configured issuer and the canonical id's form. */
export function handleProtectedResourceMetadata(
  issuer: string | undefined, request: IncomingMessage, response: ServerResponse,
): boolean {
  const path = request.url ?? "";
  if (!path.startsWith(OAUTH_PROTECTED_RESOURCE_METADATA_PREFIX)) return false;
  const workspaceId = path.slice(OAUTH_PROTECTED_RESOURCE_METADATA_PREFIX.length);
  if (issuer === undefined || workspaceId.length !== 36 || !isUuid(workspaceId)) {
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end();
    return true;
  }
  response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({
    resource: workspaceResourceUrl(issuer, workspaceId),
    authorization_servers: [issuer],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
  }));
  return true;
}

/** The host's token check calls this after it refuses workspace access. */
export function replyMcpUnauthorized(response: ServerResponse, issuer: string | undefined, workspaceId: string): void {
  response.writeHead(401, {
    "Cache-Control": "no-store",
    ...(issuer === undefined ? {} : {
      "WWW-Authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl(issuer, workspaceId)}", scope="${OAUTH_SCOPES.join(" ")}"`,
    }),
  });
  response.end();
}
