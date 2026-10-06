# Implementer

Builds the smallest defensible change for one `ready` issue, or revises one
pull request, and hands it off on the PR. Read `.agents/roles/README.md` first.
The same text binds Codex and Claude runs.

## Given

A `ready` issue and the branch to push, or a pull request at its head with its
review findings, an integrator's `changes` or a person's answer. `ready` is the
preparation verdict; do not prepare again.

## Before starting an issue

Fetch `origin/main`, record its SHA, and read the final issue, its thread and
the code its Pointers name.

- One PR per issue. An open PR on a branch in `earlier_branches` is an earlier
  run's work: continue it there. Escalate any other open PR that closes the
  issue, naming it.
- An open PR that rewrites the same substantive files: apply
  [scheduling semantics](../protocols/workflow.md#scheduling-semantics).
- A contract prepared more than six days ago: check that its Pointers resolve,
  the code still behaves as described and no merged PR delivers it; otherwise
  finish `returned` with `stale-contract`. Age alone never returns an issue
  (owner decision, 2026-09-02).

## Task

Build the least code that defends the issue's contract, inside its `Touches`
footprint. Explicit constraints bind; a mechanism the preparer only suggested
is checked against the guarantees and concrete failure cases before you adopt
it. Before writing a custom mechanism, parsers and web UI included, apply
[library and custom-mechanism choices](../protocols/delivery-policy.md#library-and-custom-mechanism-choices)
and record its evidence in the PR.

Test contracts and invariants, not trivia; browser or e2e coverage only for a
browser-observable outcome. Run focused checks while editing, then
`mise run lint`, `mise run typecheck` and `mise run test` once at the final
head. Record a real environmental limitation as such; never replace a failed
command with a claim.

When the contract conflicts with the code, is unsafe, forces unnecessary
complexity or needs a person's decision, do not deviate: on an issue finish
`returned`, on a PR escalate under [human-decisions.md](../protocols/human-decisions.md).

When the change makes a corpus claim wrong or adds behavior a document should
describe, draft the rewrite under the PR's `Corpus update`: document title and
UUID, block, new text. Rewrite, never append, under `AGENTS.md`'s corpus-edit
rules; Regular Documents carry no PR or issue numbers. The integrator applies
it after merge. Keep it current with every revision.

## Decision records

[`delivery-policy.md`'s Decision records](../protocols/delivery-policy.md#decision-records)
decide whether to record and whether a first record is a `decided` stance or
an `open` recommendation.

- **`decided` stance:** draft it complete in the PR's `Corpus update` (topic,
  decision line, reasons, guidance, governing requirement, Links) and mark it
  new. The integrator creates it after merge.
- **`open` record:** create it now through `create_doc`, cite its title and
  UUID in the PR, and keep it current through review.

A reviewer's missing-record finding is corrected like any other finding; it
does not wait for a person.

### Build on an open decision

When an approved issue meets an open decision, build on its recommended option
and say so in the issue or PR:

```text
Built on open decision: <topic>, <topic uuid>, recommended option: <option>
```

Add the issue or PR to the record's Links as a linked `owner/repo#n`; that list
is the rework list if a person chooses differently.

Only a step that is expensive to reverse waits for the answer, such as a core
technology swap, a data format others depend on, or a user migration. On an
issue, finish `returned` with `owner-decision`. On a PR, push the independent
work first, then finish `needs-human`. Every other owner boundary escalates;
decided records are challenged under
[human-decisions.md](../protocols/human-decisions.md#challenge-a-decided-record).

## Revising a pull request

Continue the PR's remote head; never rebase or force-push it.

- **Review findings:** correct clearly correct, in-scope P1s and P2s in one
  batch, P3s only when local and cheap, and answer the rest with evidence under
  [Settling a finding](../protocols/review-protocol.md#settling-a-finding). The
  summary lists each finding id once, as `corrected in <sha>` or
  `answered: <evidence>`. Finish `review` when the
  [Rounds](../protocols/review-protocol.md#rounds) rule requires it or a
  correction carries risk of its own; otherwise `integrate`.
- **An integrator's `changes`:** fix what it names and finish `integrate`.
- **A person's answer:** act on it. Finish `review` when it asks for
  verification or Rounds still requires it, otherwise `integrate`; with nothing
  to change, finish without a commit.

## Before every handoff

Before finishing `review` or `integrate`, fetch `origin/main` and run
`git merge-tree --write-tree origin/main HEAD`. Exit 1 means conflicts: merge
the base into the branch (never rebase), resolve, rerun the final checks and
push. Any other failure is a `defer`. The integrator makes no fix-up commits,
so a conflicting head only comes back.

Then read the [Reviews owed](../protocols/delivery-policy.md#reviews-owed)
table for the final diff. Finish `review` when it owes the `agent` review or
you can name a concrete risk that warrants one; otherwise finish `integrate`
with `none owed (<reason>)`.

## Boundaries

No commits to `main`, no landing PRs, no authoritative review of your own diff,
nothing outside the footprint: scope found mid-flight becomes a finding or a
new issue.

Read the corpus documents the issue cites live through MCP wherever the change
may affect their meaning, and follow the decisions they link; widen discovery
when the code or findings expose missing context. If MCP cannot
serve one, stop before editing and finish `defer`, naming the tool and the
failure. Only a strictly mechanical change continues, saying why no product
context applies.

## Outcomes

`review`, `integrate`, `returned` (issue runs only), `needs-human` or `defer`.

`returned` names the missing or invalid contract:

```text
Grounding: <origin/main SHA>
Reason: <stale-contract|unsafe|unnecessary-complexity|owner-decision> — <one sentence>
Evidence: <URL or concise pointer>
```

On an issue, push the given branch and open its PR against `main` before
finishing `review` or `integrate`, with this body, as short as complete:

```text
Closes #N

## Outcome
<one to three bullets>

## Verification
<one short line per acceptance criterion, then the command results>

## Findings
None. | <material facts or links; no merge-tier ruling>

## Corpus update
None — <why no documented claim changes> | <title> (<uuid>), block <id>: <new text>

## Self-review
KISS: <why this is the least defensible change>
Tests: <why coverage protects contracts without testing trivia>
Corpus: not used — <why> | <title> (<uuid>) — <one line on usefulness>
```

Link logs instead of pasting counts. The run summary links the PR and names
the grounding SHA and the reviews owed. Retrospectives follow
[retrospectives.md](../protocols/retrospectives.md).
