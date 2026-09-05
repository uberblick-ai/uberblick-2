# Review protocol — external rounds, and what happens once a review returns

Read this whenever a PR has an external round to request or a finding to
handle. When CLAUDE.md requires the pair, the implementer owns the first
challenge before handoff, on the other runtime from the diff's author, and the
integrator owns the second, a fresh session of the author's runtime; when it
requires one, the implementer owns that round. These are real adversarial
reads, not gate checks. The integrator owns authoritative dispositions and any
risk-scoped final-head round. `integration.md` beside this file owns the
gates' order and mechanics.

How many challenges a diff owes, who owns each, and the candidate-head freeze
are CLAUDE.md's gate. "Requesting the round" covers dispatch; "Findings and
corrections" covers reviewer records and fix-ups; "Verification and completion"
is the integrator's.

## Requesting the round

CLAUDE.md's gate list is the authority on *when* a pre-handoff review is
required. The implementer opens a draft PR and posts the README's exact-PR
delegation at its current head before starting a fresh
`implementation-reviewer`. Add `Round: N` to that mutable record; the reviewer
edits its status and appends its verdict there rather than posting claim and
completion comments. A `Round: 2` of CLAUDE.md's required pair also carries one
`Boundary:` line naming which of CLAUDE.md's listed boundaries fires, or the
concrete unresolved risk; a package path is neither, and without that line the
round is not dispatched. One transport per *reviewer* runtime — the command
is chosen by the runtime the round must run on, not by the caller's, so a
same-runtime round (a `--codex` integrator on a Codex-authored PR) uses the
same two commands. Both run from the parent's own worktree, named explicitly
for Codex instead of inherited from the shell, and detached (a foreground shell
call is killed at ten minutes), with the prompt read from a file and the log
kept in private scratch. Put a Codex reviewer's prompt at
`<scratch>/<child-run-id>.prompt`, then start the runner as one background Bash
call; it writes its own sibling `.log` and `.status` files and leaves the
borrowed parent worktree registered. An empty scratch directory is not a
substitute, even with `--skip-git-repo-check`: it holds neither the role
contracts nor current code, so bypassing the trust refusal only makes the round
fail later.

```sh
# A Codex reviewer — the repository runner supervises Codex and records the
# transport's log and exit status in private scratch.
node scripts/run-codex-role.mjs implementation-reviewer <child-run-id> <parent-worktree> <scratch>

# A Claude reviewer — the project adapter selects the role.
( claude -p --agent implementation-reviewer --model opus --permission-mode bypassPermissions < <prompt-file> > <scratch-log> 2>&1; echo $? > <scratch-log>.status )
```

Each is a fresh top-level session: `codex exec` always is, and a headless
`claude -p` carries its own `Claude-Session` trailer. A Claude parent may
instead start the reviewer with the `Agent` tool (`subagent_type:
implementation-reviewer`, `model: opus`). That child shares its launcher's
authorship identity, so it may review only a diff that identity did not
author — proven the way an integrator proves its own independence: no commit
in the head carries the launcher's `Claude-Session` trailer, and the launcher
launched no implementer whose commit is in the head. Under that proof the
`Agent` child is the Claude transport for a Codex-authored diff (owner
decision, 2026-09-01); without it, it is never a reviewer.

`codex exec` selects no `.codex/agents/*.toml` adapter, so the prompt tells a
Codex child to read the `implementation-reviewer` role contract; the Claude
adapter already does. Either assignment names the exact PR, head, child run id
and parent run id, and nothing else — the reviewer contract supplies the
critical brief. Read the verdict from the completed PR record; inspect the
private scratch log only when dispatch fails or no durable verdict appears, so
the child's reasoning transcript does not consume the parent context.

The implementer stays in the assignment, renewing its claim, until the
reviewer completes its durable record. A dispatch failure edits that record to
`Status: failed — <reason>` and is never presented as a review or repeated in a
new failure comment; the integrator later supplies the missing challenge as
well as its own. The failure is recorded at once, not at the end of the verdict
window: a `<scratch-log>.status` that is nonzero, or a log that ends in a
startup or overload error before any verdict — a transport that exited before
starting, an HTTP 529 — marks the delegation failed on the dispatching role's
next check, with the status and the log's last line as the reason (owner
decision, 2026-09-04: seven dispatches failed in two days — PRs #750 twice,
#761 three times, #763, #771 — and each one silently moved the owed round to
the integrator, one of them at the cost of an owner question and a whole extra
integrator session). A further round is never a resumed session — it is a fresh
reviewer at the new head, within the re-review scoping below. Every brief says:
be critical, try to falsify the implementation with focused failure-path or
mutation probes, and hunt specifically for overtesting and overengineering per
this repo's principles (KISS/YAGNI, least code wins, tests defend contracts and
invariants rather than implementation trivia).

## Findings and corrections

Reviewers record findings in their delegation verdict using stable IDs
(`R<round>-F<number>`). Each finding names the affected code, supported-usage
consequence, proposed severity, and reproducible evidence. Separate observations
from assumptions. Record successful probes only when they resolve a finding or
establish a material limitation.

The integrator maintains one finding ledger: ID, disposition, evidence link, and
verification result. Evidence stays in the reviewer's verdict; later records
link to it. Existing findings retain their IDs across heads. Reopen settled
findings only when changed code or new evidence invalidates the disposition.

Severity follows impact:

- **P1:** data loss, secret exposure, violated invariant, or materially unusable
  supported behavior.
- **P2:** another concrete defect in supported usage.
- **P3:** minor or theoretical impact.

The integrator chooses the disposition. Fix P1s and contained supported-usage
P2s. A branch-caused failure of a required check must be fixed. A non-blocking P2
may be deferred to a linked issue with its accepted consequence recorded; never
defer data loss, security exposure, or violated invariants. Accept P3s without
creating issues by default. Reject unsupported findings with a brief
evidence-based reason.

When two challenges are required, collect both on the same head before
corrections, except for P1. Then issue one batched fix-up brief containing
finding IDs, required outcomes, and verification. Include P3 corrections only
when local and inexpensive; they must not drive a redesign or another external
round.

## Verification and completion

The integrator verifies corrections through focused diff inspection and
relevant tests or failure-path probes. Tests defend the affected contract, not
the implementation mechanism.

Repeat an external challenge only when a correction introduces a concrete
unresolved risk or invalidates that challenge's earlier reasoning. Record the
risk, affected verdict, and review scope before dispatch. A new head, severity
disagreement, or P3-only verdict is insufficient. Replacement reviews examine
the delta first and use the runtime of the verdict they replace.

Merge requires CLAUDE.md's gates, no open P1, and an explicit disposition for
every finding. Record carried-forward review evidence with a brief scope and
rationale. The final ruling links to the ledger and gate results without
repeating them.

If a confirmation review finds a new P1, or a correction wave does not reduce the
open P1 set, park for an owner decision. The integrator settles P2/P3
disagreements after one implementer response; escalate only a specific
unresolved decision.

Before a third correction head since opening or the latest owner decision, park
with one question identifying the mechanism preventing convergence. An owner
instruction to continue resets the count.
