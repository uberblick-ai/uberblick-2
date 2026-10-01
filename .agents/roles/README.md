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
moves the labels, posts the handoff, runs the reviews an outcome names,
records which runtime did the work, and ensures only one run holds an item at a
time. A role never changes a workflow label on an existing item, posts a claim,
or starts or requests a reviewer itself. What the task produces is the run's to
write: issue bodies and relationships, commits and pull requests, findings, the
merge, corpus updates and new issues.

Until ub-agents runs this repository, a person starts each run and applies its
outcome, and the run posts its own summary as a comment on the item, headed
`Outcome: <role> <outcome>`. This table moves into the ub-agents configuration
when that lands:

| Role | Outcome | Next |
| --- | --- | --- |
| issue-preparer | `ready` | the issue becomes `ready`; when the outcome names the `agent` review, that review runs first |
| issue-preparer | `split` | the issue leaves the queue as a parent; its sub-issues start at `needs-preparation` |
| issue-preparer | `wontfix` | closed as not planned |
| implementer | `done` | the reviews the outcome names run at the pull request's head, then integration |
| implementer | `returned` | issue runs only: the issue goes back to `needs-preparation` |
| reviewer | `approve` | the issue becomes `ready`, or, once no review is pending, the PR goes to integration |
| reviewer | `changes` | back to the preparer (issue), or to the implementer once every review of that head has reported (PR) |
| integrator | `merged` | done |
| integrator | `changes` | back to the implementer |
| integrator | `more-review` | the named reviews run at the current head, then integration again |
| any | `needs-human` | parked until a person answers and removes `needs-human`; then an issue goes to the preparer, a PR to the implementer |
| any | `defer` | retried later; nothing is consumed |

A review that asked for changes runs again only when the next outcome names it
(`.agents/protocols/review-protocol.md`, Rounds). A `changes` verdict the next
outcome does not name is settled.

## Escalate what is not yours to decide

Decide what the issue, settled decisions, adopted principles and repository
policy already cover. Ask a person when the next step would change product
direction, an adopted principle or guarantee, external resources or agent
authority; when the merge policy says tier 3; or when review stops converging.
A correctable gap in a specification is not such a stop: correct it.

Finish `needs-human`. The summary is the question, ready to answer:

- what is blocked, and the one decision needed;
- the answers to pick from, and your recommendation;
- an @-mention of who can answer: the person who opened the issue (for a pull
  request, its issue), otherwise `@bk-one`;
- the closing line `Answer here, then remove needs-human.`

Any person with write access may answer. A comment from a person's account is
the answer; one from `uberblick-agent` or a bot never is. The next run works
within it. An answer covers what it names, plus fix-ups that conform to it;
anything beyond that is a new question.

## Authorship

Delegating a bounded subtask is allowed; the delegating run still owns the
outcome and the record. A context reset never erases authorship: the author of
a change is never its independent reviewer.

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
with `gh issue create --repo uberblick-ai/uberblick-2 --label
needs-preparation`, adding `--blocked-by` or `--parent` only for a real
relationship, and leave Request Source unset. This is the one label a run sets,
and only on an issue it creates.

Priority is the `priority:urgent|high|medium|low` label. A person owns every
value; agents never set one by their own judgement. The one agent write is a
shaping session recording the value the person stated.

## Retrospectives

Post one to your role's board (`AGENTS.md`, Project facts) only when the run
lost something — a session, a review round, rework, a long discovery, tokens
burned for nothing — or missed something it needed, such as a corpus document,
a pointer or a check, and only when you can say why and name the change that
would have prevented it. Otherwise post nothing. In a short paragraph, link the
item, state the cost and its cause, and the smallest useful change. A
retrospective is telemetry, never a gate.

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

## Worktrees

Work in the directory and on the branch the run was given; ub-agents creates
and removes them. Push only that branch, and never rebase or force-push a pull
request's head. Leave other runs' worktrees and processes alone. Until
ub-agents runs here, start a fresh worktree at `origin/main` on the branch
`ub-agents/<issue number>`.
