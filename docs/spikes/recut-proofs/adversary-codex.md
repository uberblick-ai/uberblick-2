The sandbox rejected the required file write as globally read-only. Material grounding limitation: the required fetch could not refresh the deleted `feat/daemon-authority-report` ref; existing remote-tracking refs, all required spike files, live GitHub issue/PR data, and the live Uberblick corpus were available.

# Adversarial verdict: local-first per machine

## 1. Decision basis

The plan does not survive as a basis for a decision. Its single most serious problem is that option D does not define a durable-before-ack ingress for the localhost Hocuspocus server: Hocuspocus 4.6.0 applies and acknowledges a browser update before its asynchronous persistence hooks can prove that the shared store accepted it, so the refused-append failure attributed exclusively to cut C remains possible in the proposed cut. The required `git fetch origin feat/daemon-authority-report spike/704-daemon-authority-harness` could not refresh the deleted `feat/daemon-authority-report` remote ref; the review instead used the existing remote-tracking refs (`9cece2d` and `9451ad4`), the three required files via `git show`, and live read-only `gh issue view 704`/`gh pr view 719`. The live Uberblick corpus was available and read through its MCP interface.

## 2. Findings

### 1. The localhost Hocuspocus path acknowledges before durable append

**Severity: P1. Status: CONFIRMED.**

**Claim attacked:** §5.2, “The serving process acknowledges to the browser when an update is in the store (applied),” and §8/weak claim 5, “Both [hard stops] belong to cut C.”

**Counterexample and evidence:** In Hocuspocus 4.6.0, an inbound update is applied and `SyncStatus(true)` is sent by `@hocuspocus/server/src/MessageReceiver.ts:268-280`. Applying the update invokes document callbacks and schedules broadcast in `Document.ts:332-354`, but `handleDocumentUpdate` merely starts the hook chain without awaiting it (`Hocuspocus.ts:277-324`); the hook chain itself starts in a later promise turn (`Hocuspocus.ts:555-588`), and `onStoreDocument` is debounced (`Hocuspocus.ts:507-545`). On the client, every local update increments the unsynced counter and sends immediately (`@hocuspocus/provider/src/HocuspocusProvider.ts:398-417`), while `SyncStatus(true)` decrements it (`provider/src/MessageReceiver.ts:94-97`). Option D still places a localhost Hocuspocus server between browser and store (§5.1), so an append failure can occur after the browser has been told the update is synced and after the in-memory document has become a publication source. The current MCP path avoids this by appending synchronously and quarantining before the provider listener runs (`packages/mcp-server/src/replica.ts:493-528`); the spike's loopback server did not (`origin/spike/704-daemon-authority-harness:packages/mcp-server/spike/daemon-authority-daemon.ts:332-387`). PR #719 records the refused-append propagation as a hard stop and says only that its topology attribution was not isolated; it does not prove the failure exclusive to cut C.

**Smallest resolving change:** Make a mandatory proof and protocol rule that every localhost browser update is durably appended before apply, broadcast, or positive sync status, using an awaited pre-apply gate (or a pinned-server patch with the same ordering). Reject/quarantine on append failure. Do not take the topology decision until that exact failure matrix passes.

### 2. Retiring `_directory` destroys the only archive and lifecycle state

**Severity: P1. Status: CONFIRMED.**

**Claim attacked:** §5.4/weak claim 8, “`_directory` stops being a shared Yjs document: derived ... from each document's own `meta`,” while “per-document `meta` [is] unchanged”; also §3's claim that the MCP surface and honesty contract stay.

**Counterexample and evidence:** The directory is expressly the sole discovery mechanism and stub cache (`packages/schema/src/directory.ts:1-16`; `CLAUDE.md:281-284`). Its entries contain `deleted`, `createdAt`, and `updatedAt` (`packages/schema/src/directory.ts:42-51`), and its tombstone/restore operations implement sticky archive semantics (`packages/schema/src/directory.ts:152-257`). Per-document `DocMeta` contains none of those lifecycle fields (`packages/schema/src/types.ts:231-265`; `packages/schema/src/doc.ts:180-195`). `archive_doc` and `restore_doc` mutate only the directory entry (`packages/mcp-server/src/tools.ts:1412-1504`), while `list_docs` reads that directory (`packages/mcp-server/src/tools.ts:1048-1096`). After the proposed retirement, an archived document's body still exists and its unchanged `meta` says nothing about deletion; a rebuild therefore resurrects it. `include_deleted`, archive/restore, stable timestamps, and complete catch-up tombstones cannot be derived as claimed. The live *MCP interface contract* requires tombstones to remain listable with `include_deleted` and restorable.

**Smallest resolving change:** Retain `_directory` for this re-cut. Retiring it requires a separate, explicit lifecycle schema and migration that moves every tombstone and timestamp into authoritative per-document state and preserves the current MCP contract.

### 3. The decision precedes the only proof of the required target scale

**Severity: P1. Status: CONFIRMED.**

**Claim attacked:** §9, “Phase 0 — decide and prove ... Proof 1. Corpus decision record,” while Proof 3, “~100 simulated machines,” is deferred to Phase 3.

**Counterexample and evidence:** R3 makes 50–100 people on one hub strongly required (§2), yet Proof 1 covers only five local processes and no hub-scale behavior (§8). The architecture is recorded and phases 1–2, estimated at 10–16 issues, are built before the only representative load probe. The live *Topology decision parameters* record makes scale an evidence gate and warns that the #704 result did not isolate topology from the harness. A Phase 3 failure would therefore invalidate an already-recorded topology after most of its bespoke machine and hub protocol had landed.

**Smallest resolving change:** Move a representative hub/load probe into Phase 0 and make it a precondition of the corpus decision. If the intended early decision is only provisional, say so and prohibit irreversible schema/protocol work until the scale gate passes.

### 4. “Only the lease holder indexes” permits indefinitely false offline search

**Severity: P1. Status: CONFIRMED.**

**Claim attacked:** §5.1, “One process at a time maintains the derived index ... Everyone else reads the index,” and “the index is honestly ‘as of’ its last maintenance”; weak claim 2.

**Counterexample and evidence:** R1 requires browser and agents on one offline machine to see one another's edits and to list/search the corpus. A serving process can keep renewing the lease while its indexing loop is wedged—the plan admits this exact case at §10—but a non-holder MCP process is still allowed to append edits and is forbidden to index them. Its next `search` reads the shared derived index (`packages/mcp-server/src/tools.ts:1100-1131`; `packages/mcp-server/src/store.ts:622-677`) and can remain stale forever even though replaying the authoritative log succeeds. An `asOf` label reports the violation; it does not satisfy complete offline search. Today, a touched document is settled/refreshed before tool completion (`packages/mcp-server/src/replica.ts:977-1048`) and index replacement is an ordinary transaction, not a lease-only operation (`packages/mcp-server/src/store.ts:500-519`).

**Smallest resolving change:** Allow every writer to synchronously index the documents it changes, reserving a lease only for background catch-up/rebuild; alternatively, require every list/search path to catch the index up to the store head before answering. Remove the “honestly stale” state as an acceptable R1 behavior.

### 5. Bootstrap and elevation have no consistent cut or atomic publication rule

**Severity: P1. Status: CONFIRMED.**

**Claim attacked:** §5.2, “Cold start and elevation are the same transfer ... in one request,” and §6, “the local store's watermark becomes the hub's sequence.”

**Counterexample and evidence:** The protocol does not identify a start-of-transfer sequence, a per-source cut, or an atomic target publication. During bootstrap, the hub can stream document A, accept a later update to A, then finish with document B. If the client records the final hub sequence, A's intervening update is skipped forever; if it records an earlier unrecorded sequence, completeness is accidental. During elevation, a local writer can append after its document was uploaded but before `ub remote push` sets the local watermark; setting the watermark to the returned hub head can mark that unuploaded update as covered. A partial failed upload can also expose half a workspace. The live *Deferred designs and their triggers*, §3, already banks the safety contract this claim says it “subsumes”: validate the manifest and every update, load into a temporary replica, publish atomically, and accept only an empty target. The plan specifies none of those safeguards.

**Smallest resolving change:** Adopt that banked contract: capture and return a bootstrap start sequence, follow it with `/changes`; capture a local source-sequence cut for elevation and clear/advance only through that cut; validate in a temporary replica and publish atomically to an empty target.

### 6. The proposed hub tables violate a closed architecture invariant

**Severity: P1. Status: CONFIRMED.**

**Claim attacked:** §5.3, “Structured non-document data (issue/PR state, agent reports for the dashboard, later users/roles) lives in hub tables, never in Yjs documents.”

**Counterexample and evidence:** The repository's closed invariant says all product state that must merge, survive offline work, or be reconstructed belongs in a Y.Doc; search/backlinks are derived; and the only hub-side non-synced tables are the workspace registry and credentials—“nothing else” (`CLAUDE.md:315-331`). Issue/PR state and agent reports are not shown to be credentials, registry data, or rebuildable caches. Putting them only in hub tables also makes them unavailable to the completely offline machine required by R1. This is not a storage implementation detail: it silently adds a second authoritative product-state model while §3 says the existing technology and MCP contract are not being re-decided.

**Smallest resolving change:** Delete this claim from the topology cut. Any future structured state must either remain Yjs state, be explicitly limited to a rebuildable projection of another authority, or receive its own owner-approved invariant change.

### 7. Removing IndexedDB removes the browser's only crash/reload buffer

**Severity: P2. Status: CONFIRMED.**

**Claim attacked:** §5.1/weak claim 6, “The browser is thin ... the store is the only local copy; y-indexeddb is removed.”

**Counterexample and evidence:** The current browser loads a room from IndexedDB, persists every update there, and records a durable checkpoint (`packages/web/src/collab/rooms.ts:547-655`); its status model distinguishes local-cache persistence from remote sync (`packages/web/src/collab/rooms.ts:330-365`). Under the proposed design, if the localhost process crashes, refuses a store append, or disappears after the editor changed its in-memory Y.Doc but before a durable ack, closing/reloading the page loses the only remaining copy. The remotely opened browser also expressly loses offline reload. Hocuspocus's unsynced counter is memory-only and a positive sync status does not itself persist browser state. Section 10 asserts that “browser edits are in the store before the ack,” but finding 1 shows that this is not a property of the pinned server.

**Smallest resolving change:** Keep y-indexeddb at least as an unacknowledged-update/reload buffer until a crash test proves durable-before-ack across process death and page reload; only then remove or narrow it.

### 8. The lease has neither fencing nor the claimed serving-process priority

**Severity: P2. Status: CONFIRMED.**

**Claim attacked:** §6/weak claim 2, the TTL lease is “sufficient coordination” and “the serving process takes the lease when it starts.”

**Counterexample and evidence:** A holder can pause past the 15-second TTL, a second process can acquire the row, and the first can resume with stale in-memory authority. The sketch has no monotonically increasing fencing token checked by index, catch-up, or watermark writes, so both processes can perform lease-guarded work. SQLite serializes each write transaction; it does not invalidate a stale holder between transactions. Separately, `INSERT ... ON CONFLICT ... WHERE expires_at < now` cannot let the serving process take a live lease from an MCP process, so the stated priority does not exist. The shared store's current index replacement and pending mutations are unconditional transactions (`packages/mcp-server/src/store.ts:398-405,500-519,603-619`).

**Smallest resolving change:** Add a lease generation and require every maintenance/watermark commit to compare it in the same transaction; define cooperative yield/preemption if serving-process priority is actually required. Otherwise drop the priority claim and do not use the lease for correctness-critical work.

### 9. Connection identity is not author attribution

**Severity: P2. Status: CONFIRMED.**

**Claim attacked:** §5.3, the hub log's `identity + time` supplies “history and attribution” because “the hub already knows the sending connection's identity.”

**Counterexample and evidence:** Hub authentication stores `context.sub` for the connected socket (`packages/hub/src/server.ts:522-632`), which identifies only that ingress connection. Under option D, browser edits and other processes' log entries can be replayed upstream by the serving process; after an outage, several authors' Yjs updates can arrive in one relay/bulk upload. Nothing in the current local update-log schema records an end-user author (`packages/mcp-server/src/store.ts:149-176,448-465`), and Yjs updates do not supply the proposed product identity. The hub can therefore attribute the batch only to the relay credential, not its authors. The spike daemon likewise creates a bridge provider for the daemon identity, not the original browser writer (`origin/spike/704-daemon-authority-harness:packages/mcp-server/spike/daemon-authority-daemon.ts:364-387`).

**Smallest resolving change:** Rename the fields to `received_from` and `received_at` and remove attribution/history as justification for this cut. True attribution needs a separately specified end-to-end authored-event envelope and trust model.

### 10. The second publication path remains an unproven correctness dependency

**Severity: P2. Status: PLAUSIBLE.**

**Claim attacked:** §5.1/§5.2/weak claim 4, “Two paths stay” and the existing `clearPending` rule “extends to bulk acks”; §9 makes only Proof 1 mandatory before decision.

**Counterexample and evidence:** `pending_rooms` is shared durable state, while acknowledgement knowledge is process-local. Current code clears only through a sequence observed by the clearing replica (`packages/mcp-server/src/replica.ts:1121-1141`; `packages/mcp-server/src/store.ts:603-619`), and provider quietness is defined by one provider instance's unsynced-message count (`packages/mcp-server/src/sync.ts:937-1022`). The proposed serving process and direct MCP provider can concurrently send overlapping document state, lose/reacquire the lease, and receive acknowledgements in different orders. The plan neither defines which local sequence a bulk hub ack covers nor prevents a stale process from advancing the shared pending/watermark state. It acknowledges the uncertainty in §10, yet Proof 2 is optional (“folded ... or its own issue”) and absent from Phase 0.

**Smallest resolving change:** Make Proof 2 mandatory before the decision and specify an ack record keyed to a captured local sequence cut, sender, and hub sequence. Exercise concurrent paths, outage, crash, and lease handoff on the same room.

## 3. Section 11 claim matrix

| # | Weak claim | Verdict | Reason |
|---:|---|---|---|
| 1 | Store bus plus log-tail relay is fast/correct for browser | **Falsified** | No durable-before-ack ingress is defined, and pinned Hocuspocus acknowledges before the proposed persistence hooks complete. |
| 2 | Lease is sufficient coordination | **Falsified** | TTL expiry permits a stale holder to resume without fencing; the acquisition SQL also provides no serving-process priority. |
| 3 | One hub sequence makes pull catch-up complete | **Weakened** | A global sequence can support completeness, but bootstrap has no consistent cut and lifecycle/tombstone state disappears with `_directory`. |
| 4 | Two upstream paths keep pending/synced honest | **Weakened** | Existing acks are provider-local while pending state is shared; no bulk-ack cut or mandatory concurrency proof is specified. |
| 5 | #704 hard stops are artifacts only of cut C | **Falsified** | The report did not isolate that attribution, and option D retains a localhost Hocuspocus publication path with the same ack-before-durability hazard. |
| 6 | Removing IndexedDB loses no required property | **Falsified** | It removes the only reload/crash buffer for browser updates not yet durably accepted by the local store. |
| 7 | Hub application server does not restore server-read latency locally | **Survives** | In the stated local mode, MCP reads the shared store and the browser reads localhost; hub HTTP reads are confined to clients without that store. |
| 8 | Unchanged per-document meta can replace the directory | **Falsified** | Meta lacks tombstone and lifecycle timestamps, while archive/restore currently mutate only `_directory`. |
| 9 | Phases 1–2 are the smallest required cut | **Falsified** | The plan adds hub history/attribution, structured tables, generalized schema, and remote indexes before proving the banked sidecar/current protocol cannot meet R1–R4. |

## 4. Over-engineering check

- The append-only hub log's `identity`/`ts`, historical versions, and diffs are not required by R1–R5. A monotonic change ledger plus current Yjs state is enough to test catch-up; true provenance can be a later, separately trusted design.
- Hub FTS/tags/backlinks and HTTP search are not needed to prove local completeness. Each machine can keep its existing derived index; remote-only browser search can remain a separate capability until evidence requires central projection.
- Hub-only issue/PR/report tables are unrelated to this topology and conflict with the closed state invariant. Remove them; if they are projections, rebuild them from their actual authority.
- Generalizing unknown block attributes/marks, binary-asset architecture, history epochs, and deletion policy does not establish any topology requirement. Keep these in their existing deferred records and out of phases 1–2.
- A correctness-bearing single-writer index lease is more machinery than necessary for idempotent per-document indexing. Let writers index their own touched documents and coordinate only background full-corpus catch-up/rebuild.
- The live *Deferred designs and their triggers*, §2, already banks a persistent, non-serving full-corpus sidecar over the existing Hocuspocus protocol as the shared intermediate. A scale and local-journey probe of that smaller shape should precede bespoke bulk, lease, log-tail, and hub-history protocols.

## 5. Missing entirely

- An authentication, token storage, origin/CSRF, and browser-isolation contract for the new localhost Hocuspocus and HTTP APIs; the #704 harness had explicit origin and token controls.
- Pagination, backpressure, cancellation/resume, size limits, and retry/idempotency rules for bootstrap, changes, and bulk upload.
- Cross-version protocol negotiation and upgrade order when old and new MCP/CLI/web processes share one SQLite store.
- Backup, restore, retention, integrity checking, and disaster recovery for the new authoritative append-only hub log.
- A precise crash matrix covering page close/reload, serving-process death, lease expiry/handoff, simultaneous direct and relayed sends, and partial elevation/bootstrap publication.