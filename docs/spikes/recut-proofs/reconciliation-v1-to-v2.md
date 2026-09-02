# Reconciliation: v1 findings → v2 dispositions

Two independent adversaries reviewed v1 (`adversary-fable.md`, `adversary-codex.md`). Every finding is listed with what v2 does about it. "Accepted" means v2 changes as the finding asks; "Owner decision" means the owner ruled on 2026-09-02; "Rejected" states why.

| Source | Finding | Disposition in v2 |
|---|---|---|
| Fable F1 (P1), Codex 1 (P1) | `ub open`'s in-process Hocuspocus acks and broadcasts before the store append; the refused-append hazard is not exclusive to cut C | **Accepted.** §5.3 makes a durable-before-ack gate a design commitment (pre-apply hook or ordered listener, chosen by Proof 1b); refusal is sticky; §9 states the hazard belongs to any un-gated ingress, D2 included. |
| Fable F2 (P1) | Presence has no local path; workspace presence lives in `_directory`'s awareness | **Accepted.** §5.3: awareness-only localhost provider from MCP processes to `ub open`; `_directory` stays, so workspace presence keeps its home. |
| Fable F3 (P1) | Lazy attach strands pending rooms; unattended agents never push offline work | **Accepted.** §5.2: pending rooms exempt from laziness; holder pushes everything; Proof 1 includes "offline create, restart, unattended push". |
| Fable F4 (P2), Codex claim 5 | Reading of hard stop (a) is a guess; the displaced-block mechanism needs an editable empty doc the pane refuses | **Accepted.** §9: no reading goes into #719 or the corpus; Proof 0 is a diagnosed control run. |
| Fable F5 (P2), Codex 2 (P1) | `_directory` cannot be retired: tombstones, timestamps, known-but-not-hydrated live only in the stub | **Accepted.** §5.6: directory stays; its retirement belongs to the permissions record (§8). |
| Fable F6 (P2), Codex 9 (P2) | Relayed updates carry the relay's identity; connection identity is not authorship | **Accepted, re-scoped.** History and blame leave this cut (§8); when built, user-level authorship comes from per-user credentials on every process, session-level from Yjs client-id registration, never from the relaying connection. |
| Fable F7 (P2), Codex 6 (P1) | Hub log with identity, and dashboard hub tables, break CLAUDE.md's closed-list invariant | **Accepted.** Both removed from the cut; §8 records each as a separate decision with the invariant change and backup consequence named. Owner confirms history is required as product intent. |
| Fable F8 (P2) | Global `seq > lastSeen` tail races per-process compaction; synchronous append can stall the serving process up to the busy timeout | **Accepted.** §5.2: only the holder compacts; §5.3: relay reads per room via `readSince` + snapshots; the stall is measured in Proof 1 and accepted rather than queued (P5). |
| Fable F9 (P2), Codex 8 (P2) | Lease has no fencing; ghost holder writes after losing it; no real serving-process priority; idle holder maintains nothing | **Accepted.** §5.2: generation-fenced writes, wedged-holder rule, no preemption claim; the holder is a full replica that runs background work, not an idle MCP process. |
| Fable F10 (P2) | Catch-up watermarks need a hub epoch and a horizon rule | **Accepted, deferred with phase 2.** §10: any catch-up protocol carries an epoch and a start-sequence cut. Nothing in phase 1 has a watermark against the hub. |
| Fable F11 (P2), Codex 3 (P1), both over-engineering lists | Phases 1–2 build hub machinery ahead of the fan-in measurement; the banked sidecar plus a relaying `ub open` meets R1–R4 | **Accepted in substance; owner decision on the gate.** v2 removes all hub-side work from the cut; the holder is the sidecar role. The owner ruled the scale probe informs rather than gates (§9), so phase 1 proceeds while the probe runs; phase 2 exists only on its evidence. |
| Codex 4 (P1) | Lease-only indexing permits indefinitely stale offline search | **Accepted.** §5.2: every writer indexes what it changes before returning, as today; the lease covers only background catch-up and compaction. |
| Codex 5 (P1) | Bootstrap and elevation have no consistent cut or atomic publication | **Accepted by removal.** No bulk transfer in this cut; R2 is met by `ub remote join` today (§5.5). If phase 2 is ever scheduled, §10 requires the banked export/import safety contract. |
| Codex 7 (P2), Fable F12 | Removing IndexedDB removes the browser's crash/reload buffer and remote-browser offline reload | **Owner decision: remove it.** §5.4 records the accepted loss window and the remote-browser regression explicitly; Proof 1b measures the window. |
| Codex 10 (P2) | Two upstream paths are an unproven correctness dependency; Proof 2 was optional | **Accepted.** Proof 2 is mandatory and is one of the first four issues. |
| Codex missing: localhost auth/origin/CORS | | **Accepted.** §5.3 and §7. |
| Codex missing: pagination/backpressure/idempotency for bulk | | **Deferred with phase 2** (§10). |
| Codex missing: cross-version processes on one store | | **Accepted.** §7: store schema version gate; upgrades are stop-all, never mixed. |
| Codex missing: backup/restore for a hub log | | **Moved to the history record** (§8), where the log lives. |
| Codex missing: crash matrix | | **Partly accepted.** Proofs 1, 1b and 2 cover page reload, serving-process death, lease handoff and concurrent sends; partial bootstrap is out with phase 2. |
| Fable claim 7, Codex claim 7 | Hub as application server does not restore server-read latency | Survived in both reviews; moot now, since the hub is unchanged. |
| Both: over-engineering of assets, epochs, deletion, shape versioning in phases 1–2 | | **Accepted.** All moved to §8 as doors kept open; none is phase-1 work. |

**What v2 deliberately did not take from the reviews.** Codex asked to keep IndexedDB until a crash test passes; the owner chose the harder cut (P5). Codex asked for the scale probe as a precondition of the decision; the owner chose "informs, does not gate", with a failed proof reopening the record. Everything else was taken.

**What v2 may have lost from v1** (for the second review to check): cold start over room-by-room hydration for large workspaces; hub-side search for browsers without a store; a path to per-identity directories before permissions; any latency benefit of pull catch-up over eager room attachment for the holder.
