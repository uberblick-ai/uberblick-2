# Dev stack — restart after every merge to `main`

`SKILL.md` step 2 dispatches here once a merge lands, so http://localhost:5173/
always serves the just-merged `main`.

Killing a running dev server is sanctioned (owner directive) but bounded:
terminate only the hub/web processes the loop itself recorded starting (the
background task handles/PIDs it kept from launching them) — never any other
process — and confirm they exited, so their ports are free, before relaunching.

Serve from your own worktree, never the shared checkout, which belongs to other
sessions: `git fetch origin main` first, then require that worktree be clean
against the ref you just fetched — no uncommitted changes, no commits absent
from the fetched `origin/main` — and if it isn't, skip the restart and say so
rather than serve something that isn't `main`. Only then fast-forward to it,
verify `HEAD` equals the fetched `origin/main`, start `mise run hub` and
`mise run web` as background tasks, and confirm http://localhost:5173/ answers
before you report the stack serving the new `main`. A fresh hub store is fine:
replicas rehydrate it over sync.
