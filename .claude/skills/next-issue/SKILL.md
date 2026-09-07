---
name: next-issue
description: >-
  Start one fresh Uberblick entry-role session inside this interactive session,
  wait for it to end, and report the line it ended on. It selects nothing and
  claims nothing.
---

# next-issue — one role session, in this session

`/next-issue <role>` starts exactly one fresh session of one entry role as a
child of this one, waits for it to end, and reports how it ended. It is the
interactive counterpart of `ub launch <role>`, which owns the unattended
terminal loop and every Codex transport; the loop around this file belongs to
the caller.

**Roles.** The continuous entry roles named in `.agents/launch.json`:
`issue-preparer`, `implementer`, `integrator`. `issue-adversary` and
`implementation-reviewer` are internal — their parent starts them under
`.agents/protocols/issue-preparation.md` or `review-protocol.md` beside this
file, never here. Any other name: say so and return.

**Runtime.** Claude only, because this surface exists to put a role in an
interactive session's own transcript. For a Codex run, or for an unattended
loop on either runtime, use `ub launch <role> [--model claude|codex]` and start
nothing here.

## What this does

1. **Prove the workflow revision.** The checkout must be on `main`; run
   `git fetch origin main` and `git merge --ff-only origin/main`. If either is
   refused, report that and stop — never launch a role from workflow files that
   are not proven current.
2. **Create one run id** — `claude-<role>-<UTC timestamp>-<short random
   suffix>`, for example `claude-integrator-20260907T081500Z-3f21a7`. Mint it
   before launch, pass it verbatim, and never substitute a tool's internal id.
3. **Start one session** with the `Agent` tool, `subagent_type` set to the role
   slug — its adapter under `.claude/agents/` — and `model: opus`, handing it
   the queue assignment and nothing more:

   > Claim and complete one eligible item for the `<role>` role per
   > `.agents/roles/<role>.md`. Identifiers: role `<role>`, run id `<run id>`,
   > launched by session `<this session's id>`.

   Name the run's private scratch directory, `<this session's
   scratchpad>/<run id>`, and the MCP route: the registered uberblick server,
   or — where none is registered — a throwaway `ub mcp serve` stdio client run
   outside the committed worktree. For an integrator launch, state that the
   child shares this session's authorship identity and must apply the role's
   trailer/claim independence check before claiming. The adapter owns effort,
   isolation and permissions; add no other flag.
4. **Report and return.** Name the role and the run id, and repeat the
   session's final line verbatim — `No eligible <role slug> work: <reason>.`,
   `Worked <role slug>: <issue|PR> #N — <outcome>.` or
   `Blocked <role slug>: <reason>.`, whose meaning for the caller's pacing is
   AGENTS.md's `Loop pacing`. A session that ends any other way is reported as
   an unconfirmed outcome, never guessed at. Then stop.

   Before paying for a session the caller may run
   `sh scripts/probe-work.sh <role>`: exit 1 means nothing can be eligible and
   exit 2 means the read failed — idle on either; exit 0 launches. The probe is
   deliberately over-inclusive and claims nothing, and the session's own final
   line stays the authority.

Everything else belongs to the role: this file observes no GitHub state,
selects nothing, claims nothing, and performs no gate, review, disposition or
merge. It never resumes a role after its handoff. The launching session's own
repo edits happen in its own worktree, never in the shared checkout, which
stays on clean `main`.
