# Role contracts

Shared rules for the four delivery roles. Each role file says what its run is
given, what it does and which outcomes it may end with. The issue schema lives
in `.github/ISSUE_SPEC.md`, executable gates in
`.agents/protocols/delivery-policy.md`. Product intent and workflow reasoning
live in the MCP corpus. These are distinct authorities, not duplicate policies.

## One run, one item, one outcome

A run is given one issue or pull request — for a pull request, also the head it
works at — and works only that item. It ends with exactly one outcome its role
file lists, plus a short summary: what was decided or changed, the grounding
commit, and links to evidence. That summary is the handoff, so it carries what
the next run needs and nothing it can read from GitHub itself.

Workflow state is not the run's to write. ub-agents applies the outcome: it
moves the labels, posts the handoff, requests the reviews an outcome names,
records which runtime did the work, and ensures only one run holds an item at a
time. A role never adds or removes a workflow label, posts a claim, or starts
or requests a reviewer itself. What the task produces is the run's to write:
issue bodies, commits and pull requests, findings, rulings, the merge, corpus
updates and follow-up issues.

Until ub-agents runs this repository, a person starts each run and applies its
outcome, and the run posts its own summary as a comment on the item, headed
`Outcome: <role> <outcome>`. This table moves into the ub-agents configuration
when that lands:

| Role | Outcome | Next |
| --- | --- | --- |
| issue-preparer | `ready` | the issue becomes `ready`; first the `agent` review when the outcome requires one |
| issue-preparer | `needs-decision` | parked on the owner question the run posted |
| issue-preparer | `split` | the issue becomes an `umbrella`; its children start at `needs-preparation` |
| issue-preparer | `wontfix` | closed as not planned |
| implementer | `done` | the PR's required reviews run at its head; with none required, integration |
| implementer | `returned` | the issue goes back to `needs-preparation` |
| reviewer | `approve` | once every required review approved the head: the issue becomes `ready`, or the PR goes to integration |
| reviewer | `changes` | back to the preparer (issue) or the implementer (PR) |
| integrator | `merged` | done |
| integrator | `changes` | back to the implementer with the ruling's fix-up brief |
| integrator | `needs-human` | parked for the owner; `human-approved` returns it to integration |
| integrator | `more-review` | the named reviews run at the current head, then integration again |
| any | `defer` | retried later; nothing is consumed |

When the required reviews of a head include more than one, all of them review
that same head before any correction starts.

## Records

Post comment bodies from files (`gh ... --body-file`), and update a mutable
record by its immutable comment id (`gh api ... -F body=@<file>`), never "edit
last". Preserve literal text and newlines. Confirm scratch-file writes
succeeded before posting; noclobber can leave stale content.

Each run uses fresh private scratch outside the worktree, namespaced by its run
id; never share it or treat it as durable state. A private transcript is never a
handoff: GitHub must be sufficient for a fresh run to continue.

Before creating a follow-up issue discovered during a run, fetch `origin/main`
and check the observation against that commit and existing open issues. Do not
queue work that the current base already resolved or already tracks. Create it
with `gh issue create --repo uberblick-ai/uberblick-2` and `needs-preparation`;
leave Request Source unset.

Priority is the `priority:urgent|high|medium|low` label. A human owns every
value; agents never set one by their own judgement. The two agent writes are a
preparer copying an umbrella's label onto the children of a split, and a
shaping session recording the value the human stated.

## Every process a run starts is that run's to end

A run owns each process it spawns on the host — a browser, a load or timing
probe, a server, a watcher — until that process exits. Start one in the
foreground of a script under a cleanup trap so that an interrupted run still
tears it down, and give it its own deadline (a `timeout`, or the tool's own
equivalent) so it dies on its own clock rather than waiting on a parent that may
never return. Never disown a process to make it someone else's problem.
A trap only runs between commands, so a loop that blocks in a foreground
`sleep` will not honour `SIGTERM` until that sleep ends: background the wait
and `wait` on it, or signal the process group, or the trap is decoration.

## Product context, proportional to the action

Current corpus context is required before a product-sensitive choice or a
judgment against product intent. If it is unavailable and proceeding could change
product meaning, stop and report what was needed and observed. Mechanical
inspection, validation and GitHub bookkeeping continue on their own inputs.

## Decide inside your authority, escalate beyond it

Make and record decisions already covered by the issue, program authorization,
adopted principles and repository policy. Escalate when work would materially
change direction, consequential product behavior, adopted principles, external
guarantees or resources, or agent authority. For preparation, an unresolved
product, authority, safety, or fundamentally unsafe-shape finding is that stop;
correctable specification findings are not.

Delegating a bounded subtask is allowed and stays bounded; the delegating run
still owns the outcome and the durable record. A context reset never erases
authorship — the author of a diff is never its independent reviewer.

## Worktrees

New implementation starts from freshly fetched `origin/main` in this run's own
isolated worktree. A revision continues the pull request's current remote head
without rebase or force-push. Never share, delete or repurpose another run's
worktree. A stopped run is never resumed: a fresh run continues from GitHub's
durable records.
