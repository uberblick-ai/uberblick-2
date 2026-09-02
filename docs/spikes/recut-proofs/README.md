# Re-cut proofs (reference branch, never merged)

Evidence and throwaway code behind the corpus decision record **Local-first per identity** (`2542cd66-b641-4900-96b4-5c461dcdcf65`), 2026-09-02/03. Start with `where-we-landed.md`, then `v3-local-first-per-identity.md` (§13 has the proof outcomes).

- `proof-1-report.md` + `packages/mcp-server/spike/proof1/` — the shared store under load (six processes, one WAL file).
- `proof-1b-report.md` + `packages/mcp-server/spike/proof1b/` — the `beforeSync` gate and the store bridge on the pinned Hocuspocus server; `cases.ts` is most of `ub open`'s serving half.
- `scale-probe-report.md` + `packages/mcp-server/spike/scale/` — the hub at 100 identities × 3 processes × 2000 documents.
- `proof-0-report.md`, `proof-0b-report.md`, `proof0-instrumentation/`, `proof0b-instrumentation/` — the #704 content-loss diagnosis and its root cause (a harness triple-click). The instrumentation applies to the harness commit `9451ad4`, not to main.
- `adversary-*.md`, `reconciliation-*.md`, `v1`/`v2` — the plan's history through two adversarial rounds.

Nothing here is production code. Tickets cite this branch by commit.
