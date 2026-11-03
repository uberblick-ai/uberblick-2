import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sanitizeDeviceName } from "@uberblick/schema/device-name";
import { requestClient } from "./client-address.js";
import { jsonObject, replyJson } from "./http.js";
import type { OAuthClient } from "./oauth-authorization.js";
import { oauthRedirectUriAllowed, oauthRedirectUriValid } from "./oauth-redirect-uri.js";
import type { HubDatabase } from "./persistence.js";
import { RequestBudget } from "./request-budget.js";

export const OAUTH_REGISTRATION_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const OAUTH_REGISTRATION_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_REGISTRATIONS_PER_ADDRESS = 100;
export const MAX_REGISTRATIONS_PER_WINDOW = 1000;
const MAX_REGISTRATION_BYTES = 4096;

interface ClientMetadata {
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
}

type RegistrationError = "invalid_client_metadata" | "invalid_redirect_uri";

function stringOptions(value: unknown, allowed: readonly string[]): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === "string" && allowed.includes(entry));
}

function metadata(body: Record<string, unknown>): ClientMetadata | RegistrationError {
  const name = sanitizeDeviceName(body.client_name);
  const grantTypes = body.grant_types === undefined ? ["authorization_code"] : body.grant_types;
  const responseTypes = body.response_types === undefined ? ["code"] : body.response_types;
  if (name === undefined || (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") ||
    !stringOptions(grantTypes, ["authorization_code", "refresh_token"]) || !stringOptions(responseTypes, ["code"])) {
    return "invalid_client_metadata";
  }
  const redirects = body.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 ||
    !redirects.every(uri => typeof uri === "string" && oauthRedirectUriValid(uri))) return "invalid_redirect_uri";
  return { client_name: name, redirect_uris: redirects, token_endpoint_auth_method: "none",
    grant_types: grantTypes, response_types: responseTypes };
}

function refuse(response: ServerResponse, error: RegistrationError | "temporarily_unavailable" | "server_error",
  status = 400, headers: Record<string, string> = {}): void {
  const description = error === "invalid_redirect_uri" ? "A valid redirect_uris list is required."
    : error === "invalid_client_metadata" ? "Public client metadata is invalid or unsupported."
    : error === "temporarily_unavailable" ? "Try registering again later." : "Registration failed.";
  replyJson(response, status, { error, error_description: description }, headers);
}

async function readRegistration(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Preserve the socket so oversized requests receive the registration error.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_REGISTRATION_BYTES) { request.resume(); throw new Error(); }
    chunks.push(bytes);
  }
  return jsonObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

/** Registration stores client metadata, never authority to access a workspace. */
export class OAuthRegisteredClients {
  private stopped = false;
  private readonly budget: RequestBudget;

  constructor(private readonly database: HubDatabase, private readonly now: () => number = Date.now) {
    database.connection.exec(`CREATE TABLE IF NOT EXISTS hub_oauth_clients (
      client_id TEXT PRIMARY KEY NOT NULL,
      metadata TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hub_oauth_clients_created ON hub_oauth_clients(created_at);
    CREATE INDEX IF NOT EXISTS hub_agent_grants_client ON hub_agent_grants(client_id)`);
    this.budget = new RequestBudget(MAX_REGISTRATIONS_PER_ADDRESS, OAUTH_REGISTRATION_WINDOW_MS,
      MAX_REGISTRATIONS_PER_WINDOW, now);
    this.expire();
  }

  stop(): void { this.stopped = true; }

  readonly lookup = async (clientId: string): Promise<OAuthClient | null> => {
    if (this.stopped) return null;
    this.expire();
    const row = this.database.connection.prepare("SELECT metadata FROM hub_oauth_clients WHERE client_id = ?").get(clientId);
    if (row === undefined) return null;
    const registered = JSON.parse(row.metadata as string) as ClientMetadata;
    // known limit: registered names are self-asserted; revisit when clients can prove their identity.
    return { name: registered.client_name, redirectUriAllowed: uri => oauthRedirectUriAllowed(uri, registered.redirect_uris) };
  };

  async register(request: IncomingMessage, response: ServerResponse, behindReleaseProxy = false): Promise<void> {
    if (!this.budget.take(requestClient(request, behindReleaseProxy))) {
      refuse(response, "temporarily_unavailable", 429, { "Retry-After": String(OAUTH_REGISTRATION_WINDOW_MS / 1000) });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      refuse(response, "invalid_client_metadata"); return;
    }
    let body: Record<string, unknown>;
    try { body = await readRegistration(request); }
    catch { refuse(response, "invalid_client_metadata"); return; }
    const registered = metadata(body);
    if (typeof registered === "string") { refuse(response, registered); return; }
    if (this.stopped) { refuse(response, "temporarily_unavailable", 503); return; }
    try {
      this.expire();
      const clientId = randomBytes(32).toString("base64url");
      const createdAt = this.now();
      this.database.connection.prepare("INSERT INTO hub_oauth_clients (client_id, metadata, created_at) VALUES (?, ?, ?)")
        .run(clientId, JSON.stringify(registered), createdAt);
      replyJson(response, 201, { client_id: clientId, client_id_issued_at: Math.floor(createdAt / 1000), ...registered });
    } catch { refuse(response, "server_error", 500); }
  }

  private expire(): void {
    // Revoked grants still retain their client; only registrations without any grant expire.
    this.database.connection.prepare(`DELETE FROM hub_oauth_clients WHERE created_at <= ?
      AND NOT EXISTS (SELECT 1 FROM hub_agent_grants WHERE client_id = hub_oauth_clients.client_id)`)
      .run(this.now() - OAUTH_REGISTRATION_LIFETIME_MS);
  }
}

export async function handleOAuthRegistration(
  clients: OAuthRegisteredClients | undefined, request: IncomingMessage, response: ServerResponse, behindReleaseProxy = false,
): Promise<boolean> {
  if (request.url?.split("?")[0] !== "/oauth/register") return false;
  if (clients === undefined) {
    response.writeHead(404, { "Cache-Control": "no-store" }); response.end(); return true;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" }); response.end(); return true;
  }
  await clients.register(request, response, behindReleaseProxy);
  return true;
}
