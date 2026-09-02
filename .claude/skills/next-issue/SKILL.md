---
name: next-issue
description: >-
  Start one fresh session of an Uberblick entry role on a chosen runtime, wait
  for it to end, and report its result. It selects nothing and claims nothing.
---

# next-issue — launch one role, once

`/next-issue <role> [--codex|--claude]` starts exactly one fresh session of one
role on one runtime, waits for it to end, and reports how it ended. It is the
interim spelling of `ub launch <role> --codex|--claude` (#489). The loop around
it belongs to the caller, and the role contracts under `.agents/roles/` do not
change when the launcher does.

**Roles.** The continuous entry roles `issue-preparer`, `implementer` and
`integrator`, and `program-coordinator` for an explicitly requested program
issue. `issue-adversary` and `implementation-reviewer` are internal: their
parent starts them under `.agents/protocols/issue-preparation.md` or
`review-protocol.md` beside this file, never this launcher. Any other name: say
so and return.

**Runtime.** `--codex` or `--claude`. Omitted, the implementer runs on Codex
and every other role on Claude (owner direction, 2026-09-01). The launcher adds
no model, effort, sandbox or permission flag beyond the ones written below; a
runtime's own configuration owns the rest.

## What this does

1. **Prove the workflow revision.** The checkout must be on `main`; run
   `git fetch origin main` and `git merge --ff-only origin/main`. If either is
   refused, report that and stop — never launch a role from workflow files
   that are not proven current.
2. **Create one run id** — `<runtime>-<role>-<UTC timestamp>-<short random
   suffix>`, for example `codex-implementer-20260901T140021Z-3f21a7`. Create it
   before launch, pass it verbatim, and never substitute a tool's internal id.
3. **Start one session**, handing it the queue assignment and nothing more:

   > Claim and complete one eligible item for the `<role>` role per
   > `.agents/roles/<role>.md`. Identifiers: role `<role>`, run id `<run id>`,
   > launched by session `<this session's id>`.

   Add the MCP route: the registered uberblick server, or — where none is
   registered — the throwaway `ub mcp serve` stdio client from #77 and #134,
   run in a scratch directory outside the committed worktree. For an
   integrator launch, state that the child shares this launching session's
   authorship identity and must apply the role's trailer/claim independence
   check before claiming.

   - **Claude:** the `Agent` tool with `subagent_type` set to the role slug
     (its adapter under `.claude/agents/`) and `model: opus` — except the
     issue-preparer, which runs on `fable` (owner direction, 2026-09-01):
     grounding a new ticket is where the extra judgment pays, and its adapter
     already pins the owner-approved `effort: high`.
   - **Codex:** give the run its own worktree,
     `git worktree add --detach <scratch>/<run id> origin/main`, write the
     assignment to `<scratch>/<run id>.prompt`, then use the one runner below
     as a background command and wait for it to exit. Use it unchanged for
     every role named above; it applies the implementer's sandbox exception
     itself:

     ```sh
     node scripts/run-codex-role.mjs <role> <run id> <scratch>/<run id> <scratch>
     ```

     The runner keeps its supervisor outside the Codex process group and writes
     `<run id>.status` from inside that group on every ending Codex produces.
     A status file reports the real exit code, including nonzero. Its absence
     after the group vanishes reports a lost run, its elapsed time, and whether
     GitHub issue comments contain the exact claim line for that run id:
     `found`, `not found`, or `could not be determined`. The GitHub read starts
     at the run's launch time and checks the durable claim grammar directly;
     the log is never claim authority.

     On a normal ending the runner removes the worktree and leaves the log and
     sentinels in scratch. On a loss it preserves the registered worktree and
     log in every claim state, so a post-claim recovery cannot discard local
     commits or uncommitted evidence. The launching session reports the
     runner's classification before applying step 4; a lost run has no
     trustworthy final line to repeat.

     For the `implementer` only, the runner uses
     `--dangerously-bypass-approvals-and-sandbox` instead of the other roles'
     workspace sandbox (owner decision,
     2026-09-01): that sandbox denies `git fetch` and `git commit` in a linked
     worktree (`.git/index.lock: Operation not permitted`), and an unattended
     run cannot answer the approval. The worktree isolates files only; the
     trust boundary is the machine the lane runs on — the remote runner with
     its repository-scoped write token, or the owner's own machine — and the
     lane is supported nowhere else. Reviewers and adversaries keep the
     sandbox. `codex exec` selects no `.codex/agents/*.toml` adapter, which
     is why the assignment names the contract. Never start it from an empty
     scratch directory (Codex refuses an untrusted directory) and never in
     the foreground (a foreground shell call is killed at ten minutes). The
     role claims, pushes and opens its PR from that worktree.
4. **Report and return.** Name the role, the runtime and the run id. For a
   normal ending, report the runner's real exit code and repeat the session's
   final line verbatim. For a lost Codex run, repeat the runner's lost-run line,
   including elapsed time and durable-claim state; do not infer or invent a
   final line. `No eligible <role> work:
   <reason>.` means the queue was empty: the caller idles for about 30 minutes
   (owner direction, 2026-09-01) before launching again. Any other ending is
   work done or a recorded stop, and the caller launches the next session at
   once. Then stop.

   Before paying for a session, the caller may run
   `sh scripts/probe-work.sh <role>`: exit 1 means nothing can be eligible
   and the caller idles as if it had read the sentinel; exit 2 means the read
   failed and the caller idles too; exit 0 launches. The probe is
   deliberately over-inclusive and claims nothing — a false yes costs one
   session that ends with the sentinel — and the session's own final line
   stays the authority.

Everything else belongs to the role: this file observes no GitHub state,
selects nothing, claims nothing, and performs no gate, review, disposition or
merge. It never resumes a role after its handoff.

## Hard rules

- The launching session's own repo edits happen in its own worktree
  (EnterWorktree), never in the shared launcher checkout, which stays on clean
  `main`.
- A runtime that is not installed or not authenticated is reported before any
  launch. Nothing is started on the other runtime silently.

Shared issue-preparation mechanics live at
`.agents/protocols/issue-preparation.md`; this directory retains only runtime
launch and review transport. The owning roles read those procedures, never this
launcher: `review-protocol.md` and `integration.md` serve the implementation
reviewer and integrator.
