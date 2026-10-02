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

Workflow state is not the run's to write. The table below is this
repository's workflow, and ub-agents applies it: it moves the labels, posts the
handoff, records which runtime did the work, and ensures only one run holds an
item at a time. A role never changes a workflow label on an existing item,
posts a claim, or starts the `agent` review itself; it may request the Copilot
review (`.agents/protocols/delivery-policy.md`). What the task produces is the
run's to write: issue bodies and relationships, commits and pull requests,
findings, the merge, corpus updates and new issues.

Each role starts on its label: the preparer on `needs-preparation`, the
implementer on `ready` (an issue) or `needs-changes` (a pull request), the
reviewer on `needs-review`, the integrator on `ready-to-merge`. Every outcome
except `defer` removes that label and adds the next one:

| Role | Outcome | Label changes |
| --- | --- | --- |
| issue-preparer | `ready` | issue: `needs-preparation` → `ready` |
| issue-preparer | `review` | issue: `needs-preparation` → `needs-review` |
| issue-preparer | `split` | issue: `needs-preparation` removed; its sub-issues carry `needs-preparation` |
| issue-preparer | `wontfix` | `needs-preparation` removed; the run has closed the issue as not planned |
| implementer | `review` | its pull request gets `needs-review`; the issue loses `ready`, or the pull request `needs-changes` |
| implementer | `integrate` | its pull request gets `ready-to-merge`; the issue loses `ready`, or the pull request `needs-changes` |
| implementer | `returned` | issue runs only: `ready` → `needs-preparation` |
| reviewer (issue) | `approve` | `needs-review` → `ready` |
| reviewer (issue) | `changes` | `needs-review` → `needs-preparation` |
| reviewer (pull request) | `approve` | `needs-review` → `ready-to-merge` |
| reviewer (pull request) | `changes` | `needs-review` → `needs-changes` |
| integrator | `merged` | pull request merged; `ready-to-merge` removed |
| integrator | `changes` | `ready-to-merge` → `needs-changes` |
| integrator | `review` | `ready-to-merge` → `needs-review` |
| any | `needs-human` | the role's label → `needs-human` |
| any | `defer` | reported as a retry, not an outcome: no label changes, and the item runs again later |

The reviewer runs as two configured agents, one per item kind, sharing
`reviewer.md`. `needs-human` pauses the item: no run picks it up while the label
is there. The person who answers replaces it with the label that should run
next — `needs-preparation` on an issue, `needs-changes` on a pull request —
unless the answer calls for another.

`ub-agent.yaml` declares these label transitions and the queue policy in
`.github/ISSUE_SPEC.md` for ub-agents to apply.

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
- the closing line `Answer here, then replace needs-human with <label>.`,
  naming `needs-preparation` on an issue or `needs-changes` on a pull request.

Any person with write access may answer. A comment from a person's account is
the answer; one from `uberblick-agent` or a bot never is. The next run works
within it. An answer covers what it names, plus fix-ups that conform to it;
anything beyond that is a new question.

## Limits for every run

Only the integrator merges. No run enables auto-merge, approves its own pull
request, changes branch protection or repository settings, pushes a tag or
publishes a release. A blocked operation is never worked around by copying
credentials, changing global settings or disabling commit signing: escalate or
defer with the evidence.

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

A run ends when its session ends, so a task your agent tool starts in the
background never reports back. Wait in the foreground with a bounded command, such as `gh pr checks <N>
--watch` under the tool's timeout. A tool that returns while the command still
runs leaves it yours: keep polling until it exits, or stop it. When what you
wait for is still pending after that, finish `defer` and name it.

## Product context, proportional to the action

Current corpus context is required before a product-sensitive choice or a
judgment against product intent. If it is unavailable and proceeding could change
product meaning, stop and report what was needed and observed. Mechanical
inspection, validation and GitHub bookkeeping continue on their own inputs.

## Worktrees

Work in the directory and on the branch the run was given; ub-agents creates
and removes them. Push only that branch, or the branch of the earlier run's
pull request you continue, and never rebase or force-push a pull request's
head. A detached checkout is pushed with `git push origin
HEAD:refs/heads/<branch>`. Leave other runs' worktrees and
processes alone.
