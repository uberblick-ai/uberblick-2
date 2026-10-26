import { isLoopbackHost } from "./loopback.js";
import { isUuid } from "./workspace.js";

export const OAUTH_SCOPES = ["docs:read", "docs:write"] as const;
export const OAUTH_AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const OAUTH_PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource/mcp/";

/** The configured public origin is the issuer for both OAuth servers. */
export function parseHubPublicUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const invalid = () => new Error("HUB_PUBLIC_URL must be an HTTPS origin, or an HTTP origin with a loopback host, without userinfo, a path, query or fragment");
  // Check the original shape before URL normalizes dot paths, empty delimiters or controls.
  if (!/^https?:\/\/[^\s/?#@\\]+\/?$/i.test(raw) ||
    [...raw].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw invalid();
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { throw invalid(); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw invalid();
  }
  return url.origin;
}

function canonicalWorkspaceId(workspaceId: string): string {
  if (workspaceId.length !== 36 || !isUuid(workspaceId)) {
    throw new Error("OAuth workspace resource requires a canonical lowercase bare UUID");
  }
  return workspaceId;
}

/** Callers supply the issuer returned by parseHubPublicUrl. */
export function workspaceResourceUrl(issuer: string, workspaceId: string): string {
  return `${issuer}/mcp/${canonicalWorkspaceId(workspaceId)}`;
}

export function protectedResourceMetadataUrl(issuer: string, workspaceId: string): string {
  return `${issuer}${OAUTH_PROTECTED_RESOURCE_METADATA_PREFIX}${canonicalWorkspaceId(workspaceId)}`;
}
