import type { IncomingMessage, ServerResponse } from "node:http";
import { parseWorkspaceId } from "@uberblick/schema";
import { OAUTH_SCOPES, workspaceResourceUrl } from "@uberblick/schema/oauth";
import { browserOrigin } from "./browser-sign-in.js";
import type { GithubSignIn } from "./github-sign-in.js";
import type { HubAdminRegistry } from "./hub-admins.js";
import { isJsonPost, readJsonRequest, replyJson } from "./http.js";
import { oauthRedirect, type ConsentSubmission, type OAuthAuthorizations } from "./oauth-authorizations.js";

export interface OAuthClient {
  name: string;
  redirectUriAllowed(uri: string): boolean;
}

/** Client metadata and registration sources own redirect matching and refusal. */
export type OAuthClientLookup = (clientId: string) => Promise<OAuthClient | null>;

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  response.end();
}

function errorPage(response: ServerResponse): void {
  response.writeHead(400, {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
  });
  response.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorization request refused</title><h1>Authorization request refused</h1><p>Start again from your agent.</p></html>');
}

function resourceWorkspace(resource: string | null, issuer: string, hubAdmins: HubAdminRegistry): string | null {
  if (resource === null || !resource.startsWith(`${issuer}/mcp/`)) return null;
  const workspaceId = resource.slice(`${issuer}/mcp/`.length);
  try {
    if (parseWorkspaceId(workspaceId).uuid !== workspaceId ||
      workspaceResourceUrl(issuer, workspaceId) !== resource || !hubAdmins.hasWorkspace(workspaceId)) return null;
    return workspaceId;
  } catch { return null; }
}

async function authorize(issuer: string, clients: OAuthClientLookup, authorizations: OAuthAuthorizations,
  hubAdmins: HubAdminRegistry, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" });
    response.end();
    return;
  }
  const parameters = new URL(request.url ?? "", issuer).searchParams;
  const clientId = parameters.get("client_id");
  const redirectUri = parameters.get("redirect_uri");
  if (!clientId || !redirectUri || parameters.getAll("client_id").length !== 1 || parameters.getAll("redirect_uri").length !== 1) {
    errorPage(response);
    return;
  }
  try {
    const client = await clients(clientId);
    if (client === null || client.name === "" || !client.redirectUriAllowed(redirectUri)) {
      errorPage(response);
      return;
    }
    // A source must return a registered absolute redirect URI without a fragment.
    if (new URL(redirectUri).hash !== "") { errorPage(response); return; }
    const state = parameters.get("state");
    const refuse = (error: string) => redirect(response, oauthRedirect(redirectUri, state, "error", error));
    try {
      if ([...parameters.keys()].some(key => parameters.getAll(key).length > 1)) { refuse("invalid_request"); return; }
      if (parameters.get("response_type") !== "code") { refuse("unsupported_response_type"); return; }
      const codeChallenge = parameters.get("code_challenge");
      if (!codeChallenge || parameters.get("code_challenge_method") !== "S256") { refuse("invalid_request"); return; }
      const resource = parameters.get("resource");
      const workspaceId = resourceWorkspace(resource, issuer, hubAdmins);
      if (workspaceId === null || resource === null) { refuse("invalid_target"); return; }
      const scope = parameters.get("scope");
      const scopes = scope === null ? [...OAUTH_SCOPES] : scope.split(" ");
      if (scopes.some(value => !(OAUTH_SCOPES as readonly string[]).includes(value)) || !scopes.includes("docs:read")) {
        refuse("invalid_scope"); return;
      }
      const requestId = authorizations.create({ clientId, clientName: client.name, redirectUri, state, codeChallenge,
        resource, workspaceId, writeRequested: scopes.includes("docs:write") });
      if (requestId === null) { refuse("temporarily_unavailable"); return; }
      redirect(response, `${issuer}/connect?request=${requestId}`);
    } catch { refuse("server_error"); }
  } catch { errorPage(response); }
}

function submission(body: Record<string, unknown>): ConsentSubmission | null {
  if (typeof body.requestId !== "string" || body.requestId === "") return null;
  if (body.decision === "deny" && Object.keys(body).length === 2) return { requestId: body.requestId, decision: "deny" };
  if (body.decision === "approve" && Object.keys(body).length === 3 &&
    (body.accessLevel === "read-only" || body.accessLevel === "read-write")) {
    return { requestId: body.requestId, decision: "approve", accessLevel: body.accessLevel };
  }
  return null;
}

export async function handleOAuthAuthorization(
  issuer: string | undefined, signIn: GithubSignIn | undefined, authorizations: OAuthAuthorizations | undefined,
  hubAdmins: HubAdminRegistry | undefined, clients: OAuthClientLookup,
  request: IncomingMessage, response: ServerResponse,
): Promise<boolean> {
  const path = request.url?.split("?")[0] ?? "";
  if (!["/oauth/authorize", "/oauth/consent/read", "/oauth/consent/submit"].includes(path)) return false;
  if (issuer === undefined || signIn === undefined || authorizations === undefined || hubAdmins === undefined) {
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  if (path === "/oauth/authorize") {
    await authorize(issuer, clients, authorizations, hubAdmins, request, response);
    return true;
  }
  const origin = browserOrigin(request);
  if (origin === null || !isJsonPost(request)) {
    replyJson(response, 400, { status: "invalid-request" });
    return true;
  }
  let body: Record<string, unknown>;
  try { body = (await readJsonRequest(request)).body; }
  catch {
    replyJson(response, 400, { status: "invalid-request" });
    return true;
  }
  try {
    const submit = path === "/oauth/consent/submit" ? submission(body) : null;
    if (path === "/oauth/consent/read" ? Object.keys(body).length !== 1 || typeof body.requestId !== "string" || body.requestId === "" : submit === null) {
      replyJson(response, 400, { status: "invalid-request" });
      return true;
    }
    const token = request.headers["x-uberblick-session"];
    const session = typeof token === "string" ? signIn.browserSession(token, origin) : null;
    if (session === null) { replyJson(response, 401, { status: "signed-out" }); return true; }
    const result = submit === null ? authorizations.read(body.requestId as string, session.principalId)
      : authorizations.submit(submit, session.principalId);
    const status = result.status === "unknown-request" ? 404 : result.status === "not-a-member" ? 403
      : result.status === "invalid-request" ? 400 : 200;
    replyJson(response, status, result);
  } catch {
    replyJson(response, 500, { status: "failed" });
  }
  return true;
}
