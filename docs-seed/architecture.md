---
uuid: 9b4ea859-8304-4e11-9cc8-76232c16a4e5
title: Architecture
tags: [reference]
links: [8865aba4-fc8b-4050-a8d2-9c851be0bed3, b1d5d904-c8b6-46a1-a4df-22251875bcdb, 2e8de409-df1b-4716-b6a9-71fa2ccd2aca, bea0f13c-5ba9-4fb6-af7b-d627b4807786, 8727c914-c462-410a-bff4-0d2975d1dbcc, 8a070124-2dc6-442a-8ea9-6db5b63ca950, 06777f59-3159-4511-8236-8fc66d70da27, 5238bd29-f9d5-43e8-ad40-2f039c705521, 6ea21fbd-aef9-4e69-873e-6c2a182e8894]
---

One Y.Doc per document, one room per Y.Doc, one SQLite row per room, and every
index derived from that state rather than trusted as it. This document is the
map; the documents tagged `implementation-reference` are the detail.

## Document model

- `meta` — a Y.Map holding `uuid`, `title`, `tags` and `links`, links by UUID.
- `blocks` — a Y.XmlFragment, one element per block, each holding a single Y.XmlText of source. This fragment is what the web editor binds to.
- `annotations` — a Y.Map of thread id to thread JSON, anchored by marks.
- `packages/schema` owns this layout and is imported by everything else. Its only runtime dependency is `fast-diff`; `yjs` is a peer dependency, pinned through the pnpm catalog so exactly one module instance exists per process.

## Rooms

- A room is `<workspaceUuid>/<docUuid>`. Two document slots are reserved: `_directory` and `_sidebar`.
- Tenancy is in the room key from day one, so a hosted hub never needs a room migration.
- The hub reads the room name strictly — exactly two non-empty segments, and a workspace segment carrying a display slug is refused, because accepting one would fork a document into two rooms.

## Hub persistence

- The hub is a Hocuspocus server with one extension, its own `HubDatabase`, on Node's built-in `node:sqlite`. The table is the one the retired Hocuspocus SQLite extension wrote, so an old database opens with no migration.
- One row per document holding `Y.encodeStateAsUpdate(doc)` — a full state snapshot, not an appended update stream, so there is nothing to prune.
- The database is opened before the socket binds: listening implies the hub can persist. `stop()` quiesces connections, then flushes, then closes.

## MCP local state

- The append-only update log is the authoritative local replica. Replicas hydrate from it on boot, never from the hub, and it records every update — local and remote origin alike — synchronously before a mutating call returns.
- The SQLite mirror over it (FTS5, tags, backlinks) is derived and rebuildable, never authoritative. The same holds for the directory document's stubs.
- A replica database records the workspace it belongs to and refuses to open under a different one.

## Workspace isolation — decided, not yet built

Everything in this section is a decision already taken and not yet code. What
runs today is namespacing: one HMAC signing secret is held by the hub, the MCP
server, the CLI and every browser bundle, so anyone holding it can mint a
read-write token for any workspace uuid, rooms are created on demand for any
accepted claim, and there is no expiry and no revocation. The enforcement point
is a string compare between two values that originate from the same untrusted
place. The plan below closes that; it is tracked as the ladder of issues under
the workspace-isolation parent issue, and each step's own issue is
authoritative for its own contract.

### The three invariants

- The key the hub verifies with is selected by the room, never by the claim — and it is a key the client could only have obtained by being provisioned for that room's workspace.
- Authorization is a property of the live connection, not of the handshake that started it: the hub keeps the decision it admitted each connection under, re-checks it, re-leases it, and closes it when the registry says the grant is gone.
- No message is applied under an authorization the hub is not currently holding: every frame passes a per-connection state gate that waits for a binding in progress and refuses one that failed.

### Key hierarchy

`HUB_ROOT_SECRET` — today's `HUB_AUTH_TOKEN`, unchanged in value — lives in the
hub process only and carries admin authority. Every other key is derived from
it and never stored:

```
K_c = HMAC-SHA256(root, "ub/v1/cred\n" + workspaceUuid + "\n" + keyVersion + "\n" + credId)
```

`keyVersion` is a random 128-bit value regenerated on every rekey, never a
counter, and it is compared by equality as a verification precondition rather
than by ordering. It is deliberately absent from the credential string: the hub
finds it from the row addressed by `credId`, so after a rekey the credential
fails the precondition and the re-derived key no longer matches the client's
bytes — two independent refusals, one intended.

A client never derives a key. It holds bytes and imports them. The credential
it holds is `ubc1.<workspaceUuid>.<credId>.<key>.<checksum>`, where `<key>` is
base64url of the 32 raw `K_c` bytes and `<checksum>` is eight lowercase hex
digits of CRC-32 over the rest — a typo detector, explicitly not a security
control, and synchronous so a truncated string is diagnosed on the boot path
with no network call. `parseCredential` runs on clients and does no crypto;
`deriveCredentialKey` runs on the hub and is the only place the derivation
string is spelled.

HMAC rather than asymmetric keys, and no JWT library: there is one verifier and
it already holds the root secret.

### Token shape

```jsonc
// WS (room) token
{ "typ": "room", "sub": "agent-...", "workspace": "<uuid>",
  "scope": "read-only" | "read-write",   // "admin" is not a WS scope
  "kid": "<credId>" | null,              // null = root-signed
  "iat": ..., "exp": ... }

// HTTP (admin) token -- audience-bound, 60s
{ "typ": "admin", "sub": "ub-admin",
  "aud": "<scheme>://<host>[:<port>]",   // the hub's configured public origin
  "kid": null, "iat": ..., "exp": ... }
```

The wire format is unchanged: `base64url(payload) "." base64url(HMAC(key,
payloadPart))`.

### Admission — one pure function

It takes the room name, the token, the current time and an attempt id, plus a
read-only registry reader, and returns either the authorization facts or a
refusal. It performs no writes, no randomness and no I/O beyond synchronous
registry reads, which is what makes it exhaustively testable while it is dark.

- Parse the room to a workspace uuid. Not a room, refuse.
- Reject `typ` other than `room`, and reject `scope: "admin"` outright — admin authority never rides a websocket connection.
- Read `kid` from the unverified payload as a lookup key only, never as authority.
- Select the key. A null `kid` selects the root secret. Otherwise load the credential row and require, as verification preconditions, that it exists, that its workspace equals the room's, that it is not revoked, that it has not expired, and that its `key_version` equals the workspace's current one. Then derive `K_c` from the root secret and the row's own fields.
- Verify the signature under the selected key. Everything after this point is authenticated.
- Clamp the lifetime regardless of what was claimed: reject a lifetime over fifteen minutes, an `iat` more than sixty seconds in the future, or an expired token. Token lifetime is the hub's property, not a minter's courtesy — every MCP server mints locally, so without a ceiling a compromised machine mints a decade-long token. Then cross-check the workspace claim against the room.
- Registry existence. A root-signed connection to an unregistered workspace carries a registration request that activation discharges idempotently; a credential-signed one is refused.
- Effective scope is the minimum of the row's scope and the claim for a credential, and the claim for a root-signed token.
- Return the effective scope, never the raw claim — a gate keyed off the raw claim would let a read-write claim signed with a read-only credential slip past the awareness restriction.

Signature verification precedes the registry gate deliberately: it makes
root-signed auto-registration reachable and removes an unauthenticated
pre-signature database read.

### Registry

The registry lives in the hub's existing SQLite file, on its existing handle:
one file, one backup, no second connection.

```sql
CREATE TABLE workspaces (
  uuid        TEXT PRIMARY KEY,
  key_version TEXT    NOT NULL,
  browser     TEXT    NOT NULL DEFAULT 'none',
  label       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE TABLE credentials (
  id          TEXT PRIMARY KEY,
  workspace   TEXT NOT NULL REFERENCES workspaces(uuid),
  key_version TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- machine | browser | guest
  scope       TEXT NOT NULL,          -- read-only | read-write
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX credentials_workspace_kind ON credentials(workspace, kind)
  WHERE revoked_at IS NULL;
CREATE TABLE hub_identity ( id TEXT PRIMARY KEY );
```

`kind` is a column rather than a naming convention because "revoke every live
browser session of this workspace" must be one indexed statement that a later
commit cannot silently break.

An admin HTTP API is served from the hub's own server: register and enumerate
workspaces, set a workspace's browser policy, rekey it, issue, list, re-scope
and revoke credentials, and mint a browser session token. Every endpoint but
one requires a root-signed, audience-bound admin bearer. The exception is a
public, ungated count probe that answers with a number and no ids — public
because the caller that matters is `ub init` on a Node client that sends no
`Origin`, and origin-gating it would refuse exactly the caller the probe exists
to warn.

### Live authorization

A per-connection record moves through `binding`, `active`, `renewing` and
`closed`. Authentication creates it; the per-message gate throws when it is
closed, waits on a barrier while it is binding or renewing, and arms renewal on
an authentication frame. Renewal replaces the authorization facts in place,
moving every secondary index in the same synchronous step, because a record
observable in neither index — even for one microtask — is a revocation scan
that misses it. The bounds are named constants: a fifteen-minute maximum token
lifetime, a three-minute renewal lead and thirty seconds of clock grace, so the
worst case for a revoked grant the scan missed is fifteen and a half minutes.

### Why the registry is not document state

The invariant is *document state syncs; auth state decides*. The reason is not
that a CRDT cannot express a revocation — it can; a grow-only set of revoked
ids converges perfectly well. It is currency and pre-authorization. First, the
hub must decide before it admits the client, and a synced replica is available
to the hub only through a connection it has not yet authorized, so the decision
would depend on state the decision gates. Second, the client controls whether
its replica is current, and merge guarantees convergence, not timeliness —
"newer wins" cannot be enforced against a party who declines to fetch the
newer. Third, it is not a derived index: the registry is not derivable from
documents at all, which is also why it is the one thing a backup must protect.

The cost is honest. Losing the registry drops every credential on every machine
and browser at once; adopting workspace rows back from the document table
restores existence, not grants, and true recovery is re-provisioning every
holder. It is bounded three ways: the registry shares the hub's database, so
one backup covers it; it holds no key material, so a leaked backup leaks
metadata rather than access; and documents are never at risk. The boundary
against document-level settings is the same sentence read twice — policy every
replica needs is document state, and who may connect is hub state.

## Invariants worth restating

- One update encoding everywhere: Yjs v1. Never mix v1 and v2.
- Exactly one `yjs` module instance per process.
- Identity is UUIDs; titles and paths are display data.
- The MCP server writes nothing to stdout but JSON-RPC; logs go to stderr.
- Block-type changes preserve the block id and the text delta, marks included.
