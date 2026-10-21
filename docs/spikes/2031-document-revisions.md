# Document revisions spike (#2031)

Recommend full snapshots for #2032 at the measured corpus size, and the proposed
three-pass matcher for prose. Recommend verified delivering accounts with unsigned
origin metadata that can only downgrade attribution: today's connection context
cannot identify the originating surface. Container fields and chart data need
their own comparison; a text diff alone is insufficient.
These are recommendations for preparation, not an adopted protocol or a revision UI.

## Person and surface

Use the **verified delivering principal** with unsigned origin metadata recorded
at the original write: room, update bytes (or digest), unique update ID, writing
credential ID and declared surface. The hub derives the account from its currently
authorized connection, never a supplied person ID. Resolve the writing credential in hub records only
as a consistency check: attribute to the delivering principal only when it names
that same principal and device and is not revoked. A missing, unknown or different
account/device credential downgrades original authorship to unknown; it cannot
select another author. Always retain the verified `deliveredBy` separately.

Routine renewal is not a new author. A syncing client renews after 15 days, before
opening rooms on reconnect, and renewal replaces its signing key while keeping
the principal/device. A hub-recorded replaced credential with no revocation may
still supply the consistency check above, even after its original lifetime; its
ID is historical metadata, not admission authority or proof of the offline writer.
Only the current credential authorizes delivery. Expired, revoked and replaced
credentials remain refused for admission, and fresh renewal proof from a replaced
key still revokes the device. No old-key signature is accepted to authorize or
positively attribute an update. This covers pending work across renewal, including
a shared-replica append immediately before another process renews.

Preserve the metadata with each pending update through local append, peer replay,
offline catch-up and compaction; deduplicate replay and retain accepted facts.
Plain merged Yjs catch-up must not silently acquire the relay's surface. After
acknowledgement pending payloads can be compacted without keeping deleted Yjs
content forever. #2032 still owes transport, causal replay and lifecycle proof.

Use `(principalId, surface kind/name)` as the author key. Session IDs are diagnostics;
device IDs guard the consistency check, not the author key. Reconnecting MCP is
not a new author. For `ub mcp serve`, use the initialized client's `title`, falling
back to `name`, then “unknown MCP client”.
For `ub open`, stamp “browser” at the browser-to-replica admission point, before
the raw update is appended. A different process can then relay it without changing
its surface. This verifies the account taking responsibility at delivery, not the
physical person typing or cryptographic proof of who wrote offline. An agent
signed in with its own account is that account's principal. The surface and
writing history remain client declarations; a client can mislabel its own work,
but cannot use metadata to attribute it to another account.

Signed origin envelopes are an alternative. They could positively attribute an
honest cross-account relay, such as pending edits after an account switch, but
none of the named same-computer relays needs that ability. Both designs need
per-update transport and compaction; signatures also need key-lifecycle and
verification rules. Prefer the smaller unsigned design for #2032. Account or
device changes instead leave original authorship unknown, including a fresh
sign-in by the same account with a different device ID. This is a deliberate limit,
not evidence that the new delivering account originally wrote those edits.

Existing stored state, pending changes without origin metadata, pre-sign-in edits
and local shared-root-secret edits have **unknown original person/surface**. Record
a verified `deliveredBy` where available, without presenting the relay as the original author.
Never infer origin from token `sub`, awareness or Yjs client IDs.
Exact retrospective authorship is a bounded negative.
A future hosted editor could stamp from a verified document-authorized browser
session; today's browser sign-in grants no document authority.

Before #2032 promises this behavior, test pending edits spanning the 15-day renewal,
peer append immediately before renewal, replay/compaction and retry after a lost
acknowledgement. Check that the same principal/device retains attribution, retired
keys alone cannot deliver or gain attribution, and revocation/current-access
refusals still win. Account switches, new-device sign-ins and missing/foreign
metadata must stay unknown while retaining `deliveredBy`. These are implementation
acceptance cases, not tests performed by this report-only spike.

Recommend **`SYNC_PROTOCOL_VERSION` 6 → 7** when origin metadata becomes mandatory: old
clients cannot preserve it and must update before reconnecting. Old state stays
“legacy / original author unknown”; upgrading cannot reconstruct it. #2032 needs
a maintainer comment explicitly approving that named version change. This PR
changes neither production code nor the version.

Evidence at `ade7ced5c3d82c7a8698b16db3007c4ad747fdc5`:
`credential-admission.ts:92–127` derives principal/device from hub records;
`sync.ts:612–643` uses the session as token `sub`; `server.ts:27–31,69–72` in
mcp-server reads the client name for presence. `replica.ts:467–485,547–589` logs
raw bytes and replays peer writes without their original surface;
`local-browser-server.ts:337–363` admits raw browser updates. Local hub admission
(`hub/src/server.ts:202–324`) has no verified account. `schema/src/protocol.ts:3–14`
requires an incompatible-contract bump. Paths are under `packages/`.

Renewal evidence at that same revision: `mcp-server/src/device-login.ts:17,220–222`
sets the half-life trigger; `sync.ts:612–624,647–675` renews before admission;
`hub/src/credentials.ts:229–245,335–364` retains historical records, refuses
replaced authority, detects reuse and preserves principal/device on replacement.
`mcp-server/src/auth-store.ts:277–285` stores one login per hub origin;
`cli/src/auth.ts:635–655` replaces a login and revokes its old device. Permissions
(`eb9a7801-05f3-417a-81d5-07c18795ac81`) and CLI: ub auth intents and examples
(`0ad5f7da-edb2-4e53-a6eb-9d95922a3e95`) state the 15/30-day and replaced-key rules.

Yjs 14 does not change the identity conclusion. Its
[attribution/rendering primitives](https://github.com/yjs/yjs/blob/main/renderer.md)
and [attribution server](https://github.com/yjs/y-simple-attribution-server)
accept application-supplied user metadata; they cannot authenticate an MCP name
or recover discarded origin. This is an inference from those APIs, not a Yjs 14
migration proposal.

## Full-state storage

Read-only hub sync into empty `gc:true` Y.Docs captured all 48 live regular
documents on 2026-10-21 at 16:54 UTC. No Markdown reconstruction or working replica
was involved. Re-decoding and `Y.encodeStateAsUpdate` verified every capture's
digest, size and completeness. These are full current CRDT states, including
comments and metadata, so they conservatively include fields #2032 excludes.
They describe hub memory at capture, not a direct read of its debounced SQLite row.
The three largest real documents were:

| Document | Full state, bytes | 176 revisions, MiB |
| --- | ---: | ---: |
| UB Agent Delivery Report | 318,746 | 53.5005 |
| CLI: ub workspace intents and examples | 62,327 | 10.4614 |
| CI Health Report | 46,818 | 7.8582 |

Assume a 30-day month with 22 editing days, two authors each editing one
uninterrupted hour per document per day, and four revisions per author-hour:
**176 snapshots/document/month**. Hold each revision at its measured current size.
All 48 documents total 1,246,335 bytes; their revisions add **219,354,960 bytes
(209.1932 MiB)/month**. One hundred documents each as large as the largest measured
add **5.2247 GiB/month**. Full snapshots are affordable at this scale; this is a
capacity judgment, not a measured hosting bill or unlimited retention guarantee.

The estimate excludes the current row, revision metadata/indexes, SQLite/WAL,
replicas and backups, and assumes no compression. A 10 MiB data-rich document
costs 1.7188 GiB/month; 100 cost 171.875 GiB. Author switches can close windows
early: switching every minute in the same two author-hours produces 2,640
revisions/month, fifteen times the baseline. Data growth and keyed-data CRDT
history can also grow later states even with GC on (see the earlier
[data spike](https://github.com/uberblick-ai/uberblick-2/issues/1398#issuecomment-6061187002)).
#2032 should size disk and backup capacity from observed bytes and author switches;
these measurements do not justify discarding revisions.

## Inline changes

The experiment used detached copies of UB Agent Delivery Report (27 blocks) and
Markdown extensions: embeds (41 blocks), edited through the shipped schema write
functions and serialized again before comparison. All **27 trials** passed:
nine text edits, four attribute/mark-only edits, nine comment controls, one chart
data edit, two regenerated-ID matches and two moves. Every comment control checked
both addition and resolution: neither changed the block comparison.

Match IDs, then LCS of unmatched content hashes, then LIS of old positions in new
order. Non-LIS pairs become removals at their old positions and additions at their
new positions. The semantic hash uses product readers for authored fields and
marks, excludes IDs/revisions/comments/system attributes, and merges adjacent
comment-split text runs. It does not reuse `blockRev`. Existing `fast-diff` runs
on word tokens from `Intl.Segmenter`; the scratch HTML marks additions and removals.

| Content | Readability and limit |
| --- | --- |
| Paragraphs | Word replacement gives readable removed/added spans. Formatting/link-only edits are detected, but text tokens cannot display their changed marks. |
| Lists | Item text reads well. Marker/indent changes are detected with no text span; list structure needs an attribute display. |
| Tables | Canonical cell text changes are understandable in source; pipes and separator rows are noisy. Row/column restructuring needs cell-aware presentation. |
| Cards | Title changes are legible in canonical source. Parts, buttons, targets and colors need named field comparison rather than one flat text stream. |
| Charts | Mapping title changes are visible as JSON tokens. A real numeric record update leaves every block unchanged; data must be compared separately, by collection/record/field. |
| Figma | Stored title/caption changes read well in source. URL/height need field labels; changes inside the external design are invisible to both snapshots. |

This proves a source-text experiment, not a rendered-editor experience. Duplicate
identical blocks can have ambiguous hash matches; a changed block with a new ID
becomes removal/addition. The exact quadratic LCS is bounded to these small samples,
and does not establish performance for large documents. #2032 can use this matcher
with explicit field/mark/data comparisons; text-only comparison has a bounded
negative result for those changes.

## Reproduce

Node 26.7.0, Yjs 13.6.32, Hocuspocus 4.7.1; existing frozen repository dependencies.
Run `mise run install` first. Replace `/absolute/private/scratch` with a fresh
private directory outside the repository. The capture reads the supported private
credential store without copying or renewing credentials, mints read-only room
tokens, confirms read-only admission, and publishes no awareness identity.

```sh
mise exec -- pnpm --filter @uberblick/mcp-server exec tsx ../../docs/spikes/2031-capture.mjs wss://hub.uberblick.ai/ws 722007fa-8921-45ee-a580-e20311030fef /absolute/private/scratch/snapshots
mise exec -- pnpm --filter @uberblick/mcp-server exec tsx ../../docs/spikes/2031-storage.mjs /absolute/private/scratch/snapshots
mise exec -- pnpm --filter @uberblick/mcp-server exec tsx ../../docs/spikes/2031-storage.mjs --recorded
mise exec -- pnpm --filter @uberblick/mcp-server exec tsx ../../docs/spikes/2031-inline.ts --out-dir /absolute/private/scratch/inline /absolute/private/scratch/snapshots/6067a08e-abd5-4467-8e8e-58da3a83fc5d.yjs /absolute/private/scratch/snapshots/98ec294c-57c2-4451-bddd-873bf9e67ad7.yjs
mise exec -- pnpm --filter @uberblick/mcp-server exec tsx ../../docs/spikes/2031-inline.ts --self-test
```

Live documents change: recapture measures their new state. Matching private
captures reproduce the original state sizes; the committed numeric-only
`--recorded` sample reproduces the original arithmetic after captures are removed,
and explicitly does not revalidate state. No document content or Yjs state is
committed. Keep captures and generated diff previews private.
