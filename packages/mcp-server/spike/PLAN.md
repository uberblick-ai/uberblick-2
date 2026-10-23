# Plan: hub as MCP host (v0.5.4)

Status: revised 2026-10-23 after an adversarial review
(`/mnt/project-files/remote-mcp/codex-review.md`, 11 P1 and 7 P2 findings,
all taken). Builds on spike #2144 (`FINDINGS.md` next to this file).

## Goal

A person adds one URL to an MCP client that supports remote servers (Claude,
ChatGPT, Codex, Cursor and others), signs in with GitHub in the browser,
approves access, and the agent then has the same tools that `ub mcp serve`
offers. There is nothing to install and no local corpus. Hosted access shows
up in the person's device list the moment it is approved, and is revoked
there, exactly like a laptop.

Out of scope: the hub web UI for documents without a local corpus (separate
milestone), other identity providers, access beyond workspace membership,
confidential clients (`private_key_jwt`), browser-based MCP clients (CORS),
private or loopback-only hubs for cloud clients, a horizontally scaled MCP
host.

## Shape

```
MCP client ─HTTPS─> Caddy ─/mcp/*, /.well-known/oauth-protected-resource/*─> mcp host (new container)
                      │                                                       │ one runtime per grant
                      │                                                       ├─ ws://hub:1234/ws  (grant's device credential)
                      │                                                       └─ unix socket in a shared volume (introspection, grant credentials)
                      ├─/oauth/*, /.well-known/oauth-authorization-server──> hub (authorization server)
                      └─/connect (SPA page) ── consent on the existing browser sign-in
```

- **Hub = authorization server.** It owns principals, memberships, device
  credentials and browser sign-in, so OAuth state lives in the hub database.
  The authorize step signs people in with the existing GitHub browser sign-in.
- **MCP host = resource server, separate process.** Built from the hub image,
  run as an `mcp` compose service. It keeps MCP load and memory out of the
  persistence process. It reaches the hub two ways only: `/ws` like any
  replica, and a unix socket on a volume mounted by just the two services.
  The socket carries no public route, and file permissions are its
  authorization. Its two calls are separated: introspection answers about a
  token; credential calls take a grant id and nothing else.
- **One grant = one device.** A grant is a durable row created at consent and
  listed in the device list at once (client name, "hosted", workspace, read
  only or read and write). Revoking it there ends its tokens, credential and
  sessions.
- **One runtime per grant.** Each grant gets its own replica set, mirror and
  hub connection, so each client has its own identity and agent name. Sessions
  of the same grant share it.

## Endpoint and discovery

- Canonical public URL from configuration (`HUB_PUBLIC_URL`), never from
  `Host` or forwarded headers. Issuer, audience and metadata derive from it.
- MCP URL per workspace: `<public>/mcp/<workspace-id>`. It mirrors the
  workspace binding of `.uberblick.json`, and it is the resource indicator
  (RFC 8707), so a token for one workspace cannot be used on another.
- Protected resource metadata (RFC 9728) at
  `/.well-known/oauth-protected-resource/mcp/<workspace-id>`: absolute
  `resource`, `authorization_servers: [<public>]`,
  `scopes_supported: ["docs:read", "docs:write"]`,
  `bearer_methods_supported: ["header"]`.
- No or invalid token: `401` with `WWW-Authenticate: Bearer
  resource_metadata="<absolute url>", scope="docs:read docs:write"`.
- AS metadata (RFC 8414) at `/.well-known/oauth-authorization-server`:
  `issuer`, `authorization_endpoint`, `token_endpoint`,
  `registration_endpoint`, `response_types_supported: ["code"]`,
  `grant_types_supported: ["authorization_code", "refresh_token"]`,
  `code_challenge_methods_supported: ["S256"]`,
  `token_endpoint_auth_methods_supported: ["none"]`,
  `client_id_metadata_document_supported: true`, `scopes_supported`.
- The web UI and `ub workspace` show the URL to copy ("Connect an agent").

## Clients

- **Client ID Metadata Documents** (preferred). `client_id` must be an https
  URL with a path, no userinfo, fragment or dot segments. Fetching enforces
  the address check at connection level: resolve, reject every private,
  loopback, link-local, special-use, IPv6 unique-local and IPv4-mapped
  address, then connect to the validated address with TLS verifying the
  original host name. No redirects, 5 s timeout, 32 KB decompressed cap,
  bounded concurrency and cache size. The document's `client_id` must equal
  the URL. Documents whose `token_endpoint_auth_method` is not `none` are
  refused with a clear error rather than treated as public.
- **Dynamic Client Registration** (RFC 7591), kept for Cursor and older
  clients: public clients only, standard responses and errors, redirect URIs
  https or loopback. Registrations stay while any grant uses them; ones that
  never got a grant expire after 30 days. Rate limits are global and per
  address with generous per-address headroom, since cloud clients share
  egress.
- **Redirect URIs.** https URIs match exactly. Loopback IP redirects
  (`http://127.0.0.1`, `http://[::1]`) match exactly except the port (RFC
  8252 §7.3), which Codex needs. `localhost` is accepted only as written in
  the registration; fragments, userinfo and look-alike hosts are refused.
- Library: evaluate the MCP SDK's server auth handlers (bundled SDK 1.32)
  against small bespoke endpoints before writing the token endpoint; the hub
  serves plain `node:http`, not Express.

## Sign-in and consent

1. `GET /oauth/authorize` validates client, redirect URI, `response_type`,
   `code_challenge_method=S256` (required, explicit), `resource` (must name an
   existing workspace URL) and scope before any redirect. Invalid client or
   redirect: an error page, never a redirect. Otherwise it stores an immutable
   pending authorization (5 minutes, bounded count) and redirects to the SPA
   page `/connect?request=<id>`.
2. `/connect` uses the existing browser sign-in. Browser session lookup gains
   the principal id (it returns only the username today).
3. Consent shows the client name, the redirect host (with a warning when it
   is only loopback), the workspace by name, and read only or read and write.
   The person must be a member of the workspace.
4. Approve or deny posts JSON to `/oauth/consent` with the browser session
   header and the request id. The existing same-origin, `Sec-Fetch-Site` and
   custom-header checks are the CSRF guard; `frame-ancestors 'none'` stays.
   The hub consumes the pending authorization atomically, rechecks
   membership, creates the grant, and answers with the redirect URL (code and
   `state`, or `error=access_denied`).

## Tokens

- Token endpoint takes `application/x-www-form-urlencoded`, returns standard
  OAuth JSON and errors, `Cache-Control: no-store`.
- Authorization code: 60 s, stored hashed, bound to client, exact redirect,
  PKCE challenge, resource and scope; consumed atomically. A second
  redemption of a valid code revokes every token issued from it.
- Access token: opaque, 1 hour, stored hashed, bound to grant, resource and
  scope. Accepted only in the `Authorization` header.
- Refresh token: opaque, hashed, rotated on every use within a family per
  grant, 30 days idle. Spent tokens keep their lineage; reuse revokes the
  grant. Refresh may narrow scope, never widen it.
- No positive caching of introspection: each MCP request asks the hub over
  the socket (a hashed lookup in SQLite). The answer carries principal,
  grant, workspace, scope and expiry, and is negative when the grant is
  revoked, the membership is gone or the workspace is suspended. If the hub
  cannot answer, the request fails closed with 503.
- No token passthrough: the client's token never leaves the MCP host.

## Hosted credentials

- Credential rows gain a ceiling for hosted grants: grant id, one workspace,
  and read only or read and write. Issuance, renewal and admission all
  enforce it. Today renewal widens a credential to every current membership
  and admission trusts the scope the key signs; hosted credentials must not
  inherit either.
- The MCP host asks for a credential with only a grant id and a public key;
  the hub derives principal, workspace and scope from the grant.
- The MCP server's credential loading (`ensureDeviceLogin`, one login per
  hub origin) is replaced by an injected credential provider keyed by grant,
  with its own renewal lock and outcome per grant.
- Keys: generated by the MCP host, private key in a 0700 directory, one 0600
  file per grant, published with write-then-rename so a crash never leaves a
  half-written key. Renewal stores the new key before it retires the old one
  and handles a lost renewal response the way the CLI does. Key loss: the
  host asks for a fresh credential for the same grant; the hub checks the
  grant is live and revokes the previous credential.
- Lifecycle events are distinct: renewal replacement, expiry and revocation.
  Only revocation cascades to tokens and sessions.

## MCP host

- Streamable HTTP, stateful sessions, each bound to the grant that opened
  it. Every POST, GET and DELETE is introspected; another grant's token or a
  negative answer ends the request, and open GET streams are rechecked every
  30 s and closed when the grant ends.
- Scope is checked per request, at dispatch and again right before a
  mutation. Read-only grants list only tools that do not write, including
  sidebar writes. A narrowed token on a session that listed write tools gets
  `403 insufficient_scope` on write calls.
- Per session: `McpServer`, `GuidanceBriefing` (ten-minute lease as today),
  `ServerWork`, help catalog. A new MCP session reads guidance again.
- Origin: absent is allowed (native and server clients); a present Origin
  must be in a deployment-configured list, otherwise `403`. No CORS.
- Writes: hosted tools answer after the hub confirms the change, so the
  mirror rarely holds unsynced work. A runtime with unsynced changes is never
  evicted or deleted; closing drains admitted work first. Revocation stops
  new work, lets in-flight calls finish, discards what the hub then refuses,
  and logs it.
- Capacity: limits per grant (sessions, concurrent calls, request budget),
  per principal (grants, runtimes) and global (runtimes, memory, disk, open
  files). Idle clean runtimes are evicted after 15 minutes, oldest first;
  when every runtime is busy a new one is refused with 503 and `Retry-After`.

## Packaging and operations

- The release builder produces `mcp-host.mjs` next to the hub bundles; the
  hub image carries it; the `mcp` service overrides port, data volume and
  health check (a real readiness check: socket reachable and `/ws` admits).
- Caddy routes `/mcp/*` and the protected resource metadata to `mcp`, and
  `/oauth/*` plus the AS metadata to the hub. The test auth stub never ships
  in a release image.
- Operator notes: the shared socket volume, `HUB_PUBLIC_URL`, the `mcp`
  volume (keys and mirrors, backed up separately from the hub database), and
  that cloud clients need a public HTTPS hub.

## Corpus and docs

- Corpus first: "MCP: hosted endpoint" (who it is for, connecting each
  client, read only versus read and write, revoking).
- Website guide "Connect an agent without installing anything", published
  after the client acceptance run.

## Issue breakdown (v0.5.4: Hub as MCP host)

1. Corpus page "MCP: hosted endpoint".
2. Split `createMcpServer` into a per-grant runtime and a per-session server,
   with an injected credential provider and agent name.
3. MCP host transport and sessions: Streamable HTTP at `/mcp/<workspace-id>`,
   session bound to grant, Origin policy, drain before close.
4. MCP host capacity: idle eviction, unsynced-runtime retention, per-grant,
   per-principal and global limits.
5. Packaging: builder entry, image, `mcp` service, socket and data volumes,
   Caddy routes, readiness check, `HUB_PUBLIC_URL`.
6. Discovery: protected resource metadata, AS metadata, 401 challenge.
7. Client ID Metadata Documents with the connection-level SSRF guard.
8. Dynamic client registration.
9. Authorization transaction: authorize validation, pending authorizations,
   consent API with principal id, grant creation.
10. Consent page `/connect` on the browser sign-in.
11. Token endpoint: code exchange with PKCE, resource binding, code reuse
    revocation.
12. Refresh token families: rotation, lineage, reuse detection, narrowing.
13. Hosted credential ceiling: grant, workspace and scope enforced at
    issuance, renewal and admission; issuance by grant id.
14. Grant lifecycle: device list rows from consent, revocation cascade,
    renewal versus revocation events.
15. MCP host key storage and recovery: file layout, crash-safe renewal, key
    loss, backup and restore.
16. Hub to MCP host socket: introspection without positive caching, fail
    closed, stream rechecks.
17. Scope enforcement per request: read-only tool list, dispatch and
    pre-mutation checks, `insufficient_scope`.
18. Protocol and security tests (failure cases), grown with 6 to 17.
19. Client acceptance on a staging hub: Claude, ChatGPT, Codex, Cursor
    (connect, refresh, reconnect, revoke).
20. Capacity measurement with the MCP host in its own process: large
    histories, concurrent grants, reconnect storms.
21. Website guide and operator notes.

Order: 1, 2, 6 and 13 can start now. 3 after 2; 4 and 5 after 3. 7 to 12 in
sequence after 6. 14 after 9 and 13; 15 and 16 after 14; 17 after 3 and 16.
18 runs alongside; 19 and 20 before public enablement; 21 last.
Public enablement needs 4, 13 to 17 and 19.

## Decided in review

- Separate MCP host process, with a narrow local channel instead of network
  endpoints and a shared secret.
- Per-workspace URL.
- Opaque access tokens with live introspection.
- Both CIMD and DCR; CIMD preferred.
