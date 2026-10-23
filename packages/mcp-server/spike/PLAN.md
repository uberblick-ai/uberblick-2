# Plan: hub as MCP host (v0.5.4)

Status: draft for review, 2026-10-23. Builds on spike #2144 (`FINDINGS.md`
next to this file).

## Goal

A person adds one URL to an MCP client that supports remote servers (Claude,
ChatGPT, Codex, Cursor and others), signs in with GitHub in the browser,
approves access, and the agent then has the same 27 tools that `ub mcp serve`
offers. There is nothing to install and no local corpus. Hosted access shows
up in the person's device list and is revoked there, exactly like a laptop.

Out of scope: the hub web UI for reading and editing documents without a local
corpus (separate milestone), GitLab or other identity providers, sharing
outside workspace membership, a stateless or horizontally scaled MCP host.

## Shape

```
MCP client ──HTTPS──> Caddy ──/mcp/*, /.well-known/oauth-protected-resource/*──> mcp host (new process)
                        │                                                         │  one replica set per grant
                        │                                                         └──ws://hub:1234/ws (device credential)
                        └──/oauth/*, /.well-known/oauth-authorization-server────> hub (authorization server)
                        └──/connect (SPA page) ── consent, reuses browser sign-in
```

- **Hub = authorization server.** It already owns principals, memberships,
  device credentials and browser sign-in, so OAuth lives in the hub process
  and the hub database. No new identity provider: the authorize step signs
  people in with the existing GitHub browser sign-in.
- **MCP host = resource server.** A second process built from the hub image
  (`mcp-host.mjs`, new `mcp` compose service). It talks to the hub like any
  replica: over `/ws` with a device credential. It keeps hub persistence and
  crash behaviour as they are and can evict idle replica sets.
- **One grant = one device.** Approving a client creates a device credential
  for that person, named after the client (for example "Claude (hosted)").
  The MCP host generates and keeps the Ed25519 key; the hub only sees the
  public key, as with laptops. Revoking the device in the existing device list
  ends the grant, its tokens and its open sessions.
- **One replica set per grant.** The spike measured 5 to 6 MB per set with 50
  documents and 10 to 17 MB with 200, and a cold 200-document mirror ready in
  0.54 s. Per grant (not per workspace) gives each client its own identity and
  agent name, which removes the "last session names every cursor" problem the
  spike found. Sessions of the same grant share the set.

## Endpoint and URL

- MCP URL per workspace: `https://<hub>/mcp/<workspace-id>`. The local server
  is bound to one workspace by `.uberblick.json`; the hosted URL mirrors that,
  the resource indicator (RFC 8707) names the workspace, and a token for one
  workspace cannot be replayed against another.
- Protected resource metadata (RFC 9728) at
  `/.well-known/oauth-protected-resource/mcp/<workspace-id>`, listing the hub
  as the only authorization server and the scopes `docs:read docs:write`.
- A request without a valid token gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="…", scope="docs:read docs:write"`.
- The web UI and `ub workspace` show the URL to copy ("Connect an agent").

## Sign-in and consent

1. Client discovers metadata and calls `GET /oauth/authorize` with
   `response_type=code`, `client_id`, `redirect_uri`, `state`,
   `code_challenge` (S256 only), `resource`, `scope`.
2. The hub validates the client and the exact redirect URI before any
   redirect. Invalid client or redirect: an error page, never a redirect.
   Otherwise it stores a pending authorization (5 minutes, single use) and
   redirects to the SPA page `/connect?request=<id>`.
3. `/connect` uses the existing browser sign-in (GitHub device flow, browser
   session bound to the exact origin). Already signed in: straight to consent.
4. Consent shows the client name, the redirect host (and a warning when it is
   only localhost), the workspace by name, and a choice of read only or read
   and write. Only workspaces the person is a member of can be approved; the
   resource names one, so the page shows it rather than offering a picker.
5. Approve or deny posts to `/oauth/consent` with the browser session header
   and the request id. The same-origin and `Sec-Fetch-Site` checks the browser
   sign-in already applies are the CSRF guard; the hub answers with the
   redirect URL (code and `state`, or `error=access_denied`) and the page
   navigates there.

## Clients

- **Client ID Metadata Documents** (the spec's SHOULD): `client_id` is an
  HTTPS URL; the hub fetches it with an SSRF guard (https only, public
  addresses only after DNS resolution, no redirects, 5 s timeout, 32 KB cap,
  short cache), requires `client_id` in the document to equal the URL, and
  takes `client_name` and `redirect_uris` from it.
- **Dynamic Client Registration** (RFC 7591, the spec's MAY, still the path
  most clients use today): `POST /oauth/register`, public clients only
  (`token_endpoint_auth_method: none`), redirect URIs https or loopback,
  rate limited per address, registrations without a grant expire after a day.
- AS metadata (RFC 8414) at `/.well-known/oauth-authorization-server` with
  `code_challenge_methods_supported: ["S256"]`,
  `client_id_metadata_document_supported: true`, the registration endpoint,
  `grant_types_supported: ["authorization_code", "refresh_token"]`.

## Tokens

- Authorization code: 60 s, single use, bound to client, redirect URI, PKCE
  challenge, resource and scope.
- Access token: opaque, 1 hour, stored hashed, bound to grant and resource
  (audience). Only accepted in the `Authorization` header, never in a query.
- Refresh token: opaque, rotated on every use, 30 days idle lifetime (the
  device credential lifetime). Reuse of a rotated refresh token revokes the
  grant.
- Validation: the MCP host asks the hub over the internal network
  (`POST /internal/oauth/introspect` on `hub:1234`, never routed by Caddy,
  authenticated by a shared secret between the two containers) and caches an
  answer for at most 60 s. The answer carries principal, grant, device,
  workspace and scope, and is negative as soon as the device is revoked or the
  membership is gone.
- No token passthrough: the MCP host never forwards the client's token; it
  reaches the hub with the grant's own device credential.

## Grant and device credential

- On the first request for a grant, the MCP host generates an Ed25519 key,
  asks the hub (internal endpoint) to issue the device credential for the
  grant's principal with that public key, and stores the private key in its
  own volume (one row per grant). Renewal uses the existing
  `/auth/credential/renew` exchange.
- The device list shows the device with the client name and "hosted". Revoke
  there: the hub revokes the credential and the grant; introspection turns
  negative; the MCP host closes the grant's sessions and deletes its mirror
  and key.
- Membership removal works as today: the credential no longer admits that
  workspace, and introspection refuses the grant.

## MCP host

- Streamable HTTP, stateful sessions (`Mcp-Session-Id`), session bound to the
  grant that opened it; a request with another grant's token is refused.
- Per session: `McpServer`, `GuidanceBriefing` (ten-minute lease as today),
  `ServerWork`, help catalog. Per grant: replica set, mirror, hub connection,
  agent name taken from the grant's client name.
- Validates the `Origin` header (spec requirement against DNS rebinding):
  absent or listed in the client's metadata, otherwise `403`.
- Read-only grants (`docs:read`) register only tools whose table entry does
  not write. A write call from such a grant cannot happen because the tool is
  not listed; `403 insufficient_scope` covers the edge where scope shrinks
  mid-session.
- Limits: request body size, open sessions per grant, open replica sets per
  host (oldest idle evicted), idle eviction after 15 minutes, a per-grant
  request budget like the hub's.
- Mirror and keys live in the `mcp` volume; a lost volume only costs a cold
  start and a new device credential.

## Corpus and docs

- Corpus first: page "MCP: hosted endpoint" (who it is for, the connect
  scenario per client, read only versus read and write, revoking).
- Website guide "Connect an agent without installing anything" and the
  REMOTE notes for operators (the `mcp` service, the secret, the volume).

## Issue breakdown (v0.5.4: Hub as MCP host)

1. Corpus page "MCP: hosted endpoint".
2. Split `createMcpServer` into a shared workspace runtime and a per-session
   server; agent name passed in, not set on the shared replicas.
3. MCP host process: Streamable HTTP at `/mcp/<workspace-id>`, sessions,
   Origin check, limits, idle eviction (test auth stub until 6 and 9 land).
4. Packaging: `mcp-host.mjs` in the hub image, `mcp` compose service and
   volume, Caddy routes, health check.
5. Protected resource metadata and the 401 challenge.
6. Authorization server metadata and Client ID Metadata Documents with the
   SSRF guard.
7. Dynamic client registration.
8. Authorize endpoint and the `/connect` consent page on the browser sign-in.
9. Token endpoint: code exchange with PKCE, resource binding, access tokens,
   rotating refresh tokens with reuse detection.
10. Grants as server-held device credentials: issuance, renewal, device list
    label, revocation cascade to tokens and sessions.
11. Internal introspection between hub and MCP host, membership changes.
12. Read-only grants register only read tools.
13. End-to-end test: an MCP SDK client runs the full OAuth flow against a
    local hub and MCP host.
14. Website guide and operator notes.

Order: 1, 2 and 5 can start now; 3 after 2; 4 after 3; 6 to 9 in sequence;
10 and 11 after 9; 12 after 2; 13 and 14 last.

## Open questions for review

- MCP host as a separate process versus routes inside the hub process (the
  separate process needs the internal introspection and issuance endpoints
  and a shared secret).
- Per-workspace URL versus one URL with the workspace picked at consent.
- Opaque tokens with introspection versus signed access tokens the MCP host
  verifies locally.
- Whether DCR is needed for the clients we care about, or CIMD is enough.
