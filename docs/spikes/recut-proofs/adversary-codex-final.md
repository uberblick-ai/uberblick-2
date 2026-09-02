Yes. One major hole remains: the overall D3 topology survives, but the proposed index-sequencing fix can still certify an incomplete document state as current, so Proof 1 does not establish its claimed index-correctness result.

### CONFIRMED — `indexed_through_seq` is not a causal cut

- **Claim broken:** V3 says `indexed_through_seq` prevents an older derivation overwriting newer index rows, using `max(lastSeq, lastAppendedSeq)` (`v3-local-first-per-identity.md:49,142`; `proof-1-report.md:250-255`).
- **Concrete evidence:** A tool settles only before editing (`packages/mcp-server/src/tools.ts:1189-1194`), while `lastSeq` advances only when log rows are replayed (`packages/mcp-server/src/replica.ts:563-575`). Therefore process A can settle through N, process B append N+1, then A—without seeing N+1—append N+2 and index its incomplete Y.Doc as cut N+2. The proof prototype computes exactly that maximum and rejects a later derivation at the same cut (`packages/mcp-server/spike/proof1/sequenced-store.ts:110-116,132-137`). When B subsequently replays through N+2 and derives the correct merged index, it is skipped as equal; the stale search rows persist without another document update.
- **Why major:** This directly violates the promised offline-search correctness and disproves the conclusion that the proposed sequence makes stale overwrite impossible.
- **Smallest change:** Index only from a contiguous log cut actually applied to the deriving Y.Doc. After a local append, replay all same-room rows through the returned sequence before deriving and committing the index; never treat `max(lastSeq, lastAppendedSeq)` as that proof. Add this exact two-process interleaving to Proof 1.

Codex session ID: 01a06466-9108-7e90-ba36-e841e68f6785
Resume in Codex: codex resume 01a06466-9108-7e90-ba36-e841e68f6785
