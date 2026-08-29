# Dev stack — restart after every merge to `main`

`integration.md`'s post-merge pass dispatches here once a merge lands, so
http://localhost:5173/ serves the just-merged `main`.

Killing a running dev server is sanctioned (owner directive) but bounded to your
own: terminate only the hub/web processes this session started itself (the
background task handles/PIDs it kept from launching them) — never any other
process — and confirm they exited, so their ports are free, before relaunching.
A fresh integrator started none, so it kills nothing: it records in its handoff
that a running dev stack, if any, predates the merge and needs a restart by
whoever runs it (`mise run dev`).

Where you do start one, serve from your own worktree, never the shared
checkout, which belongs to other sessions: `git fetch origin main` first, then
require that worktree be clean against the ref you just fetched — no
uncommitted changes, no commits absent from the fetched `origin/main` — and if
it isn't, skip the restart and say so rather than serve something that isn't
`main`. Only then fast-forward to it, verify `HEAD` equals the fetched
`origin/main`, start `mise run hub` and `mise run web` as background tasks, and
confirm http://localhost:5173/ answers before you report the stack serving the
new `main`. A fresh hub store is fine: replicas rehydrate it over sync.
