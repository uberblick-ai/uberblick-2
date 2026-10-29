import { type OAuthClient, UnsupportedOAuthClientAuthentication } from "./oauth-authorization.js";
import { fetchMetadataDocument, parseMetadataClientId } from "./oauth-metadata-fetch.js";
import { oauthRedirectUriAllowed } from "./oauth-redirect-uri.js";

export const METADATA_CACHE_TTL_MS = 5 * 60_000;
export const MAX_METADATA_CACHE_ENTRIES = 256;
export const MAX_CONCURRENT_METADATA_FETCHES = 8;

function metadataClient(value: unknown, clientId: string): OAuthClient | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  if (document.client_id !== clientId || typeof document.client_name !== "string" || document.client_name === "" ||
    !Array.isArray(document.redirect_uris) || document.redirect_uris.length === 0 ||
    !document.redirect_uris.every(uri => typeof uri === "string")) return null;
  if (document.token_endpoint_auth_method !== "none") throw new UnsupportedOAuthClientAuthentication();
  const redirects: string[] = [...document.redirect_uris];
  // known limit: client names are self-asserted; revisit when clients can prove their identity.
  return { name: document.client_name, redirectUriAllowed: uri => oauthRedirectUriAllowed(uri, redirects) };
}

/** Per-hub bounds and validated-document cache; injected transport is a test seam only. */
export class OAuthMetadataClients {
  private readonly cache = new Map<string, { client: OAuthClient; expiresAt: number }>();
  private readonly active = new Set<AbortController>();
  private stopped = false;

  constructor(
    private readonly fetchDocument = fetchMetadataDocument,
    private readonly now: () => number = Date.now,
  ) {}

  readonly lookup = async (clientId: string): Promise<OAuthClient | null> => {
    if (this.stopped) return null;
    const cached = this.cache.get(clientId);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.client;
    this.cache.delete(clientId);
    const url = parseMetadataClientId(clientId);
    if (url === null || this.active.size >= MAX_CONCURRENT_METADATA_FETCHES) return null;
    const controller = new AbortController();
    this.active.add(controller);
    try {
      const value = await this.fetchDocument(url, controller.signal);
      if (this.stopped) return null;
      const client = metadataClient(value, clientId);
      if (client === null) return null;
      const oldest = this.cache.keys().next().value;
      if (this.cache.size >= MAX_METADATA_CACHE_ENTRIES && oldest !== undefined) this.cache.delete(oldest);
      this.cache.set(clientId, { client, expiresAt: this.now() + METADATA_CACHE_TTL_MS });
      return client;
    } catch (error) {
      if (error instanceof UnsupportedOAuthClientAuthentication) throw error;
      return null;
    } finally { this.active.delete(controller); }
  };

  stop(): void {
    this.stopped = true;
    this.cache.clear();
    for (const controller of this.active) controller.abort();
  }
}
