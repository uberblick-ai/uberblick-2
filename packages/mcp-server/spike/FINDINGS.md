# Spike #2144: hosted MCP endpoint on the hub

Throwaway branch. `src/http-gateway.ts` serves the existing tools over
Streamable HTTP from one shared replica set; `spike/run.mts` and
`spike/memory.mts` prove and measure it against a local hub.

Run from `packages/mcp-server` with Node 26:

```sh
node --import tsx spike/run.mts
node --expose-gc --import tsx spike/memory.mts 200 3   # docs per workspace, workspaces
```

## Results (local hub, cloud container, Node 26.12.1)

| Check | Result |
| --- | --- |
| No bearer | 401 with `WWW-Authenticate: Bearer resource_metadata=...` |
| Tools over HTTP | 27 tools, unchanged; first `initialize` + `tools/list` 206 ms |
| Two sessions, one replica set | `create_doc` in session A (25 ms), found by `search` and read by `get_doc` in session B |
| Laptop replica (stdio server, own mirror) | sees the HTTP write; HTTP sessions see a laptop write after 115 ms |
| Guidance gate per session | B refused (`guidance_required`) while A, after reading the guidance page, writes |
| Agent name | shared: after two sessions every cursor is labelled `client-b` |
| Start per replica set | 31 to 53 ms for an empty workspace |
| Memory per replica set | about 5 to 6 MB RSS with 50 documents of 8 paragraphs; 10 to 17 MB with 200 |
| Cold mirror, 200 documents on the hub | all listed 0.54 s after start (search ran afterwards; hub and gateway shared one process, so memory is indicative only) |

## Answers

1. **Transport.** The tools run unchanged. `createMcpServer` splits into a
   shared part (replicas, mirror, hub connection, tag seeding) and a
   per-session part (`McpServer`, `GuidanceBriefing`, `ServerWork`, help
   catalog). About 150 lines.
2. **Where it runs.** As a client of the hub over loopback `/ws`, like any
   replica. Recommended: a second process in the hub image, routed by Caddy,
   not code inside the hub process. It keeps hub persistence and crash
   behaviour as they are, and it can evict idle replica sets.
3. **Identity.** One replica set carries one token identity and one agent
   name for every session. Correct attribution needs one replica set per
   person and workspace, which the memory numbers make affordable, plus the
   agent name per session instead of `replicas.setAgentName`.
4. **Sign-in.** Remote hubs admit only device credentials with current
   membership; the loopback HMAC secret this spike uses is refused off
   loopback (`resolveCoreHubConfig`). So each OAuth grant should create a
   device credential for that person, with the key generated and held by the
   gateway and the device named after the client. Existing device lists and
   revocation then cover hosted access. The hub becomes the OAuth
   authorization server (PKCE, client registration) and signs people in with
   its existing GitHub flow. Not prototyped.
5. **Guidance gate.** Works per session as is. Stateful Streamable HTTP
   sessions keep the ten-minute lease; a new MCP session reads the guidance
   again. A stateless deployment would key the lease on the grant.
6. **Routing and read-only.** Proposed: Caddy routes `/mcp` and the OAuth
   metadata paths next to `/ws` and `/auth/*` (today it routes only those two). A read-only grant registers only tools
   whose table entry does not write; the per-session server makes that a
   filter at registration.
